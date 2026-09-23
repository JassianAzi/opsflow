import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export interface ClaimedOutboxRow {
  id: string;
  executionId: string;
  jobPayload: unknown;
  attemptCount: number;
  lockToken: string;
}

interface OutboxRow {
  id: string;
  execution_id: string;
  job_payload: unknown;
  attempt_count: number;
  lock_token: string;
}

export interface OutboxRepository {
  claimNext(
    leaseMilliseconds: number,
    maxAttempts: number,
  ): Promise<ClaimedOutboxRow | null>;
  markPublished(id: string, lockToken: string): Promise<boolean>;
  markFailed(
    id: string,
    lockToken: string,
    error: string,
    nextAvailableAt: Date,
    terminal: boolean,
  ): Promise<boolean>;
}

export class PostgresOutboxRepository implements OutboxRepository {
  constructor(private readonly pool: Pool) {}

  async claimNext(
    leaseMilliseconds: number,
    maxAttempts: number,
  ): Promise<ClaimedOutboxRow | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.failExhausted(client, leaseMilliseconds, maxAttempts);

      const lockToken = randomUUID();
      const result = await client.query<OutboxRow>(
        `WITH candidate AS (
           SELECT id
           FROM execution_queue_outbox
           WHERE status = 'pending'
             AND available_at <= clock_timestamp()
             AND attempt_count < $1
             AND (
               locked_at IS NULL
               OR locked_at < clock_timestamp() - ($2::double precision * interval '1 millisecond')
             )
           ORDER BY available_at, created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE execution_queue_outbox AS outbox
         SET locked_at = clock_timestamp(),
             lock_token = $3,
             attempt_count = outbox.attempt_count + 1,
             updated_at = clock_timestamp()
         FROM candidate
         WHERE outbox.id = candidate.id
         RETURNING outbox.id,
                   outbox.execution_id,
                   outbox.job_payload,
                   outbox.attempt_count,
                   outbox.lock_token`,
        [maxAttempts, leaseMilliseconds, lockToken],
      );
      await client.query('COMMIT');

      const row = result.rows[0];
      return row
        ? {
            id: row.id,
            executionId: row.execution_id,
            jobPayload: row.job_payload,
            attemptCount: row.attempt_count,
            lockToken: row.lock_token,
          }
        : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markPublished(id: string, lockToken: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE execution_queue_outbox
       SET status = 'published',
           published_at = clock_timestamp(),
           locked_at = NULL,
           lock_token = NULL,
           last_error = NULL,
           updated_at = clock_timestamp()
       WHERE id = $1 AND lock_token = $2 AND status = 'pending'`,
      [id, lockToken],
    );
    return result.rowCount === 1;
  }

  async markFailed(
    id: string,
    lockToken: string,
    error: string,
    nextAvailableAt: Date,
    terminal: boolean,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE execution_queue_outbox
       SET status = CASE WHEN $3 THEN 'failed'::queue_outbox_status ELSE 'pending'::queue_outbox_status END,
           available_at = $4,
           locked_at = NULL,
           lock_token = NULL,
           last_error = $5,
           updated_at = clock_timestamp()
       WHERE id = $1 AND lock_token = $2 AND status = 'pending'`,
      [id, lockToken, terminal, nextAvailableAt, error],
    );
    return result.rowCount === 1;
  }

  private async failExhausted(
    client: PoolClient,
    leaseMilliseconds: number,
    maxAttempts: number,
  ): Promise<void> {
    await client.query(
      `UPDATE execution_queue_outbox
       SET status = 'failed',
           locked_at = NULL,
           lock_token = NULL,
           last_error = COALESCE(last_error, 'Dispatch lease expired after the maximum number of attempts.'),
           updated_at = clock_timestamp()
       WHERE status = 'pending'
         AND attempt_count >= $1
         AND (
           locked_at IS NULL
           OR locked_at < clock_timestamp() - ($2::double precision * interval '1 millisecond')
         )`,
      [maxAttempts, leaseMilliseconds],
    );
  }
}
