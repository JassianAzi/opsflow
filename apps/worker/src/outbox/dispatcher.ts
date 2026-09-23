import { executionQueueJobSchema } from '@opsflow/shared';
import type { OutboxRepository } from './repository.js';
import type { QueuePublisher } from './publisher.js';

export interface DispatcherLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface OutboxDispatcherOptions {
  pollMilliseconds?: number;
  leaseMilliseconds?: number;
  maxAttempts?: number;
  baseBackoffMilliseconds?: number;
  maxBackoffMilliseconds?: number;
  logger?: DispatcherLogger;
}

export type DispatchResult =
  'idle' | 'published' | 'retry' | 'failed' | 'lost-lease';

const defaultLogger: DispatcherLogger = {
  info: (message) => console.info(message),
  error: (message) => console.error(message),
};

export class OutboxDispatcher {
  private readonly pollMilliseconds: number;
  private readonly leaseMilliseconds: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMilliseconds: number;
  private readonly maxBackoffMilliseconds: number;
  private readonly logger: DispatcherLogger;
  private stopped = true;
  private loopPromise: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly repository: OutboxRepository,
    private readonly publisher: QueuePublisher,
    options: OutboxDispatcherOptions = {},
  ) {
    this.pollMilliseconds = options.pollMilliseconds ?? 1_000;
    this.leaseMilliseconds = options.leaseMilliseconds ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseBackoffMilliseconds = options.baseBackoffMilliseconds ?? 1_000;
    this.maxBackoffMilliseconds = options.maxBackoffMilliseconds ?? 60_000;
    this.logger = options.logger ?? defaultLogger;
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

  async dispatchOnce(): Promise<DispatchResult> {
    const row = await this.repository.claimNext(
      this.leaseMilliseconds,
      this.maxAttempts,
    );
    if (!row) return 'idle';

    const parsed = executionQueueJobSchema.safeParse(row.jobPayload);
    if (!parsed.success || parsed.data.executionId !== row.executionId) {
      const updated = await this.repository.markFailed(
        row.id,
        row.lockToken,
        'Stored queue payload is invalid.',
        new Date(),
        true,
      );
      return updated ? 'failed' : 'lost-lease';
    }

    try {
      await this.publisher.publish(parsed.data);
      const updated = await this.repository.markPublished(
        row.id,
        row.lockToken,
      );
      if (updated) {
        this.logger.info(`Published execution ${row.executionId}.`);
        return 'published';
      }
      return 'lost-lease';
    } catch (error) {
      const terminal = row.attemptCount >= this.maxAttempts;
      const updated = await this.repository.markFailed(
        row.id,
        row.lockToken,
        redactError(error),
        new Date(Date.now() + this.backoffFor(row.attemptCount)),
        terminal,
      );
      if (updated)
        this.logger.error(
          `Execution ${row.executionId} queue publication failed; ${
            terminal ? 'no attempts remain' : 'retry scheduled'
          }.`,
        );
      return updated ? (terminal ? 'failed' : 'retry') : 'lost-lease';
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const result = await this.dispatchOnce();
        if (result !== 'idle') continue;
      } catch (error) {
        this.logger.error(`Outbox polling failed: ${redactError(error)}`);
      }
      await this.delay();
    }
  }

  private backoffFor(attempt: number): number {
    return Math.min(
      this.baseBackoffMilliseconds * 2 ** Math.max(0, attempt - 1),
      this.maxBackoffMilliseconds,
    );
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

export function redactError(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : 'Unknown queue publication error.';
  return raw
    .replace(/(?:redis|rediss):\/\/[^\s]+/gi, '[redacted redis URL]')
    .replace(
      /(?:postgres|postgresql):\/\/[^\s]+/gi,
      '[redacted PostgreSQL URL]',
    )
    .replace(/(password|passwd|token|secret)=([^\s&]+)/gi, '$1=[redacted]')
    .slice(0, 500);
}
