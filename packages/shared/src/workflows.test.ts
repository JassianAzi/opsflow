import { describe, expect, it } from 'vitest';
import {
  createWorkflowInputSchema,
  updateWorkflowInputSchema,
  workflowStepInputSchema,
} from './workflows.js';

describe('workflow configuration contracts', () => {
  it('requires a positive expected version for workflow updates', () => {
    expect(
      updateWorkflowInputSchema.safeParse({
        expectedVersion: 2,
        name: 'Updated',
      }).success,
    ).toBe(true);
    expect(
      updateWorkflowInputSchema.safeParse({ name: 'Updated' }).success,
    ).toBe(false);
    expect(
      updateWorkflowInputSchema.safeParse({
        expectedVersion: 0,
        name: 'Updated',
      }).success,
    ).toBe(false);
    expect(
      updateWorkflowInputSchema.safeParse({ expectedVersion: 1 }).success,
    ).toBe(false);
  });

  it('accepts an incomplete schedule draft but rejects malformed cron and unknown trigger configuration', () => {
    expect(
      createWorkflowInputSchema.safeParse({
        name: 'Daily',
        triggerType: 'schedule',
        triggerConfig: {},
      }).success,
    ).toBe(true);
    expect(
      createWorkflowInputSchema.safeParse({
        name: 'Daily',
        triggerType: 'schedule',
        triggerConfig: { cron: '0 9 * * 1-5', timezone: 'UTC' },
      }).success,
    ).toBe(true);
    expect(
      createWorkflowInputSchema.safeParse({
        name: 'Daily',
        triggerType: 'schedule',
        triggerConfig: { cron: '99 9 * * *' },
      }).success,
    ).toBe(false);
    expect(
      createWorkflowInputSchema.safeParse({
        name: 'Manual',
        triggerType: 'manual',
        triggerConfig: { cron: '* * * * *' },
      }).success,
    ).toBe(false);
  });

  it('requires condition values except for existence operators and enforces numeric comparisons', () => {
    const condition = (operator: string, value?: unknown) =>
      workflowStepInputSchema.safeParse({
        stepType: 'condition',
        actionType: null,
        name: 'Check',
        config: {
          field: 'customer.score',
          operator,
          ...(value === undefined ? {} : { value }),
        },
      }).success;
    expect(condition('exists')).toBe(true);
    expect(condition('exists', 'yes')).toBe(false);
    expect(condition('equals')).toBe(false);
    expect(condition('greater_than', '10')).toBe(false);
    expect(condition('greater_than', 10)).toBe(true);
  });

  it('validates action-specific configuration and rejects obvious secret headers', () => {
    const action = (actionType: string, config: Record<string, unknown>) =>
      workflowStepInputSchema.safeParse({
        stepType: 'action',
        actionType,
        name: 'Act',
        config,
      }).success;
    expect(action('log', { message: 'Reached this step' })).toBe(true);
    expect(action('internal_task', { title: 'Follow up' })).toBe(true);
    expect(
      action('mock_email', {
        to: 'demo@example.com',
        subject: 'Hello',
        body: 'Body',
      }),
    ).toBe(true);
    expect(
      action('ai', {
        operation: 'classify',
        prompt: 'Classify this',
        outputSchema: {},
      }),
    ).toBe(true);
    expect(
      action('http_request', {
        method: 'POST',
        url: 'https://example.com',
        headers: {},
      }),
    ).toBe(true);
    expect(
      action('http_request', {
        method: 'GET',
        url: 'http://localhost:3000',
        headers: { Authorization: 'Bearer secret' },
      }),
    ).toBe(false);
    expect(
      action('mock_email', { to: 'bad', subject: 'Hello', body: 'Body' }),
    ).toBe(false);
  });
});
