import { z } from 'zod';

export const workflowStatusSchema = z.enum(['draft', 'active', 'inactive']);
export const triggerTypeSchema = z.enum(['manual', 'webhook', 'schedule']);
export const stepTypeSchema = z.enum(['condition', 'action']);
export const actionTypeSchema = z.enum([
  'log',
  'internal_task',
  'mock_email',
  'http_request',
  'ai',
]);
export const conditionOperatorSchema = z.enum([
  'equals',
  'not_equals',
  'contains',
  'greater_than',
  'less_than',
  'exists',
  'does_not_exist',
]);

const object = z.record(z.string(), z.unknown());
const nonempty = z.string().trim().min(1);

// Five numeric cron fields. Named weekdays and macros are intentionally unsupported.
export function validCron(expression: string): boolean {
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => {
    const [minimum, maximum] = ranges[index]!;
    return field!.split(',').every((part) => {
      const [base, stride, extra] = part.split('/');
      if (
        extra !== undefined ||
        (stride !== undefined && (!/^\d+$/.test(stride) || Number(stride) < 1))
      )
        return false;
      if (base === '*') return true;
      const match = /^(\d+)(?:-(\d+))?$/.exec(base ?? '');
      if (!match) return false;
      const start = Number(match[1]);
      const end = match[2] === undefined ? start : Number(match[2]);
      return start >= minimum && end <= maximum && start <= end;
    });
  });
}

export const scheduleTriggerConfigSchema = z
  .object({
    cron: z
      .string()
      .trim()
      .refine(validCron, 'Use a valid five-field numeric cron expression.')
      .optional(),
    timezone: nonempty
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Use a valid IANA time zone.')
      .optional(),
  })
  .strict();

export const conditionConfigSchema = z
  .object({
    field: nonempty
      .max(200)
      .regex(
        /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/,
        'Use a dotted field path.',
      ),
    operator: conditionOperatorSchema,
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  })
  .strict()
  .superRefine((config, context) => {
    const existence =
      config.operator === 'exists' || config.operator === 'does_not_exist';
    if (!existence && config.value === undefined)
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'A value is required for this operator.',
      });
    if (existence && config.value !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'This operator does not accept a value.',
      });
    if (
      ['greater_than', 'less_than'].includes(config.operator) &&
      typeof config.value !== 'number'
    )
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Comparison requires a number.',
      });
    if (config.operator === 'contains' && typeof config.value !== 'string')
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Contains requires a string.',
      });
  });

export const logActionConfigSchema = z
  .object({ message: nonempty.max(2000) })
  .strict();
export const internalTaskActionConfigSchema = z
  .object({
    title: nonempty.max(200),
    description: z.string().max(4000).default(''),
  })
  .strict();
export const mockEmailActionConfigSchema = z
  .object({
    to: z.email(),
    subject: nonempty.max(200),
    body: nonempty.max(10000),
  })
  .strict();
export const httpRequestActionConfigSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    url: z
      .url()
      .refine(
        (value) => /^https?:\/\//i.test(value),
        'Use an HTTP or HTTPS URL.',
      ),
    headers: z
      .record(z.string(), z.string())
      .default({})
      .refine(
        (headers) =>
          !Object.keys(headers).some((key) =>
            /^(authorization|cookie|proxy-authorization|x-api-key)$/i.test(key),
          ),
        'Store credentials outside workflow configuration.',
      ),
    body: z.string().max(50000).optional(),
  })
  .strict();
export const aiActionConfigSchema = z
  .object({
    operation: z.enum(['classify', 'extract']),
    prompt: nonempty.max(10000),
    outputSchema: object.optional(),
  })
  .strict();

export const retryConfigSchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(3600000).optional(),
  })
  .strict();

export const workflowStepInputSchema = z
  .object({
    stepType: stepTypeSchema,
    actionType: actionTypeSchema.nullable(),
    name: nonempty.max(120),
    config: object,
    retryConfig: retryConfigSchema.default({}),
  })
  .strict()
  .superRefine((step, context) => {
    if (step.stepType === 'condition') {
      if (step.actionType !== null)
        context.addIssue({
          code: 'custom',
          path: ['actionType'],
          message: 'Condition steps cannot have an action type.',
        });
      addIssues(conditionConfigSchema.safeParse(step.config), context, [
        'config',
      ]);
      if (Object.keys(step.retryConfig).length)
        context.addIssue({
          code: 'custom',
          path: ['retryConfig'],
          message: 'Conditions do not retry.',
        });
    } else {
      if (step.actionType === null) {
        context.addIssue({
          code: 'custom',
          path: ['actionType'],
          message: 'An action type is required.',
        });
        return;
      }
      const schemas = {
        log: logActionConfigSchema,
        internal_task: internalTaskActionConfigSchema,
        mock_email: mockEmailActionConfigSchema,
        http_request: httpRequestActionConfigSchema,
        ai: aiActionConfigSchema,
      };
      addIssues(schemas[step.actionType].safeParse(step.config), context, [
        'config',
      ]);
    }
  });

function addIssues(
  result: { success: boolean; error?: z.ZodError },
  context: z.RefinementCtx,
  prefix: (string | number)[],
) {
  if (result.success) return;
  for (const issue of result.error!.issues)
    context.addIssue({
      code: 'custom',
      path: [...prefix, ...issue.path],
      message: issue.message,
    });
}

export const createWorkflowInputSchema = z
  .object({
    name: nonempty.max(120),
    description: z.string().max(4000).default(''),
    triggerType: triggerTypeSchema,
    triggerConfig: object.default({}),
  })
  .strict()
  .superRefine((input, context) =>
    validateTrigger(input.triggerType, input.triggerConfig, context),
  );

export const updateWorkflowInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    name: nonempty.max(120).optional(),
    description: z.string().max(4000).optional(),
    triggerType: triggerTypeSchema.optional(),
    triggerConfig: object.optional(),
    steps: z.array(workflowStepInputSchema).max(100).optional(),
  })
  .strict()
  .refine(
    (input) => Object.keys(input).some((key) => key !== 'expectedVersion'),
    'Provide at least one workflow field.',
  );

export function validateTrigger(
  type: z.infer<typeof triggerTypeSchema>,
  config: Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  const result =
    type === 'schedule'
      ? scheduleTriggerConfigSchema.safeParse(config)
      : z.object({}).strict().safeParse(config);
  addIssues(result, context, ['triggerConfig']);
}

export type CreateWorkflowInput = z.infer<typeof createWorkflowInputSchema>;
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowInputSchema>;
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;
export type TriggerType = z.infer<typeof triggerTypeSchema>;
export type StepType = z.infer<typeof stepTypeSchema>;
export type ActionType = z.infer<typeof actionTypeSchema>;
export type WorkflowStepInput = z.infer<typeof workflowStepInputSchema>;

export interface WorkflowSummary {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  triggerType: TriggerType;
  triggerConfig: Record<string, unknown>;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface WorkflowStep extends WorkflowStepInput {
  id: string;
  workflowId: string;
  stepOrder: number;
  createdAt: string;
  updatedAt: string;
}
export interface WorkflowDetail extends WorkflowSummary {
  steps: WorkflowStep[];
}
