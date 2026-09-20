import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { HealthResponse } from '@opsflow/shared';
import type { Database } from './db/client.js';
import { createAuthRepository } from './auth/repository.js';
import { createAuthService } from './auth/service.js';
import { registerAuthRoutes } from './auth/routes.js';
import { createOrganizationRepository } from './organizations/repository.js';
import { createOrganizationService } from './organizations/service.js';
import { registerOrganizationRoutes } from './organizations/routes.js';
import { ApiError, installErrorHandler } from './errors.js';
import { createWorkflowRepository } from './workflows/repository.js';
import { createWorkflowService } from './workflows/service.js';
import { registerWorkflowRoutes } from './workflows/routes.js';

export interface AppOptions {
  database: Database;
  production: boolean;
  webOrigin: string;
  logger?: boolean;
}

export function buildApp(options: AppOptions) {
  const app = Fastify({
    logger: options.logger ?? {
      redact: ['req.headers.cookie', 'req.headers.authorization'],
    },
  });
  app.register(cookie);
  installErrorHandler(app);

  app.addHook('onRequest', async (request) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && origin !== options.webOrigin) {
        throw new ApiError(
          403,
          'INVALID_ORIGIN',
          'Request origin is not allowed.',
        );
      }
    }
  });

  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'api',
    timestamp: new Date().toISOString(),
  }));

  const auth = createAuthService(createAuthRepository(options.database));
  const organizations = createOrganizationService(
    createOrganizationRepository(options.database),
  );
  registerAuthRoutes(app, auth, options.production);
  registerOrganizationRoutes(app, auth, organizations);
  const workflows = createWorkflowService(
    createWorkflowRepository(options.database),
    organizations,
  );
  registerWorkflowRoutes(app, auth, workflows);

  return app;
}
