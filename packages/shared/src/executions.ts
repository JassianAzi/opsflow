import { z } from 'zod';
import {
  actionTypeSchema,
  triggerTypeSchema,
  validateTrigger,
  workflowStepInputSchema,
} from './workflows.js';

export const EXECUTION_QUEUE_NAME = 'opsflow-executions';
export const EXECUTION_JOB_NAME = 'execute-workflow';

export const executionStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const executionStepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'skipped',
  'failed',
]);

export const queueOutboxStatusSchema = z.enum([
  'pending',
  'published',
  'failed',
]);

const jsonObjectSchema = z.record(z.string(), z.unknown());
const nonempty = z.string().trim().min(1);

export const idempotencyKeySchema = z.string().trim().min(1).max(200);

export const executionStepSnapshotSchema = z
  .object({
    workflowStepId: z.uuid(),
    stepOrder: z.number().int().min(0),
    stepType: z.enum(['condition', 'action']),
    actionType: actionTypeSchema.nullable(),
    name: nonempty.max(120),
    config: jsonObjectSchema,
    retryConfig: jsonObjectSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const result = workflowStepInputSchema.safeParse({
      stepType: snapshot.stepType,
      actionType: snapshot.actionType,
      name: snapshot.name,
      config: snapshot.config,
      retryConfig: snapshot.retryConfig,
    });
    if (result.success) return;
    for (const issue of result.error.issues)
      context.addIssue({
        code: 'custom',
        path: issue.path,
        message: issue.message,
      });
  });

export const workflowExecutionSnapshotSchema = z
  .object({
    workflowId: z.uuid(),
    organizationId: z.uuid(),
    workflowVersion: z.number().int().min(1),
    name: nonempty.max(120),
    description: z.string().max(4000),
    triggerType: triggerTypeSchema,
    triggerConfig: jsonObjectSchema,
    steps: z.array(executionStepSnapshotSchema).min(1).max(100),
  })
  .strict()
  .superRefine((snapshot, context) => {
    validateTrigger(snapshot.triggerType, snapshot.triggerConfig, context);
    if (
      snapshot.triggerType === 'schedule' &&
      typeof snapshot.triggerConfig.cron !== 'string'
    )
      context.addIssue({
        code: 'custom',
        path: ['triggerConfig', 'cron'],
        message: 'An executable schedule requires a cron expression.',
      });

    let actionSeen = false;
    snapshot.steps.forEach((step, index) => {
      if (step.stepOrder !== index)
        context.addIssue({
          code: 'custom',
          path: ['steps', index, 'stepOrder'],
          message: 'Execution snapshot steps must use consecutive ordering.',
        });
      if (step.stepType === 'action') actionSeen = true;
      else if (actionSeen)
        context.addIssue({
          code: 'custom',
          path: ['steps', index, 'stepType'],
          message: 'Conditions must precede actions.',
        });
    });
    if (!snapshot.steps.some((step) => step.stepType === 'action'))
      context.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'An executable workflow requires at least one action.',
      });
  });

export const executionQueueJobSchema = z
  .object({ executionId: z.uuid() })
  .strict();

const nullableDateTime = z.iso.datetime().nullable();

export const executionStepSchema = executionStepSnapshotSchema
  .safeExtend({
    id: z.uuid(),
    executionId: z.uuid(),
    status: executionStepStatusSchema,
    inputData: z.unknown().nullable(),
    outputData: z.unknown().nullable(),
    attemptCount: z.number().int().min(0),
    startedAt: nullableDateTime,
    completedAt: nullableDateTime,
    errorType: z.string().nullable(),
    errorMessage: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
export type ExecutionStepStatus = z.infer<typeof executionStepStatusSchema>;
export type QueueOutboxStatus = z.infer<typeof queueOutboxStatusSchema>;
export type ExecutionStepSnapshot = z.infer<typeof executionStepSnapshotSchema>;
export type WorkflowExecutionSnapshot = z.infer<
  typeof workflowExecutionSnapshotSchema
>;
export type ExecutionQueueJob = z.infer<typeof executionQueueJobSchema>;
export type ExecutionStep = z.infer<typeof executionStepSchema>;
