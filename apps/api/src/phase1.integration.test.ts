import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from './app.js';
import { createDatabase } from './db/client.js';
import { organizationMembers, sessions, users } from './db/schema.js';

const password = 'correct horse battery staple';
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = testDatabaseUrl ? describe : describe.skip;

databaseDescribe('Phase 1 API integration', () => {
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
      sql`TRUNCATE TABLE organization_members, organizations, sessions, users CASCADE`,
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
    expect(tokenHash).toBe(createHash('sha256').update(rawToken).digest('hex'));
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
    expect(session?.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 30_000);
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
    const organizationId = (await createOrganization(alice, 'Acme Team')).json()
      .organization.id as string;
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
});
