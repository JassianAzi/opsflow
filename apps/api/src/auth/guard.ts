import type { FastifyRequest } from 'fastify';
import type { PublicUser } from '@opsflow/shared';
import { ApiError } from '../errors.js';
import type { AuthService } from './service.js';
import { SESSION_COOKIE } from './session.js';

export function createRequireUser(service: AuthService) {
  return async (request: FastifyRequest): Promise<PublicUser> => {
    const user = await service.currentUser(request.cookies[SESSION_COOKIE]);
    if (!user)
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required.');
    return user;
  };
}
