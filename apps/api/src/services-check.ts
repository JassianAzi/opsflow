import { resolve } from 'node:path';
import { createRedisClient, loadEnvironment } from '@opsflow/config';
import { createDatabase } from './db/client.js';

const environment = loadEnvironment(resolve(process.cwd(), '../../.env'));
const { pool } = createDatabase(environment.DATABASE_URL);
const redis = createRedisClient(environment.REDIS_URL);
redis.on('error', (error) => console.error('Redis error:', error.message));

try {
  await pool.query('SELECT 1');
  console.info('PostgreSQL: connected');
  await redis.connect();
  await redis.ping();
  console.info('Redis: connected');
} catch (error) {
  console.error('Local service connectivity check failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
  redis.disconnect();
}
