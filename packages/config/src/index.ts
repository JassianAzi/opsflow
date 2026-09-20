import { config as loadDotEnv } from 'dotenv';
import { Redis } from 'ioredis';
import { z } from 'zod';

const postgresUrl = z
  .url()
  .refine((value) => /^postgres(ql)?:\/\//.test(value), {
    message: 'must be a postgresql:// URL',
  });

const redisUrl = z.url().refine((value) => /^rediss?:\/\//.test(value), {
  message: 'must be a redis:// or rediss:// URL',
});

export const environmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  WEB_ORIGIN: z.url().default('http://127.0.0.1:5173'),
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,
});

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(
  envFile: string,
  source: NodeJS.ProcessEnv = process.env,
): Environment {
  loadDotEnv({ path: envFile, quiet: true });
  const result = environmentSchema.safeParse(source);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export function createRedisClient(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
}
