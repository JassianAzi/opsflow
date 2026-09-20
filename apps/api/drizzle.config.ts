import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';
import { loadEnvironment } from '@opsflow/config';

const environment = loadEnvironment(resolve(process.cwd(), '../../.env'));

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: environment.DATABASE_URL },
});
