import {
  EXECUTION_QUEUE_PAYLOAD_INVALID,
  EXECUTION_QUEUE_RECOVERY_EXHAUSTED,
  type ExecutionQueueJob,
} from '@opsflow/shared';
import { redactError } from '../outbox/dispatcher.js';
import type { JobReconciliationResult } from '../outbox/publisher.js';
import type {
  PostgresExecutionRepository,
  QueueReconciliationClaim,
} from './repository.js';

export interface ReconciliationQueue {
  reconcile(
    payload: ExecutionQueueJob,
    options?: { recover?: boolean },
  ): Promise<JobReconciliationResult>;
}

export interface ExecutionQueueReconcilerOptions {
  pollMilliseconds?: number;
  batchSize?: number;
  maxAttempts?: number;
  claimLockMilliseconds?: number;
  baseBackoffMilliseconds?: number;
  maxBackoffMilliseconds?: number;
  logger?: {
    info(message: string): void;
    error(message: string): void;
  };
}

const invalidJobMessage =
  'The retained queue job failed identity validation and was not executed.';
const exhaustedMessage =
  'Queue recovery reached its durable attempt limit before execution processing could resume.';

export class ExecutionQueueReconciler {
  private readonly pollMilliseconds: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly claimLockMilliseconds: number;
  private readonly baseBackoffMilliseconds: number;
  private readonly maxBackoffMilliseconds: number;
  private readonly logger: {
    info(message: string): void;
    error(message: string): void;
  };
  private stopped = true;
  private loopPromise: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly repository: PostgresExecutionRepository,
    private readonly queue: ReconciliationQueue,
    options: ExecutionQueueReconcilerOptions = {},
  ) {
    this.pollMilliseconds = options.pollMilliseconds ?? 5_000;
    this.batchSize = options.batchSize ?? 100;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.claimLockMilliseconds = options.claimLockMilliseconds ?? 30_000;
    this.baseBackoffMilliseconds = options.baseBackoffMilliseconds ?? 30_000;
    this.maxBackoffMilliseconds = options.maxBackoffMilliseconds ?? 300_000;
    this.logger = options.logger ?? console;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loopPromise;
  }

  async reconcileOnce(): Promise<number> {
    let recovered = 0;
    for (let index = 0; index < this.batchSize; index += 1) {
      const claim = await this.repository.claimNextQueueReconciliation({
        maxAttempts: this.maxAttempts,
        lockMilliseconds: this.claimLockMilliseconds,
        baseBackoffMilliseconds: this.baseBackoffMilliseconds,
        maxBackoffMilliseconds: this.maxBackoffMilliseconds,
      });
      if (!claim) break;

      try {
        const result = await this.queue.reconcile(
          { executionId: claim.executionId },
          { recover: claim.canRecover },
        );
        recovered += await this.handleResult(claim, result);
      } catch (error) {
        const message = redactError(error);
        const result = await this.repository.failQueueReconciliation(
          claim,
          message,
          {
            errorType: EXECUTION_QUEUE_RECOVERY_EXHAUSTED,
            errorMessage: exhaustedMessage,
          },
        );
        if (result === 'recorded')
          this.logger.error(
            `Execution queue recovery exhausted for ${claim.executionId}.`,
          );
        else
          this.logger.error(
            `Execution queue reconciliation failed for ${claim.executionId}: ${message}`,
          );
      }
    }
    return recovered;
  }

  private async handleResult(
    claim: QueueReconciliationClaim,
    result: JobReconciliationResult,
  ): Promise<number> {
    if (result.type === 'created' || result.type === 'retried') {
      await this.repository.finishQueueReconciliation(
        claim,
        'scheduled',
        this.pollMilliseconds,
      );
      this.logger.info(
        `${result.type === 'retried' ? 'Retried' : 'Recreated'} execution job ${claim.executionId}.`,
      );
      return 1;
    }

    if (result.type === 'active') {
      await this.repository.finishQueueReconciliation(
        claim,
        'active',
        this.pollMilliseconds,
      );
      return 0;
    }

    if (result.type === 'invalid') {
      const terminal = await this.repository.recordReconciliationTerminal(
        claim,
        {
          errorType: EXECUTION_QUEUE_PAYLOAD_INVALID,
          errorMessage: invalidJobMessage,
        },
      );
      if (terminal === 'recorded')
        this.logger.error(
          `Execution job ${claim.executionId} has an invalid retained queue ${result.reason}.`,
        );
      return 0;
    }

    const terminal = await this.repository.recordReconciliationTerminal(claim, {
      errorType: EXECUTION_QUEUE_RECOVERY_EXHAUSTED,
      errorMessage: exhaustedMessage,
    });
    if (terminal === 'recorded')
      this.logger.error(
        `Execution queue recovery exhausted for ${claim.executionId}.`,
      );
    return 0;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.reconcileOnce();
      } catch (error) {
        this.logger.error(
          `Execution queue reconciliation failed: ${redactError(error)}`,
        );
      }
      await this.delay();
    }
  }

  private async delay(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, this.pollMilliseconds);
      this.wake = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    this.wake = undefined;
  }
}
