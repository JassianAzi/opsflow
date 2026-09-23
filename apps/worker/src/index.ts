import { resolve } from 'node:path';
import { EXECUTION_QUEUE_NAME } from '@opsflow/shared';
import { loadEnvironment } from '@opsflow/config';
import { Pool } from 'pg';
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
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; stopping outbox dispatcher.`);
  await dispatcher.stop();
  await publisher.close();
  await pool.end();
  console.info('OpsFlow worker stopped.');
}

try {
  await pool.query('select 1 from execution_queue_outbox limit 0');
  dispatcher.start();
  console.info('OpsFlow worker ready; outbox dispatcher started.');

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
  await publisher.close();
  await pool.end();
  process.exitCode = 1;
}
