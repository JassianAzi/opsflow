import { z } from 'zod';

export const serviceNameSchema = z.enum(['api', 'worker']);

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: serviceNameSchema,
  timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const registerInputSchema = z.object({
  email: z.string().trim().pipe(z.email().max(254)),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(1).max(100),
});

export const loginInputSchema = z.object({
  email: z.string().trim().pipe(z.email().max(254)),
  password: z.string().min(1),
});

export const organizationRoleSchema = z.enum(['owner', 'member']);

export const createOrganizationInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const changeMemberRoleInputSchema = z.object({
  role: organizationRoleSchema,
});

export const organizationIdParamsSchema = z.object({
  organizationId: z.uuid(),
});

export const memberIdParamsSchema = organizationIdParamsSchema.extend({
  memberId: z.uuid(),
});

export type RegisterInput = z.infer<typeof registerInputSchema>;
export type LoginInput = z.infer<typeof loginInputSchema>;
export type CreateOrganizationInput = z.infer<
  typeof createOrganizationInputSchema
>;
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
  createdAt: string;
}

export interface OrganizationMember {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: OrganizationRole;
  createdAt: string;
}
