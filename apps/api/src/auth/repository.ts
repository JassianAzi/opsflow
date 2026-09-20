import { and, eq, gt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sessions, users } from '../db/schema.js';

export function createAuthRepository(db: Database) {
  return {
    async createUser(email: string, passwordHash: string, displayName: string) {
      const [user] = await db
        .insert(users)
        .values({ email, passwordHash, displayName })
        .returning();
      if (!user) throw new Error('User insert returned no row');
      return user;
    },
    async findUserByEmail(email: string) {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return user ?? null;
    },
    async createSession(userId: string, tokenHash: string, expiresAt: Date) {
      await db.insert(sessions).values({ userId, tokenHash, expiresAt });
    },
    async findActiveSession(tokenHash: string) {
      const [row] = await db
        .select({
          sessionId: sessions.id,
          lastSeenAt: sessions.lastSeenAt,
          user: {
            id: users.id,
            email: users.email,
            displayName: users.displayName,
            createdAt: users.createdAt,
          },
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            gt(sessions.expiresAt, new Date()),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async touchSession(sessionId: string) {
      await db
        .update(sessions)
        .set({ lastSeenAt: new Date() })
        .where(eq(sessions.id, sessionId));
    },
    async deleteSession(tokenHash: string) {
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    },
  };
}
