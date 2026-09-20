import type { LoginInput, PublicUser, RegisterInput } from '@opsflow/shared';
import { ApiError } from '../errors.js';
import { createAuthRepository } from './repository.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  createSessionToken,
  hashSessionToken,
  SESSION_DURATION_MS,
} from './session.js';

type AuthRepository = ReturnType<typeof createAuthRepository>;

function publicUser(user: {
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
}): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
  };
}

function isEmailConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if (
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'users_email_normalized_unique'
  )
    return true;
  return 'cause' in error && isEmailConflict(error.cause);
}

export function createAuthService(repository: AuthRepository) {
  return {
    async register(input: RegisterInput): Promise<PublicUser> {
      const email = input.email.trim().toLowerCase();
      const passwordHash = await hashPassword(input.password);
      try {
        return publicUser(
          await repository.createUser(email, passwordHash, input.displayName),
        );
      } catch (error) {
        if (isEmailConflict(error))
          throw new ApiError(
            409,
            'EMAIL_ALREADY_REGISTERED',
            'Email is already registered.',
          );
        throw error;
      }
    },
    async login(
      input: LoginInput,
    ): Promise<{ user: PublicUser; token: string }> {
      const user = await repository.findUserByEmail(
        input.email.trim().toLowerCase(),
      );
      if (!user) {
        await hashPassword(input.password);
        throw new ApiError(
          401,
          'INVALID_CREDENTIALS',
          'Invalid email or password.',
        );
      }
      if (!(await verifyPassword(input.password, user.passwordHash))) {
        throw new ApiError(
          401,
          'INVALID_CREDENTIALS',
          'Invalid email or password.',
        );
      }
      const token = createSessionToken();
      await repository.createSession(
        user.id,
        hashSessionToken(token),
        new Date(Date.now() + SESSION_DURATION_MS),
      );
      return { user: publicUser(user), token };
    },
    async currentUser(token: string | undefined): Promise<PublicUser | null> {
      if (!token) return null;
      const session = await repository.findActiveSession(
        hashSessionToken(token),
      );
      if (!session) return null;
      if (Date.now() - session.lastSeenAt.getTime() > 5 * 60 * 1000) {
        await repository.touchSession(session.sessionId);
      }
      return publicUser(session.user);
    },
    async logout(token: string | undefined): Promise<void> {
      if (token) await repository.deleteSession(hashSessionToken(token));
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
