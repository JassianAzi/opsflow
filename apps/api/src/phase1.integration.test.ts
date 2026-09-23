import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { workflowExecutionSnapshotSchema } from '@opsflow/shared';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from './app.js';
import { createDatabase } from './db/client.js';
import {
  executionQueueOutbox,
  executionSteps,
  organizationMembers,
  sessions,
  users,
  workflowExecutions,
  workflowSteps,
  workflows,
} from './db/schema.js';

const password = 'correct horse battery staple';
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = testDatabaseUrl ? describe : describe.skip;

databaseDescribe(
  'Authentication, organizations, and workflows API integration',
  () => {
    let database: ReturnType<typeof createDatabase>;
    let app: ReturnType<typeof buildApp>;

    beforeAll(async () => {
      if (
        !testDatabaseUrl ||
        new URL(testDatabaseUrl).pathname !== '/opsflow_test'
      ) {
        throw new Error(
          'Integration tests require a dedicated opsflow_test database.',
        );
      }
      database = createDatabase(testDatabaseUrl);
      await migrate(database.db, {
        migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
      });
      app = buildApp({
        database: database.db,
        production: false,
        webOrigin: 'http://127.0.0.1:5173',
        logger: false,
      });
      await app.ready();
    });

    afterAll(async () => {
      if (app) await app.close();
      if (database) await database.pool.end();
    });

    beforeEach(async () => {
      await database.db.execute(
        sql`TRUNCATE TABLE execution_queue_outbox, execution_steps, workflow_executions, workflow_steps, workflows, organization_members, organizations, sessions, users CASCADE`,
      );
    });

    async function register(email: string, displayName = 'Example User') {
      return app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password, displayName },
      });
    }

    async function login(email: string, suppliedPassword = password) {
      return app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: suppliedPassword },
      });
    }

    function cookieFrom(response: Awaited<ReturnType<typeof login>>): string {
      const header = response.headers['set-cookie'];
      const value = Array.isArray(header) ? header[0] : header;
      if (!value) throw new Error('Expected a session cookie');
      return value.split(';')[0] ?? '';
    }

    async function createOrganization(cookie: string, name: string) {
      return app.inject({
        method: 'POST',
        url: '/api/organizations',
        headers: { cookie },
        payload: { name },
      });
    }

    it('registers a normalized email without exposing the password hash', async () => {
      const response = await register('  ALICE@example.com  ', 'Alice');
      expect(response.statusCode).toBe(201);
      expect(response.json().user).toMatchObject({
        email: 'alice@example.com',
        displayName: 'Alice',
      });
      expect(response.body).not.toContain('passwordHash');
      expect(response.body).not.toContain('password_hash');
      const [stored] = await database.db
        .select({ passwordHash: users.passwordHash })
        .from(users);
      expect(stored?.passwordHash).toMatch(/^scrypt:[a-f0-9]+:[a-f0-9]+$/);
      expect(stored?.passwordHash).not.toContain(password);
    });

    it('rejects duplicate email regardless of case', async () => {
      await register('alice@example.com');
      const response = await register('ALICE@example.com');
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('EMAIL_ALREADY_REGISTERED');
    });

    it('logs in with an HTTP-only cookie, stores a token hash, and resolves /me', async () => {
      await register('alice@example.com');
      const response = await login('ALICE@example.com');
      expect(response.statusCode).toBe(200);
      const cookie = cookieFrom(response);
      expect(response.headers['set-cookie']).toContain('HttpOnly');
      expect(response.headers['set-cookie']).toContain('SameSite=Lax');
      const [{ tokenHash }] = await database.db
        .select({ tokenHash: sessions.tokenHash })
        .from(sessions);
      const rawToken = cookie.slice(cookie.indexOf('=') + 1);
      expect(tokenHash).toBe(
        createHash('sha256').update(rawToken).digest('hex'),
      );
      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.email).toBe('alice@example.com');
    });

    it('rejects invalid credentials with the same response for unknown users', async () => {
      await register('alice@example.com');
      const wrongPassword = await login('alice@example.com', 'wrong password');
      const unknownUser = await login('nobody@example.com', 'wrong password');
      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownUser.statusCode).toBe(401);
      expect(wrongPassword.json()).toEqual(unknownUser.json());
    });

    it('rejects unauthenticated and expired sessions', async () => {
      const unauthenticated = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
      });
      expect(unauthenticated.statusCode).toBe(401);
      await register('alice@example.com');
      const cookie = cookieFrom(await login('alice@example.com'));
      await database.db.update(sessions).set({ expiresAt: new Date(0) });
      const expired = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie },
      });
      expect(expired.statusCode).toBe(401);
    });

    it('logs out and invalidates the server-side session', async () => {
      await register('alice@example.com');
      const cookie = cookieFrom(await login('alice@example.com'));
      const logout = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie },
      });
      expect(logout.statusCode).toBe(204);
      expect(logout.headers['set-cookie']).toContain('Max-Age=0');
      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie },
      });
      expect(me.statusCode).toBe(401);
    });

    it('refreshes last-seen time for an active session', async () => {
      await register('alice@example.com');
      const cookie = cookieFrom(await login('alice@example.com'));
      await database.db.update(sessions).set({ lastSeenAt: new Date(0) });
      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie },
      });
      expect(me.statusCode).toBe(200);
      const [session] = await database.db
        .select({ lastSeenAt: sessions.lastSeenAt })
        .from(sessions);
      expect(session?.lastSeenAt.getTime()).toBeGreaterThan(
        Date.now() - 30_000,
      );
    });

    it('marks the session cookie Secure in production mode', async () => {
      await register('alice@example.com');
      const productionApp = buildApp({
        database: database.db,
        production: true,
        webOrigin: 'https://opsflow.example',
        logger: false,
      });
      try {
        const response = await productionApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 'alice@example.com', password },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['set-cookie']).toContain('Secure');
      } finally {
        await productionApp.close();
      }
    });

    it('creates an organization and owner membership atomically', async () => {
      await register('alice@example.com');
      const cookie = cookieFrom(await login('alice@example.com'));
      const response = await createOrganization(cookie, 'Acme Team');
      expect(response.statusCode).toBe(201);
      expect(response.json().organization).toMatchObject({
        name: 'Acme Team',
        role: 'owner',
      });
      const memberships = await database.db.select().from(organizationMembers);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.role).toBe('owner');
    });

    it('lists only organizations of the signed-in user', async () => {
      await register('alice@example.com');
      await register('bob@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const bob = cookieFrom(await login('bob@example.com'));
      await createOrganization(alice, 'Alice Team');
      await createOrganization(bob, 'Bob Team');
      const response = await app.inject({
        method: 'GET',
        url: '/api/organizations',
        headers: { cookie: alice },
      });
      expect(response.statusCode).toBe(200);
      expect(
        response
          .json()
          .organizations.map(
            (organization: { name: string }) => organization.name,
          ),
      ).toEqual(['Alice Team']);
    });

    it('hides organization and members from non-members', async () => {
      await register('alice@example.com');
      await register('bob@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const bob = cookieFrom(await login('bob@example.com'));
      const organizationId = (
        await createOrganization(alice, 'Private Team')
      ).json().organization.id as string;
      for (const path of [
        `/api/organizations/${organizationId}`,
        `/api/organizations/${organizationId}/members`,
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: path,
          headers: { cookie: bob },
        });
        expect(response.statusCode).toBe(404);
      }
    });

    it('allows owners to view members and prevents demoting the last owner', async () => {
      await register('alice@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const organizationId = (
        await createOrganization(alice, 'Acme Team')
      ).json().organization.id as string;
      const membersResponse = await app.inject({
        method: 'GET',
        url: `/api/organizations/${organizationId}/members`,
        headers: { cookie: alice },
      });
      expect(membersResponse.statusCode).toBe(200);
      expect(membersResponse.json().members).toHaveLength(1);
      const memberId = membersResponse.json().members[0].id as string;
      const demotion = await app.inject({
        method: 'PATCH',
        url: `/api/organizations/${organizationId}/members/${memberId}`,
        headers: { cookie: alice },
        payload: { role: 'member' },
      });
      expect(demotion.statusCode).toBe(409);
      expect(demotion.json().error.code).toBe('LAST_OWNER');
    });

    it('rejects member role changes and allows an owner to promote a member', async () => {
      const aliceUser = (await register('alice@example.com')).json().user;
      const bobUser = (await register('bob@example.com')).json().user;
      const alice = cookieFrom(await login('alice@example.com'));
      const bob = cookieFrom(await login('bob@example.com'));
      const organizationId = (
        await createOrganization(alice, 'Shared Team')
      ).json().organization.id as string;
      const [membership] = await database.db
        .insert(organizationMembers)
        .values({ organizationId, userId: bobUser.id, role: 'member' })
        .returning();
      expect(aliceUser.id).toBeDefined();
      const path = `/api/organizations/${organizationId}/members/${membership.id}`;
      const denied = await app.inject({
        method: 'PATCH',
        url: path,
        headers: { cookie: bob },
        payload: { role: 'owner' },
      });
      expect(denied.statusCode).toBe(403);
      const promoted = await app.inject({
        method: 'PATCH',
        url: path,
        headers: { cookie: alice },
        payload: { role: 'owner' },
      });
      expect(promoted.statusCode).toBe(200);
      expect(promoted.json().member.role).toBe('owner');
    });

    it('rejects a cross-origin mutation', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { origin: 'https://other.example' },
        payload: { email: 'alice@example.com', password, displayName: 'Alice' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('INVALID_ORIGIN');
    });

    async function createWorkflow(
      organizationId: string,
      cookie: string,
      payload: Record<string, unknown> = {},
    ) {
      return app.inject({
        method: 'POST',
        url: `/api/organizations/${organizationId}/workflows`,
        headers: { cookie },
        payload: {
          name: 'Follow up',
          triggerType: 'manual',
          triggerConfig: {},
          ...payload,
        },
      });
    }

    async function createActiveManualWorkflow(
      organizationId: string,
      cookie: string,
      message = 'Original event',
    ) {
      const created = await createWorkflow(organizationId, cookie);
      const workflowId = created.json().workflow.id as string;
      const configured = await app.inject({
        method: 'PATCH',
        url: `/api/organizations/${organizationId}/workflows/${workflowId}`,
        headers: { cookie },
        payload: {
          expectedVersion: 1,
          steps: [
            {
              stepType: 'action',
              actionType: 'log',
              name: 'Record event',
              config: { message },
              retryConfig: { maxAttempts: 2 },
            },
          ],
        },
      });
      expect(configured.statusCode).toBe(200);
      const activated = await app.inject({
        method: 'POST',
        url: `/api/organizations/${organizationId}/workflows/${workflowId}/activate`,
        headers: { cookie },
      });
      expect(activated.statusCode).toBe(200);
      return activated.json().workflow;
    }

    it('creates, reads, updates, lists, and deletes a workflow with version tracking', async () => {
      await register('alice@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const organizationId = (await createOrganization(alice, 'Acme')).json()
        .organization.id as string;
      const created = await createWorkflow(organizationId, alice);
      expect(created.statusCode).toBe(201);
      const workflowId = created.json().workflow.id as string;
      expect(created.json().workflow).toMatchObject({
        status: 'draft',
        version: 1,
        steps: [],
      });
      const base = `/api/organizations/${organizationId}/workflows/${workflowId}`;
      const read = await app.inject({
        method: 'GET',
        url: base,
        headers: { cookie: alice },
      });
      expect(read.statusCode).toBe(200);
      const changed = await app.inject({
        method: 'PATCH',
        url: base,
        headers: { cookie: alice },
        payload: {
          expectedVersion: 1,
          name: 'Updated',
          description: 'A useful description',
        },
      });
      expect(changed.json().workflow).toMatchObject({
        name: 'Updated',
        description: 'A useful description',
        version: 2,
      });
      const same = await app.inject({
        method: 'PATCH',
        url: base,
        headers: { cookie: alice },
        payload: { expectedVersion: 2, name: 'Updated' },
      });
      expect(same.json().workflow.version).toBe(2);
      const list = await app.inject({
        method: 'GET',
        url: `/api/organizations/${organizationId}/workflows`,
        headers: { cookie: alice },
      });
      expect(
        list.json().workflows.map((workflow: { id: string }) => workflow.id),
      ).toEqual([workflowId]);
      const removed = await app.inject({
        method: 'DELETE',
        url: base,
        headers: { cookie: alice },
      });
      expect(removed.statusCode).toBe(204);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: base,
            headers: { cookie: alice },
          })
        ).statusCode,
      ).toBe(404);
    });

    it('allows a member to edit and list, while hiding organizations and cross-organization workflows', async () => {
      await register('alice@example.com');
      const bobUser = (await register('bob@example.com')).json().user;
      await register('charlie@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const bob = cookieFrom(await login('bob@example.com'));
      const charlie = cookieFrom(await login('charlie@example.com'));
      const orgA = (await createOrganization(alice, 'A')).json().organization
        .id as string;
      const orgB = (await createOrganization(charlie, 'B')).json().organization
        .id as string;
      await database.db
        .insert(organizationMembers)
        .values({ organizationId: orgA, userId: bobUser.id, role: 'member' });
      const id = (await createWorkflow(orgA, bob)).json().workflow.id as string;
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgA}/workflows`,
            headers: { cookie: bob },
          })
        ).json().workflows,
      ).toHaveLength(1);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/organizations/${orgA}/workflows/${id}`,
            headers: { cookie: bob },
            payload: { expectedVersion: 1, name: 'Edited by member' },
          })
        ).statusCode,
      ).toBe(200);
      for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
        const result = await app.inject({
          method,
          url: `/api/organizations/${orgB}/workflows/${id}`,
          headers: { cookie: bob },
          ...(method === 'PATCH'
            ? { payload: { expectedVersion: 1, name: 'No' } }
            : {}),
        });
        expect(result.statusCode).toBe(404);
      }
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgB}/workflows/${id}`,
            headers: { cookie: charlie },
          })
        ).statusCode,
      ).toBe(404);
      for (const action of ['activate', 'deactivate']) {
        const crossOrganization = await app.inject({
          method: 'POST',
          url: `/api/organizations/${orgB}/workflows/${id}/${action}`,
          headers: { cookie: charlie },
        });
        expect(crossOrganization.statusCode).toBe(404);
        expect(crossOrganization.json().error.code).toBe('WORKFLOW_NOT_FOUND');

        const nonMember = await app.inject({
          method: 'POST',
          url: `/api/organizations/${orgB}/workflows/${id}/${action}`,
          headers: { cookie: bob },
        });
        expect(nonMember.statusCode).toBe(404);
        expect(nonMember.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
      }
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgB}/workflows`,
            headers: { cookie: bob },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgA}/workflows`,
            headers: { cookie: charlie },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgA}/workflows`,
          })
        ).statusCode,
      ).toBe(401);
    });

    it('rejects invalid trigger, condition, and action configurations', async () => {
      await register('alice@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const organizationId = (await createOrganization(alice, 'Acme')).json()
        .organization.id as string;
      expect(
        (
          await createWorkflow(organizationId, alice, {
            triggerType: 'unknown',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await createWorkflow(organizationId, alice, {
            triggerType: 'schedule',
            triggerConfig: { cron: '99 * * * *' },
          })
        ).statusCode,
      ).toBe(400);
      const id = (await createWorkflow(organizationId, alice)).json().workflow
        .id as string;
      const url = `/api/organizations/${organizationId}/workflows/${id}`;
      const invalidSteps = [
        [
          {
            stepType: 'condition',
            actionType: null,
            name: 'Check',
            config: { field: 'customer.status', operator: 'equals' },
            retryConfig: {},
          },
        ],
        [
          {
            stepType: 'action',
            actionType: 'mock_email',
            name: 'Email',
            config: { to: 'invalid', subject: 'Hi', body: 'Body' },
            retryConfig: {},
          },
        ],
        [
          {
            stepType: 'action',
            actionType: 'unsupported',
            name: 'Unknown',
            config: {},
            retryConfig: {},
          },
        ],
      ];
      for (const steps of invalidSteps) {
        const response = await app.inject({
          method: 'PATCH',
          url,
          headers: { cookie: alice },
          payload: { expectedVersion: 1, steps },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('activates only a complete ordered workflow and does not execute it', async () => {
      await register('alice@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const organizationId = (await createOrganization(alice, 'Acme')).json()
        .organization.id as string;
      const id = (
        await createWorkflow(organizationId, alice, { triggerType: 'schedule' })
      ).json().workflow.id as string;
      const url = `/api/organizations/${organizationId}/workflows/${id}`;
      const activate = `${url}/activate`;
      const empty = await app.inject({
        method: 'POST',
        url: activate,
        headers: { cookie: alice },
      });
      expect(empty.statusCode).toBe(400);
      expect(empty.json().error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'steps' }),
          expect.objectContaining({ path: 'triggerConfig.cron' }),
        ]),
      );
      const steps = [
        {
          stepType: 'condition',
          actionType: null,
          name: 'Check status',
          config: {
            field: 'customer.status',
            operator: 'equals',
            value: 'active',
          },
          retryConfig: {},
        },
        {
          stepType: 'action',
          actionType: 'log',
          name: 'Log event',
          config: { message: 'Ready' },
          retryConfig: {},
        },
        {
          stepType: 'action',
          actionType: 'internal_task',
          name: 'Create task',
          config: { title: 'Follow up', description: '' },
          retryConfig: {},
        },
      ];
      const unordered = await app.inject({
        method: 'PATCH',
        url,
        headers: { cookie: alice },
        payload: { expectedVersion: 1, steps: [steps[1], steps[0]] },
      });
      expect(unordered.statusCode).toBe(400);
      const saved = await app.inject({
        method: 'PATCH',
        url,
        headers: { cookie: alice },
        payload: {
          expectedVersion: 1,
          triggerConfig: { cron: '0 9 * * 1-5', timezone: 'UTC' },
          steps,
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(
        saved
          .json()
          .workflow.steps.map((step: { stepOrder: number }) => step.stepOrder),
      ).toEqual([0, 1, 2]);
      await expect(
        database.db.insert(workflowSteps).values({
          workflowId: id,
          stepOrder: 0,
          stepType: 'action',
          actionType: 'log',
          name: 'Duplicate order',
          config: { message: 'No' },
        }),
      ).rejects.toThrow();
      expect(saved.json().workflow.version).toBe(2);
      const originalStepIds = saved
        .json()
        .workflow.steps.map((step: { id: string }) => step.id);
      const metadataOnly = await app.inject({
        method: 'PATCH',
        url,
        headers: { cookie: alice },
        payload: {
          expectedVersion: 2,
          description: 'Ready to activate',
          steps,
        },
      });
      expect(metadataOnly.statusCode).toBe(200);
      expect(metadataOnly.json().workflow.version).toBe(3);
      expect(
        metadataOnly
          .json()
          .workflow.steps.map((step: { id: string }) => step.id),
      ).toEqual(originalStepIds);
      const active = await app.inject({
        method: 'POST',
        url: activate,
        headers: { cookie: alice },
      });
      expect(active.statusCode).toBe(200);
      expect(active.json().workflow.status).toBe('active');
      expect(active.json().workflow.version).toBe(3);
      const invalidWhileActive = await app.inject({
        method: 'PATCH',
        url,
        headers: { cookie: alice },
        payload: { expectedVersion: 3, steps: [] },
      });
      expect(invalidWhileActive.statusCode).toBe(400);
      const inactive = await app.inject({
        method: 'POST',
        url: `${url}/deactivate`,
        headers: { cookie: alice },
      });
      expect(inactive.json().workflow.status).toBe('inactive');
      expect(inactive.json().workflow.version).toBe(3);
    });

    it('rejects a stale workflow update without overwriting the newer definition', async () => {
      await register('alice@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const organizationId = (await createOrganization(alice, 'Acme')).json()
        .organization.id as string;
      const workflow = (await createWorkflow(organizationId, alice)).json()
        .workflow;
      const url = `/api/organizations/${organizationId}/workflows/${workflow.id}`;

      const first = await app.inject({
        method: 'PATCH',
        url,
        headers: { cookie: alice },
        payload: { expectedVersion: 1, name: 'Newer name' },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().workflow).toMatchObject({
        name: 'Newer name',
        version: 2,
      });

      const stale = await app.inject({
        method: 'PATCH',
        url,
        headers: { cookie: alice },
        payload: { expectedVersion: 1, description: 'Stale description' },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toEqual({
        error: {
          code: 'WORKFLOW_VERSION_CONFLICT',
          message:
            'This workflow changed after you opened it. Reload version 2 before saving.',
        },
      });

      const persisted = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: alice },
      });
      expect(persisted.json().workflow).toMatchObject({
        name: 'Newer name',
        description: '',
        version: 2,
      });

      const current = await app.inject({
        method: 'PATCH',
        url,
        headers: { cookie: alice },
        payload: { expectedVersion: 2, description: 'Current description' },
      });
      expect(current.statusCode).toBe(200);
      expect(current.json().workflow).toMatchObject({
        description: 'Current description',
        version: 3,
      });
    });

    it('enforces workflow integrity constraints in PostgreSQL', async () => {
      await register('alice@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const organizationId = (await createOrganization(alice, 'Acme')).json()
        .organization.id as string;
      const workflowId = (await createWorkflow(organizationId, alice)).json()
        .workflow.id as string;

      await expect(
        database.db
          .update(workflows)
          .set({ version: 0 })
          .where(sql`${workflows.id} = ${workflowId}`),
      ).rejects.toThrow();
      await expect(
        database.db.insert(workflowSteps).values({
          workflowId,
          stepOrder: -1,
          stepType: 'action',
          actionType: 'log',
          name: 'Negative order',
          config: { message: 'No' },
        }),
      ).rejects.toThrow();
      await expect(
        database.db.insert(workflowSteps).values({
          workflowId,
          stepOrder: 0,
          stepType: 'condition',
          actionType: 'log',
          name: 'Inconsistent action type',
          config: {
            field: 'customer.status',
            operator: 'exists',
          },
        }),
      ).rejects.toThrow();
    });

    it('creates a queued manual test execution for an organization member', async () => {
      await register('alice@example.com');
      const bobUser = (await register('bob@example.com')).json().user;
      const alice = cookieFrom(await login('alice@example.com'));
      const bob = cookieFrom(await login('bob@example.com'));
      const organizationId = (await createOrganization(alice, 'Acme')).json()
        .organization.id as string;
      await database.db.insert(organizationMembers).values({
        organizationId,
        userId: bobUser.id,
        role: 'member',
      });
      const workflow = await createActiveManualWorkflow(organizationId, alice);

      const response = await app.inject({
        method: 'POST',
        url: `/api/organizations/${organizationId}/workflows/${workflow.id}/test`,
        headers: { cookie: bob },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json().executionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      const executionId = response.json().executionId as string;
      const [execution] = await database.db
        .select()
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, executionId));
      const persistedSteps = await database.db
        .select()
        .from(executionSteps)
        .where(eq(executionSteps.executionId, executionId));
      const [outbox] = await database.db
        .select()
        .from(executionQueueOutbox)
        .where(eq(executionQueueOutbox.executionId, executionId));
      expect(execution).toMatchObject({
        organizationId,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        triggerType: 'manual',
        triggerPayload: {},
        status: 'queued',
      });
      expect(execution.workflowSnapshot).toMatchObject({
        workflowId: workflow.id,
        organizationId,
        workflowVersion: workflow.version,
        steps: [
          { name: 'Record event', config: { message: 'Original event' } },
        ],
      });
      expect(persistedSteps).toHaveLength(1);
      expect(persistedSteps[0]).toMatchObject({
        name: 'Record event',
        config: { message: 'Original event' },
        status: 'pending',
      });
      expect(outbox).toMatchObject({
        jobPayload: { executionId },
        status: 'pending',
        attemptCount: 0,
      });
    });

    it('rejects unauthorized, inactive, non-manual, and cross-tenant test executions', async () => {
      await register('alice@example.com');
      await register('bob@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const bob = cookieFrom(await login('bob@example.com'));
      const organizationA = (await createOrganization(alice, 'A')).json()
        .organization.id as string;
      const organizationB = (await createOrganization(bob, 'B')).json()
        .organization.id as string;
      const draft = (await createWorkflow(organizationA, alice)).json()
        .workflow;
      const draftUrl = `/api/organizations/${organizationA}/workflows/${draft.id}/test`;

      const unauthenticated = await app.inject({
        method: 'POST',
        url: draftUrl,
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.json().error.code).toBe('UNAUTHORIZED');
      const inactive = await app.inject({
        method: 'POST',
        url: draftUrl,
        headers: { cookie: alice },
      });
      expect(inactive.statusCode).toBe(409);
      expect(inactive.json().error.code).toBe('WORKFLOW_NOT_ACTIVE');
      const nonMember = await app.inject({
        method: 'POST',
        url: draftUrl,
        headers: { cookie: bob },
      });
      expect(nonMember.statusCode).toBe(404);
      expect(nonMember.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
      const crossTenant = await app.inject({
        method: 'POST',
        url: `/api/organizations/${organizationB}/workflows/${draft.id}/test`,
        headers: { cookie: bob },
      });
      expect(crossTenant.statusCode).toBe(404);
      expect(crossTenant.json().error.code).toBe('WORKFLOW_NOT_FOUND');

      const webhook = (
        await createWorkflow(organizationA, alice, { triggerType: 'webhook' })
      ).json().workflow;
      await app.inject({
        method: 'PATCH',
        url: `/api/organizations/${organizationA}/workflows/${webhook.id}`,
        headers: { cookie: alice },
        payload: {
          expectedVersion: 1,
          steps: [
            {
              stepType: 'action',
              actionType: 'log',
              name: 'Record webhook',
              config: { message: 'Received' },
            },
          ],
        },
      });
      await app.inject({
        method: 'POST',
        url: `/api/organizations/${organizationA}/workflows/${webhook.id}/activate`,
        headers: { cookie: alice },
      });
      const nonManual = await app.inject({
        method: 'POST',
        url: `/api/organizations/${organizationA}/workflows/${webhook.id}/test`,
        headers: { cookie: alice },
      });
      expect(nonManual.statusCode).toBe(409);
      expect(nonManual.json().error.code).toBe('WORKFLOW_TRIGGER_NOT_MANUAL');
      expect(await database.db.select().from(workflowExecutions)).toHaveLength(
        0,
      );
    });

    it('returns one execution for concurrent idempotent manual test requests', async () => {
      await register('alice@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const organizationId = (await createOrganization(alice, 'Acme')).json()
        .organization.id as string;
      const workflow = await createActiveManualWorkflow(organizationId, alice);
      const request = () =>
        app.inject({
          method: 'POST',
          url: `/api/organizations/${organizationId}/workflows/${workflow.id}/test`,
          headers: { cookie: alice, 'idempotency-key': '  retry-1  ' },
        });

      const [first, replay] = await Promise.all([request(), request()]);
      expect(first.statusCode).toBe(202);
      expect(replay.statusCode).toBe(202);
      expect(replay.json()).toEqual(first.json());
      expect(
        await database.db
          .select()
          .from(workflowExecutions)
          .where(eq(workflowExecutions.workflowId, workflow.id)),
      ).toHaveLength(1);
      expect(await database.db.select().from(executionSteps)).toHaveLength(1);
      expect(
        await database.db.select().from(executionQueueOutbox),
      ).toHaveLength(1);
      const [execution] = await database.db.select().from(workflowExecutions);
      expect(execution.idempotencyKey).toBe('retry-1');
    });

    it('preserves execution snapshots after the active workflow is edited', async () => {
      await register('alice@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const organizationId = (await createOrganization(alice, 'Acme')).json()
        .organization.id as string;
      const workflow = await createActiveManualWorkflow(organizationId, alice);
      const created = await app.inject({
        method: 'POST',
        url: `/api/organizations/${organizationId}/workflows/${workflow.id}/test`,
        headers: { cookie: alice },
      });
      const executionId = created.json().executionId as string;
      const [originalStep] = await database.db
        .select()
        .from(executionSteps)
        .where(eq(executionSteps.executionId, executionId));

      const edited = await app.inject({
        method: 'PATCH',
        url: `/api/organizations/${organizationId}/workflows/${workflow.id}`,
        headers: { cookie: alice },
        payload: {
          expectedVersion: workflow.version,
          name: 'Edited workflow',
          steps: [
            {
              stepType: 'action',
              actionType: 'log',
              name: 'Changed action',
              config: { message: 'Changed event' },
            },
          ],
        },
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().workflow.version).toBe(workflow.version + 1);
      expect(edited.json().workflow.steps[0].id).not.toBe(
        originalStep.workflowStepId,
      );

      const [execution] = await database.db
        .select()
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, executionId));
      const [persistedStep] = await database.db
        .select()
        .from(executionSteps)
        .where(eq(executionSteps.executionId, executionId));
      expect(execution.workflowVersion).toBe(workflow.version);
      expect(execution.workflowSnapshot).toMatchObject({
        name: workflow.name,
        workflowVersion: workflow.version,
        steps: [{ config: { message: 'Original event' } }],
      });
      expect(persistedStep).toMatchObject({
        id: originalStep.id,
        workflowStepId: originalStep.workflowStepId,
        config: { message: 'Original event' },
      });
    });

    it('rolls back execution and step inserts when the outbox insert fails', async () => {
      await register('alice@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const organizationId = (await createOrganization(alice, 'Acme')).json()
        .organization.id as string;
      const workflow = await createActiveManualWorkflow(organizationId, alice);
      await database.db.execute(
        sql.raw(
          `CREATE FUNCTION opsflow_test_reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced outbox failure'; END; $$`,
        ),
      );
      await database.db.execute(
        sql.raw(
          `CREATE TRIGGER opsflow_test_reject_outbox BEFORE INSERT ON execution_queue_outbox FOR EACH ROW EXECUTE FUNCTION opsflow_test_reject_outbox()`,
        ),
      );
      const response = await (async () => {
        try {
          return await app.inject({
            method: 'POST',
            url: `/api/organizations/${organizationId}/workflows/${workflow.id}/test`,
            headers: { cookie: alice },
          });
        } finally {
          await database.db.execute(
            sql.raw(
              `DROP TRIGGER IF EXISTS opsflow_test_reject_outbox ON execution_queue_outbox`,
            ),
          );
          await database.db.execute(
            sql.raw(`DROP FUNCTION IF EXISTS opsflow_test_reject_outbox()`),
          );
        }
      })();
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe('INTERNAL_ERROR');
      expect(await database.db.select().from(workflowExecutions)).toHaveLength(
        0,
      );
      expect(await database.db.select().from(executionSteps)).toHaveLength(0);
      expect(
        await database.db.select().from(executionQueueOutbox),
      ).toHaveLength(0);
    });

    it('returns a conflict when deleting a workflow with retained execution history', async () => {
      await register('alice@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const organizationId = (await createOrganization(alice, 'Acme')).json()
        .organization.id as string;
      const workflow = await createActiveManualWorkflow(organizationId, alice);
      const url = `/api/organizations/${organizationId}/workflows/${workflow.id}`;
      const created = await app.inject({
        method: 'POST',
        url: `${url}/test`,
        headers: { cookie: alice },
      });
      expect(created.statusCode).toBe(202);

      const removed = await app.inject({
        method: 'DELETE',
        url,
        headers: { cookie: alice },
      });
      expect(removed.statusCode).toBe(409);
      expect(removed.json().error.code).toBe('WORKFLOW_HAS_EXECUTIONS');
      expect(
        (
          await app.inject({
            method: 'GET',
            url,
            headers: { cookie: alice },
          })
        ).statusCode,
      ).toBe(200);
      expect(await database.db.select().from(workflowExecutions)).toHaveLength(
        1,
      );
    });

    it('persists execution and step snapshots independently of mutable workflow steps', async () => {
      await register('alice@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const organizationId = (await createOrganization(alice, 'Acme')).json()
        .organization.id as string;
      const created = (await createWorkflow(organizationId, alice)).json()
        .workflow;
      const configured = await app.inject({
        method: 'PATCH',
        url: `/api/organizations/${organizationId}/workflows/${created.id}`,
        headers: { cookie: alice },
        payload: {
          expectedVersion: 1,
          steps: [
            {
              stepType: 'action',
              actionType: 'log',
              name: 'Record event',
              config: { message: 'Received' },
              retryConfig: { maxAttempts: 2 },
            },
          ],
        },
      });
      const workflow = configured.json().workflow;
      const step = workflow.steps[0];
      const snapshot = workflowExecutionSnapshotSchema.parse({
        workflowId: workflow.id,
        organizationId,
        workflowVersion: workflow.version,
        name: workflow.name,
        description: workflow.description,
        triggerType: workflow.triggerType,
        triggerConfig: workflow.triggerConfig,
        steps: [
          {
            workflowStepId: step.id,
            stepOrder: step.stepOrder,
            stepType: step.stepType,
            actionType: step.actionType,
            name: step.name,
            config: step.config,
            retryConfig: step.retryConfig,
          },
        ],
      });
      const [execution] = await database.db
        .insert(workflowExecutions)
        .values({
          organizationId,
          workflowId: workflow.id,
          workflowVersion: workflow.version,
          triggerType: workflow.triggerType,
          triggerPayload: { source: 'test' },
          workflowSnapshot: snapshot,
        })
        .returning();
      await database.db.insert(executionSteps).values({
        executionId: execution.id,
        workflowStepId: step.id,
        stepOrder: step.stepOrder,
        stepType: step.stepType,
        actionType: step.actionType,
        name: step.name,
        config: step.config,
        retryConfig: step.retryConfig,
      });
      await database.db.insert(executionQueueOutbox).values({
        executionId: execution.id,
        jobPayload: { executionId: execution.id },
      });

      await database.db
        .delete(workflowSteps)
        .where(eq(workflowSteps.id, step.id));

      const [persistedExecution] = await database.db
        .select()
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, execution.id));
      const [persistedStep] = await database.db
        .select()
        .from(executionSteps)
        .where(eq(executionSteps.executionId, execution.id));
      expect(persistedExecution.workflowSnapshot).toEqual(snapshot);
      expect(persistedStep).toMatchObject({
        workflowStepId: step.id,
        name: 'Record event',
        config: { message: 'Received' },
        status: 'pending',
      });
      await expect(
        database.db.delete(workflows).where(eq(workflows.id, workflow.id)),
      ).rejects.toThrow();
      expect(
        await database.db
          .select()
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, execution.id)),
      ).toHaveLength(1);
    });

    it('enforces execution tenant, ordering, and outbox payload constraints', async () => {
      await register('alice@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const organizationId = (await createOrganization(alice, 'Acme')).json()
        .organization.id as string;
      const otherOrganizationId = (
        await createOrganization(alice, 'Other organization')
      ).json().organization.id as string;
      const workflow = (await createWorkflow(organizationId, alice)).json()
        .workflow;
      const workflowStepId = randomUUID();
      const snapshot = workflowExecutionSnapshotSchema.parse({
        workflowId: workflow.id,
        organizationId,
        workflowVersion: workflow.version,
        name: workflow.name,
        description: workflow.description,
        triggerType: workflow.triggerType,
        triggerConfig: workflow.triggerConfig,
        steps: [
          {
            workflowStepId,
            stepOrder: 0,
            stepType: 'action',
            actionType: 'log',
            name: 'Record event',
            config: { message: 'Received' },
            retryConfig: {},
          },
        ],
      });

      await expect(
        database.db.insert(workflowExecutions).values({
          organizationId: otherOrganizationId,
          workflowId: workflow.id,
          workflowVersion: workflow.version,
          triggerType: workflow.triggerType,
          triggerPayload: {},
          workflowSnapshot: snapshot,
        }),
      ).rejects.toThrow();

      const [execution] = await database.db
        .insert(workflowExecutions)
        .values({
          organizationId,
          workflowId: workflow.id,
          workflowVersion: workflow.version,
          triggerType: workflow.triggerType,
          triggerPayload: {},
          workflowSnapshot: snapshot,
        })
        .returning();
      await expect(
        database.db.insert(executionSteps).values({
          executionId: execution.id,
          workflowStepId,
          stepOrder: -1,
          stepType: 'action',
          actionType: 'log',
          name: 'Invalid order',
          config: { message: 'No' },
          retryConfig: {},
        }),
      ).rejects.toThrow();
      await expect(
        database.db.insert(executionQueueOutbox).values({
          executionId: execution.id,
          jobPayload: { executionId: randomUUID() },
        }),
      ).rejects.toThrow();
      await database.db.insert(executionQueueOutbox).values({
        executionId: execution.id,
        jobPayload: { executionId: execution.id },
      });
      await expect(
        database.db.insert(executionQueueOutbox).values({
          executionId: execution.id,
          jobPayload: { executionId: execution.id },
        }),
      ).rejects.toThrow();
    });

    it('enforces execution idempotency, retry, and timestamp constraints', async () => {
      await register('alice@example.com');
      const alice = cookieFrom(await login('alice@example.com'));
      const organizationId = (await createOrganization(alice, 'Acme')).json()
        .organization.id as string;
      const workflow = (await createWorkflow(organizationId, alice)).json()
        .workflow;
      const workflowStepId = randomUUID();
      const snapshot = workflowExecutionSnapshotSchema.parse({
        workflowId: workflow.id,
        organizationId,
        workflowVersion: workflow.version,
        name: workflow.name,
        description: workflow.description,
        triggerType: workflow.triggerType,
        triggerConfig: workflow.triggerConfig,
        steps: [
          {
            workflowStepId,
            stepOrder: 0,
            stepType: 'action',
            actionType: 'log',
            name: 'Record event',
            config: { message: 'Received' },
            retryConfig: {},
          },
        ],
      });
      const executionValues = {
        organizationId,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        triggerType: workflow.triggerType,
        triggerPayload: {},
        workflowSnapshot: snapshot,
        idempotencyKey: 'test-run-1',
      };
      const [execution] = await database.db
        .insert(workflowExecutions)
        .values(executionValues)
        .returning();

      await expect(
        database.db.insert(workflowExecutions).values(executionValues),
      ).rejects.toThrow();
      await expect(
        database.db.insert(executionQueueOutbox).values({
          executionId: execution.id,
          jobPayload: { executionId: execution.id },
          attemptCount: -1,
        }),
      ).rejects.toThrow();
      await expect(
        database.db.insert(workflowExecutions).values({
          ...executionValues,
          idempotencyKey: 'reversed-execution',
          startedAt: new Date('2026-01-01T00:00:02.000Z'),
          completedAt: new Date('2026-01-01T00:00:01.000Z'),
        }),
      ).rejects.toThrow();
      await expect(
        database.db.insert(executionSteps).values({
          executionId: execution.id,
          workflowStepId,
          stepOrder: 0,
          stepType: 'action',
          actionType: 'log',
          name: 'Record event',
          config: { message: 'Received' },
          retryConfig: {},
          startedAt: new Date('2026-01-01T00:00:02.000Z'),
          completedAt: new Date('2026-01-01T00:00:01.000Z'),
        }),
      ).rejects.toThrow();
    });
  },
);
