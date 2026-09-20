import type { FastifyInstance } from 'fastify';
import { loginInputSchema, registerInputSchema } from '@opsflow/shared';
import type { AuthService } from './service.js';
import { createRequireUser } from './guard.js';
import {
  clearSessionCookie,
  SESSION_COOKIE,
  setSessionCookie,
} from './session.js';

export function registerAuthRoutes(
  app: FastifyInstance,
  service: AuthService,
  production: boolean,
): void {
  const requireUser = createRequireUser(service);

  app.post('/api/auth/register', async (request, reply) => {
    const user = await service.register(
      registerInputSchema.parse(request.body),
    );
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const result = await service.login(loginInputSchema.parse(request.body));
    setSessionCookie(reply, result.token, production);
    return { user: result.user };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await service.logout(request.cookies[SESSION_COOKIE]);
    clearSessionCookie(reply, production);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (request) => ({
    user: await requireUser(request),
  }));
}
