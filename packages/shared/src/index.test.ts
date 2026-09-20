import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './index.js';

describe('health response contract', () => {
  it('rejects an invalid timestamp', () => {
    expect(
      healthResponseSchema.safeParse({
        status: 'ok',
        service: 'api',
        timestamp: 'yesterday',
      }).success,
    ).toBe(false);
  });
});
