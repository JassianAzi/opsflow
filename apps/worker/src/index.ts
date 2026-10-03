import { resolve } from 'node:path';
import {
  EXECUTION_QUEUE_NAME,
  EXECUTION_QUEUE_PAYLOAD_INVALID,
} from '@opsflow/shared';
import { loadEnvironment } from '@opsflow/config';
import { Pool } from 'pg';
import { BullExecutionConsumer } from './execution/consumer.js';
import { ExecutionProcessor } from './execution/processor.js';
import { ExecutionQueueReconciler } from './execution/reconciler.js';
import { ExecutionRecoveryMonitor } from './execution/recovery.js';
import { PostgresExecutionRepository } from './execution/repository.js';
import { OutboxDispatcher } from './outbox/dispatcher.js';
import { BullQueuePublisher } from './outbox/publisher.js';
import { PostgresOutboxRepository } from './outbox/repository.js';

const environment = loadEnvironment(resolve(process.cwd(), '../../.env'));
const pool = new Pool({
  connectionString: environment.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5_000,
  query_timeout: 5_000,
});
const publisher = new BullQueuePublisher({
  redisUrl: environment.REDIS_URL,
  queueName: EXECUTION_QUEUE_NAME,
});
const dispatcher = new OutboxDispatcher(
  new PostgresOutboxRepository(pool),
  publisher,
);
const executionRepository = new PostgresExecutionRepository(pool);
const consumer = new BullExecutionConsumer({
  redisUrl: environment.REDIS_URL,
  queueName: EXECUTION_QUEUE_NAME,
  processor: new ExecutionProcessor(executionRepository),
  handleInvalidJob: async (executionId) => {
    await executionRepository.recordInvalidQueueDelivery(executionId, {
      errorType: EXECUTION_QUEUE_PAYLOAD_INVALID,
      errorMessage:
        'The retained queue job failed identity validation and was not executed.',
    });
  },
});
const recovery = new ExecutionRecoveryMonitor(executionRepository);
const reconciliation = new ExecutionQueueReconciler(
  executionRepository,
  publisher,
);
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; stopping outbox dispatcher.`);
  await dispatcher.stop();
  await reconciliation.stop();
  await recovery.stop();
  await consumer.close();
  await publisher.close();
  await pool.end();
  console.info('OpsFlow worker stopped.');
}

try {
  await pool.query(
    `select error_type, processing_token, processing_lease_expires_at,
            processing_attempt, reconciliation_attempt_count,
            reconciliation_available_at, reconciliation_lock_token
     from workflow_executions limit 0`,
  );
  recovery.start();
  consumer.start();
  reconciliation.start();
  dispatcher.start();
  console.info(
    'OpsFlow worker ready; dispatcher, consumer, and reconciliation started.',
  );

  const handleSignal = (signal: string) => {
    void shutdown(signal).catch((error: unknown) => {
      console.error(
        'Worker shutdown failed:',
        error instanceof Error ? error.message : 'Unknown shutdown error.',
      );
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
} catch (error) {
  console.error(
    'Worker failed to start:',
    error instanceof Error ? error.message : 'Unknown startup error.',
  );
  await reconciliation.stop();
  await recovery.stop();
  await consumer.close(true);
  await publisher.close();
  await pool.end();
  process.exitCode = 1;
}
