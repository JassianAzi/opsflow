import {
  createWorkflowInputSchema,
  workflowStepInputSchema,
  type WorkflowStepInput,
  type TriggerType,
} from '@opsflow/shared';

export interface WorkflowIssue {
  path: string;
  message: string;
}

export function validateWorkflowDefinition(
  definition: {
    name: string;
    description: string;
    triggerType: TriggerType;
    triggerConfig: Record<string, unknown>;
    steps: Array<
      Pick<WorkflowStepInput, 'stepType' | 'actionType' | 'name' | 'config'> & {
        retryConfig?: unknown;
      }
    >;
  },
  complete: boolean,
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const trigger = createWorkflowInputSchema.safeParse({
    name: definition.name,
    description: definition.description,
    triggerType: definition.triggerType,
    triggerConfig: definition.triggerConfig,
  });
  if (!trigger.success)
    issues.push(
      ...trigger.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  let seenAction = false;
  for (const [index, step] of definition.steps.entries()) {
    const parsed = workflowStepInputSchema.safeParse({
      stepType: step.stepType,
      actionType: step.actionType,
      name: step.name,
      config: step.config,
      retryConfig: step.retryConfig,
    });
    if (!parsed.success)
      issues.push(
        ...parsed.error.issues.map((issue) => ({
          path: ['steps', index, ...issue.path].join('.'),
          message: issue.message,
        })),
      );
    if (step.stepType === 'action') seenAction = true;
    if (step.stepType === 'condition' && seenAction)
      issues.push({
        path: `steps.${index}`,
        message: 'Conditions must precede actions.',
      });
  }
  if (complete) {
    if (definition.triggerType === 'schedule' && !definition.triggerConfig.cron)
      issues.push({
        path: 'triggerConfig.cron',
        message: 'A cron expression is required to activate a schedule.',
      });
    if (!seenAction)
      issues.push({
        path: 'steps',
        message: 'Add at least one action before activation.',
      });
  }
  return issues;
}
