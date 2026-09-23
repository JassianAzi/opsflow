import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  idempotencyKeySchema,
  organizationIdParamsSchema,
} from '@opsflow/shared';
import { createRequireUser } from '../auth/guard.js';
import type { AuthService } from '../auth/service.js';
import type { ExecutionService } from './service.js';

const workflowParams = organizationIdParamsSchema.extend({
  workflowId: z.uuid(),
});

export function registerExecutionRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: ExecutionService,
): void {
  const requireUser = createRequireUser(auth);
  app.post(
    '/api/organizations/:organizationId/workflows/:workflowId/test',
    async (request, reply) => {
      const user = await requireUser(request);
      const { organizationId, workflowId } = workflowParams.parse(
        request.params,
      );
      const idempotencyKey = idempotencyKeySchema
        .optional()
        .parse(request.headers['idempotency-key']);
      const execution = await service.createManualTest(
        organizationId,
        workflowId,
        user.id,
        idempotencyKey,
      );
      return reply.code(202).send(execution);
    },
  );
}
