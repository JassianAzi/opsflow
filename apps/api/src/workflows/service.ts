import type {
  CreateWorkflowInput,
  UpdateWorkflowInput,
  WorkflowDetail,
  WorkflowSummary,
  WorkflowStepInput,
} from '@opsflow/shared';
import { ApiError } from '../errors.js';
import type { OrganizationService } from '../organizations/service.js';
import { createWorkflowRepository } from './repository.js';
import { validateWorkflowDefinition } from './validation.js';

type WorkflowRepository = ReturnType<typeof createWorkflowRepository>;
type RawWorkflow = NonNullable<Awaited<ReturnType<WorkflowRepository['find']>>>;

function summary(row: Omit<RawWorkflow, 'steps'>): WorkflowSummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    description: row.description,
    status: row.status,
    triggerType: row.triggerType,
    triggerConfig: row.triggerConfig,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function detail(row: RawWorkflow): WorkflowDetail {
  return {
    ...summary(row),
    steps: row.steps.map((step) => ({
      id: step.id,
      workflowId: step.workflowId,
      stepOrder: step.stepOrder,
      stepType: step.stepType,
      actionType: step.actionType,
      name: step.name,
      config: step.config,
      retryConfig: step.retryConfig,
      createdAt: step.createdAt.toISOString(),
      updatedAt: step.updatedAt.toISOString(),
    })),
  };
}

function assertValid(
  row: Pick<
    RawWorkflow,
    'name' | 'description' | 'triggerType' | 'triggerConfig' | 'status'
  > & {
    steps: Array<{
      stepType: WorkflowStepInput['stepType'];
      actionType: WorkflowStepInput['actionType'];
      name: string;
      config: Record<string, unknown>;
      retryConfig: Record<string, unknown>;
    }>;
  },
  complete: boolean,
): void {
  const issues = validateWorkflowDefinition(
    { ...row, steps: row.steps },
    complete,
  );
  if (issues.length)
    throw new ApiError(
      400,
      'WORKFLOW_INVALID',
      'Workflow configuration is invalid.',
      issues,
    );
}

export function createWorkflowService(
  repository: WorkflowRepository,
  organizations: OrganizationService,
) {
  async function authorize(organizationId: string, userId: string) {
    await organizations.get(organizationId, userId);
  }
  function required(row: RawWorkflow | null): RawWorkflow {
    if (!row)
      throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found.');
    return row;
  }
  return {
    async list(
      organizationId: string,
      userId: string,
    ): Promise<WorkflowSummary[]> {
      await authorize(organizationId, userId);
      return (await repository.list(organizationId)).map(summary);
    },
    async create(
      organizationId: string,
      userId: string,
      input: CreateWorkflowInput,
    ): Promise<WorkflowDetail> {
      await authorize(organizationId, userId);
      return detail(await repository.create(organizationId, userId, input));
    },
    async get(
      organizationId: string,
      workflowId: string,
      userId: string,
    ): Promise<WorkflowDetail> {
      await authorize(organizationId, userId);
      return detail(
        required(await repository.find(organizationId, workflowId)),
      );
    },
    async update(
      organizationId: string,
      workflowId: string,
      userId: string,
      input: UpdateWorkflowInput,
    ): Promise<WorkflowDetail> {
      await authorize(organizationId, userId);
      const row = await repository.update(
        organizationId,
        workflowId,
        input,
        (candidate) => {
          assertValid(candidate, candidate.status === 'active');
        },
      );
      if (!row)
        throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found.');
      if (row.status === 'version-conflict')
        throw new ApiError(
          409,
          'WORKFLOW_VERSION_CONFLICT',
          `This workflow changed after you opened it. Reload version ${row.currentVersion} before saving.`,
        );
      return detail(row.workflow);
    },
    async activate(
      organizationId: string,
      workflowId: string,
      userId: string,
    ): Promise<WorkflowDetail> {
      await authorize(organizationId, userId);
      const row = await repository.setStatus(
        organizationId,
        workflowId,
        'active',
        (candidate) => assertValid(required(candidate), true),
      );
      return detail(required(row));
    },
    async deactivate(
      organizationId: string,
      workflowId: string,
      userId: string,
    ): Promise<WorkflowDetail> {
      await authorize(organizationId, userId);
      const row = await repository.setStatus(
        organizationId,
        workflowId,
        'inactive',
      );
      return detail(required(row));
    },
    async remove(
      organizationId: string,
      workflowId: string,
      userId: string,
    ): Promise<void> {
      await authorize(organizationId, userId);
      const result = await repository.remove(organizationId, workflowId);
      if (result === 'not-found')
        throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found.');
      if (result === 'has-executions')
        throw new ApiError(
          409,
          'WORKFLOW_HAS_EXECUTIONS',
          'A workflow with retained execution history cannot be deleted.',
        );
    },
  };
}

export type WorkflowService = ReturnType<typeof createWorkflowService>;
