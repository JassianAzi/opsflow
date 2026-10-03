# OpsFlow

A workflow-automation backend built as a portfolio engineering project:
organizations define workflows (trigger, ordered conditions and actions), and
executions are queued durably and processed by a background worker.

**Status: In Development.** Runs locally with Docker Compose; not deployed.

## What works today

- **Accounts and organizations:** registration, sign-in/out, multi-tenant
  organizations with `owner` and `member` roles, enforced on every
  organization-scoped route.
- **Workflow management:** create, edit, validate and activate workflows with a
  trigger and ordered condition/action steps, through the API and a React
  editor. Saves use optimistic concurrency (`expectedVersion`, `409` on a lost
  update).
- **Manual test executions:** one API call atomically stores an immutable
  execution snapshot, its copied steps, and a queue outbox row, with optional
  `Idempotency-Key` support.
- **Queue pipeline:** the worker dispatches committed outbox rows to BullMQ and
  consumes the jobs, recording a durable terminal result for every execution.

## In development

- **The workflow step engine is not implemented yet.** Every execution
  currently ends as `failed` with `EXECUTION_ENGINE_NOT_IMPLEMENTED`, and every
  copied step is recorded as `skipped`; no condition or action runs. The
  pipeline around it (dispatch, claiming, retries, recovery) is complete so the
  engine can be added without weakening those guarantees.

## Planned

Condition evaluation and core actions, webhook triggers, an HTTP action, an
optional AI-provider action (with a mock provider for cost-free development),
an execution dashboard, and audit logs. See `docs/ROADMAP.md`.

## Architecture

```text
apps/web      React + Vite (Tailwind)        workflow editor
apps/api      Fastify + Drizzle ORM          auth, organizations, workflows, executions
apps/worker   BullMQ + node-postgres         outbox dispatch, consumption, recovery
packages/shared  Zod contracts shared by every app
packages/config  validated environment and connection settings
```

PostgreSQL is the source of truth; Redis carries only the BullMQ queue. A job
contains just `{ executionId }`, and the worker re-reads and validates the
stored snapshot before doing anything.

## Engineering highlights

- **TypeScript npm-workspaces monorepo** with shared Zod contracts across API,
  worker and frontend.
- **Transactional outbox:** the execution, its snapshot and the outbox row
  commit in one transaction; the dispatcher publishes with deterministic job
  IDs, bounded retries and exponential backoff.
- **Immutable execution snapshots:** later workflow edits cannot change an
  execution already created.
- **Fenced leases:** workers claim executions with `FOR UPDATE`, a random
  processing token and a lease timed by PostgreSQL's `clock_timestamp()`; a
  worker that lost its claim cannot overwrite a newer result.
- **Concurrent-safe claiming** with `FOR UPDATE SKIP LOCKED` for outbox rows,
  expired leases and reconciliation work.
- **Idempotent processing:** duplicate or redelivered jobs are no-ops once an
  execution is terminal; manual executions accept an idempotency key.
- **Reconciliation and recovery:** expired claims, stalled jobs and executions
  left queued after Redis or worker failures are recovered with durable,
  capped retry counters and explicit terminal reasons.
- **Security basics:** scrypt password hashing, hashed session tokens in
  HTTP-only, SameSite cookies, tenant-scoped queries.
- **Integration tests against real PostgreSQL and Redis**, including forced
  worker termination, lost claims, concurrent recovery and queue outages.
- **GitHub Actions CI** provisions PostgreSQL 16 and Redis 7 service containers
  and runs lint, typecheck, tests and build.

## Run locally

Requirements: Node.js 22.12+, npm 10 and Docker Compose.

```bash
cp .env.example .env        # local-only sample values
docker compose up -d
npm ci
npm run db:migrate
npm run services:check
npm run dev
```

Web: `http://127.0.0.1:5173`. API health: `http://127.0.0.1:4000/health`.
PostgreSQL uses host port 5433 by default.

## Quality checks

```bash
npm run lint
npm run typecheck
npm test            # integration suites need TEST_DATABASE_URL and TEST_REDIS_URL
npm run build
```

Integration tests run only against a dedicated database named `opsflow_test`.
See `docs/DEVELOPMENT.md` for the exact setup, and
`scripts/verify-infrastructure-gate.ps1` for the Docker infrastructure check
(PostgreSQL/Redis health, migrations, persistence, Linux worker readiness and
graceful shutdown).

## Documentation

`docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/API.md`,
`docs/SECURITY.md`, `docs/DEVELOPMENT.md`, `docs/REQUIREMENTS.md`,
`docs/ROADMAP.md` and `docs/CHANGELOG.md`.
