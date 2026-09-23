import { workflowExecutionSnapshotSchema } from '@opsflow/shared';
import { ApiError } from '../errors.js';
import { createExecutionRepository } from './repository.js';

type ExecutionRepository = ReturnType<typeof createExecutionRepository>;

export function createExecutionService(repository: ExecutionRepository) {
  return {
    async createManualTest(
      organizationId: string,
      workflowId: string,
      userId: string,
      idempotencyKey: string | undefined,
    ): Promise<{ executionId: string }> {
      const result = await repository.createManualTest(
        organizationId,
        workflowId,
        userId,
        idempotencyKey,
        (workflow, steps) => {
          if (workflow.status !== 'active')
            throw new ApiError(
              409,
              'WORKFLOW_NOT_ACTIVE',
              'Only an active workflow can create a test execution.',
            );
          if (workflow.triggerType !== 'manual')
            throw new ApiError(
              409,
              'WORKFLOW_TRIGGER_NOT_MANUAL',
              'Test execution is available only for manual workflows.',
            );
          const snapshot = workflowExecutionSnapshotSchema.safeParse({
            workflowId: workflow.id,
            organizationId: workflow.organizationId,
            workflowVersion: workflow.version,
            name: workflow.name,
            description: workflow.description,
            triggerType: workflow.triggerType,
            triggerConfig: workflow.triggerConfig,
            steps: steps.map((step) => ({
              workflowStepId: step.id,
              stepOrder: step.stepOrder,
              stepType: step.stepType,
              actionType: step.actionType,
              name: step.name,
              config: step.config,
              retryConfig: step.retryConfig,
            })),
          });
          if (!snapshot.success)
            throw new ApiError(
              400,
              'WORKFLOW_INVALID',
              'Workflow configuration is invalid.',
              snapshot.error.issues.map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message,
              })),
            );
          return snapshot.data;
        },
      );
      if (result.status === 'not-member')
        throw new ApiError(
          404,
          'ORGANIZATION_NOT_FOUND',
          'Organization not found.',
        );
      if (result.status === 'not-found')
        throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found.');
      return { executionId: result.executionId };
    },
  };
}

export type ExecutionService = ReturnType<typeof createExecutionService>;
