import type { FastifyInstance } from 'fastify';
import {
  changeMemberRoleInputSchema,
  createOrganizationInputSchema,
  memberIdParamsSchema,
  organizationIdParamsSchema,
} from '@opsflow/shared';
import type { AuthService } from '../auth/service.js';
import { createRequireUser } from '../auth/guard.js';
import type { OrganizationService } from './service.js';

export function registerOrganizationRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: OrganizationService,
): void {
  const requireUser = createRequireUser(auth);

  app.get('/api/organizations', async (request) => {
    const user = await requireUser(request);
    return { organizations: await service.list(user.id) };
  });

  app.post('/api/organizations', async (request, reply) => {
    const user = await requireUser(request);
    const organization = await service.create(
      createOrganizationInputSchema.parse(request.body),
      user.id,
    );
    return reply.code(201).send({ organization });
  });

  app.get('/api/organizations/:organizationId', async (request) => {
    const user = await requireUser(request);
    const { organizationId } = organizationIdParamsSchema.parse(request.params);
    return { organization: await service.get(organizationId, user.id) };
  });

  app.get('/api/organizations/:organizationId/members', async (request) => {
    const user = await requireUser(request);
    const { organizationId } = organizationIdParamsSchema.parse(request.params);
    return { members: await service.members(organizationId, user.id) };
  });

  app.patch(
    '/api/organizations/:organizationId/members/:memberId',
    async (request) => {
      const user = await requireUser(request);
      const { organizationId, memberId } = memberIdParamsSchema.parse(
        request.params,
      );
      const { role } = changeMemberRoleInputSchema.parse(request.body);
      return {
        member: await service.changeRole(
          organizationId,
          user.id,
          memberId,
          role,
        ),
      };
    },
  );
}
