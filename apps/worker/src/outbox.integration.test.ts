import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EXECUTION_QUEUE_NAME } from '@opsflow/shared';
import { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from './outbox/dispatcher.js';
import { BullQueuePublisher } from './outbox/publisher.js';
import { PostgresOutboxRepository } from './outbox/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const integrationDescribe = databaseUrl && redisUrl ? describe : describe.skip;
const silentLogger = { info: () => undefined, error: () => undefined };

integrationDescribe('outbox dispatcher integration', () => {
  let pool: Pool;
  let cleanupConnection: Redis;
  let cleanupQueue: Queue;
  const queueName = `${EXECUTION_QUEUE_NAME}-${randomUUID()}`;

  beforeAll(async () => {
    if (!databaseUrl || new URL(databaseUrl).pathname !== '/opsflow_test')
      throw new Error(
        'Outbox tests require a dedicated opsflow_test database.',
      );
    if (!redisUrl) throw new Error('Outbox tests require TEST_REDIS_URL.');

    pool = new Pool({ connectionString: databaseUrl });
    await migrate(drizzle({ client: pool }), {
      migrationsFolder: fileURLToPath(
        new URL('../../api/drizzle', import.meta.url),
      ),
    });
    cleanupConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    cleanupQueue = new Queue(queueName, { connection: cleanupConnection });
  });

  afterAll(async () => {
    if (cleanupQueue) {
      await cleanupQueue.obliterate({ force: true });
      await cleanupQueue.close();
    }
    if (cleanupConnection) cleanupConnection.disconnect();
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    await cleanupQueue.obliterate({ force: true });
    await pool.query(
      'TRUNCATE TABLE execution_queue_outbox, execution_steps, workflow_executions, workflow_steps, workflows, organization_members, organizations, sessions, users CASCADE',
    );
  });

  it('publishes one deterministic job before marking the outbox row published', async () => {
    const fixture = await createPendingExecution(pool);
    const publisher = createPublisher(redisUrl!, queueName);
    const dispatcher = createDispatcher(pool, publisher);

    await expect(dispatcher.dispatchOnce()).resolves.toBe('published');

    const stored = await getOutbox(pool, fixture.outboxId);
    expect(stored).toMatchObject({ status: 'published', attempt_count: 1 });
    expect(stored.published_at).toBeInstanceOf(Date);
    expect(stored.lock_token).toBeNull();
    const job = await cleanupQueue.getJob(fixture.executionId);
    expect(job?.name).toBe('execute-workflow');
    expect(job?.data).toEqual({ executionId: fixture.executionId });
    await publisher.close();
  });

  it('reclaims a crashed claim and duplicate submission keeps one BullMQ job', async () => {
    const fixture = await createPendingExecution(pool);
    const repository = new PostgresOutboxRepository(pool);
    const firstPublisher = createPublisher(redisUrl!, queueName);
    const claim = await repository.claimNext(1, 5);
    expect(claim?.executionId).toBe(fixture.executionId);
    await firstPublisher.publish({ executionId: fixture.executionId });
    await pool.query(
      `UPDATE execution_queue_outbox SET locked_at = clock_timestamp() - interval '1 minute' WHERE id = $1`,
      [fixture.outboxId],
    );

    const secondPublisher = createPublisher(redisUrl!, queueName);
    const dispatcher = createDispatcher(pool, secondPublisher, {
      leaseMilliseconds: 1,
    });
    await expect(dispatcher.dispatchOnce()).resolves.toBe('published');

    expect(await cleanupQueue.getJobCounts('waiting')).toEqual({ waiting: 1 });
    expect(await getOutbox(pool, fixture.outboxId)).toMatchObject({
      status: 'published',
      attempt_count: 2,
    });
    await firstPublisher.close();
    await secondPublisher.close();
  });

  it('lets concurrent dispatchers claim different rows exactly once', async () => {
    const fixtures = await Promise.all([
      createPendingExecution(pool),
      createPendingExecution(pool),
      createPendingExecution(pool),
      createPendingExecution(pool),
    ]);
    const firstPublisher = createPublisher(redisUrl!, queueName);
    const secondPublisher = createPublisher(redisUrl!, queueName);
    const first = createDispatcher(pool, firstPublisher);
    const second = createDispatcher(pool, secondPublisher);

    await Promise.all([
      first.dispatchOnce(),
      second.dispatchOnce(),
      first.dispatchOnce(),
      second.dispatchOnce(),
    ]);

    const rows = await pool.query(
      `SELECT status, attempt_count FROM execution_queue_outbox ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(4);
    expect(rows.rows).toEqual(
      expect.arrayContaining(
        fixtures.map(() => ({ status: 'published', attempt_count: 1 })),
      ),
    );
    expect(await cleanupQueue.getJobCounts('waiting')).toEqual({ waiting: 4 });
    await firstPublisher.close();
    await secondPublisher.close();
  });

  it('keeps work pending during a Redis outage and publishes it after recovery', async () => {
    const fixture = await createPendingExecution(pool);
    const unavailablePublisher = createPublisher(
      'redis://127.0.0.1:1',
      queueName,
      300,
    );
    const unavailableDispatcher = createDispatcher(pool, unavailablePublisher, {
      baseBackoffMilliseconds: 1,
    });

    await expect(unavailableDispatcher.dispatchOnce()).resolves.toBe('retry');
    const pending = await getOutbox(pool, fixture.outboxId);
    expect(pending).toMatchObject({ status: 'pending', attempt_count: 1 });
    expect(pending.last_error).toBeTruthy();
    expect(pending.last_error).not.toContain('redis://');
    await pool.query(
      'UPDATE execution_queue_outbox SET available_at = clock_timestamp() WHERE id = $1',
      [fixture.outboxId],
    );
    await unavailablePublisher.close();

    const recoveredPublisher = createPublisher(redisUrl!, queueName);
    const recoveredDispatcher = createDispatcher(pool, recoveredPublisher);
    await expect(recoveredDispatcher.dispatchOnce()).resolves.toBe('published');
    expect(await getOutbox(pool, fixture.outboxId)).toMatchObject({
      status: 'published',
      attempt_count: 2,
      last_error: null,
    });
    expect(await cleanupQueue.getJob(fixture.executionId)).toBeTruthy();
    await recoveredPublisher.close();
  });

  it('marks an outbox row failed after the bounded attempt count', async () => {
    const fixture = await createPendingExecution(pool);
    const unavailablePublisher = createPublisher(
      'redis://127.0.0.1:1',
      queueName,
      300,
    );
    const dispatcher = createDispatcher(pool, unavailablePublisher, {
      maxAttempts: 2,
      baseBackoffMilliseconds: 1,
    });

    await expect(dispatcher.dispatchOnce()).resolves.toBe('retry');
    await pool.query(
      'UPDATE execution_queue_outbox SET available_at = clock_timestamp() WHERE id = $1',
      [fixture.outboxId],
    );
    await expect(dispatcher.dispatchOnce()).resolves.toBe('failed');
    expect(await getOutbox(pool, fixture.outboxId)).toMatchObject({
      status: 'failed',
      attempt_count: 2,
    });
    await unavailablePublisher.close();
  });

  it('starts and stops the dispatcher loop cleanly', async () => {
    const fixture = await createPendingExecution(pool);
    const publisher = createPublisher(redisUrl!, queueName);
    const dispatcher = new OutboxDispatcher(
      new PostgresOutboxRepository(pool),
      publisher,
      { logger: silentLogger, pollMilliseconds: 10 },
    );

    dispatcher.start();
    await waitFor(async () => {
      const row = await getOutbox(pool, fixture.outboxId);
      return row.status === 'published';
    });
    await expect(dispatcher.stop()).resolves.toBeUndefined();
    await publisher.close();
  });
});

function createPublisher(
  url: string,
  queueName: string,
  publishTimeoutMilliseconds = 2_000,
): BullQueuePublisher {
  return new BullQueuePublisher({
    redisUrl: url,
    queueName,
    publishTimeoutMilliseconds,
  });
}

function createDispatcher(
  pool: Pool,
  publisher: BullQueuePublisher,
  options: {
    leaseMilliseconds?: number;
    maxAttempts?: number;
    baseBackoffMilliseconds?: number;
  } = {},
): OutboxDispatcher {
  return new OutboxDispatcher(new PostgresOutboxRepository(pool), publisher, {
    logger: silentLogger,
    ...options,
  });
}

async function createPendingExecution(pool: Pool): Promise<{
  executionId: string;
  outboxId: string;
}> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  const workflowId = randomUUID();
  const executionId = randomUUID();
  const outboxId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, display_name)
     VALUES ($1, $2, 'test', 'Dispatcher Test')`,
    [userId, `${userId}@example.com`],
  );
  await pool.query(
    `INSERT INTO organizations (id, name, slug, created_by)
     VALUES ($1, 'Dispatcher Test', $2, $3)`,
    [organizationId, `dispatcher-${organizationId}`, userId],
  );
  await pool.query(
    `INSERT INTO workflows
       (id, organization_id, name, status, trigger_type, created_by)
     VALUES ($1, $2, 'Dispatcher Test', 'active', 'manual', $3)`,
    [workflowId, organizationId, userId],
  );
  await pool.query(
    `INSERT INTO workflow_executions
       (id, organization_id, workflow_id, workflow_version, trigger_type, workflow_snapshot)
     VALUES ($1, $2, $3, 1, 'manual', $4)`,
    [executionId, organizationId, workflowId, { fixture: true }],
  );
  await pool.query(
    `INSERT INTO execution_queue_outbox (id, execution_id, job_payload)
     VALUES ($1, $2, $3)`,
    [outboxId, executionId, { executionId }],
  );
  return { executionId, outboxId };
}

async function getOutbox(
  pool: Pool,
  id: string,
): Promise<Record<string, unknown>> {
  const result = await pool.query(
    `SELECT status, attempt_count, available_at, locked_at, lock_token,
            published_at, last_error
     FROM execution_queue_outbox WHERE id = $1`,
    [id],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error('Expected outbox row.');
  return row;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for dispatcher state.');
}
