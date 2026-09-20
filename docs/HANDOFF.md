# OpsFlow AI Handoff

This file is the canonical transfer document between coding agents.

Every AI agent must update this file before ending a work session.

---

## Current State

### Active Milestone

Phase 1 — Authentication and Organizations

### Status

Complete for the requested Phase 1 implementation. The generated migration
applied and all 17 tests passed against a dedicated local PostgreSQL database.
Docker Compose and GitHub-hosted CI remain unverified because Docker and a Git
remote are unavailable here. No Phase 2 work was started.

### Repository State

Git is on `main` with no commits or remote. All project files remain untracked,
including this Phase 1 implementation. `.env`, `node_modules`, build output,
and `.local/` are ignored. The existing `.env` still reflects the earlier
local setup; it was not overwritten. The isolated PostgreSQL test cluster and
its data are under ignored `.local/pgdata` on port 55433; it was used only for
`opsflow_test` and was stopped after validation. The machine's existing
PostgreSQL server on 5432 was untouched.

### Implementation Summary

- Made Compose host ports configurable with `POSTGRES_PORT=5433` and
  `REDIS_PORT=6379` defaults; PostgreSQL remains on container port 5432.
- Added users, sessions, organizations, and organization_members with UUID
  keys, foreign keys, a role enum, normalized-email uniqueness, and indexes.
- Added registration, login, logout, and current-user routes with shared Zod
  schemas, scrypt password hashes, secure random session tokens, hashed token
  storage, expiry, revocation, and last-seen updates.
- Added transactional organization creation, member-scoped organization reads,
  owner-only role changes, and transactional last-owner protection.
- Added the React authentication and organization interface and a Vite `/api`
  proxy. Organization selection is frontend state; there is no server-side
  active-organization field yet.
- Added PostgreSQL-backed API integration tests and a CI PostgreSQL service.

### Authentication and Cookie Design

- Registration trims and lowercases email; PostgreSQL uniquely indexes
  `lower(email)`. Passwords are scrypt-hashed with a random 16-byte salt and
  64-byte derived key. Login gives the same public error for unknown email and
  wrong password, and spends a scrypt operation for unknown email.
- Login creates a 32-byte random opaque token. Only its SHA-256 hash is stored
  in `sessions`. A cookie named `opsflow_session` holds the raw token, with
  HTTP-only, SameSite=Lax, path `/`, seven-day max-age, and Secure in production.
  Logout deletes the database session and clears the cookie. Expired sessions
  are rejected; `last_seen_at` updates at most once every five minutes.
- Local web requests use the Vite same-origin `/api` proxy. Mutations with an
  `Origin` header must match `WEB_ORIGIN`. Public deployment still needs a CSRF,
  HTTPS, cookie-domain, proxy, and rate-limit review.

### Architecture Decisions

- Reused npm workspaces, Fastify, Drizzle, PostgreSQL, and the separate worker.
  Added only `@fastify/cookie` for cookie parsing and serialization; no OAuth,
  password reset, invitations, or workflow libraries were added.
- Routes parse shared schemas and delegate to services. Auth and organization
  repositories own database access. Organization list/get and member queries
  include requesting-user membership in the query. Role changes lock the
  organization row inside a transaction before checking owner count.
- The web UI uses direct fetch and local state. React Router and TanStack Query
  remain deferred because Phase 1 has only a small number of views.

### Schema and Migrations

- `apps/api/src/db/schema.ts` defines the four Phase 1 tables and indexes.
- `apps/api/drizzle/0000_soft_next_avengers.sql` is the migration; its metadata
  is in `apps/api/drizzle/meta/_journal.json` and
  `apps/api/drizzle/meta/0000_snapshot.json`.
- `npm run db:generate` generated the migration. `npm run db:migrate` applied it
  to a dedicated `opsflow_test` database on isolated PostgreSQL port 55433.
  No unrelated database was changed. There is no seed data.

### Files Changed in Phase 1

Added:

- `apps/api/drizzle/0000_soft_next_avengers.sql`, `apps/api/drizzle/meta/_journal.json`, `apps/api/drizzle/meta/0000_snapshot.json`
- `apps/api/src/errors.ts`, `apps/api/src/phase1.integration.test.ts`
- `apps/api/src/auth/guard.ts`, `apps/api/src/auth/password.ts`, `apps/api/src/auth/repository.ts`, `apps/api/src/auth/routes.ts`, `apps/api/src/auth/service.ts`, `apps/api/src/auth/session.ts`
- `apps/api/src/organizations/repository.ts`, `apps/api/src/organizations/routes.ts`, `apps/api/src/organizations/service.ts`
- `apps/web/src/App.tsx`, `apps/web/src/api.ts`

Modified:

- `.env.example`, `.gitignore`, `docker-compose.yml`, `.github/workflows/ci.yml`, `package-lock.json`
- `apps/api/package.json`, `apps/api/src/app.ts`, `apps/api/src/app.test.ts`, `apps/api/src/index.ts`, `apps/api/src/db/client.ts`, `apps/api/src/db/schema.ts`
- `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/src/main.tsx`
- `packages/config/src/index.ts`, `packages/shared/src/index.ts`
- `README.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/DATABASE.md`, `docs/SECURITY.md`, `docs/DEVELOPMENT.md`, `docs/ROADMAP.md`, `docs/CHANGELOG.md`, `docs/HANDOFF.md`

### Exact Commands Run and Results

- `git status --short --branch`, `git log -3 --oneline`, `rg --files --hidden ...`: inspected. No commits exist.
- `Get-Command docker`, `Get-Command initdb,pg_ctl,psql`: Docker unavailable; PostgreSQL 18 binaries available.
- `npm view @fastify/cookie version --offline=false`, `npm install --offline=false`: package version checked; install passed.
- `npm run db:generate`: passed; generated `0000_soft_next_avengers.sql`.
- PostgreSQL 18 `initdb -D .local/pgdata -U opsflow_test -A trust`, `pg_ctl ... -p 55433 -h 127.0.0.1 start`, `psql ... -c 'CREATE DATABASE opsflow_test'`: isolated cluster/database created. Initial sandboxed `pg_ctl` attempt failed to spawn; permitted retry passed.
- `$env:DATABASE_URL='postgresql://opsflow_test@127.0.0.1:55433/opsflow_test'; npm run db:migrate`: passed.
- `$env:TEST_DATABASE_URL='postgresql://opsflow_test@127.0.0.1:55433/opsflow_test'; npm test`: 17 tests in 4 files passed. Initial run had 2 failing tests for whitespace email and wrapped duplicate errors; both were fixed and rerun successfully.
- `npm ci --offline=false`: passed after dependency changes.
- `npm run format`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build`: all passed after final source changes.
- `npm run start -w @opsflow/api` with `DATABASE_URL` overridden to the dedicated test database: passed; `/health` returned HTTP 200 and unauthenticated `/api/auth/me` returned 401.
- `npm run dev -w @opsflow/web`: passed; HTML and `src/App.tsx` returned HTTP 200 and Vite `/api/auth/me` proxy returned 401. Through the proxy, registration, login, organization creation, and listing succeeded. Temporary API and Vite processes were stopped.
- PostgreSQL 18 `pg_ctl -D .local/pgdata stop -m fast`: passed; the isolated test server was stopped.

### Known Issues and Environment Limits

- Docker is not installed or on PATH here. Compose containers and Redis-backed
  worker readiness have not been verified. The existing machine PostgreSQL on
  port 5432 was left untouched. The default Docker host port is now 5433.
- GitHub Actions has not run because there is no remote or commit. The CI job
  now provides a dedicated PostgreSQL test service.
- `npm test` without `TEST_DATABASE_URL` runs unit/smoke tests and skips the
  database integration suite; CI sets the variable and runs all tests.
- npm install still reports four moderate transitive Drizzle Kit/esbuild
  advisories inherited from Phase 0.
- The ignored `.local/pgdata` test cluster is local validation data, not a
  repository artifact. The existing ignored `.env` may still use port 5432;
  update it manually to match `.env.example` when using Compose.

### Unfinished Work and Recommended Next Action

Do not begin Phase 2 in this handoff. On a machine with Docker, update the
existing `.env` to use host port 5433 (or another free `POSTGRES_PORT`), run
`docker compose up -d`, `npm run db:migrate`, `npm run services:check`, and
verify `npm run start -w @opsflow/worker`. Publish/commit the repository and
confirm GitHub Actions. Then begin Phase 2 — Workflow CRUD using the existing
membership-scoped repository pattern. No Phase 2 schema or endpoints exist yet.

### Assumptions

- The sample `.env.example` password is for local development only.
- `opsflow_test` is reserved for disposable integration fixtures and must not
  be an application or unrelated database.
- The web and API remain behind a same-origin proxy locally; deployment design
  remains postponed.

---

## Previous State — Phase 0

### Active Milestone

Phase 0 — Repository Foundation

### Status

Partially complete. Source foundation and automated local checks pass. Docker
service boot and Redis-backed worker startup remain unverified on this machine.

### Repository State

The supplied directory had no `.git` metadata. Git was initialized on `main`;
there are no commits or remote. All project files are currently untracked.
`.env` was created from `.env.example` for local validation and is ignored.

### Completed Work

- npm workspaces for `apps/web`, `apps/api`, `apps/worker`, `packages/shared`, and `packages/config`
- React, TypeScript, Vite, and Tailwind starter screen; `@/` alias for later UI components
- Fastify API with `GET /health`; response contract shared with `packages/shared`
- separate Node worker entry point with validated environment and Redis connection
- shared strict TypeScript, ESLint, Prettier, Zod environment validation, and Redis client factory
- Drizzle and node-postgres client plus empty schema and migration directory
- Docker Compose PostgreSQL and Redis definitions with persistent volumes
- Vitest smoke tests for health, shared contract, and environment validation
- GitHub Actions install, lint, typecheck, test, and build workflow
- root scripts, lockfile, `.gitignore`, `.env.example`, and implementation documentation

### Files Changed

Added:

- `.npmrc`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `.env.example`, `.github/workflows/ci.yml`
- `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `docker-compose.yml`
- `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/styles.css`
- `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/drizzle.config.ts`, `apps/api/drizzle/README.md`, `apps/api/src/app.ts`, `apps/api/src/app.test.ts`, `apps/api/src/index.ts`, `apps/api/src/services-check.ts`, `apps/api/src/db/client.ts`, `apps/api/src/db/schema.ts`
- `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/src/index.ts`
- `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/index.test.ts`
- `packages/config/package.json`, `packages/config/tsconfig.base.json`, `packages/config/tsconfig.json`, `packages/config/src/index.ts`, `packages/config/src/index.test.ts`

Modified: `README.md`, `docs/ARCHITECTURE.md`, `docs/API.md`,
`docs/DATABASE.md`, `docs/DEVELOPMENT.md`, `docs/ROADMAP.md`,
`docs/HANDOFF.md`, `docs/CHANGELOG.md`.

Existing planning files `docs/REQUIREMENTS.md`, `docs/SECURITY.md`,
`docs/AI_INSTRUCTIONS.md`, and `prompts/*` were preserved.

### Database Migrations

None. `apps/api/src/db/schema.ts` exports no tables. `apps/api/drizzle/`
contains only a README. The Phase 1 agent must add the first domain schema and
versioned SQL migration. `npm run db:generate` and `npm run db:migrate` are
configured but were not run because there is no schema change.

### Commands Run

- `git status --short --branch`, `git log -3 --oneline` (initially failed: no Git repository)
- `git init`, `git branch -m main`, `git status --short --branch`
- `node --version` (22.18.0), `npm --version` (10.9.3), `docker --version`, `docker compose version`
- `npm install --offline=false`, `npm ci --offline=false`
- `npm run format`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`
- `npm run start -w @opsflow/api` and `Invoke-RestMethod http://127.0.0.1:4000/health`
- `npm run dev -w @opsflow/web` and HTTP requests to `/` and `/src/main.tsx`
- `npm run start -w @opsflow/worker`, `docker compose up -d`, `npm run services:check`
- `npm audit --json --offline=false`
- API start with `DATABASE_URL=not-a-postgres-url` to verify validation failure

### Validation Results

- Clean `npm ci --offline=false`: passed after stopping local dev server processes.
- `npm run lint`, `npm run typecheck`, `npm test` (3 tests), `npm run build`, and `npm run format:check`: passed after final changes.
- Earlier build and test attempts hit this environment's child-process `EPERM` sandbox; both passed with process permission. An earlier typecheck exposed duplicate Vite majors; pinning Vite 6 across the workspace resolved it. Two `npm ci` attempts failed while the running Vite process held a native module; the clean retry passed after stopping those processes.
- API startup: passed. `GET /health` returned HTTP 200 and the structured JSON contract.
- Web Vite dev server: passed. HTML and starter module returned HTTP 200. Production web build passed.
- Invalid `DATABASE_URL`: API startup failed with a clear Zod error, as intended.
- Docker startup: could not run because `docker` is not installed or on PATH here.
- PostgreSQL/Redis connectivity: could not validate the Compose services. A separate PostgreSQL server already answers on localhost:5432 but rejected the sample OpsFlow password; Redis on localhost:6379 refused connection, so worker exited with status 1. The worker configuration loaded before that connection failure.
- GitHub Actions workflow exists; no remote or CI run yet.
- npm audit reported four moderate transitive advisories through Drizzle Kit's older esbuild dependency. The offered automatic fix downgrades Drizzle Kit across a major range and was not applied.

### Known Issues

- Docker is unavailable on the implementation machine; Phase 0 infrastructure boot and worker readiness require another environment.
- Port 5432 is occupied by a separate PostgreSQL server here. Stop it or change the Compose host port and matching `DATABASE_URL` before starting OpsFlow PostgreSQL.
- The four moderate Drizzle Kit transitive audit findings remain. Review when Drizzle Kit updates its loader dependency.
- GitHub CI has not run because this new repository has no commit or remote.

### Unfinished Work

- Boot the Compose PostgreSQL and Redis services, run `npm run services:check`, then verify the worker reaches its ready log.
- Commit and publish the repository when ready; the entire working tree is untracked.
- No Phase 1 code was started.

### Recommended Next Action

Finish Phase 0 in an environment with Docker Compose: resolve the local 5432
port collision if present, copy `.env.example` to `.env`, run
`docker compose up -d`, `npm run services:check`, and
`npm run start -w @opsflow/worker` to confirm its ready log. Re-run the five
checks above and confirm GitHub Actions after publishing. Then start Phase 1.

### Important Decisions

- npm workspaces: built into npm, one lockfile, little workspace tooling.
- Fastify: small typed Node server, built-in request injection for endpoint tests, and a good fit for thin routes.
- Drizzle: explicit SQL migrations and TypeScript-first PostgreSQL schema without generated client code. Empty schema now; Phase 1 owns first migration.
- Vite 6 pinned across web and Vitest to avoid duplicate incompatible Vite plugin types. React Router, TanStack Query, and shadcn/ui remain planned; only the alias and CSS base are prepared.
- Redis client factory is shared by API and worker; BullMQ queues and execution are reserved for Phase 3.
- `API_HOST` is configurable, defaulting to loopback for local development. No paid services, deployment wiring, AI providers, authentication, or workflow domain code added.
- Organization-based tenant isolation, optional AI provider abstraction with mock implementation, linear workflows, and public GitHub remain architectural goals for later phases.

### Assumptions

- Node 22 and npm 10 are baseline tools. Docker is expected on the next validation machine.
- `.env.example` uses local sample credentials only; `.env` must remain untracked.
- The existing PostgreSQL listener on 5432 is unrelated to OpsFlow.

---

## Transfer Checklist

The outgoing agent must complete all applicable items:

- [x] Git status inspected
- [x] current milestone recorded
- [x] completed work recorded
- [x] files changed recorded
- [x] migrations recorded
- [x] validation commands recorded
- [x] test results recorded
- [x] known issues recorded
- [x] unfinished work recorded
- [x] next action recorded
- [x] architectural decisions recorded
- [x] documentation updated

The incoming agent must:

- [ ] read this file
- [ ] inspect Git status
- [ ] inspect recent commits
- [ ] inspect changed files
- [ ] confirm migrations
- [ ] run relevant validation
- [ ] compare implementation against docs
- [ ] continue from the recommended next action

---

## Handoff History

### Entry 001 — Planning

Agent:
ChatGPT

Summary:
Created the initial project specification and transfer protocol.

Next:
Begin Phase 0 using Codex.

### Entry 002 — Phase 0 foundation

Agent:
Codex

Summary:
Implemented the workspace, starter apps, shared packages, local service
configuration, tests, and CI. Automated local checks pass. Docker-dependent
service boot is pending on a machine with Docker.

Next:
Finish the infrastructure and worker boot checks listed above before Phase 1.

### Entry 003 — Phase 1 authentication and organizations

Agent:
Codex

Summary:
Added the Phase 1 migration, database-backed authentication, organization
authorization, frontend flows, and PostgreSQL integration tests. The test
cluster was isolated from the machine's existing PostgreSQL installation.

Next:
Verify Compose and worker readiness when Docker is available, then begin
Phase 2 after publishing and confirming CI.
