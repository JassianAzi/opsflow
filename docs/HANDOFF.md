# OpsFlow AI Handoff

This file is the canonical transfer document between coding agents.

Every AI agent must update this file before ending a work session.

---

## Current State — Phase 3 Milestone 4 Durable Outbox Dispatch

### Milestone and Status

Phase 3 Milestone 4 is **implemented and intentionally uncommitted for
review**. The worker now claims committed PostgreSQL outbox rows and publishes
strict `{ executionId }` jobs to BullMQ. It does not consume jobs, change
execution or step status, evaluate conditions, or perform actions.

The independently reviewed Milestone 3 was validated again and committed
separately as `da0a0299210f4fd285b5cfa8fb2bf998b24088ff feat: create manual
workflow executions` before Milestone 4 work began.

### Dispatch and Reliability Design

- The worker verifies PostgreSQL connectivity and the required outbox relation
  at startup, starts a dedicated outbox dispatcher module, and stops the
  polling loop, BullMQ queue connection, and PostgreSQL pool on SIGINT or
  SIGTERM.
- `PostgresOutboxRepository.claimNext` uses a transaction and `FOR UPDATE SKIP
  LOCKED` to select one due pending row. The claim records `locked_at`, a random
  UUID `lock_token`, and increments `attempt_count`. Multiple dispatcher
  instances can claim different rows without sharing ownership.
- Claim completion and failure updates require both the row ID and matching
  lock token. A stale claim becomes eligible after 30 seconds. Claims that
  crash on their final allowed attempt are changed to `failed` after the lease
  expires.
- The dispatcher validates the stored payload with the shared strict
  `executionQueueJobSchema` and confirms its execution ID matches the outbox
  row. Invalid persisted payloads fail permanently without reaching Redis.
- BullMQ receives job name `execute-workflow`, data `{ executionId }`, and the
  execution UUID as its deterministic job ID. Completed and failed jobs are
  retained so that this ID remains a deduplication key.
- The outbox row is marked `published` only after `Queue.add` resolves. A crash
  after Redis accepts the job but before PostgreSQL updates the row leaves a
  stale lease; the later retry uses the same job ID, gets BullMQ's duplicate
  acknowledgement, and safely marks the row published.
- Redis publication uses a finite request retry and two-second timeout.
  Failures clear the lease, retain a redacted and truncated error, and advance
  `available_at` with exponential backoff from one to sixty seconds. Five
  attempts are allowed by default. Redis unavailability does not stop the
  worker, so pending work recovers after Redis or the process returns.
- Queue constants and the job payload schema remain in `packages/shared`.
  There is no worker consumer in this milestone.

### Database and Migration State

- Added `apps/api/drizzle/0004_mushy_mandarin.sql` and
  `apps/api/drizzle/meta/0004_snapshot.json`; the migration adds nullable UUID
  `execution_queue_outbox.lock_token` for claim ownership.
- Updated the Drizzle journal and current schema. Migrations 0000–0003 were not
  edited.
- Migration 0004 was applied successfully after migrations 0000–0003 to a
  fresh disposable PostgreSQL 16 database named exactly `opsflow_test`.

### Focused Tests

- A single due row produces one BullMQ job with the exact name, deterministic
  ID, and payload, then records a published outbox row.
- A simulated crash after queue submission expires its database lease; a new
  dispatcher submits the same deterministic ID, leaves one waiting job, and
  marks the row published on its second claim.
- Two dispatcher instances claim and publish four rows concurrently with one
  attempt and one job per execution.
- An unavailable Redis endpoint leaves a row pending with redacted error and
  backoff; a new dispatcher publishes it after Redis recovery.
- Repeated publication failure reaches the bounded attempt count and records a
  failed row.
- The polling dispatcher starts, publishes pending work, and stops cleanly.

### Files Changed in Milestone 4

Added:

- `apps/api/drizzle/0004_mushy_mandarin.sql`
- `apps/api/drizzle/meta/0004_snapshot.json`
- `apps/worker/src/outbox/dispatcher.ts`
- `apps/worker/src/outbox/publisher.ts`
- `apps/worker/src/outbox/repository.ts`
- `apps/worker/src/outbox.integration.test.ts`

Modified:

- `.github/workflows/ci.yml`
- `apps/api/drizzle/meta/_journal.json`
- `apps/api/src/db/schema.ts`
- `apps/worker/package.json`
- `apps/worker/src/index.ts`
- `apps/worker/tsconfig.json`
- `package-lock.json`
- `package.json`
- `packages/shared/src/executions.ts`
- `scripts/verify-infrastructure-gate.ps1`
- `README.md`
- `docs/API.md`
- `docs/ARCHITECTURE.md`
- `docs/DATABASE.md`
- `docs/DEVELOPMENT.md`
- `docs/ROADMAP.md`
- `docs/CHANGELOG.md`
- `docs/HANDOFF.md`

### Commands and Results

- Milestone 3 closeout: `npm run lint`, `npm run typecheck`, `npm run
  format:check`, `npm run build`, Drizzle consistency, migration immutability,
  and `git diff --check` passed. Fresh disposable PostgreSQL migration and all
  **46 tests in 7 files** passed before commit
  `da0a0299210f4fd285b5cfa8fb2bf998b24088ff`.
- `npm run db:generate`: passed and generated migration 0004 plus its snapshot.
- Initial `npm run lint`, `npm run typecheck`, and `npm run format:check`:
  passed.
- Disposable containers `opsflow-m4-pg-b5df4cf972` and
  `opsflow-m4-redis-b5df4cf972` reached healthy on dynamic loopback ports 57195
  and 57196. `npm run db:migrate` applied migrations 0000–0004, and the first
  integration run passed **51 tests in 8 files**.
- A first rerun of `scripts/verify-infrastructure-gate.ps1` exposed that the
  worker logged readiness after a generic database ping and then reported its
  missing outbox relation in the gate's unmigrated database. Startup now
  verifies that relation, and the gate now applies committed migrations before
  launching its Linux worker image.
- The corrected gate used disposable project
  `opsflow-m1-6608-b3cdebb1` on dynamic ports 57684 and 57685. PostgreSQL and
  Redis health, both `services:check` calls, migrations 0000–0004, persistence
  through restart, worker readiness without a polling error, SIGTERM exit code
  0, and scoped cleanup all passed.
- Final `npm run lint`, `npm run typecheck`, `npm run format:check`, and
  `npm run build`: passed. Vite emitted only its existing nonfatal Zod comment
  and bundle-size warnings.
- Final `npm run db:migrate`: passed as an idempotent migration check against
  the disposable database. Final `npm test` passed **52 tests in 8 files**,
  including six PostgreSQL-and-Redis dispatcher integration tests.
- `npm exec --workspace @opsflow/api drizzle-kit check`: passed with
  `Everything's fine`.
- `git diff --exit-code HEAD --` for migrations 0000–0003: passed unchanged.
- `git diff --check`: passed with line-ending notices only.
- The dedicated Milestone 4 PostgreSQL and Redis containers and the gate's
  Compose projects, volumes, worker images, and temporary contexts were
  removed after validation.

### Observability

Pending and terminal dispatch work can be inspected without selecting stored
payloads:

```sql
SELECT status, count(*) FROM execution_queue_outbox GROUP BY status;
SELECT id, execution_id, attempt_count, available_at, last_error
FROM execution_queue_outbox
WHERE status IN ('pending', 'failed')
ORDER BY available_at;
```

Worker logs contain execution IDs and publish/retry state, but omit payloads,
Redis URLs, and credentials.

### Known Issues, Limits, and Git State

- No BullMQ consumer or workflow execution behavior exists yet. Waiting jobs
  intentionally remain in Redis.
- Queue acknowledgements and PostgreSQL updates cannot be one distributed
  transaction. Deterministic retained job IDs make the crash gap at-least-once
  safe for this producer; later consumers must also be idempotent.
- Hosted GitHub Actions remains unverified. The workflow now provisions Redis
  for dispatcher integration tests, but no hosted run was available.
- The optional Phase 2 concurrent PATCH interleaving and rendered dirty-editor
  tests remain deferred. Existing older routes retain the tracked membership
  revocation timing window.
- Milestone 4 changes listed above are the only working-tree changes and must
  remain uncommitted for independent review. `git status --short` lists only
  those modified and added files; there are no temporary test artifacts.

### Recommended Next Action

Independently review and commit Milestone 4. Then implement a BullMQ consumer
as the next isolated milestone: claim one execution by ID, enforce idempotent
execution state transitions, and prove crash/retry behavior before evaluating
conditions or actions.

---

## Previous State — Phase 3 Milestone 3 Transactional Manual Execution Creation

### Milestone and Status

Phase 3 Milestone 3 is **complete for transactional manual test execution
creation**. An authenticated organization member can request a test run for an
active manual workflow. The API returns HTTP 202 with an execution ID after one
PostgreSQL transaction commits the server-built workflow snapshot, copied
execution steps, and one pending queue outbox row.

Milestone 2 was reviewed independently, extended with its requested constraint
coverage, and committed separately as
`fe3c2458ae1980d82f0cbfbffa0e8f87ca6d397a feat: add phase 3 execution
contracts`.

No Redis call, outbox dispatch, BullMQ producer or consumer, worker database
access, condition evaluation, action execution, or execution status processing
was added.

### API and Transaction Design

- Added `POST /api/organizations/:organizationId/workflows/:workflowId/test`.
  It returns `202 { "executionId": "<uuid>" }`.
- The route uses the existing session guard and parses organization and
  workflow UUIDs with shared schemas. The optional standard `Idempotency-Key`
  header is trimmed and limited to 1–200 characters.
- The repository opens one transaction, locks the requesting user's matching
  organization membership with `FOR SHARE`, then locks the workflow selected
  by both workflow and organization ID with `FOR UPDATE`.
- Only active manual workflows are accepted. The service constructs the
  snapshot from the locked workflow and its ordered database steps and validates
  it with `workflowExecutionSnapshotSchema`; client-supplied workflow
  definitions are never accepted.
- The transaction inserts the queued `workflow_executions` row, all copied
  `execution_steps`, and exactly one pending `execution_queue_outbox` row. Any
  failed insert rolls back all earlier writes.
- An idempotency key is unique per workflow. Requests for the same workflow and
  key serialize on the workflow lock; a replay returns HTTP 202 with the
  original execution ID and creates no duplicate execution, steps, or outbox
  row. Requests without a key create distinct executions. Current membership
  is required even for a replay.
- Draft or inactive workflows return `409 WORKFLOW_NOT_ACTIVE`; active webhook
  or schedule workflows return `409 WORKFLOW_TRIGGER_NOT_MANUAL`.
- Workflow deletion now locks the workflow and checks for retained execution
  history. History returns `409 WORKFLOW_HAS_EXECUTIONS` instead of an
  unhandled foreign-key error; workflows without history are still hard
  deleted.

### Database and Migration State

- Milestone 3 adds no migration and does not alter migration files.
- Migration `0003_chilly_texas_twister.sql` from Milestone 2 remains the latest
  migration and supplies the execution, copied step, and outbox tables.
- The manual test repository is the first application writer for those tables.
  The outbox remains pending until a later dispatcher is implemented.

### Focused Tests

- An organization member receives HTTP 202 and the database contains one
  queued execution, validated immutable snapshot, pending copied step, and
  exact `{ executionId }` outbox payload.
- Requests reject unauthenticated users, non-members, tenant-mismatched workflow
  IDs, draft workflows, and active non-manual workflows without creating an
  execution.
- Two concurrent requests with the same idempotency key return the same
  execution ID and leave exactly one execution, step set, and outbox row.
- Editing the active workflow after creation replaces its mutable step while
  the execution snapshot and copied step retain the original version, step ID,
  and configuration.
- A test-only PostgreSQL trigger forces the outbox insert to fail; the API
  returns its normal internal-error envelope and the transaction leaves zero
  execution, step, and outbox rows. The trigger and function are removed in a
  `finally` block.
- Deleting a workflow after creating an execution returns the documented 409,
  and both workflow and history remain.

### Files Changed in Milestone 3

Added:

- `apps/api/src/executions/repository.ts`
- `apps/api/src/executions/routes.ts`
- `apps/api/src/executions/service.ts`

Modified:

- `apps/api/src/app.ts`
- `apps/api/src/phase1.integration.test.ts`
- `apps/api/src/workflows/repository.ts`
- `apps/api/src/workflows/service.ts`
- `packages/shared/src/executions.ts`
- `packages/shared/src/executions.test.ts`
- `README.md`
- `docs/API.md`
- `docs/ARCHITECTURE.md`
- `docs/CHANGELOG.md`
- `docs/HANDOFF.md`
- `docs/ROADMAP.md`
- `docs/SECURITY.md`

### Commands and Results

- Milestone 2 closeout used disposable PostgreSQL 16 container
  `opsflow-m2-close-51d473e809` on dynamic host port `61120`.
  `npm run db:migrate` passed and `npm test` passed **39 tests in 7 files**;
  cleanup removed the container.
- Milestone 2 `npm run lint`, `npm run typecheck`, `npm run format:check`,
  `npm run build`, `npm exec --workspace @opsflow/api drizzle-kit check`, prior
  migration diff, and `git diff --check`: passed. Commit
  `fe3c2458ae1980d82f0cbfbffa0e8f87ca6d397a` was created.
- During Milestone 3, `npx prettier --write` on changed TypeScript files,
  `npm run lint`, and `npm run typecheck`: passed.
- First disposable Milestone 3 PostgreSQL run applied migrations 0000–0003 and
  passed **46 tests in 7 files**; container
  `opsflow-m3-test-af7c14a815` was removed.
- Final disposable PostgreSQL 16 run used container
  `opsflow-m3-final-43e86e7ac3` on dynamic host port `49157`.
  `npm run db:migrate` passed and `npm test` passed **46 tests in 7 files**,
  including concurrent idempotency requests; cleanup removed the container.
- Final `npm run lint`, `npm run typecheck`, `npm run format:check`, and
  `npm run build`: passed. Vite retained the existing nonfatal Zod annotation
  and greater-than-500-kB bundle warnings.
- `npm exec --workspace @opsflow/api drizzle-kit check`: passed with
  `Everything's fine`.
- `git diff --exit-code HEAD -- apps/api/drizzle`: passed; Milestone 3 changes
  no migration.
- `git diff --check`: passed with line-ending notices only.

### Known Issues, Assumptions, and Git State

- The outbox is durable but has no dispatcher. Rows remain `pending`; no Redis
  or BullMQ interaction occurs and the worker still only verifies Redis
  readiness.
- There is no execution read API or frontend test-run control yet. Those were
  outside this milestone.
- Hosted GitHub Actions remains unverified because no hosted run is available.
- The optional Phase 2 concurrent PATCH interleaving and rendered dirty-editor
  navigation tests remain deferred. Existing Phase 1 and Phase 2 routes retain
  the previously tracked membership-revocation timing window; the new manual
  execution path locks membership within its write transaction.
- `main` points to Milestone 2 commit
  `fe3c2458ae1980d82f0cbfbffa0e8f87ca6d397a`. Milestone 3 files listed above
  are uncommitted and contain the only working-tree changes.

### Recommended Next Action

Review and commit Milestone 3. Then implement the outbox dispatcher as a small
separate milestone: claim pending outbox rows safely, publish only
`{ executionId }` to BullMQ after database commit, record publish attempts and
errors, and prove retry behavior without consuming or executing jobs yet.

---

## Previous State — Phase 3 Milestone 2 Execution Contracts and Migration

### Milestone and Status

Phase 3 Milestone 2 is **complete for the requested contracts and migration
scope**. Shared schemas and PostgreSQL storage now define immutable workflow
execution snapshots, copied execution step definitions and state, and a
durable queue outbox whose job payload contains only `executionId`.

No manual test endpoint, execution service/repository, outbox dispatcher,
BullMQ producer or consumer, worker database access, status processor, or
workflow step execution was added. Phase 3 Milestone 1 is committed as
`8b22d3e5f6ac659bc690b2ebe399a51c70c28b0c chore: verify phase 3 infrastructure
gate`.

### Contracts and Storage Decisions

- `packages/shared/src/executions.ts` defines execution, execution step, and
  outbox statuses; immutable workflow and step snapshot schemas; the persisted
  execution step response shape; and strict queue jobs shaped only as
  `{ executionId: uuid }`.
- Executable snapshots require a valid trigger, at least one action,
  consecutive zero-based step order, conditions before actions, and valid
  action-specific configuration. Schedule snapshots require a cron expression.
- `workflow_executions.workflow_snapshot` stores the workflow identity,
  organization, version, metadata, trigger configuration, and complete ordered
  step definitions captured for one run.
- `execution_steps` copies `workflow_step_id`, order, type, action type, name,
  config, and retry config. `workflow_step_id` has no foreign key to mutable
  `workflow_steps`, so editing or deleting source steps cannot rewrite history.
- The execution-to-workflow relationship uses a composite
  `(workflow_id, organization_id)` foreign key. This enforces tenant
  consistency and uses restrictive deletion, so deleting a workflow cannot
  cascade away execution history.
- Workflow idempotency keys are unique per workflow. Execution and step
  listing/status indexes support later API and worker queries.
- `execution_queue_outbox` has one row per execution, retry/availability state,
  and a database check requiring `job_payload` to equal the matching
  `{ "executionId": execution_id }`. Milestone 3 must create the execution,
  steps, and outbox row atomically before adding a dispatcher.

### Migration and Database State

- Added `apps/api/drizzle/0003_chilly_texas_twister.sql` and
  `apps/api/drizzle/meta/0003_snapshot.json`; updated only the Drizzle journal
  metadata needed to register migration 0003.
- Migrations `0000_soft_next_avengers.sql`,
  `0001_previous_amazoness.sql`, and `0002_sticky_joseph.sql` are unchanged.
- Drizzle initially generated the composite workflow index after its dependent
  foreign key. The new, unapplied migration was corrected to create the unique
  index first.
- A fresh disposable PostgreSQL 16 container named
  `opsflow-m2-db-29792-e1a271b9` exposed only a dynamically assigned local port
  and contained a dedicated `opsflow_test` database. Migrations 0000–0003
  applied successfully; the migration catalog contained four entries and all
  three new tables were present. The container was removed after tests. No
  existing, unrelated, or production database was accessed.

### Focused Tests

- Shared contract tests accept complete snapshots and reject malformed action
  configuration, nondeterministic order, incomplete schedules, missing
  actions, unsupported statuses, and queue payloads with missing or extra
  fields.
- PostgreSQL tests persist an execution, copied step, and outbox row; delete
  the mutable source step; confirm both snapshots remain; and confirm workflow
  deletion is restricted while history exists.
- PostgreSQL tests reject cross-organization workflow execution references,
  negative execution step order, mismatched outbox payloads, and duplicate
  outbox rows.
- Review follow-up tests reject duplicate idempotency keys for one workflow,
  negative outbox attempt counts, and reversed execution and execution-step
  timestamps.

### Files Changed in Milestone 2

Added:

- `apps/api/drizzle/0003_chilly_texas_twister.sql`
- `apps/api/drizzle/meta/0003_snapshot.json`
- `packages/shared/src/executions.ts`
- `packages/shared/src/executions.test.ts`

Modified:

- `apps/api/drizzle/meta/_journal.json`
- `apps/api/src/db/schema.ts`
- `apps/api/src/phase1.integration.test.ts`
- `packages/shared/src/index.ts`
- `README.md`
- `docs/API.md`
- `docs/ARCHITECTURE.md`
- `docs/DATABASE.md`
- `docs/ROADMAP.md`
- `docs/CHANGELOG.md`
- `docs/HANDOFF.md`

### Commands and Results

- Milestone 1 closeout: `npm run lint`, `npm run typecheck`,
  `npm run format:check`, Windows PowerShell 5.1 parsing, and staged
  `git diff --check`: passed; commit
  `8b22d3e5f6ac659bc690b2ebe399a51c70c28b0c` created.
- `npm run build -w @opsflow/shared`: passed.
- `npx vitest run packages/shared/src/executions.test.ts`: 5 tests passed.
- `npm run db:generate`: passed and generated migration 0003. A direct diff
  confirmed migrations 0000–0002 remained unchanged.
- `npm run typecheck`: passed after the schema and test changes.
- Disposable PostgreSQL `docker run ... postgres:16-alpine`: reached healthy.
- With `DATABASE_URL` set only to the disposable `opsflow_test`,
  `npm run db:migrate`: passed; four migrations and the three new execution
  tables were confirmed through `psql`.
- With `TEST_DATABASE_URL` set only to that same disposable database,
  `npm test`: 38 tests in 7 files passed.
- `docker rm --force opsflow-m2-db-29792-e1a271b9`: passed; disposable database
  cleanup completed.
- Final `npm run lint`: passed.
- Final `npm run format:check`: initially identified only generated migration
  journal/snapshot JSON formatting; `npx prettier --write` corrected those two
  files and the rerun passed.
- Final `npm run typecheck`: passed for every workspace.
- Final `npm run build`: passed for every workspace. Vite retained the existing
  nonfatal Zod annotation and greater-than-500-kB chunk warnings.
- `npm exec --workspace @opsflow/api drizzle-kit check`: passed with
  `Everything's fine`.
- `git diff --exit-code HEAD --` for migrations 0000–0002: passed unchanged.
- `git diff --check`: passed with line-ending notices only.
- Independent Milestone 2 review found no blocking implementation defect. It
  identified stale roadmap infrastructure wording and missing direct coverage
  for several database constraints; both were corrected before commit.
- A new disposable PostgreSQL 16 container named
  `opsflow-m2-close-51d473e809` used dynamically assigned host port `61120`.
  `npm run db:migrate` applied migrations 0000–0003 successfully and
  `npm test` passed **39 tests in 7 files**. The container was force-removed
  after the run.

### Git State

Milestone 2 was committed as
`fe3c2458ae1980d82f0cbfbffa0e8f87ca6d397a feat: add phase 3 execution
contracts` after independent review and the focused constraint coverage
follow-up.

### Open Issues and Recommended Next Action

- Hosted GitHub Actions remains unverified because no hosted run is available.
- The optional concurrent PATCH interleaving and rendered dirty-navigation
  tests remain deferred. The membership-revocation timing window remains
  tracked for future authorization work.
- Milestone 3 should add an authenticated manual test endpoint and an
  execution service that locks and validates an active workflow, captures its
  snapshot, inserts execution/step/outbox rows in one transaction, then
  dispatches only committed outbox rows to BullMQ. Worker consumption and
  state transitions should be added and verified separately before action
  behavior begins.

---

## Previous State — Phase 3 Milestone 1 Infrastructure Gate

### Milestone and Status

Phase 3 Milestone 1 is **complete**. A normal Windows PowerShell 5.1 session
with Docker Desktop access ran `scripts/verify-infrastructure-gate.ps1` to
completion and ended with
`PHASE 3 MILESTONE 1 INFRASTRUCTURE GATE: PASSED`. PostgreSQL and Redis health,
application connectivity, worker readiness, graceful shutdown, and persistence
through service recreation were all demonstrated with a uniquely named
disposable Compose project. The script removed its containers, network, named
volumes, temporary worker image, and temporary build context after the run.
Existing Docker resources and the unrelated PostgreSQL listener on port 5432
were not touched.

This milestone added no execution schema, migration, API route, BullMQ job, or
workflow behavior. Phase 2 remediation remains committed as
`3a28d6b fix: harden phase 2 workflow editing`.

### Implementation and Gate Design

- Added `scripts/verify-infrastructure-gate.ps1` as a repeatable Windows
  PowerShell 5.1 compatible gate.
- The script creates a unique Compose project name and asks Windows for two
  currently available host ports instead of relying on fixed disposable ports.
- PostgreSQL 16 Alpine and Redis 7 Alpine start through the existing Compose
  file and must reach Docker health status `healthy`.
- `npm.cmd run services:check` must connect to both services before and after
  service recreation. `npm.cmd` is selected explicitly because the installed
  Node `npm.ps1` shim accesses `$MyInvocation.Statement`, which is unavailable
  under Windows PowerShell 5.1 in this invocation mode.
- The script writes unique PostgreSQL and Redis markers, recreates the service
  containers without deleting named volumes, and verifies both markers after
  restart.
- A temporary Linux worker image is built from the current worker and config
  packages. The worker must log readiness, accept SIGTERM, and exit with code
  0 within ten seconds.
- Resource ownership is scoped to the unique project and temporary worker
  names. Final cleanup is guarded so it runs once, ignores only harmless
  already-absent resources, preserves the primary failure, and restores the
  caller's environment and working directory.
- Failure diagnostics print the exception position and PowerShell script stack
  before cleanup. Native stdout and stderr are captured with
  `ErrorActionPreference=Continue`; the native exit code alone determines
  command success.

### Commands and Results

- External gate command:
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File
  .\scripts\verify-infrastructure-gate.ps1`: passed and printed the final gate
  success marker.
- Docker Compose configuration and startup: passed with dynamically selected
  disposable PostgreSQL and Redis host ports.
- PostgreSQL container health and `pg_isready`: passed.
- Redis container health and `redis-cli PING`: passed with `PONG`.
- First `npm.cmd run services:check`: passed with `PostgreSQL: connected` and
  `Redis: connected`.
- PostgreSQL and Redis persistence marker writes: passed.
- Compose `down` without `--volumes`, followed by `up --wait`: passed; both
  unique persistence markers survived container recreation.
- Second `npm.cmd run services:check`: passed after restart.
- Worker readiness: passed after the expected ready log.
- Worker `docker stop --signal SIGTERM --time 10`: passed; the container exit
  code was 0.
- Final disposable cleanup: passed; the gate removed its project containers,
  network, named volumes, worker container/image, and temporary build context.
- Windows PowerShell `5.1.26100.9444` parser check: passed.
- The exact native wrapper was tested under Windows PowerShell 5.1 with actual
  `npm.cmd --version` (exit 0) and a missing npm script (stderr plus exit 1):
  passed without the `npm.ps1` `Statement` error.
- Earlier sandbox attempts that could not access Docker Desktop remain useful
  environment history only; the successful external run supersedes them for
  Milestone 1 readiness.

### Files Changed

- `scripts/verify-infrastructure-gate.ps1`
- `docs/CHANGELOG.md`
- `docs/HANDOFF.md`

No application source, package dependency, Compose definition, environment
schema, database schema, or migration was changed.

### Remaining Limits and Next Action

- Hosted GitHub Actions remains unverified because no remote or hosted run is
  available. This is separate from the locally passed infrastructure gate.
- The optional concurrent PATCH interleaving and rendered dirty-navigation
  tests remain deferred. The existing membership-revocation timing window
  remains tracked.
- The infrastructure gate is ready for Phase 3 Milestone 2: add shared
  execution contracts and durable PostgreSQL execution/outbox tables without
  adding an API trigger, BullMQ dispatch, worker consumption, or step
  execution.

---

## Previous State — Phase 2 Remediation

### Milestone and Status

Phase 2 remediation is complete for the requested stale-update, unsaved-draft,
database-integrity, and focused-test scope. No Phase 3 execution, queue,
webhook, provider, or worker behavior was added. The original Phase 2 work is
committed as `57255fc feat: complete phase 2 workflow management`. The
remediation changes listed below are uncommitted on `main`.

### Implementation Summary

- Workflow configuration PATCH payloads now require `expectedVersion`. The
  repository compares it with the persisted version inside the existing
  transaction and `FOR UPDATE` row lock. A mismatch performs no write and
  returns `409 WORKFLOW_VERSION_CONFLICT` with a reload message. The React
  editor sends the version from its loaded workflow and never retries a
  conflict automatically.
- The editor compares metadata, trigger configuration, and ordered steps with
  its loaded workflow. It blocks activation while dirty. It describes the
  unsaved changes that will be lost before workflow reload/switch, editor
  close, selected-workflow deletion or deactivation, organization switch,
  creating another organization/workflow, and sign-out. It also registers a
  browser before-unload warning. Successful saves load the returned version as
  the new clean baseline.
- Added database checks for `workflows.version >= 1`, nonnegative
  `workflow_steps.step_order`, and the condition/action-to-`action_type`
  relationship. These are in new migration
  `apps/api/drizzle/0002_sticky_joseph.sql`; applied migrations 0000 and 0001
  were not edited.
- Expanded observable API tests for a successful expected-version update,
  stale conflict and preservation of the newer definition, cross-organization
  activation/deactivation, status-only version preservation, and database
  constraints. Browser-independent editor behavior tests exercise dirty
  comparisons, discard decisions and messages, and activation blocking.

### Migration Preflight and State

- Before applying migration 0002, explicit read-only queries against the
  dedicated `opsflow_test` database returned zero rows with an invalid version,
  negative step order, or inconsistent step/action type.
- `npm run db:migrate` applied 0002 only to
  `postgresql://opsflow_test@127.0.0.1:55433/opsflow_test`.
- PostgreSQL reports all three new constraints as validated and records three
  applied Drizzle migrations. `drizzle-kit check` reports the migration set is
  consistent. There is no seed data.

### Files Changed in This Remediation

Added:

- `apps/api/drizzle/0002_sticky_joseph.sql`
- `apps/api/drizzle/meta/0002_snapshot.json`
- `apps/web/src/workflow-editor.ts`
- `apps/web/src/workflow-editor.test.ts`

Modified:

- `apps/api/drizzle/meta/_journal.json`
- `apps/api/src/db/schema.ts`
- `apps/api/src/phase1.integration.test.ts`
- `apps/api/src/workflows/repository.ts`
- `apps/api/src/workflows/service.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/WorkflowWorkspace.tsx`
- `packages/shared/src/workflows.ts`
- `packages/shared/src/workflows.test.ts`
- `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/DATABASE.md`,
  `docs/DEVELOPMENT.md`, `docs/CHANGELOG.md`, `docs/HANDOFF.md`

### Commands and Results

- Read `docs/HANDOFF.md`, requirements and architecture documentation, the
  audit report, the Phase 2 commit diff, and current implementation before
  editing. Initial `git status --short --branch` was clean on `main`; recent
  history was `57255fc` followed by `0c130c0`.
- Baseline audit checks: `npm run lint`, `npm run typecheck`, and
  `npm run format:check` passed. PostgreSQL-backed `npm test` confirmed the
  reported 24 tests in five files. Baseline `npm run build` passed after an
  expected sandbox `spawn EPERM` retry with child-process permission.
- Baseline `npm run services:check` connected to isolated PostgreSQL and then
  failed because Redis refused `127.0.0.1:6379`. Worker startup loaded config
  and failed clearly for the same unavailable Redis service. Docker was not
  found on PATH. These are environment limits, not demonstrated code defects.
- `npm run db:generate` passed and created `0002_sticky_joseph.sql` plus its
  snapshot. A diff check confirmed migrations 0000 and 0001 were unchanged.
- PostgreSQL preflight query: `invalid_versions=0`, `invalid_orders=0`, and
  `inconsistent_step_types=0` in `opsflow_test`.
- `$env:DATABASE_URL='postgresql://opsflow_test@127.0.0.1:55433/opsflow_test'; npm run db:migrate`:
  passed. Constraint catalog query confirmed all three constraints validated.
- `$env:TEST_DATABASE_URL='postgresql://opsflow_test@127.0.0.1:55433/opsflow_test'; npm test`:
  **31 tests in 6 files passed** after rerunning with child-process permission;
  the first sandboxed attempt could not spawn Vitest workers (`EPERM`) and ran
  no tests.
- `npm run lint`, `npm run typecheck`, `npm run format:check`: passed.
- `npm run build`: passed for all packages and applications after rerunning
  with child-process permission; the first sandboxed Vite attempt could not
  spawn esbuild (`EPERM`). Vite retained its nonfatal Zod comment and
  greater-than-500-kB chunk warnings.
- `npm exec --workspace @opsflow/api drizzle-kit check`:
  passed with `Everything's fine`.
- `git diff --check`: passed with Windows LF-to-CRLF notices. The isolated
  PostgreSQL cluster was stopped after final validation.

### Remaining Findings and Environment Limits

- Membership authorization and workflow data access remain separate queries.
  Current cross-organization operations are blocked and tested, and there is no
  membership-removal endpoint, but a future revocation feature should combine
  membership enforcement with the workflow query/transaction to eliminate the
  narrow time-of-check/time-of-use window.
- Editor logic has focused unit coverage but no rendered browser component or
  end-to-end test harness. Optional HTTP headers, AI output schema, and retry
  settings remain API-only controls as documented.
- Docker Compose, Redis readiness, a successful worker-ready state, and hosted
  GitHub Actions remain unverified. Redis was not running locally. No production
  or unrelated database was accessed. The unrelated PostgreSQL listener on
  port 5432 was untouched.
- The production web build succeeds with a chunk-size warning. Existing
  Drizzle Kit/esbuild transitive advisories were not changed in this milestone.

### Git State and Recommended Next Action

The original Phase 2 milestone is committed as `57255fc`; all remediation
changes are currently uncommitted on `main`. Review and commit them as one
Phase 2 remediation change. Phase 2 is then ready for Phase 3 implementation,
but Redis/worker readiness must be verified in a Docker-capable environment
before Phase 3 can be called complete. When Phase 3 begins, preserve the
expected-version API and design versioned workflow definition snapshots before
execution records depend on replaceable workflow-step IDs.

---

## Previous State — Phase 2

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

### Entry 005 — Phase 2 remediation

Agent:
Codex

Summary:
Added expected-version conflict protection, dirty-editor safeguards, database
integrity constraints in migration 0002, and focused API/editor tests. The
original Phase 2 baseline is commit `57255fc`; remediation remains uncommitted.

Next:
Review and commit remediation, verify Redis/worker readiness and hosted CI when
available, then begin Phase 3 without weakening workflow version checks.
