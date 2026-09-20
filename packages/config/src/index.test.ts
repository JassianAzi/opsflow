import { describe, expect, it } from 'vitest';
import { environmentSchema } from './index.js';

describe('environment configuration', () => {
  it('reports missing service URLs', () => {
    const result = environmentSchema.safeParse({ NODE_ENV: 'development' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path[0])).toEqual([
        'DATABASE_URL',
        'REDIS_URL',
      ]);
    }
  });
});
