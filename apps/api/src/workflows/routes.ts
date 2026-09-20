import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createWorkflowInputSchema,
  organizationIdParamsSchema,
  updateWorkflowInputSchema,
} from '@opsflow/shared';
import type { AuthService } from '../auth/service.js';
import { createRequireUser } from '../auth/guard.js';
import type { WorkflowService } from './service.js';

const workflowParams = organizationIdParamsSchema.extend({
  workflowId: z.uuid(),
});

export function registerWorkflowRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: WorkflowService,
): void {
  const requireUser = createRequireUser(auth);
  app.get('/api/organizations/:organizationId/workflows', async (request) => {
    const user = await requireUser(request);
    const { organizationId } = organizationIdParamsSchema.parse(request.params);
    return { workflows: await service.list(organizationId, user.id) };
  });
  app.post(
    '/api/organizations/:organizationId/workflows',
    async (request, reply) => {
      const user = await requireUser(request);
      const { organizationId } = organizationIdParamsSchema.parse(
        request.params,
      );
      const workflow = await service.create(
        organizationId,
        user.id,
        createWorkflowInputSchema.parse(request.body),
      );
      return reply.code(201).send({ workflow });
    },
  );
  app.get(
    '/api/organizations/:organizationId/workflows/:workflowId',
    async (request) => {
      const user = await requireUser(request);
      const { organizationId, workflowId } = workflowParams.parse(
        request.params,
      );
      return {
        workflow: await service.get(organizationId, workflowId, user.id),
      };
    },
  );
  app.patch(
    '/api/organizations/:organizationId/workflows/:workflowId',
    async (request) => {
      const user = await requireUser(request);
      const { organizationId, workflowId } = workflowParams.parse(
        request.params,
      );
      return {
        workflow: await service.update(
          organizationId,
          workflowId,
          user.id,
          updateWorkflowInputSchema.parse(request.body),
        ),
      };
    },
  );
  app.delete(
    '/api/organizations/:organizationId/workflows/:workflowId',
    async (request, reply) => {
      const user = await requireUser(request);
      const { organizationId, workflowId } = workflowParams.parse(
        request.params,
      );
      await service.remove(organizationId, workflowId, user.id);
      return reply.code(204).send();
    },
  );
  app.post(
    '/api/organizations/:organizationId/workflows/:workflowId/activate',
    async (request) => {
      const user = await requireUser(request);
      const { organizationId, workflowId } = workflowParams.parse(
        request.params,
      );
      return {
        workflow: await service.activate(organizationId, workflowId, user.id),
      };
    },
  );
  app.post(
    '/api/organizations/:organizationId/workflows/:workflowId/deactivate',
    async (request) => {
      const user = await requireUser(request);
      const { organizationId, workflowId } = workflowParams.parse(
        request.params,
      );
      return {
        workflow: await service.deactivate(organizationId, workflowId, user.id),
      };
    },
  );
}
