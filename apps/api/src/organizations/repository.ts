import { and, count, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { OrganizationRole } from '@opsflow/shared';
import type { Database } from '../db/client.js';
import { organizationMembers, organizations, users } from '../db/schema.js';

export function createOrganizationRepository(db: Database) {
  const actorMembership = alias(organizationMembers, 'actor_membership');
  return {
    async createWithOwner(name: string, slug: string, userId: string) {
      return db.transaction(async (tx) => {
        const [organization] = await tx
          .insert(organizations)
          .values({ name, slug, createdBy: userId })
          .returning();
        if (!organization)
          throw new Error('Organization insert returned no row');
        await tx
          .insert(organizationMembers)
          .values({ organizationId: organization.id, userId, role: 'owner' });
        return organization;
      });
    },
    async listForUser(userId: string) {
      return db
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          createdAt: organizations.createdAt,
          role: organizationMembers.role,
        })
        .from(organizations)
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.organizationId, organizations.id),
            eq(organizationMembers.userId, userId),
          ),
        );
    },
    async findForUser(organizationId: string, userId: string) {
      const [row] = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          createdAt: organizations.createdAt,
          role: organizationMembers.role,
        })
        .from(organizations)
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.organizationId, organizations.id),
            eq(organizationMembers.userId, userId),
          ),
        )
        .where(eq(organizations.id, organizationId))
        .limit(1);
      return row ?? null;
    },
    async listMembers(organizationId: string, actorId: string) {
      return db
        .select({
          id: organizationMembers.id,
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          role: organizationMembers.role,
          createdAt: organizationMembers.createdAt,
        })
        .from(organizationMembers)
        .innerJoin(
          actorMembership,
          and(
            eq(
              actorMembership.organizationId,
              organizationMembers.organizationId,
            ),
            eq(actorMembership.userId, actorId),
          ),
        )
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(eq(organizationMembers.organizationId, organizationId));
    },
    async changeRole(
      organizationId: string,
      actorId: string,
      memberId: string,
      role: OrganizationRole,
    ) {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .innerJoin(
            organizationMembers,
            and(
              eq(organizationMembers.organizationId, organizations.id),
              eq(organizationMembers.userId, actorId),
            ),
          )
          .where(eq(organizations.id, organizationId))
          .for('update', { of: organizations })
          .limit(1);
        if (!locked) return { status: 'not-member' as const };

        const [actor] = await tx
          .select({ role: organizationMembers.role })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.organizationId, organizationId),
              eq(organizationMembers.userId, actorId),
            ),
          )
          .limit(1);
        if (actor?.role !== 'owner') return { status: 'not-owner' as const };

        const [target] = await tx
          .select({
            id: organizationMembers.id,
            userId: users.id,
            email: users.email,
            displayName: users.displayName,
            role: organizationMembers.role,
            createdAt: organizationMembers.createdAt,
          })
          .from(organizationMembers)
          .innerJoin(users, eq(organizationMembers.userId, users.id))
          .where(
            and(
              eq(organizationMembers.organizationId, organizationId),
              eq(organizationMembers.id, memberId),
            ),
          )
          .limit(1);
        if (!target) return { status: 'target-missing' as const };

        if (target.role === 'owner' && role === 'member') {
          const [ownerCount] = await tx
            .select({ value: count() })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.organizationId, organizationId),
                eq(organizationMembers.role, 'owner'),
              ),
            );
          if ((ownerCount?.value ?? 0) <= 1)
            return { status: 'last-owner' as const };
        }

        if (target.role !== role) {
          await tx
            .update(organizationMembers)
            .set({ role })
            .where(
              and(
                eq(organizationMembers.organizationId, organizationId),
                eq(organizationMembers.id, memberId),
              ),
            );
        }
        return { status: 'success' as const, member: { ...target, role } };
      });
    },
  };
}
