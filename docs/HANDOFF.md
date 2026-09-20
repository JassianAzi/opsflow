# OpsFlow AI Handoff

This file is the canonical transfer document between coding agents.

Every AI agent must update this file before ending a work session.

---

## Current State — Phase 2

### Milestone and Status

Phase 2 — Workflow CRUD: **Complete for the requested scope**. Authenticated
organization members can create, configure, view, list, activate, deactivate,
and delete persisted workflows. Nothing executes yet. GitHub CI and Docker
Compose remain unverified in this environment.

### Verified Repository State

- Inspected all required documents, source structure, manifests, schema,
  migrations, tests, frontend state, `git status`, and recent history before
  editing. The previous handoff was stale on Git history: `main` has commit
  `0c130c0 feat: complete phase 1 authentication and organizations`. There is
  no remote. Phase 1 files were present, and the initial working tree was clean.
- All Phase 2 changes listed below remain **uncommitted** on `main`. The
  ignored `.env`, `.local/`, dependencies, and build output are not tracked.
  The isolated PostgreSQL 18 cluster is under `.local/pgdata`, ran on port
  55433 only for testing, and was stopped after validation. The unrelated
  local PostgreSQL instance on 5432 was untouched.

### Implementation and Workflow Model

- Added `workflows` and `workflow_steps` with UUID keys, foreign keys, enum
  columns, JSONB config columns, timestamps, an organization listing index,
  and a unique `(workflow_id, step_order)` index. Conditions precede actions.
  The array order in PATCH becomes consecutive zero-based `step_order` values.
- Shared Zod schemas define statuses, triggers, condition operators, action
  types, and typed configs. Reusable validation checks the complete definition
  independently of HTTP. Drafts may have zero steps and may omit schedule cron;
  activation requires a complete trigger and at least one valid action. Cron
  accepts five numeric fields, lists, ranges, wildcards, and strides; an
  optional IANA timezone is stored. No scheduler is implemented.
- The API uses the single workflow PATCH endpoint for metadata, trigger, and
  complete ordered step replacement. It validates and writes the replacement
  in one transaction under a workflow row lock. This choice keeps ordering
  atomic and avoids a large step subresource API. A changed definition
  increments `version` once, beginning at 1; no-op updates and status changes
  do not increment it. Edited step sets receive new step IDs. Phase 3 must
  plan a versioned definition snapshot or equivalent before historic execution
  records depend on step IDs.
- Workflow service reuses Phase 1 organization membership authorization; all
  repository reads, writes, status changes, and deletes also match both
  workflow ID and organization ID. Owners and members share all Phase 2
  workflow permissions. Non-members see `ORGANIZATION_NOT_FOUND`; a workflow
  from a different organization appears as `WORKFLOW_NOT_FOUND` to a member of
  the requested organization.
- DELETE hard deletes a workflow and cascades its steps because execution
  history does not exist. Activate/deactivate only change status and updated
  time; they do not enqueue or execute. Invalid activation returns
  `400 WORKFLOW_INVALID` with field paths. Unexpected internal errors retain
  the existing generic API response.
- Added a React workflow list and ordered editor under a selected
  organization. It supports creation, opening, metadata/trigger edits, adding
  and editing conditions and actions, removing and reordering steps, saving,
  activation/deactivation, and deletion. The UI exposes required action fields.
  Optional HTTP headers, AI output schema, and retry settings are validated and
  stored by the API but are not yet editable in the UI.
- No new dependency or execution, queue, webhook intake, action call, AI call,
  credential store, or execution table was added.

### Database and Migration State

- Preserved Phase 1 `apps/api/drizzle/0000_soft_next_avengers.sql` unchanged.
- Generated and applied `apps/api/drizzle/0001_previous_amazoness.sql`; added
  `apps/api/drizzle/meta/0001_snapshot.json` and updated `meta/_journal.json`.
- Applied only to dedicated `opsflow_test` at
  `postgresql://opsflow_test@127.0.0.1:55433/opsflow_test`. Integration tests
  guard the `/opsflow_test` database name before truncating fixtures. No seed
  data or unrelated database was changed.

### Exact Files Changed in Phase 2

Added:

- `apps/api/drizzle/0001_previous_amazoness.sql`, `apps/api/drizzle/meta/0001_snapshot.json`
- `apps/api/src/workflows/repository.ts`, `apps/api/src/workflows/service.ts`, `apps/api/src/workflows/routes.ts`, `apps/api/src/workflows/validation.ts`
- `apps/web/src/WorkflowWorkspace.tsx`
- `packages/shared/src/workflows.ts`, `packages/shared/src/workflows.test.ts`

Modified:

- `apps/api/drizzle/meta/_journal.json`, `apps/api/src/app.ts`, `apps/api/src/db/schema.ts`, `apps/api/src/errors.ts`, `apps/api/src/phase1.integration.test.ts`
- `apps/web/src/App.tsx`, `apps/web/src/api.ts`, `packages/shared/src/index.ts`
- `README.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/DEVELOPMENT.md`, `docs/ROADMAP.md`, `docs/SECURITY.md`, `docs/CHANGELOG.md`, `docs/HANDOFF.md`

### Exact Commands Run and Results

- `git status --short --branch`, `git log -5 --oneline`, `git remote -v`,
  `rg --files -g '!node_modules' -g '!.local'`, and source/doc `Get-Content`
  reads: confirmed clean Phase 1 base and one commit; no Git remote.
- `npm run typecheck`: initial runs caught two TypeScript typing mistakes in
  new code, fixed; final run passed all workspaces.
- `$env:DATABASE_URL='postgresql://opsflow_test@127.0.0.1:55433/opsflow_test'; npm run db:generate`:
  initial sandboxed Drizzle/esbuild child spawn returned `EPERM` despite npm's
  zero exit code; permitted retry passed and generated migration 0001.
- `& 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe' -D (Join-Path (Get-Location) '.local\pgdata') -l (Join-Path (Get-Location) '.local\postgres.log') -o '-p 55433 -h 127.0.0.1' start`:
  passed for existing isolated test cluster. Initial `pg_ctl ... status`
  confirmed it was stopped.
- `$env:DATABASE_URL='postgresql://opsflow_test@127.0.0.1:55433/opsflow_test'; npm run db:migrate`:
  passed; Phase 2 migration applied.
- `$env:TEST_DATABASE_URL='postgresql://opsflow_test@127.0.0.1:55433/opsflow_test'; npm test`:
  first run had three new workflow test failures from passing full workflow
  rows to a strict input schema; fixed. Final run: **24 tests in 5 files
  passed**, including database integration coverage for CRUD, authorization,
  cross-organization access, validation, activation, versioning, and ordering.
- `npm run lint`: first run found two unused imports; fixed. Final run passed.
- `npm run typecheck`: passed after final code changes.
- `npm run build`: passed for shared, config, API, worker, and web. Vite emitted
  nonfatal Zod comment and >500 kB chunk warnings.
- `npx prettier --write ...`: formatted changed TypeScript and Drizzle metadata.
  `npm run format:check` initially identified three files; formatted them and
  final check passed.
- `git diff --check`: passed, with Git's Windows LF-to-CRLF conversion warnings.
- `Get-Command docker -ErrorAction SilentlyContinue`: Docker not available on
  PATH; Compose and Redis readiness were not claimed or tested.
- `& 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe' -D (Join-Path (Get-Location) '.local\pgdata') stop -m fast`:
  passed; isolated test cluster stopped after tests.

### Known Issues, Limits, and Assumptions

- Docker Compose and Redis-backed worker readiness remain unverified locally;
  Docker is not installed/on PATH. GitHub Actions has not run because this
  repository has no remote. The unrelated machine PostgreSQL on 5432 remains
  untouched; Compose defaults to host port 5433.
- The web editor omits optional HTTP headers, AI output schema, and retry
  controls. The API supports them. Step IDs change after a material step edit.
  No workflow execution or execution history exists yet.
- The production web build reports a >500 kB chunk warning. This is not a
  build failure. Previous Drizzle Kit/esbuild transitive dependency advisories
  were not reevaluated or changed in Phase 2.
- `npm test` skips database integration cases without `TEST_DATABASE_URL`;
  CI supplies the dedicated PostgreSQL database. `opsflow_test` is disposable
  test data only. Schedule timezone, when omitted, is intended to mean UTC
  when scheduling is implemented later.

### Unfinished Work and Exact Recommended Next Action

Do not start execution work in this phase. Commit/review the uncommitted Phase
2 changes. In an environment with Docker, start Compose services, apply
committed migrations to an OpsFlow database, and confirm worker Redis
readiness; publish to GitHub and run CI when ready. Then begin Phase 3 — Queue
and Worker by designing versioned workflow definition snapshots alongside
execution rows, wiring BullMQ to the existing Redis client, and keeping the
Phase 2 API contracts intact. Do not use changing step IDs as historic
execution references without a snapshot strategy.

---

## Previous State — Phase 1

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

### Entry 004 — Phase 2 workflow CRUD

Agent:
Codex

Summary:
Added workflow and ordered-step migration, shared configuration schemas,
organization-scoped CRUD and activation API, a linear editor, and PostgreSQL
integration tests. All requested local checks passed; Docker and GitHub CI
remain unavailable for verification here.

Next:
Review and commit Phase 2, verify Compose/CI when available, then begin
Phase 3 with a workflow definition snapshot strategy before execution records.
