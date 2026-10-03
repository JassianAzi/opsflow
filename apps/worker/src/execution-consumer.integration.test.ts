import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  EXECUTION_ENGINE_NOT_IMPLEMENTED,
  EXECUTION_JOB_NAME,
  EXECUTION_PROCESSING_LEASE_EXPIRED,
  EXECUTION_PROCESSING_ERROR,
  EXECUTION_QUEUE_PAYLOAD_INVALID,
  EXECUTION_QUEUE_NAME,
  EXECUTION_QUEUE_RECOVERY_EXHAUSTED,
  EXECUTION_SNAPSHOT_INVALID,
  type WorkflowExecutionSnapshot,
} from '@opsflow/shared';
import { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { buildApp } from '../../api/src/app.js';
import { createDatabase } from '../../api/src/db/client.js';
import { BullExecutionConsumer } from './execution/consumer.js';
import { ExecutionProcessor } from './execution/processor.js';
import { ExecutionQueueReconciler } from './execution/reconciler.js';
import { ExecutionRecoveryMonitor } from './execution/recovery.js';
import {
  type ExecutionOutcome,
  PostgresExecutionRepository,
} from './execution/repository.js';
import { OutboxDispatcher } from './outbox/dispatcher.js';
import { BullQueuePublisher } from './outbox/publisher.js';
import { validateExecutionJobIdentity } from './outbox/publisher.js';
import { PostgresOutboxRepository } from './outbox/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const integrationDescribe = databaseUrl && redisUrl ? describe : describe.skip;
const silentLogger = { info: () => undefined, error: () => undefined };
const engineDeferredOutcome: ExecutionOutcome = {
  errorType: EXECUTION_ENGINE_NOT_IMPLEMENTED,
  errorMessage: 'Skipped because the Phase 3 engine is deferred.',
};

integrationDescribe('execution consumer integration', () => {
  let pool: Pool;
  let queueConnection: Redis;
  let queue: Queue;
  const consumers = new Set<BullExecutionConsumer>();
  const recoveryMonitors = new Set<ExecutionRecoveryMonitor>();
  const queueName = `${EXECUTION_QUEUE_NAME}-consumer-${randomUUID()}`;

  beforeAll(async () => {
    if (!databaseUrl || new URL(databaseUrl).pathname !== '/opsflow_test')
      throw new Error(
        'Consumer tests require a dedicated opsflow_test database.',
      );
    if (!redisUrl) throw new Error('Consumer tests require TEST_REDIS_URL.');

    pool = new Pool({ connectionString: databaseUrl });
    await migrate(drizzle({ client: pool }), {
      migrationsFolder: fileURLToPath(
        new URL('../../api/drizzle', import.meta.url),
      ),
    });
    queueConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue(queueName, { connection: queueConnection });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    queueConnection.disconnect();
    await pool.end();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await pool.query(
      'TRUNCATE TABLE execution_queue_outbox, execution_steps, workflow_executions, workflow_steps, workflows, organization_members, organizations, sessions, users CASCADE',
    );
  });

  afterEach(async () => {
    await Promise.all(
      [...recoveryMonitors].map(async (monitor) => monitor.stop()),
    );
    recoveryMonitors.clear();
    await Promise.all(
      [...consumers].map(async (consumer) => consumer.close(true)),
    );
    consumers.clear();
  });

  it('completes transport only after recording the deferred engine outcome', async () => {
    const fixture = await createExecution(pool);
    startConsumer();
    const job = await addExecutionJob(fixture.executionId);

    await waitForExecutionStatus(fixture.executionId, 'failed');

    const execution = await getExecution(fixture.executionId);
    expect(execution).toMatchObject({
      status: 'failed',
      error_type: EXECUTION_ENGINE_NOT_IMPLEMENTED,
      processing_token: null,
      processing_lease_expires_at: null,
    });
    expect(execution.started_at).toBeInstanceOf(Date);
    expect(execution.completed_at).toBeInstanceOf(Date);
    const steps = await getExecutionSteps(fixture.executionId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      status: 'skipped',
      error_type: EXECUTION_ENGINE_NOT_IMPLEMENTED,
    });
    expect(String(steps[0]?.error_message)).toContain('not implemented');
    await waitFor(async () => (await job.getState()) === 'completed');
  });

  it('runs a manual API test through outbox dispatch to the Phase 3 terminal result', async () => {
    const database = createDatabase(databaseUrl!);
    const app = buildApp({
      database: database.db,
      production: false,
      webOrigin: 'http://127.0.0.1:5173',
      logger: false,
    });
    const publisher = new BullQueuePublisher({
      redisUrl: redisUrl!,
      queueName,
    });
    try {
      await app.ready();
      await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'pipeline@example.com',
          password: 'correct horse battery staple',
          displayName: 'Pipeline Test',
        },
      });
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'pipeline@example.com',
          password: 'correct horse battery staple',
        },
      });
      const setCookie = login.headers['set-cookie'];
      const cookie = (
        Array.isArray(setCookie) ? setCookie[0] : setCookie
      )?.split(';')[0];
      expect(cookie).toBeTruthy();
      const organization = await app.inject({
        method: 'POST',
        url: '/api/organizations',
        headers: { cookie },
        payload: { name: 'Pipeline Organization' },
      });
      const organizationId = organization.json().organization.id as string;
      const created = await app.inject({
        method: 'POST',
        url: `/api/organizations/${organizationId}/workflows`,
        headers: { cookie },
        payload: {
          name: 'Pipeline Workflow',
          description: '',
          triggerType: 'manual',
          triggerConfig: {},
        },
      });
      const workflowId = created.json().workflow.id as string;
      const saved = await app.inject({
        method: 'PATCH',
        url: `/api/organizations/${organizationId}/workflows/${workflowId}`,
        headers: { cookie },
        payload: {
          expectedVersion: 1,
          steps: [
            {
              stepType: 'action',
              actionType: 'log',
              name: 'Record pipeline event',
              config: { message: 'Pipeline reached worker' },
              retryConfig: {},
            },
          ],
        },
      });
      expect(saved.statusCode).toBe(200);
      const activated = await app.inject({
        method: 'POST',
        url: `/api/organizations/${organizationId}/workflows/${workflowId}/activate`,
        headers: { cookie },
      });
      expect(activated.statusCode).toBe(200);
      const testExecution = await app.inject({
        method: 'POST',
        url: `/api/organizations/${organizationId}/workflows/${workflowId}/test`,
        headers: { cookie },
      });
      expect(testExecution.statusCode).toBe(202);
      const executionId = testExecution.json().executionId as string;

      startConsumer();
      const dispatcher = new OutboxDispatcher(
        new PostgresOutboxRepository(pool),
        publisher,
        { logger: silentLogger },
      );
      await expect(dispatcher.dispatchOnce()).resolves.toBe('published');
      await waitForExecutionStatus(executionId, 'failed');
      expect(await getExecution(executionId)).toMatchObject({
        status: 'failed',
        error_type: EXECUTION_ENGINE_NOT_IMPLEMENTED,
      });
      expect(await getExecutionSteps(executionId)).toEqual([
        expect.objectContaining({
          status: 'skipped',
          error_type: EXECUTION_ENGINE_NOT_IMPLEMENTED,
        }),
      ]);
      await waitFor(async () => {
        const job = await queue.getJob(executionId);
        return job ? (await job.getState()) === 'completed' : false;
      });
    } finally {
      await publisher.close();
      await app.close();
      await database.pool.end();
    }
  });

  it('treats a duplicate delivery of a terminal execution as a no-op', async () => {
    const fixture = await createExecution(pool);
    startConsumer();
    const firstJob = await addExecutionJob(fixture.executionId);
    await waitFor(async () => (await firstJob.getState()) === 'completed');
    const first = await getExecution(fixture.executionId);

    await firstJob.remove();
    const duplicate = await addExecutionJob(fixture.executionId);
    await waitFor(async () => (await duplicate.getState()) === 'completed');
    const replayed = await getExecution(fixture.executionId);

    expect(replayed.status).toBe('failed');
    expect(replayed.error_type).toBe(EXECUTION_ENGINE_NOT_IMPLEMENTED);
    expect(replayed.completed_at).toEqual(first.completed_at);
    expect(await getExecutionSteps(fixture.executionId)).toHaveLength(1);
  });

  it('uses the immutable snapshot and copied step after the workflow is edited', async () => {
    const fixture = await createExecution(pool, { stepName: 'Original log' });
    await pool.query(
      `UPDATE workflows SET name = 'Edited workflow', version = version + 1 WHERE id = $1`,
      [fixture.workflowId],
    );
    await pool.query(
      `UPDATE workflow_steps
       SET name = 'Edited log', config = '{"message":"edited"}'::jsonb
       WHERE id = $1`,
      [fixture.workflowStepId],
    );
    startConsumer();
    await addExecutionJob(fixture.executionId);

    await waitForExecutionStatus(fixture.executionId, 'failed');

    const execution = await getExecution(fixture.executionId);
    const snapshot = execution.workflow_snapshot as WorkflowExecutionSnapshot;
    expect(snapshot.name).toBe('Snapshot workflow');
    expect(snapshot.steps[0]?.name).toBe('Original log');
    const [copiedStep] = await getExecutionSteps(fixture.executionId);
    expect(copiedStep).toMatchObject({
      name: 'Original log',
      config: { message: 'original' },
      status: 'skipped',
    });
  });

  it('recovers a stalled BullMQ job after termination following the database claim', async () => {
    const fixture = await createExecution(pool);
    const neverCompletes = new Promise<void>(() => undefined);
    const firstConsumer = startConsumer({
      leaseMilliseconds: 150,
      lockDuration: 400,
      stalledInterval: 100,
      afterClaim: async () => neverCompletes,
    });
    const job = await addExecutionJob(fixture.executionId);
    await waitForExecutionStatus(fixture.executionId, 'running');

    await firstConsumer.close(true);
    consumers.delete(firstConsumer);
    startConsumer({
      leaseMilliseconds: 150,
      lockDuration: 400,
      stalledInterval: 100,
    });
    startRecoveryMonitor(20, 0);

    await waitForExecutionStatus(fixture.executionId, 'failed', 8_000);
    expect((await getExecution(fixture.executionId)).error_type).toBe(
      EXECUTION_PROCESSING_LEASE_EXPIRED,
    );
    await waitFor(async () => (await job.getState()) === 'completed', 8_000);
  });

  it('validates tenant identity from the snapshot and scopes writes to one execution', async () => {
    const target = await createExecution(pool);
    const other = await createExecution(pool);
    const targetExecution = await getExecution(target.executionId);
    const mismatchedSnapshot = {
      ...(targetExecution.workflow_snapshot as WorkflowExecutionSnapshot),
      organizationId: other.organizationId,
    };
    await pool.query(
      'UPDATE workflow_executions SET workflow_snapshot = $2 WHERE id = $1',
      [target.executionId, mismatchedSnapshot],
    );
    startConsumer();
    await addExecutionJob(target.executionId);

    await waitForExecutionStatus(target.executionId, 'failed');

    expect((await getExecution(target.executionId)).error_type).toBe(
      EXECUTION_SNAPSHOT_INVALID,
    );
    expect(await getExecution(other.executionId)).toMatchObject({
      organization_id: other.organizationId,
      status: 'queued',
    });
    expect(await getExecutionSteps(other.executionId)).toEqual([
      expect.objectContaining({ status: 'pending' }),
    ]);
  });

  it('records an unexpected processor error without leaking sensitive details', async () => {
    const fixture = await createExecution(pool);
    startConsumer({
      afterClaim: async () => {
        throw new Error(
          'synthetic failure redis://user:password@example.test password=secret',
        );
      },
    });
    const job = await addExecutionJob(fixture.executionId);

    await waitForExecutionStatus(fixture.executionId, 'failed');

    const execution = await getExecution(fixture.executionId);
    expect(execution.error_type).toBe(EXECUTION_PROCESSING_ERROR);
    expect(execution.error_message).not.toContain('redis://');
    expect(execution.error_message).not.toContain('password=secret');
    expect(await getExecutionSteps(fixture.executionId)).toEqual([
      expect.objectContaining({
        status: 'skipped',
        error_type: EXECUTION_PROCESSING_ERROR,
      }),
    ]);
    await waitFor(async () => (await job.getState()) === 'completed');
  });

  it('reconciles an exhausted job after database connectivity returns', async () => {
    const fixture = await createExecution(pool, { publishedOutbox: true });
    const unavailablePool = new Pool({
      connectionString:
        'postgresql://opsflow_test:test_only@127.0.0.1:1/opsflow_test',
      connectionTimeoutMillis: 50,
    });
    const unavailableConsumer = startConsumer({
      repository: new PostgresExecutionRepository(unavailablePool),
    });
    const job = await queue.add(
      EXECUTION_JOB_NAME,
      { executionId: fixture.executionId },
      {
        jobId: fixture.executionId,
        attempts: 2,
        backoff: { type: 'exponential', delay: 20 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    await waitFor(async () => (await job.getState()) === 'failed');
    expect(await getExecution(fixture.executionId)).toMatchObject({
      status: 'queued',
      error_type: null,
    });
    await unavailableConsumer.close(true);
    consumers.delete(unavailableConsumer);
    await unavailablePool.end();

    startConsumer();
    const firstPublisher = new BullQueuePublisher({
      redisUrl: redisUrl!,
      queueName,
    });
    const secondPublisher = new BullQueuePublisher({
      redisUrl: redisUrl!,
      queueName,
    });
    try {
      const first = new ExecutionQueueReconciler(
        new PostgresExecutionRepository(pool),
        firstPublisher,
        { logger: silentLogger },
      );
      const second = new ExecutionQueueReconciler(
        new PostgresExecutionRepository(pool),
        secondPublisher,
        { logger: silentLogger },
      );
      const recovered = await Promise.all([
        first.reconcileOnce(),
        second.reconcileOnce(),
      ]);
      expect(recovered.reduce((sum, count) => sum + count, 0)).toBe(1);
      await waitForExecutionStatus(fixture.executionId, 'failed');
      expect(await getExecution(fixture.executionId)).toMatchObject({
        status: 'failed',
        error_type: EXECUTION_ENGINE_NOT_IMPLEMENTED,
      });
      await waitFor(async () => (await job.getState()) === 'completed');
    } finally {
      await firstPublisher.close();
      await secondPublisher.close();
    }
  });

  it('durably fails invalid retained job names, payloads, and identifiers', async () => {
    const invalidName = await createExecution(pool, { publishedOutbox: true });
    const invalidPayload = await createExecution(pool, {
      publishedOutbox: true,
    });
    await queue.add(
      'wrong-execution-name',
      { executionId: invalidName.executionId },
      { jobId: invalidName.executionId, removeOnFail: false },
    );
    await queue.add(
      EXECUTION_JOB_NAME,
      { executionId: invalidPayload.executionId, unexpected: true },
      { jobId: invalidPayload.executionId, removeOnFail: false },
    );

    const publisher = new BullQueuePublisher({
      redisUrl: redisUrl!,
      queueName,
    });
    try {
      const reconciler = new ExecutionQueueReconciler(
        new PostgresExecutionRepository(pool),
        publisher,
        { logger: silentLogger },
      );
      await expect(reconciler.reconcileOnce()).resolves.toBe(0);
    } finally {
      await publisher.close();
    }

    for (const executionId of [
      invalidName.executionId,
      invalidPayload.executionId,
    ]) {
      expect(await getExecution(executionId)).toMatchObject({
        status: 'failed',
        error_type: EXECUTION_QUEUE_PAYLOAD_INVALID,
      });
      expect(await getExecutionSteps(executionId)).toEqual([
        expect.objectContaining({
          status: 'skipped',
          error_type: EXECUTION_QUEUE_PAYLOAD_INVALID,
        }),
      ]);
    }

    const invalidJobId = await createExecution(pool, {
      publishedOutbox: true,
    });
    expect(
      validateExecutionJobIdentity(
        {
          id: randomUUID(),
          name: EXECUTION_JOB_NAME,
          data: { executionId: invalidJobId.executionId },
        },
        invalidJobId.executionId,
      ),
    ).toBe('job-id');
    const invalidIdReconciler = new ExecutionQueueReconciler(
      new PostgresExecutionRepository(pool),
      {
        reconcile: async () => ({ type: 'invalid', reason: 'job-id' }),
      },
      { logger: silentLogger },
    );
    await invalidIdReconciler.reconcileOnce();
    expect(await getExecution(invalidJobId.executionId)).toMatchObject({
      status: 'failed',
      error_type: EXECUTION_QUEUE_PAYLOAD_INVALID,
    });

    const remaining = await pool.query<{ count: string }>(
      `SELECT count(*)
       FROM workflow_executions AS execution
       INNER JOIN execution_queue_outbox AS outbox
         ON outbox.execution_id = execution.id
       WHERE execution.status = 'queued' AND outbox.status = 'published'`,
    );
    expect(Number(remaining.rows[0]?.count)).toBe(0);
  });

  it('durably resolves a delivered job whose ID does not match its execution', async () => {
    const fixture = await createExecution(pool, { publishedOutbox: true });
    startConsumer();
    const job = await queue.add(
      EXECUTION_JOB_NAME,
      { executionId: fixture.executionId },
      {
        jobId: randomUUID(),
        attempts: 5,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    await waitForExecutionStatus(fixture.executionId, 'failed');
    expect(await getExecution(fixture.executionId)).toMatchObject({
      status: 'failed',
      error_type: EXECUTION_QUEUE_PAYLOAD_INVALID,
    });
    expect(await getExecutionSteps(fixture.executionId)).toEqual([
      expect.objectContaining({
        status: 'skipped',
        error_type: EXECUTION_QUEUE_PAYLOAD_INVALID,
      }),
    ]);
    await waitFor(async () => (await job.getState()) === 'failed');
    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(1);
  });

  it('does not let more than one reconciliation batch of invalid jobs starve newer work', async () => {
    const valid = await createExecution(pool, { publishedOutbox: true });
    const invalidIds = await createPublishedExecutionBatch(pool, valid, 101);
    await pool.query(
      `UPDATE workflow_executions
       SET queued_at = CASE
         WHEN id = $1 THEN clock_timestamp() + interval '1 day'
         ELSE clock_timestamp() - interval '1 day'
       END
       WHERE id = ANY($2::uuid[]) OR id = $1`,
      [valid.executionId, invalidIds],
    );

    const seen: string[] = [];
    const reconciler = new ExecutionQueueReconciler(
      new PostgresExecutionRepository(pool),
      {
        reconcile: async ({ executionId }) => {
          seen.push(executionId);
          return executionId === valid.executionId
            ? { type: 'created' }
            : { type: 'invalid', reason: 'payload' };
        },
      },
      { batchSize: 100, logger: silentLogger },
    );

    await expect(reconciler.reconcileOnce()).resolves.toBe(0);
    expect(seen).not.toContain(valid.executionId);
    await expect(reconciler.reconcileOnce()).resolves.toBe(1);
    expect(seen).toContain(valid.executionId);
    expect(await getExecution(valid.executionId)).toMatchObject({
      status: 'queued',
      reconciliation_attempt_count: 1,
    });
    const failed = await pool.query<{ count: string }>(
      `SELECT count(*) FROM workflow_executions
       WHERE id = ANY($1::uuid[])
         AND status = 'failed'
         AND error_type = $2`,
      [invalidIds, EXECUTION_QUEUE_PAYLOAD_INVALID],
    );
    expect(Number(failed.rows[0]?.count)).toBe(101);
  }, 15_000);

  it('bounds reconciliation failures durably across restarts and concurrent workers', async () => {
    const fixture = await createExecution(pool, { publishedOutbox: true });
    let calls = 0;
    const unavailableQueue = {
      reconcile: async () => {
        calls += 1;
        throw new Error('redis://user:password@example.test unavailable');
      },
    };
    const options = {
      maxAttempts: 3,
      baseBackoffMilliseconds: 100,
      maxBackoffMilliseconds: 150,
      claimLockMilliseconds: 1_000,
      logger: silentLogger,
    };
    const createReconciler = () =>
      new ExecutionQueueReconciler(
        new PostgresExecutionRepository(pool),
        unavailableQueue,
        options,
      );

    await createReconciler().reconcileOnce();
    const firstFailure = await getExecution(fixture.executionId);
    expect(firstFailure).toMatchObject({
      status: 'queued',
      reconciliation_attempt_count: 1,
    });
    expect(firstFailure.reconciliation_last_error).not.toContain('redis://');
    expect(firstFailure.reconciliation_last_error).not.toContain('password');
    expect(
      await getReconciliationDelay(pool, fixture.executionId),
    ).toBeLessThanOrEqual(150);
    await makeReconciliationDue(pool, fixture.executionId);
    await Promise.all([
      createReconciler().reconcileOnce(),
      createReconciler().reconcileOnce(),
    ]);
    const cappedDelay = await getReconciliationDelay(pool, fixture.executionId);
    expect(cappedDelay).toBeGreaterThan(75);
    expect(cappedDelay).toBeLessThanOrEqual(150);
    expect((await getExecution(fixture.executionId)).status).toBe('queued');
    await makeReconciliationDue(pool, fixture.executionId);
    await createReconciler().reconcileOnce();

    expect(calls).toBe(3);
    expect(await getExecution(fixture.executionId)).toMatchObject({
      status: 'failed',
      error_type: EXECUTION_QUEUE_RECOVERY_EXHAUSTED,
      reconciliation_attempt_count: 3,
      reconciliation_locked_at: null,
      reconciliation_lock_token: null,
    });
    expect(await getExecutionSteps(fixture.executionId)).toEqual([
      expect.objectContaining({
        status: 'skipped',
        error_type: EXECUTION_QUEUE_RECOVERY_EXHAUSTED,
      }),
    ]);
  });

  it('does not let invalid-job reconciliation overwrite a concurrent active claim', async () => {
    const fixture = await createExecution(pool, { publishedOutbox: true });
    const repository = new PostgresExecutionRepository(pool);
    let activeClaim: Awaited<ReturnType<typeof repository.claim>> | undefined;
    const reconciler = new ExecutionQueueReconciler(
      repository,
      {
        reconcile: async () => {
          activeClaim = await repository.claim(fixture.executionId, 5_000);
          return { type: 'invalid', reason: 'payload' };
        },
      },
      { logger: silentLogger },
    );

    await reconciler.reconcileOnce();
    expect(activeClaim?.type).toBe('claimed');
    expect(await getExecution(fixture.executionId)).toMatchObject({
      status: 'running',
      error_type: null,
    });
    expect(await getExecutionSteps(fixture.executionId)).toEqual([
      expect.objectContaining({ status: 'pending' }),
    ]);
  });

  it('fences a stale owner after a newer claim records the result', async () => {
    const fixture = await createExecution(pool);
    const repository = new PostgresExecutionRepository(pool);
    const first = await repository.claim(fixture.executionId, 5_000);
    expect(first.type).toBe('claimed');
    if (first.type !== 'claimed') throw new Error('Expected first claim.');
    await pool.query(
      `UPDATE workflow_executions
       SET processing_lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [fixture.executionId],
    );
    const second = await repository.claim(fixture.executionId, 5_000);
    expect(second.type).toBe('claimed');
    if (second.type !== 'claimed')
      throw new Error('Expected replacement claim.');

    await expect(
      repository.recordFailure(
        fixture.executionId,
        first.execution.processingToken,
        engineDeferredOutcome,
      ),
    ).resolves.toBe('lost-claim');
    await expect(
      repository.recordFailure(
        fixture.executionId,
        second.execution.processingToken,
        engineDeferredOutcome,
      ),
    ).resolves.toBe('recorded');
    expect(await getExecution(fixture.executionId)).toMatchObject({
      status: 'failed',
      error_type: EXECUTION_ENGINE_NOT_IMPLEMENTED,
    });
  });

  it('serializes expired-claim recovery against a concurrent reclaim', async () => {
    for (let index = 0; index < 4; index += 1) {
      const fixture = await createExecution(pool);
      const repository = new PostgresExecutionRepository(pool);
      const initial = await repository.claim(fixture.executionId, 5_000);
      expect(initial.type).toBe('claimed');
      await pool.query(
        `UPDATE workflow_executions
         SET processing_lease_expires_at = clock_timestamp() - interval '1 second'
         WHERE id = $1`,
        [fixture.executionId],
      );

      const recover = () =>
        repository.recoverExpired({
          errorType: EXECUTION_PROCESSING_LEASE_EXPIRED,
          errorMessage: 'Recovered expired test claim.',
        });
      const reclaim = () => repository.claim(fixture.executionId, 5_000);
      const claimResult =
        index % 2 === 0
          ? (await Promise.all([recover(), reclaim()]))[1]
          : (await Promise.all([reclaim(), recover()]))[0];
      if (claimResult.type === 'claimed') {
        await repository.recordFailure(
          fixture.executionId,
          claimResult.execution.processingToken,
          engineDeferredOutcome,
        );
      }

      const execution = await getExecution(fixture.executionId);
      expect(execution.status).toBe('failed');
      expect([
        EXECUTION_ENGINE_NOT_IMPLEMENTED,
        EXECUTION_PROCESSING_LEASE_EXPIRED,
      ]).toContain(execution.error_type);
      expect(execution.processing_token).toBeNull();
      expect(execution.processing_lease_expires_at).toBeNull();
      expect(await getExecutionSteps(fixture.executionId)).toEqual([
        expect.objectContaining({
          status: 'skipped',
          error_type: execution.error_type,
        }),
      ]);
    }
  });

  it('retries a one-time outcome persistence failure without reclassifying it', async () => {
    const fixture = await createExecution(pool);
    await pool.query(`
      CREATE SEQUENCE reject_consumer_outcome_once_seq;
      CREATE FUNCTION reject_consumer_outcome() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'failed'
           AND nextval('reject_consumer_outcome_once_seq') = 1 THEN
          RAISE EXCEPTION 'synthetic outcome failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_consumer_outcome_trigger
      BEFORE UPDATE ON workflow_executions
      FOR EACH ROW EXECUTE FUNCTION reject_consumer_outcome();
    `);
    startConsumer({ leaseMilliseconds: 200 });
    startRecoveryMonitor(10, 0);
    const job = await addExecutionJob(fixture.executionId);
    try {
      await waitFor(async () => {
        const current = await queue.getJob(job.id!);
        return (current?.attemptsMade ?? 0) >= 1;
      });
    } finally {
      await pool.query(
        'DROP TRIGGER IF EXISTS reject_consumer_outcome_trigger ON workflow_executions; DROP FUNCTION IF EXISTS reject_consumer_outcome(); DROP SEQUENCE IF EXISTS reject_consumer_outcome_once_seq;',
      );
    }

    await waitForExecutionStatus(fixture.executionId, 'failed');
    expect((await getExecution(fixture.executionId)).error_type).toBe(
      EXECUTION_ENGINE_NOT_IMPLEMENTED,
    );
    await waitFor(async () => (await job.getState()) === 'completed');
    expect((await queue.getJob(job.id!))?.attemptsMade).toBeGreaterThanOrEqual(
      2,
    );
  });

  function startConsumer(
    options: {
      repository?: PostgresExecutionRepository;
      leaseMilliseconds?: number;
      lockDuration?: number;
      stalledInterval?: number;
      afterClaim?: ConstructorParameters<
        typeof ExecutionProcessor
      >[1]['afterClaim'];
    } = {},
  ): BullExecutionConsumer {
    const repository =
      options.repository ?? new PostgresExecutionRepository(pool);
    const processor = new ExecutionProcessor(repository, {
      leaseMilliseconds: options.leaseMilliseconds,
      afterClaim: options.afterClaim,
      logger: silentLogger,
    });
    const consumer = new BullExecutionConsumer({
      redisUrl: redisUrl!,
      queueName,
      processor,
      lockDuration: options.lockDuration,
      stalledInterval: options.stalledInterval,
      handleInvalidJob: async (executionId) => {
        await repository.recordInvalidQueueDelivery(executionId, {
          errorType: EXECUTION_QUEUE_PAYLOAD_INVALID,
          errorMessage:
            'The retained queue job failed identity validation and was not executed.',
        });
      },
      logger: silentLogger,
    });
    consumers.add(consumer);
    consumer.start();
    return consumer;
  }

  function startRecoveryMonitor(
    pollMilliseconds: number,
    recoveryGraceMilliseconds = 0,
  ): ExecutionRecoveryMonitor {
    const monitor = new ExecutionRecoveryMonitor(
      new PostgresExecutionRepository(pool),
      { pollMilliseconds, recoveryGraceMilliseconds, logger: silentLogger },
    );
    recoveryMonitors.add(monitor);
    monitor.start();
    return monitor;
  }

  async function addExecutionJob(executionId: string) {
    return queue.add(
      EXECUTION_JOB_NAME,
      { executionId },
      {
        jobId: executionId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 50 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
  }

  async function getExecution(executionId: string) {
    const result = await pool.query(
      `SELECT organization_id, workflow_id, workflow_snapshot, status,
              started_at, completed_at, error_type, error_message,
              processing_token, processing_lease_expires_at,
              processing_attempt, reconciliation_attempt_count,
              reconciliation_available_at, reconciliation_locked_at,
              reconciliation_lock_token, reconciliation_last_error
       FROM workflow_executions WHERE id = $1`,
      [executionId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error('Expected execution row.');
    return row;
  }

  async function getExecutionSteps(executionId: string) {
    const result = await pool.query(
      `SELECT name, config, status, error_type, error_message
       FROM execution_steps WHERE execution_id = $1 ORDER BY step_order`,
      [executionId],
    );
    return result.rows as Record<string, unknown>[];
  }

  async function waitForExecutionStatus(
    executionId: string,
    status: string,
    timeoutMilliseconds = 4_000,
  ): Promise<void> {
    await waitFor(
      async () => (await getExecution(executionId)).status === status,
      timeoutMilliseconds,
    );
  }
});

interface FixtureOptions {
  stepName?: string;
  publishedOutbox?: boolean;
}

async function createExecution(
  pool: Pool,
  options: FixtureOptions = {},
): Promise<{
  executionId: string;
  organizationId: string;
  workflowId: string;
  workflowStepId: string;
}> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  const workflowId = randomUUID();
  const workflowStepId = randomUUID();
  const executionId = randomUUID();
  const stepName = options.stepName ?? 'Log result';
  const snapshot: WorkflowExecutionSnapshot = {
    workflowId,
    organizationId,
    workflowVersion: 1,
    name: 'Snapshot workflow',
    description: '',
    triggerType: 'manual',
    triggerConfig: {},
    steps: [
      {
        workflowStepId,
        stepOrder: 0,
        stepType: 'action',
        actionType: 'log',
        name: stepName,
        config: { message: 'original' },
        retryConfig: {},
      },
    ],
  };
  await pool.query(
    `INSERT INTO users (id, email, password_hash, display_name)
     VALUES ($1, $2, 'test', 'Consumer Test')`,
    [userId, `${userId}@example.com`],
  );
  await pool.query(
    `INSERT INTO organizations (id, name, slug, created_by)
     VALUES ($1, 'Consumer Test', $2, $3)`,
    [organizationId, `consumer-${organizationId}`, userId],
  );
  await pool.query(
    `INSERT INTO workflows
       (id, organization_id, name, status, trigger_type, version, created_by)
     VALUES ($1, $2, 'Snapshot workflow', 'active', 'manual', 1, $3)`,
    [workflowId, organizationId, userId],
  );
  await pool.query(
    `INSERT INTO workflow_steps
       (id, workflow_id, step_order, step_type, action_type, name, config)
     VALUES ($1, $2, 0, 'action', 'log', $3, '{"message":"original"}'::jsonb)`,
    [workflowStepId, workflowId, stepName],
  );
  await pool.query(
    `INSERT INTO workflow_executions
       (id, organization_id, workflow_id, workflow_version, trigger_type, workflow_snapshot)
     VALUES ($1, $2, $3, 1, 'manual', $4)`,
    [executionId, organizationId, workflowId, snapshot],
  );
  await pool.query(
    `INSERT INTO execution_steps
       (execution_id, workflow_step_id, step_order, step_type, action_type, name, config)
     VALUES ($1, $2, 0, 'action', 'log', $3, '{"message":"original"}'::jsonb)`,
    [executionId, workflowStepId, stepName],
  );
  if (options.publishedOutbox)
    await pool.query(
      `INSERT INTO execution_queue_outbox
         (execution_id, job_payload, status, published_at)
       VALUES (
         $1::uuid,
         jsonb_build_object('executionId', ($1::uuid)::text),
         'published',
         clock_timestamp()
       )`,
      [executionId],
    );
  return { executionId, organizationId, workflowId, workflowStepId };
}

async function createPublishedExecutionBatch(
  pool: Pool,
  source: {
    executionId: string;
    organizationId: string;
    workflowId: string;
    workflowStepId: string;
  },
  count: number,
): Promise<string[]> {
  const snapshotResult = await pool.query<{ workflow_snapshot: unknown }>(
    'SELECT workflow_snapshot FROM workflow_executions WHERE id = $1',
    [source.executionId],
  );
  const executionIds = Array.from({ length: count }, () => randomUUID());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO workflow_executions
         (id, organization_id, workflow_id, workflow_version, trigger_type, workflow_snapshot)
       SELECT execution_id, $2, $3, 1, 'manual', $4::jsonb
       FROM unnest($1::uuid[]) AS execution_id`,
      [
        executionIds,
        source.organizationId,
        source.workflowId,
        JSON.stringify(snapshotResult.rows[0]?.workflow_snapshot),
      ],
    );
    await client.query(
      `INSERT INTO execution_steps
         (execution_id, workflow_step_id, step_order, step_type, action_type, name, config)
       SELECT execution_id, $2, 0, 'action', 'log', 'Bulk log',
              '{"message":"original"}'::jsonb
       FROM unnest($1::uuid[]) AS execution_id`,
      [executionIds, source.workflowStepId],
    );
    await client.query(
      `INSERT INTO execution_queue_outbox
         (execution_id, job_payload, status, published_at)
       SELECT execution_id,
              jsonb_build_object('executionId', execution_id::text),
              'published', clock_timestamp()
       FROM unnest($1::uuid[]) AS execution_id`,
      [executionIds],
    );
    await client.query('COMMIT');
    return executionIds;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function makeReconciliationDue(
  pool: Pool,
  executionId: string,
): Promise<void> {
  await pool.query(
    `UPDATE workflow_executions
     SET reconciliation_available_at = clock_timestamp()
     WHERE id = $1`,
    [executionId],
  );
}

async function getReconciliationDelay(
  pool: Pool,
  executionId: string,
): Promise<number> {
  const result = await pool.query<{ milliseconds: number }>(
    `SELECT GREATEST(
       0,
       EXTRACT(EPOCH FROM (reconciliation_available_at - clock_timestamp())) * 1000
     )::double precision AS milliseconds
     FROM workflow_executions
     WHERE id = $1`,
    [executionId],
  );
  return result.rows[0]?.milliseconds ?? 0;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMilliseconds = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for execution consumer state.');
}
