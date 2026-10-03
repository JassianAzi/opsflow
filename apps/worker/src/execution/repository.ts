import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export interface ClaimedExecution {
  id: string;
  organizationId: string;
  workflowId: string;
  workflowVersion: number;
  triggerType: string;
  workflowSnapshot: unknown;
  processingToken: string;
  steps: ClaimedExecutionStep[];
}

export interface ClaimedExecutionStep {
  id: string;
  workflowStepId: string;
  stepOrder: number;
  stepType: string;
  actionType: string | null;
  name: string;
  config: unknown;
  retryConfig: unknown;
}

export type ClaimExecutionResult =
  | { type: 'claimed'; execution: ClaimedExecution }
  | { type: 'in-progress'; retryAfterMilliseconds: number }
  | { type: 'terminal' }
  | { type: 'missing' };

interface ExecutionRow {
  id: string;
  organization_id: string;
  workflow_id: string;
  workflow_version: number;
  trigger_type: string;
  workflow_snapshot: unknown;
  status: string;
  processing_lease_active: boolean;
  processing_lease_remaining_ms: number | null;
  processing_attempt: number | null;
}

interface ExecutionStepRow {
  id: string;
  workflow_step_id: string;
  step_order: number;
  step_type: string;
  action_type: string | null;
  name: string;
  config: unknown;
  retry_config: unknown;
}

export interface ExecutionOutcome {
  errorType: string;
  errorMessage: string;
}

export interface QueueReconciliationClaim {
  executionId: string;
  lockToken: string;
  attemptNumber: number;
  maxAttempts: number;
  canRecover: boolean;
}

export interface QueueReconciliationClaimOptions {
  maxAttempts: number;
  lockMilliseconds: number;
  baseBackoffMilliseconds: number;
  maxBackoffMilliseconds: number;
}

export type ReconciliationTerminalResult =
  'recorded' | 'lost-claim' | 'terminal';

export class PostgresExecutionRepository {
  constructor(private readonly pool: Pool) {}

  async claim(
    executionId: string,
    leaseMilliseconds: number,
    deliveryAttempt = 0,
  ): Promise<ClaimExecutionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<ExecutionRow>(
        `SELECT id, organization_id, workflow_id, workflow_version,
                trigger_type, workflow_snapshot, status,
                processing_attempt,
                COALESCE(processing_lease_expires_at > clock_timestamp(), false)
                  AS processing_lease_active,
                CASE
                  WHEN processing_lease_expires_at > clock_timestamp()
                  THEN GREATEST(
                    1,
                    CEIL(EXTRACT(EPOCH FROM (
                      processing_lease_expires_at - clock_timestamp()
                    )) * 1000)::integer
                  )
                  ELSE NULL
                END AS processing_lease_remaining_ms
         FROM workflow_executions
         WHERE id = $1
         FOR UPDATE`,
        [executionId],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return { type: 'missing' };
      }
      if (['completed', 'failed', 'cancelled'].includes(row.status)) {
        await client.query('COMMIT');
        return { type: 'terminal' };
      }
      if (
        row.status === 'running' &&
        row.processing_lease_active &&
        row.processing_lease_remaining_ms &&
        (row.processing_attempt ?? 0) >= deliveryAttempt
      ) {
        await client.query('COMMIT');
        return {
          type: 'in-progress',
          retryAfterMilliseconds: row.processing_lease_remaining_ms,
        };
      }

      const processingToken = randomUUID();
      await client.query(
        `UPDATE workflow_executions
         SET status = 'running',
             started_at = COALESCE(started_at, clock_timestamp()),
             completed_at = NULL,
             error_type = NULL,
             error_message = NULL,
             processing_token = $2,
             processing_lease_expires_at = clock_timestamp() + ($3::double precision * interval '1 millisecond'),
             processing_attempt = $4,
             reconciliation_locked_at = NULL,
             reconciliation_lock_token = NULL
         WHERE id = $1`,
        [executionId, processingToken, leaseMilliseconds, deliveryAttempt],
      );
      const stepResult = await client.query<ExecutionStepRow>(
        `SELECT id, workflow_step_id, step_order, step_type, action_type,
                name, config, retry_config
         FROM execution_steps
         WHERE execution_id = $1
         ORDER BY step_order`,
        [executionId],
      );
      await client.query('COMMIT');
      return {
        type: 'claimed',
        execution: {
          id: row.id,
          organizationId: row.organization_id,
          workflowId: row.workflow_id,
          workflowVersion: row.workflow_version,
          triggerType: row.trigger_type,
          workflowSnapshot: row.workflow_snapshot,
          processingToken,
          steps: stepResult.rows.map(mapStep),
        },
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordFailure(
    executionId: string,
    processingToken: string,
    outcome: ExecutionOutcome,
  ): Promise<'recorded' | 'lost-claim' | 'terminal'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{
        status: string;
        processing_token: string | null;
      }>(
        `SELECT status, processing_token
         FROM workflow_executions
         WHERE id = $1
         FOR UPDATE`,
        [executionId],
      );
      const row = result.rows[0];
      if (!row || ['completed', 'failed', 'cancelled'].includes(row.status)) {
        await client.query('COMMIT');
        return 'terminal';
      }
      if (
        row.status !== 'running' ||
        row.processing_token !== processingToken
      ) {
        await client.query('COMMIT');
        return 'lost-claim';
      }

      await writeFailure(client, executionId, outcome);
      await client.query('COMMIT');
      return 'recorded';
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverExpired(
    outcome: ExecutionOutcome,
    graceMilliseconds = 0,
  ): Promise<string | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ id: string }>(
        `SELECT id
         FROM workflow_executions
         WHERE status = 'running'
           AND (
             processing_lease_expires_at IS NULL
              OR processing_lease_expires_at <=
                 clock_timestamp() - ($1::double precision * interval '1 millisecond')
           )
         ORDER BY processing_lease_expires_at NULLS FIRST, started_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [graceMilliseconds],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return undefined;
      }
      await writeFailure(client, row.id, outcome);
      await client.query('COMMIT');
      return row.id;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimNextQueueReconciliation(
    options: QueueReconciliationClaimOptions,
  ): Promise<QueueReconciliationClaim | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{
        id: string;
        reconciliation_attempt_count: number;
      }>(
        `SELECT execution.id, execution.reconciliation_attempt_count
         FROM workflow_executions AS execution
         INNER JOIN execution_queue_outbox AS outbox
           ON outbox.execution_id = execution.id
         WHERE execution.status = 'queued'
           AND outbox.status = 'published'
           AND execution.reconciliation_available_at <= clock_timestamp()
           AND (
             execution.reconciliation_locked_at IS NULL
             OR execution.reconciliation_locked_at <=
                clock_timestamp() - ($1::double precision * interval '1 millisecond')
           )
         ORDER BY execution.queued_at, execution.id
         FOR UPDATE OF execution SKIP LOCKED
         LIMIT 1`,
        [options.lockMilliseconds],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return undefined;
      }

      const canRecover = row.reconciliation_attempt_count < options.maxAttempts;
      const attemptNumber = canRecover
        ? row.reconciliation_attempt_count + 1
        : row.reconciliation_attempt_count;
      const backoffMilliseconds = Math.min(
        options.maxBackoffMilliseconds,
        options.baseBackoffMilliseconds * 2 ** Math.max(0, attemptNumber - 1),
      );
      const lockToken = randomUUID();
      await client.query(
        `UPDATE workflow_executions
         SET reconciliation_attempt_count = $2,
             reconciliation_available_at =
               clock_timestamp() + ($3::double precision * interval '1 millisecond'),
             reconciliation_locked_at = clock_timestamp(),
             reconciliation_lock_token = $4
         WHERE id = $1`,
        [row.id, attemptNumber, backoffMilliseconds, lockToken],
      );
      await client.query('COMMIT');
      return {
        executionId: row.id,
        lockToken,
        attemptNumber,
        maxAttempts: options.maxAttempts,
        canRecover,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async finishQueueReconciliation(
    claim: QueueReconciliationClaim,
    result: 'scheduled' | 'active',
    activePollMilliseconds: number,
  ): Promise<boolean> {
    const completed = await this.pool.query(
      `UPDATE workflow_executions
       SET reconciliation_attempt_count = CASE
             WHEN $3 = 'active' AND $4::boolean
               AND reconciliation_attempt_count = $5
             THEN GREATEST(reconciliation_attempt_count - 1, 0)
             ELSE reconciliation_attempt_count
           END,
           reconciliation_available_at = CASE
             WHEN $3 = 'active'
             THEN clock_timestamp() + ($6::double precision * interval '1 millisecond')
             ELSE reconciliation_available_at
           END,
           reconciliation_locked_at = NULL,
           reconciliation_lock_token = NULL,
           reconciliation_last_error = NULL
       WHERE id = $1
         AND reconciliation_lock_token = $2`,
      [
        claim.executionId,
        claim.lockToken,
        result,
        claim.canRecover,
        claim.attemptNumber,
        activePollMilliseconds,
      ],
    );
    return completed.rowCount === 1;
  }

  async failQueueReconciliation(
    claim: QueueReconciliationClaim,
    redactedError: string,
    exhaustedOutcome: ExecutionOutcome,
  ): Promise<'retry-pending' | ReconciliationTerminalResult> {
    if (claim.attemptNumber >= claim.maxAttempts)
      return this.recordReconciliationTerminal(claim, exhaustedOutcome);

    const result = await this.pool.query(
      `UPDATE workflow_executions
       SET reconciliation_locked_at = NULL,
           reconciliation_lock_token = NULL,
           reconciliation_last_error = $3
       WHERE id = $1
         AND status = 'queued'
         AND reconciliation_lock_token = $2`,
      [claim.executionId, claim.lockToken, redactedError],
    );
    return result.rowCount === 1 ? 'retry-pending' : 'lost-claim';
  }

  async recordReconciliationTerminal(
    claim: QueueReconciliationClaim,
    outcome: ExecutionOutcome,
  ): Promise<ReconciliationTerminalResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{
        status: string;
        reconciliation_lock_token: string | null;
        outbox_status: string | null;
      }>(
        `SELECT execution.status, execution.reconciliation_lock_token,
                outbox.status AS outbox_status
         FROM workflow_executions AS execution
         LEFT JOIN execution_queue_outbox AS outbox
           ON outbox.execution_id = execution.id
         WHERE execution.id = $1
         FOR UPDATE OF execution`,
        [claim.executionId],
      );
      const row = result.rows[0];
      if (!row || ['completed', 'failed', 'cancelled'].includes(row.status)) {
        await client.query('COMMIT');
        return 'terminal';
      }
      if (
        row.status !== 'queued' ||
        row.outbox_status !== 'published' ||
        row.reconciliation_lock_token !== claim.lockToken
      ) {
        await client.query('COMMIT');
        return 'lost-claim';
      }

      await writeFailure(client, claim.executionId, outcome);
      await client.query(
        `UPDATE workflow_executions
         SET reconciliation_last_error = $2
         WHERE id = $1`,
        [claim.executionId, outcome.errorMessage],
      );
      await client.query('COMMIT');
      return 'recorded';
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordInvalidQueueDelivery(
    executionId: string,
    outcome: ExecutionOutcome,
  ): Promise<ReconciliationTerminalResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{
        status: string;
        outbox_status: string | null;
      }>(
        `SELECT execution.status, outbox.status AS outbox_status
         FROM workflow_executions AS execution
         LEFT JOIN execution_queue_outbox AS outbox
           ON outbox.execution_id = execution.id
         WHERE execution.id = $1
         FOR UPDATE OF execution`,
        [executionId],
      );
      const row = result.rows[0];
      if (!row || ['completed', 'failed', 'cancelled'].includes(row.status)) {
        await client.query('COMMIT');
        return 'terminal';
      }
      if (row.status !== 'queued' || row.outbox_status !== 'published') {
        await client.query('COMMIT');
        return 'lost-claim';
      }

      await writeFailure(client, executionId, outcome);
      await client.query(
        `UPDATE workflow_executions
         SET reconciliation_last_error = $2
         WHERE id = $1`,
        [executionId, outcome.errorMessage],
      );
      await client.query('COMMIT');
      return 'recorded';
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapStep(row: ExecutionStepRow): ClaimedExecutionStep {
  return {
    id: row.id,
    workflowStepId: row.workflow_step_id,
    stepOrder: row.step_order,
    stepType: row.step_type,
    actionType: row.action_type,
    name: row.name,
    config: row.config,
    retryConfig: row.retry_config,
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the operation error; releasing the broken client lets pg discard it.
  }
}

async function writeFailure(
  client: PoolClient,
  executionId: string,
  outcome: ExecutionOutcome,
): Promise<void> {
  await client.query(
    `UPDATE execution_steps
     SET status = 'skipped',
         completed_at = clock_timestamp(),
         error_type = $2,
         error_message = $3,
         updated_at = clock_timestamp()
     WHERE execution_id = $1`,
    [executionId, outcome.errorType, outcome.errorMessage],
  );
  await client.query(
    `UPDATE workflow_executions
     SET status = 'failed',
         completed_at = clock_timestamp(),
         error_type = $2,
          error_message = $3,
          processing_token = NULL,
          processing_lease_expires_at = NULL,
          processing_attempt = NULL,
          reconciliation_locked_at = NULL,
          reconciliation_lock_token = NULL
     WHERE id = $1`,
    [executionId, outcome.errorType, outcome.errorMessage],
  );
}
