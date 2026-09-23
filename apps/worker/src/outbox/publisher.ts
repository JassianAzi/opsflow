import { EXECUTION_JOB_NAME, type ExecutionQueueJob } from '@opsflow/shared';
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
        removeOnComplete: false,
        removeOnFail: false,
      }),
      this.publishTimeoutMilliseconds,
    );
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
