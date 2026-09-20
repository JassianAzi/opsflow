import { afterAll, describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@opsflow/shared';
import { buildApp } from './app.js';
import { createDatabase } from './db/client.js';

const { db, pool } = createDatabase(
  'postgresql://unused:unused@127.0.0.1:1/unused',
);
const app = buildApp({
  database: db,
  production: false,
  webOrigin: 'http://127.0.0.1:5173',
  logger: false,
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('GET /health', () => {
  it('returns the shared health contract', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.parse(response.json())).toMatchObject({
      status: 'ok',
      service: 'api',
    });
  });
});
