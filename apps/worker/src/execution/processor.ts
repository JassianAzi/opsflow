import { isDeepStrictEqual } from 'node:util';
import {
  EXECUTION_ENGINE_NOT_IMPLEMENTED,
  EXECUTION_PROCESSING_ERROR,
  EXECUTION_SNAPSHOT_INVALID,
  workflowExecutionSnapshotSchema,
  type ExecutionQueueJob,
  type WorkflowExecutionSnapshot,
} from '@opsflow/shared';
import { redactError } from '../outbox/dispatcher.js';
import type {
  ClaimedExecution,
  ExecutionOutcome,
  PostgresExecutionRepository,
} from './repository.js';

const engineDeferredMessage =
  'Skipped because workflow execution is not implemented in Phase 3.';

export interface ExecutionProcessorOptions {
  leaseMilliseconds?: number;
  afterClaim?: (execution: ClaimedExecution) => Promise<void>;
  logger?: { error(message: string): void };
}

export class ExecutionProcessor {
  private readonly leaseMilliseconds: number;
  private readonly afterClaim:
    ((execution: ClaimedExecution) => Promise<void>) | undefined;
  private readonly logger: { error(message: string): void };

  constructor(
    private readonly repository: PostgresExecutionRepository,
    options: ExecutionProcessorOptions = {},
  ) {
    this.leaseMilliseconds = options.leaseMilliseconds ?? 5_000;
    this.afterClaim = options.afterClaim;
    this.logger = options.logger ?? console;
  }

  async process(
    payload: ExecutionQueueJob,
    deliveryAttempt = 0,
  ): Promise<void> {
    const claim = await this.claimWhenAvailable(
      payload.executionId,
      deliveryAttempt,
    );
    if (claim.type === 'missing')
      throw new Error(`Execution ${payload.executionId} does not exist.`);
    if (claim.type === 'terminal') return;

    const { execution } = claim;
    let outcome: ExecutionOutcome = {
      errorType: EXECUTION_ENGINE_NOT_IMPLEMENTED,
      errorMessage: engineDeferredMessage,
    };
    try {
      await this.afterClaim?.(execution);
      validateClaimedExecution(execution);
    } catch (error) {
      this.logger.error(
        `Execution ${execution.id} processing failed: ${redactError(error)}`,
      );
      const errorType =
        error instanceof InvalidExecutionSnapshotError
          ? EXECUTION_SNAPSHOT_INVALID
          : EXECUTION_PROCESSING_ERROR;
      outcome = {
        errorType,
        errorMessage:
          errorType === EXECUTION_SNAPSHOT_INVALID
            ? 'Persisted execution snapshot does not match its copied execution state.'
            : `Unexpected worker processing error: ${redactError(error)}`,
      };
    }
    await this.recordOutcome(execution, outcome);
  }

  private async claimWhenAvailable(
    executionId: string,
    deliveryAttempt: number,
  ) {
    while (true) {
      const claim = await this.repository.claim(
        executionId,
        this.leaseMilliseconds,
        deliveryAttempt,
      );
      if (claim.type !== 'in-progress') return claim;
      await delay(claim.retryAfterMilliseconds);
    }
  }

  private async recordOutcome(
    execution: ClaimedExecution,
    outcome: ExecutionOutcome,
  ): Promise<void> {
    const result = await this.repository.recordFailure(
      execution.id,
      execution.processingToken,
      outcome,
    );
    if (result === 'lost-claim')
      throw new Error(
        'Execution processing claim was replaced before a durable outcome was recorded.',
      );
  }
}

export class InvalidExecutionSnapshotError extends Error {}

export function validateClaimedExecution(
  execution: ClaimedExecution,
): WorkflowExecutionSnapshot {
  const result = workflowExecutionSnapshotSchema.safeParse(
    execution.workflowSnapshot,
  );
  if (!result.success)
    throw new InvalidExecutionSnapshotError('Snapshot schema is invalid.');
  const snapshot = result.data;
  if (
    snapshot.workflowId !== execution.workflowId ||
    snapshot.organizationId !== execution.organizationId ||
    snapshot.workflowVersion !== execution.workflowVersion ||
    snapshot.triggerType !== execution.triggerType
  )
    throw new InvalidExecutionSnapshotError(
      'Snapshot identity does not match the execution row.',
    );
  if (snapshot.steps.length !== execution.steps.length)
    throw new InvalidExecutionSnapshotError(
      'Snapshot steps do not match copied execution steps.',
    );
  snapshot.steps.forEach((snapshotStep, index) => {
    const step = execution.steps[index];
    if (
      !step ||
      snapshotStep.workflowStepId !== step.workflowStepId ||
      snapshotStep.stepOrder !== step.stepOrder ||
      snapshotStep.stepType !== step.stepType ||
      snapshotStep.actionType !== step.actionType ||
      snapshotStep.name !== step.name ||
      !isDeepStrictEqual(snapshotStep.config, step.config) ||
      !isDeepStrictEqual(snapshotStep.retryConfig, step.retryConfig)
    )
      throw new InvalidExecutionSnapshotError(
        `Snapshot step ${index} does not match its copied execution step.`,
      );
  });
  return snapshot;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
