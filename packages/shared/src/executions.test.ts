import { describe, expect, it } from 'vitest';
import {
  executionQueueJobSchema,
  executionStatusSchema,
  executionStepSnapshotSchema,
  executionStepStatusSchema,
  idempotencyKeySchema,
  workflowExecutionSnapshotSchema,
} from './executions.js';

const workflowId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const workflowStepId = '33333333-3333-4333-8333-333333333333';
const executionId = '44444444-4444-4444-8444-444444444444';

const action = {
  workflowStepId,
  stepOrder: 0,
  stepType: 'action' as const,
  actionType: 'log' as const,
  name: 'Record event',
  config: { message: 'Received' },
  retryConfig: { maxAttempts: 2 },
};

describe('execution contracts', () => {
  it('accepts a complete immutable workflow snapshot', () => {
    expect(
      workflowExecutionSnapshotSchema.safeParse({
        workflowId,
        organizationId,
        workflowVersion: 3,
        name: 'Capture event',
        description: 'Snapshot example',
        triggerType: 'manual',
        triggerConfig: {},
        steps: [action],
      }).success,
    ).toBe(true);
  });

  it('rejects malformed step configuration and nondeterministic ordering', () => {
    expect(
      executionStepSnapshotSchema.safeParse({
        ...action,
        config: {},
      }).success,
    ).toBe(false);
    expect(
      workflowExecutionSnapshotSchema.safeParse({
        workflowId,
        organizationId,
        workflowVersion: 1,
        name: 'Out of order',
        description: '',
        triggerType: 'manual',
        triggerConfig: {},
        steps: [{ ...action, stepOrder: 1 }],
      }).success,
    ).toBe(false);
  });

  it('requires executable schedules and at least one action', () => {
    expect(
      workflowExecutionSnapshotSchema.safeParse({
        workflowId,
        organizationId,
        workflowVersion: 1,
        name: 'Incomplete schedule',
        description: '',
        triggerType: 'schedule',
        triggerConfig: {},
        steps: [action],
      }).success,
    ).toBe(false);
    expect(
      workflowExecutionSnapshotSchema.safeParse({
        workflowId,
        organizationId,
        workflowVersion: 1,
        name: 'Condition only',
        description: '',
        triggerType: 'manual',
        triggerConfig: {},
        steps: [
          {
            ...action,
            stepType: 'condition',
            actionType: null,
            config: { field: 'customer.active', operator: 'exists' },
            retryConfig: {},
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('allows only supported execution and step statuses', () => {
    expect(executionStatusSchema.safeParse('queued').success).toBe(true);
    expect(executionStatusSchema.safeParse('paused').success).toBe(false);
    expect(executionStepStatusSchema.safeParse('skipped').success).toBe(true);
    expect(executionStepStatusSchema.safeParse('cancelled').success).toBe(
      false,
    );
  });

  it('keeps the queue job payload limited to one execution id', () => {
    expect(executionQueueJobSchema.parse({ executionId })).toEqual({
      executionId,
    });
    expect(
      executionQueueJobSchema.safeParse({ executionId, workflowId }).success,
    ).toBe(false);
    expect(executionQueueJobSchema.safeParse({ workflowId }).success).toBe(
      false,
    );
  });

  it('normalizes and bounds idempotency keys', () => {
    expect(idempotencyKeySchema.parse('  manual-run-1  ')).toBe('manual-run-1');
    expect(idempotencyKeySchema.safeParse('').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('x'.repeat(201)).success).toBe(false);
  });
});
