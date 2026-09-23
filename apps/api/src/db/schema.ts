import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const organizationRole = pgEnum('organization_role', [
  'owner',
  'member',
]);
export const workflowStatus = pgEnum('workflow_status', [
  'draft',
  'active',
  'inactive',
]);
export const workflowTriggerType = pgEnum('workflow_trigger_type', [
  'manual',
  'webhook',
  'schedule',
]);
export const workflowStepType = pgEnum('workflow_step_type', [
  'condition',
  'action',
]);
export const workflowActionType = pgEnum('workflow_action_type', [
  'log',
  'internal_task',
  'mock_email',
  'http_request',
  'ai',
]);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('users_email_normalized_unique').on(sql`lower(${table.email})`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const organizationMembers = pgTable(
  'organization_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: organizationRole('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('organization_members_org_user_unique').on(
      table.organizationId,
      table.userId,
    ),
    index('organization_members_user_id_idx').on(table.userId),
  ],
);

export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: workflowStatus('status').notNull().default('draft'),
    triggerType: workflowTriggerType('trigger_type').notNull(),
    triggerConfig: jsonb('trigger_config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('workflows_version_positive', sql`${table.version} >= 1`),
    index('workflows_organization_updated_idx').on(
      table.organizationId,
      table.updatedAt,
    ),
  ],
);

export const workflowSteps = pgTable(
  'workflow_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    stepOrder: integer('step_order').notNull(),
    stepType: workflowStepType('step_type').notNull(),
    actionType: workflowActionType('action_type'),
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    retryConfig: jsonb('retry_config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('workflow_steps_order_nonnegative', sql`${table.stepOrder} >= 0`),
    check(
      'workflow_steps_action_type_consistent',
      sql`(${table.stepType} = 'condition' AND ${table.actionType} IS NULL) OR (${table.stepType} = 'action' AND ${table.actionType} IS NOT NULL)`,
    ),
    uniqueIndex('workflow_steps_workflow_order_unique').on(
      table.workflowId,
      table.stepOrder,
    ),
  ],
);
