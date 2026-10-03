import {
  executionQueueJobSchema,
  type ExecutionQueueJob,
} from '@opsflow/shared';
import { Redis } from 'ioredis';
import { UnrecoverableError, Worker } from 'bullmq';
import { redactError } from '../outbox/dispatcher.js';
import {
  extractExecutionId,
  type InvalidExecutionJobReason,
  validateExecutionJobIdentity,
} from '../outbox/publisher.js';
import type { ExecutionProcessor } from './processor.js';

export interface ExecutionConsumerOptions {
  redisUrl: string;
  queueName: string;
  processor: ExecutionProcessor;
  lockDuration?: number;
  stalledInterval?: number;
  maxStalledCount?: number;
  handleInvalidJob?: (
    executionId: string,
    reason: InvalidExecutionJobReason,
  ) => Promise<void>;
  logger?: {
    info(message: string): void;
    error(message: string): void;
  };
}

export class BullExecutionConsumer {
  private readonly connection: Redis;
  private readonly worker: Worker<ExecutionQueueJob>;
  private readonly logger: {
    info(message: string): void;
    error(message: string): void;
  };

  constructor(options: ExecutionConsumerOptions) {
    this.logger = options.logger ?? console;
    this.connection = new Redis(options.redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      retryStrategy: (attempt) => Math.min(attempt * 100, 1_000),
    });
    this.connection.on('error', (error) =>
      this.logger.error(
        `Execution consumer Redis error: ${redactError(error)}`,
      ),
    );
    this.worker = new Worker<ExecutionQueueJob>(
      options.queueName,
      async (job) => {
        const parsed = executionQueueJobSchema.safeParse(job.data);
        const executionId = extractExecutionId(job.data);
        const invalidReason = executionId
          ? validateExecutionJobIdentity(job, executionId)
          : 'payload';
        if (!parsed.success || invalidReason) {
          if (executionId && options.handleInvalidJob)
            await options.handleInvalidJob(
              executionId,
              invalidReason ?? 'payload',
            );
          throw new UnrecoverableError('Execution queue job is invalid.');
        }
        await options.processor.process(parsed.data, job.attemptsMade);
      },
      {
        connection: this.connection,
        autorun: false,
        concurrency: 1,
        lockDuration: options.lockDuration ?? 30_000,
        stalledInterval: options.stalledInterval ?? 5_000,
        maxStalledCount: options.maxStalledCount ?? 1,
      },
    );
    this.worker.on('completed', (job) =>
      this.logger.info(`Execution job ${job.id ?? 'unknown'} completed.`),
    );
    this.worker.on('failed', (job, error) =>
      this.logger.error(
        `Execution job ${job?.id ?? 'unknown'} failed: ${redactError(error)}`,
      ),
    );
    this.worker.on('error', (error) =>
      this.logger.error(`Execution consumer error: ${redactError(error)}`),
    );
  }

  start(): void {
    void this.worker
      .run()
      .catch((error: unknown) =>
        this.logger.error(`Execution consumer stopped: ${redactError(error)}`),
      );
  }

  async close(force = false): Promise<void> {
    await this.worker.close(force);
    this.connection.disconnect();
  }
}
