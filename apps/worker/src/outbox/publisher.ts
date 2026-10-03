import {
  EXECUTION_JOB_NAME,
  executionQueueJobSchema,
  type ExecutionQueueJob,
} from '@opsflow/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export interface QueuePublisher {
  publish(payload: ExecutionQueueJob): Promise<void>;
  close(): Promise<void>;
}

export interface BullQueuePublisherOptions {
  redisUrl: string;
  queueName: string;
  publishTimeoutMilliseconds?: number;
}

export type InvalidExecutionJobReason = 'name' | 'payload' | 'job-id';

export type JobReconciliationResult =
  | {
      type:
        'created' | 'retried' | 'active' | 'completed' | 'failed' | 'missing';
    }
  | { type: 'invalid'; reason: InvalidExecutionJobReason };

const executionJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1_000 },
  removeOnComplete: false,
  removeOnFail: false,
};

export class BullQueuePublisher implements QueuePublisher {
  private readonly connection: Redis;
  private readonly queue: Queue<ExecutionQueueJob>;
  private readonly publishTimeoutMilliseconds: number;

  constructor(options: BullQueuePublisherOptions) {
    this.connection = new Redis(options.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
      retryStrategy: (attempt) => Math.min(attempt * 100, 1_000),
    });
    this.connection.on('error', () => {
      // Publication errors are persisted by the dispatcher. Avoid logging URLs or credentials.
    });
    this.queue = new Queue<ExecutionQueueJob>(options.queueName, {
      connection: this.connection,
    });
    this.queue.on('error', () => {
      // Queue.add errors are handled by publish and recorded in the outbox.
    });
    this.publishTimeoutMilliseconds =
      options.publishTimeoutMilliseconds ?? 2_000;
  }

  async publish(payload: ExecutionQueueJob): Promise<void> {
    await withTimeout(
      this.queue.add(EXECUTION_JOB_NAME, payload, {
        jobId: payload.executionId,
        ...executionJobOptions,
      }),
      this.publishTimeoutMilliseconds,
    );
  }

  async reconcile(
    payload: ExecutionQueueJob,
    options: { recover?: boolean } = {},
  ): Promise<JobReconciliationResult> {
    const job = await withTimeout(
      this.queue.getJob(payload.executionId),
      this.publishTimeoutMilliseconds,
    );
    if (!job) {
      if (options.recover === false) return { type: 'missing' };
      await this.publish(payload);
      return { type: 'created' };
    }
    const invalidReason = validateExecutionJobIdentity(
      job,
      payload.executionId,
    );
    if (invalidReason) return { type: 'invalid', reason: invalidReason };

    const state = await withTimeout(
      job.getState(),
      this.publishTimeoutMilliseconds,
    );
    if (state === 'completed') return { type: 'completed' };
    if (state !== 'failed') return { type: 'active' };
    if (options.recover === false) return { type: 'failed' };
    try {
      await withTimeout(
        job.retry('failed', {
          resetAttemptsMade: true,
          resetAttemptsStarted: true,
        }),
        this.publishTimeoutMilliseconds,
      );
      return { type: 'retried' };
    } catch (error) {
      const currentState = await withTimeout(
        job.getState(),
        this.publishTimeoutMilliseconds,
      );
      if (currentState === 'completed') return { type: 'completed' };
      if (currentState !== 'failed') return { type: 'active' };
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      await withTimeout(this.queue.close(), 2_000);
    } catch {
      await this.queue.disconnect();
    } finally {
      this.connection.disconnect();
    }
  }
}

export function validateExecutionJobIdentity(
  job: { id?: string; name: string; data: unknown },
  executionId: string,
): InvalidExecutionJobReason | undefined {
  if (job.name !== EXECUTION_JOB_NAME) return 'name';
  const parsed = executionQueueJobSchema.safeParse(job.data);
  if (!parsed.success || parsed.data.executionId !== executionId)
    return 'payload';
  if (job.id !== executionId) return 'job-id';
  return undefined;
}

export function extractExecutionId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || !('executionId' in data))
    return undefined;
  const parsed = executionQueueJobSchema.shape.executionId.safeParse(
    data.executionId,
  );
  return parsed.success ? parsed.data : undefined;
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Queue publication timed out.')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
