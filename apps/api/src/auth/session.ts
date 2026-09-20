import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';

export const SESSION_COOKIE = 'opsflow_session';
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  production: boolean,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: production,
    path: '/',
    maxAge: SESSION_DURATION_MS / 1000,
  });
}

export function clearSessionCookie(
  reply: FastifyReply,
  production: boolean,
): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    secure: production,
    sameSite: 'lax',
    httpOnly: true,
  });
}
