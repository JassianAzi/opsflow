import { randomBytes } from 'node:crypto';
import type {
  CreateOrganizationInput,
  OrganizationMember,
  OrganizationRole,
  OrganizationSummary,
} from '@opsflow/shared';
import { ApiError } from '../errors.js';
import { createOrganizationRepository } from './repository.js';

type OrganizationRepository = ReturnType<typeof createOrganizationRepository>;

function summary(row: {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
  createdAt: Date;
}): OrganizationSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

function member(row: {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: OrganizationRole;
  createdAt: Date;
}): OrganizationMember {
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

function createSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `${base || 'organization'}-${randomBytes(5).toString('hex')}`;
}

export function createOrganizationService(repository: OrganizationRepository) {
  async function requireOrganization(organizationId: string, userId: string) {
    const organization = await repository.findForUser(organizationId, userId);
    if (!organization) {
      throw new ApiError(
        404,
        'ORGANIZATION_NOT_FOUND',
        'Organization not found.',
      );
    }
    return organization;
  }

  return {
    async create(
      input: CreateOrganizationInput,
      userId: string,
    ): Promise<OrganizationSummary> {
      const organization = await repository.createWithOwner(
        input.name,
        createSlug(input.name),
        userId,
      );
      return summary({ ...organization, role: 'owner' });
    },
    async list(userId: string): Promise<OrganizationSummary[]> {
      return (await repository.listForUser(userId)).map(summary);
    },
    async get(
      organizationId: string,
      userId: string,
    ): Promise<OrganizationSummary> {
      return summary(await requireOrganization(organizationId, userId));
    },
    async members(
      organizationId: string,
      userId: string,
    ): Promise<OrganizationMember[]> {
      await requireOrganization(organizationId, userId);
      return (await repository.listMembers(organizationId, userId)).map(member);
    },
    async changeRole(
      organizationId: string,
      actorId: string,
      memberId: string,
      role: OrganizationRole,
    ): Promise<OrganizationMember> {
      const result = await repository.changeRole(
        organizationId,
        actorId,
        memberId,
        role,
      );
      switch (result.status) {
        case 'not-member':
          throw new ApiError(
            404,
            'ORGANIZATION_NOT_FOUND',
            'Organization not found.',
          );
        case 'not-owner':
          throw new ApiError(
            403,
            'OWNER_REQUIRED',
            'Only an owner can change member roles.',
          );
        case 'target-missing':
          throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Member not found.');
        case 'last-owner':
          throw new ApiError(
            409,
            'LAST_OWNER',
            'An organization must keep at least one owner.',
          );
        case 'success':
          return member(result.member);
      }
    },
  };
}

export type OrganizationService = ReturnType<typeof createOrganizationService>;
