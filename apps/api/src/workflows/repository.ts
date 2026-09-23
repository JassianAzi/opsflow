import { and, asc, desc, eq } from 'drizzle-orm';
import type {
  CreateWorkflowInput,
  TriggerType,
  UpdateWorkflowInput,
  WorkflowStatus,
  WorkflowStepInput,
} from '@opsflow/shared';
import type { Database } from '../db/client.js';
import { workflows, workflowSteps } from '../db/schema.js';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function createWorkflowRepository(db: Database) {
  async function find(organizationId: string, workflowId: string) {
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.id, workflowId),
          eq(workflows.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!workflow) return null;
    const steps = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.workflowId, workflow.id))
      .orderBy(asc(workflowSteps.stepOrder));
    return { ...workflow, steps };
  }

  return {
    find,
    async list(organizationId: string) {
      return db
        .select()
        .from(workflows)
        .where(eq(workflows.organizationId, organizationId))
        .orderBy(desc(workflows.updatedAt), asc(workflows.id));
    },
    async create(
      organizationId: string,
      userId: string,
      input: CreateWorkflowInput,
    ) {
      const [workflow] = await db
        .insert(workflows)
        .values({
          organizationId,
          createdBy: userId,
          name: input.name,
          description: input.description,
          triggerType: input.triggerType,
          triggerConfig: input.triggerConfig,
        })
        .returning();
      if (!workflow) throw new Error('Workflow insert returned no row');
      return { ...workflow, steps: [] };
    },
    async update(
      organizationId: string,
      workflowId: string,
      input: UpdateWorkflowInput,
      validate: (definition: {
        name: string;
        description: string;
        triggerType: TriggerType;
        triggerConfig: Record<string, unknown>;
        status: WorkflowStatus;
        steps: Array<
          Pick<
            WorkflowStepInput,
            'stepType' | 'actionType' | 'name' | 'config'
          > & { retryConfig: Record<string, unknown> }
        >;
      }) => void,
    ) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.id, workflowId),
              eq(workflows.organizationId, organizationId),
            ),
          )
          .for('update')
          .limit(1);
        if (!current) return null;
        if (current.version !== input.expectedVersion) {
          return {
            status: 'version-conflict' as const,
            currentVersion: current.version,
          };
        }
        const currentSteps = await tx
          .select()
          .from(workflowSteps)
          .where(eq(workflowSteps.workflowId, workflowId))
          .orderBy(asc(workflowSteps.stepOrder));
        const next = {
          ...current,
          name: input.name ?? current.name,
          description: input.description ?? current.description,
          triggerType: input.triggerType ?? current.triggerType,
          triggerConfig: input.triggerConfig ?? current.triggerConfig,
          steps: input.steps ?? currentSteps,
        };
        validate(next);
        const oldSteps = stableJson(
          currentSteps.map((step) => [
            step.stepType,
            step.actionType,
            step.name,
            step.config,
            step.retryConfig,
          ]),
        );
        const newSteps = stableJson(
          next.steps.map((step) => [
            step.stepType,
            step.actionType,
            step.name,
            step.config,
            step.retryConfig,
          ]),
        );
        const oldConfig = stableJson([
          current.name,
          current.description,
          current.triggerType,
          current.triggerConfig,
          oldSteps,
        ]);
        const newConfig = stableJson([
          next.name,
          next.description,
          next.triggerType,
          next.triggerConfig,
          newSteps,
        ]);
        if (oldConfig === newConfig)
          return {
            status: 'success' as const,
            workflow: { ...current, steps: currentSteps },
          };
        const [updated] = await tx
          .update(workflows)
          .set({
            name: next.name,
            description: next.description,
            triggerType: next.triggerType,
            triggerConfig: next.triggerConfig,
            version: current.version + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(workflows.id, workflowId),
              eq(workflows.organizationId, organizationId),
            ),
          )
          .returning();
        if (!updated) throw new Error('Workflow update returned no row');
        let steps = currentSteps;
        if (input.steps !== undefined && oldSteps !== newSteps) {
          await tx
            .delete(workflowSteps)
            .where(eq(workflowSteps.workflowId, workflowId));
          steps = input.steps.length
            ? await tx
                .insert(workflowSteps)
                .values(
                  input.steps.map((step, index) => ({
                    workflowId,
                    stepOrder: index,
                    stepType: step.stepType,
                    actionType: step.actionType,
                    name: step.name,
                    config: step.config,
                    retryConfig: step.retryConfig,
                  })),
                )
                .returning()
            : [];
          steps.sort((a, b) => a.stepOrder - b.stepOrder);
        }
        return {
          status: 'success' as const,
          workflow: { ...updated, steps },
        };
      });
    },
    async setStatus(
      organizationId: string,
      workflowId: string,
      status: 'active' | 'inactive',
      validate?: (definition: Awaited<ReturnType<typeof find>>) => void,
    ) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.id, workflowId),
              eq(workflows.organizationId, organizationId),
            ),
          )
          .for('update')
          .limit(1);
        if (!current) return null;
        const steps = await tx
          .select()
          .from(workflowSteps)
          .where(eq(workflowSteps.workflowId, workflowId))
          .orderBy(asc(workflowSteps.stepOrder));
        validate?.({ ...current, steps });
        if (current.status === status) return { ...current, steps };
        const [updated] = await tx
          .update(workflows)
          .set({ status, updatedAt: new Date() })
          .where(
            and(
              eq(workflows.id, workflowId),
              eq(workflows.organizationId, organizationId),
            ),
          )
          .returning();
        if (!updated) throw new Error('Workflow status update returned no row');
        return { ...updated, steps };
      });
    },
    async remove(organizationId: string, workflowId: string) {
      const deleted = await db
        .delete(workflows)
        .where(
          and(
            eq(workflows.id, workflowId),
            eq(workflows.organizationId, organizationId),
          ),
        )
        .returning({ id: workflows.id });
      return deleted.length > 0;
    },
  };
}
