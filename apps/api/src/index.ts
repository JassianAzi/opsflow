import { resolve } from 'node:path';
import { loadEnvironment } from '@opsflow/config';
import { buildApp } from './app.js';
import { createDatabase } from './db/client.js';

const environment = loadEnvironment(resolve(process.cwd(), '../../.env'));
const { db, pool } = createDatabase(environment.DATABASE_URL);
const app = buildApp({
  database: db,
  production: environment.NODE_ENV === 'production',
  webOrigin: environment.WEB_ORIGIN,
});
app.addHook('onClose', async () => {
  await pool.end();
});

const shutdown = () => {
  void app.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  await app.listen({ host: environment.API_HOST, port: environment.API_PORT });
} catch (error) {
  app.log.error(error, 'API failed to start');
  process.exitCode = 1;
}
