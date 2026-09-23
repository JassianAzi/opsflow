import { and, asc, eq } from 'drizzle-orm';
import type { WorkflowExecutionSnapshot } from '@opsflow/shared';
import type { Database } from '../db/client.js';
import {
  executionQueueOutbox,
  executionSteps,
  organizationMembers,
  workflowExecutions,
  workflowSteps,
  workflows,
} from '../db/schema.js';

type WorkflowRow = typeof workflows.$inferSelect;
type WorkflowStepRow = typeof workflowSteps.$inferSelect;

export function createExecutionRepository(db: Database) {
  return {
    async createManualTest(
      organizationId: string,
      workflowId: string,
      userId: string,
      idempotencyKey: string | undefined,
      createSnapshot: (
        workflow: WorkflowRow,
        steps: WorkflowStepRow[],
      ) => WorkflowExecutionSnapshot,
    ) {
      return db.transaction(async (tx) => {
        const [membership] = await tx
          .select({ id: organizationMembers.id })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.organizationId, organizationId),
              eq(organizationMembers.userId, userId),
            ),
          )
          .for('share')
          .limit(1);
        if (!membership) return { status: 'not-member' as const };

        const [workflow] = await tx
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
        if (!workflow) return { status: 'not-found' as const };

        if (idempotencyKey) {
          const [existing] = await tx
            .select({ id: workflowExecutions.id })
            .from(workflowExecutions)
            .where(
              and(
                eq(workflowExecutions.workflowId, workflowId),
                eq(workflowExecutions.idempotencyKey, idempotencyKey),
              ),
            )
            .limit(1);
          if (existing)
            return {
              status: 'success' as const,
              executionId: existing.id,
              replayed: true,
            };
        }

        const steps = await tx
          .select()
          .from(workflowSteps)
          .where(eq(workflowSteps.workflowId, workflowId))
          .orderBy(asc(workflowSteps.stepOrder));
        const snapshot = createSnapshot(workflow, steps);
        const [execution] = await tx
          .insert(workflowExecutions)
          .values({
            organizationId,
            workflowId,
            workflowVersion: workflow.version,
            triggerType: workflow.triggerType,
            triggerPayload: {},
            workflowSnapshot: snapshot,
            idempotencyKey,
          })
          .returning({ id: workflowExecutions.id });
        if (!execution) throw new Error('Execution insert returned no row');

        await tx.insert(executionSteps).values(
          snapshot.steps.map((step) => ({
            executionId: execution.id,
            workflowStepId: step.workflowStepId,
            stepOrder: step.stepOrder,
            stepType: step.stepType,
            actionType: step.actionType,
            name: step.name,
            config: step.config,
            retryConfig: step.retryConfig,
          })),
        );
        await tx.insert(executionQueueOutbox).values({
          executionId: execution.id,
          jobPayload: { executionId: execution.id },
        });
        return {
          status: 'success' as const,
          executionId: execution.id,
          replayed: false,
        };
      });
    },
  };
}
