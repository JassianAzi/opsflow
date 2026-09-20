import { resolve } from 'node:path';
import { createRedisClient, loadEnvironment } from '@opsflow/config';

const environment = loadEnvironment(resolve(process.cwd(), '../../.env'));
const redis = createRedisClient(environment.REDIS_URL);
redis.on('error', (error) => console.error('Redis error:', error.message));

try {
  await redis.connect();
  await redis.ping();
  console.info('OpsFlow worker ready; queue processing starts in Phase 3.');

  const shutdown = () => {
    redis.disconnect();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error('Worker failed to connect to Redis:', error);
  redis.disconnect();
  process.exitCode = 1;
}
