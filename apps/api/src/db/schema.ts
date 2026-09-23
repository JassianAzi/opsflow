import { sql } from 'drizzle-orm';
import type {
  ExecutionQueueJob,
  WorkflowExecutionSnapshot,
} from '@opsflow/shared';
import {
  check,
  foreignKey,
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
export const executionStatus = pgEnum('execution_status', [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export const executionStepStatus = pgEnum('execution_step_status', [
  'pending',
  'running',
  'completed',
  'skipped',
  'failed',
]);
export const queueOutboxStatus = pgEnum('queue_outbox_status', [
  'pending',
  'published',
  'failed',
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
    uniqueIndex('workflows_id_organization_unique').on(
      table.id,
      table.organizationId,
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

export const workflowExecutions = pgTable(
  'workflow_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workflowId: uuid('workflow_id').notNull(),
    workflowVersion: integer('workflow_version').notNull(),
    triggerType: workflowTriggerType('trigger_type').notNull(),
    triggerPayload: jsonb('trigger_payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    workflowSnapshot: jsonb('workflow_snapshot')
      .$type<WorkflowExecutionSnapshot>()
      .notNull(),
    idempotencyKey: text('idempotency_key'),
    status: executionStatus('status').notNull().default('queued'),
    queuedAt: timestamp('queued_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    errorMessage: text('error_message'),
  },
  (table) => [
    check(
      'workflow_executions_version_positive',
      sql`${table.workflowVersion} >= 1`,
    ),
    check(
      'workflow_executions_trigger_payload_object',
      sql`jsonb_typeof(${table.triggerPayload}) = 'object'`,
    ),
    check(
      'workflow_executions_snapshot_object',
      sql`jsonb_typeof(${table.workflowSnapshot}) = 'object'`,
    ),
    check(
      'workflow_executions_timestamps_ordered',
      sql`${table.startedAt} IS NULL OR ${table.completedAt} IS NULL OR ${table.startedAt} <= ${table.completedAt}`,
    ),
    foreignKey({
      name: 'workflow_executions_workflow_org_fk',
      columns: [table.workflowId, table.organizationId],
      foreignColumns: [workflows.id, workflows.organizationId],
    }).onDelete('restrict'),
    uniqueIndex('workflow_executions_workflow_idempotency_unique')
      .on(table.workflowId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index('workflow_executions_org_queued_idx').on(
      table.organizationId,
      table.queuedAt,
    ),
    index('workflow_executions_workflow_queued_idx').on(
      table.workflowId,
      table.queuedAt,
    ),
    index('workflow_executions_status_queued_idx').on(
      table.status,
      table.queuedAt,
    ),
  ],
);

export const executionSteps = pgTable(
  'execution_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    executionId: uuid('execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    workflowStepId: uuid('workflow_step_id').notNull(),
    stepOrder: integer('step_order').notNull(),
    stepType: workflowStepType('step_type').notNull(),
    actionType: workflowActionType('action_type'),
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    retryConfig: jsonb('retry_config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: executionStepStatus('status').notNull().default('pending'),
    inputData: jsonb('input_data').$type<unknown>(),
    outputData: jsonb('output_data').$type<unknown>(),
    attemptCount: integer('attempt_count').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    errorType: text('error_type'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('execution_steps_order_nonnegative', sql`${table.stepOrder} >= 0`),
    check(
      'execution_steps_attempt_count_nonnegative',
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      'execution_steps_action_type_consistent',
      sql`(${table.stepType} = 'condition' AND ${table.actionType} IS NULL) OR (${table.stepType} = 'action' AND ${table.actionType} IS NOT NULL)`,
    ),
    check(
      'execution_steps_config_object',
      sql`jsonb_typeof(${table.config}) = 'object'`,
    ),
    check(
      'execution_steps_retry_config_object',
      sql`jsonb_typeof(${table.retryConfig}) = 'object'`,
    ),
    check(
      'execution_steps_timestamps_ordered',
      sql`${table.startedAt} IS NULL OR ${table.completedAt} IS NULL OR ${table.startedAt} <= ${table.completedAt}`,
    ),
    uniqueIndex('execution_steps_execution_order_unique').on(
      table.executionId,
      table.stepOrder,
    ),
    index('execution_steps_execution_status_idx').on(
      table.executionId,
      table.status,
    ),
  ],
);

export const executionQueueOutbox = pgTable(
  'execution_queue_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    executionId: uuid('execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    jobPayload: jsonb('job_payload').$type<ExecutionQueueJob>().notNull(),
    status: queueOutboxStatus('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'execution_queue_outbox_attempt_count_nonnegative',
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      'execution_queue_outbox_payload_matches_execution',
      sql`${table.jobPayload} = jsonb_build_object('executionId', ${table.executionId}::text)`,
    ),
    uniqueIndex('execution_queue_outbox_execution_unique').on(
      table.executionId,
    ),
    index('execution_queue_outbox_dispatch_idx').on(
      table.status,
      table.availableAt,
    ),
  ],
);
