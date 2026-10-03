import { EXECUTION_PROCESSING_LEASE_EXPIRED } from '@opsflow/shared';
import { redactError } from '../outbox/dispatcher.js';
import type { PostgresExecutionRepository } from './repository.js';

const recoveryMessage =
  'Execution stopped because its processing lease and retry grace period expired.';

export interface ExecutionRecoveryOptions {
  pollMilliseconds?: number;
  recoveryGraceMilliseconds?: number;
  logger?: {
    info(message: string): void;
    error(message: string): void;
  };
}

export class ExecutionRecoveryMonitor {
  private readonly pollMilliseconds: number;
  private readonly logger: {
    info(message: string): void;
    error(message: string): void;
  };
  private readonly recoveryGraceMilliseconds: number;
  private stopped = true;
  private loopPromise: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly repository: PostgresExecutionRepository,
    options: ExecutionRecoveryOptions = {},
  ) {
    this.pollMilliseconds = options.pollMilliseconds ?? 1_000;
    this.recoveryGraceMilliseconds =
      options.recoveryGraceMilliseconds ?? 15_000;
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

  async recoverOnce(): Promise<string | undefined> {
    return this.repository.recoverExpired(
      {
        errorType: EXECUTION_PROCESSING_LEASE_EXPIRED,
        errorMessage: recoveryMessage,
      },
      this.recoveryGraceMilliseconds,
    );
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const executionId = await this.recoverOnce();
        if (executionId) {
          this.logger.info(`Recovered expired execution ${executionId}.`);
          continue;
        }
      } catch (error) {
        this.logger.error(`Execution recovery failed: ${redactError(error)}`);
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
