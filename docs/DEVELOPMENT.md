# OpsFlow Development Guide

## 1. Local Development

From the repository root:

```bash
cp .env.example .env
docker compose up -d
npm ci
npm run db:migrate
npm run services:check
npm run dev
```

Open `http://127.0.0.1:5173` for registration, login, organizations, and
workflow management. Check `http://127.0.0.1:4000/health` for API liveness.
Stop the app processes with
Ctrl+C and local services with `docker compose down`. Docker named volumes
retain PostgreSQL and Redis data.

## 2. Prerequisites

Expected:
- Git
- Node.js 22.12 or newer
- npm 10 or newer
- Docker Desktop
- Docker Compose

## 3. Development Services

Local services:
- PostgreSQL
- Redis

Application processes:
- web
- API
- worker

The worker checks Redis on startup and stays connected. It does not process
jobs yet. PostgreSQL and Redis must be running before `npm run dev`. Docker
PostgreSQL uses host port 5433 by default, with internal port 5432. The host
ports can be changed through `POSTGRES_PORT` and `REDIS_PORT`; update
`DATABASE_URL` and `REDIS_URL` to match. An existing `.env` from Phase 0 may
still point to port 5432 and must be edited manually.

## 4. Environment Variables

Copy `.env.example` to `.env`. Current variables:

```env
NODE_ENV=development
API_PORT=4000
API_HOST=127.0.0.1
WEB_ORIGIN=http://127.0.0.1:5173
POSTGRES_PASSWORD=opsflow_local
POSTGRES_PORT=5433
REDIS_PORT=6379
DATABASE_URL=postgresql://opsflow:opsflow_local@localhost:5433/opsflow
REDIS_URL=redis://localhost:6379
```

The sample password is local only. Keep `POSTGRES_PASSWORD` and the password in
`DATABASE_URL` in sync. Do not commit `.env`. The API and worker validate
`NODE_ENV`, `API_PORT`, `API_HOST`, `WEB_ORIGIN`, `DATABASE_URL`, and
`REDIS_URL` at startup. No session or AI credentials are needed in Phase 2.
The web port is fixed at 5173 in Vite configuration; Vite proxies `/api` to
the configured API host and port.

## 5. Package Scripts

Implemented root scripts:

```json
{
  "dev": "build shared packages, then run three apps",
  "build": "build all packages and apps",
  "test": "run Vitest",
  "lint": "run ESLint",
  "typecheck": "check all workspaces",
  "format:check": "check source formatting",
  "services:check": "connect to PostgreSQL and Redis"
}
```

`npm run db:generate` and `npm run db:migrate` use Drizzle Kit. Phase 1's
committed migration creates users, sessions, organizations, and memberships.
Phase 2's migration creates workflows and workflow steps. Generate and commit
a versioned SQL migration for every later schema change.
Do not use schema push in place of migrations.

API integration tests run when `TEST_DATABASE_URL` points to a **dedicated**
PostgreSQL database named `opsflow_test`. They apply committed migrations and
clear their own fixture rows. The test suite skips database integration tests
when this variable is absent; CI supplies a PostgreSQL service and runs all
tests. Example local setup with a dedicated database:

```bash
TEST_DATABASE_URL=postgresql://opsflow:opsflow_local@localhost:5433/opsflow_test npm test
```

Create `opsflow_test` separately first, using credentials with access to that
database. Do not point the test suite at an existing application database.
In PowerShell, set `$env:TEST_DATABASE_URL` before running `npm test`.

Create a draft workflow in an organization, open it from the list, select a
trigger, add conditions and actions, and save the configuration. The editor
uses one PATCH request for the entire ordered step array. Activation checks
the complete definition; it does not start a job. Schedule cron uses five
numeric fields (minute, hour, day of month, month, weekday) and optionally an
IANA timezone. When timezone is omitted, future scheduling should interpret
the expression in UTC. The editor currently exposes required action fields;
optional HTTP headers, AI output schema, and retry settings can be sent through
the API but are not yet editable in the UI.

Docker is optional for code changes and unit checks. If a local PostgreSQL
server is available, point `DATABASE_URL` at a dedicated OpsFlow database and
run `npm run db:migrate`. Start the API and web separately with
`npm run build:packages`, `npm run dev -w @opsflow/api`, and
`npm run dev -w @opsflow/web`. The worker needs Redis and will exit clearly
when Redis is unavailable.

npm workspaces was chosen because it ships with npm and needs no additional
workspace manager. `packages/shared` and `packages/config` compile before the
apps so Node can import their built JavaScript. The lockfile is included; use
`npm ci` for reproducible installs.

## 6. Branching

Recommended:
- `main` stays working
- feature work uses short-lived branches where practical

For AI-assisted development, direct work on a feature branch is preferable for larger changes.

## 7. Commit Style

Preferred examples:

```text
feat: add workflow execution queue
fix: enforce organization scope on workflow lookup
test: add condition evaluator coverage
docs: update worker architecture
refactor: extract workflow service
```

## 8. Definition of Done

A task is not complete until:

- implementation works
- types pass
- tests pass or missing tests are documented
- lint passes
- migrations are included if schema changed
- affected documentation is updated
- HANDOFF.md is updated when an AI agent stops work

## 9. Documentation Rule

The code is the implementation source of truth.

The documentation must be updated to match it.

If implementation intentionally deviates from a document, update the document in the same milestone.

## 10. Demo Data

Use seeded fake data only.

No personal credentials or real customer data should enter the repository.
