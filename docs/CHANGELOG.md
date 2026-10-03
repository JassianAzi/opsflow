# Changelog

All notable project changes should be recorded here.

This project uses milestone-oriented development rather than strict semantic versioning during the initial build.

## Unreleased

### Phase 3 — Milestone 5 Worker Consumption and Execution Lifecycle

- added a BullMQ consumer that accepts only the strict `{ executionId }` job,
  verifies its deterministic job ID, and loads the persisted immutable
  execution snapshot and copied steps without reading mutable workflow rows
- added atomic execution claims with UUID token fencing and expiring leases;
  duplicate deliveries of terminal executions are harmless
- added an expired-claim recovery monitor so a worker termination cannot leave
  an execution running indefinitely
- records the Phase 3 deferred-engine result explicitly: copied steps become
  `skipped` with a reason and the execution becomes `failed` with
  `EXECUTION_ENGINE_NOT_IMPLEMENTED`; no condition or action is evaluated
- records invalid snapshots, unexpected processing errors, and worker
  termination under distinct durable error types; database write failures fail
  and retry the BullMQ job instead of reporting false completion
- added migration `0005_certain_secret_warriors.sql` for execution error type,
  processing token, lease expiration, consistency constraint, and recovery
  index without modifying migrations 0000 through 0004
- added PostgreSQL and Redis integration coverage for transport-only
  processing, duplicates, immutable snapshot use after workflow edits,
  crash/restart recovery, tenant identity validation, redacted unexpected
  errors, and database retry recovery
- configured dispatched BullMQ jobs with bounded retry and exponential backoff
- added durable reconciliation for published executions left queued after a
  BullMQ retry cycle exhausts during a PostgreSQL outage; retained failed jobs
  are retried with the same deterministic ID after connectivity returns
- made reconciliation restart-safe and safe across multiple workers by using
  durable PostgreSQL eligibility plus BullMQ's atomic finished-job retry
- separated processing failures from outcome persistence failures so a
  transient database write error is retried without changing the intended
  domain result to `EXECUTION_PROCESSING_ERROR`
- moved all processing-lease eligibility and remaining-time calculations to
  PostgreSQL's clock while preserving UUID token fencing
- added focused coverage for retry exhaustion and recovery, concurrent
  reconcilers, one-time persistence failure, stale claim owners,
  recovery/reclaim races, production retry options, and the complete manual
  API-to-outbox-to-consumer path
- updated the disposable infrastructure gate for the combined dispatcher and
  consumer readiness message; the gate passes including graceful SIGTERM
- added migration `0006_oval_king_cobra.sql` with durable reconciliation
  attempt, availability, error, and fenced claim fields plus the persisted
  BullMQ delivery attempt used by processing ownership
- made invalid retained job names, payloads, or IDs atomically fail a still
  queued execution with `EXECUTION_QUEUE_PAYLOAD_INVALID`; copied steps are
  skipped and active or terminal executions remain fenced from the update
- bounded reconciliation to five durable cycles across restarts and concurrent
  workers, with exponential backoff capped at five minutes and terminal
  `EXECUTION_QUEUE_RECOVERY_EXHAUSTED` handling
- allowed a later BullMQ delivery attempt to replace an earlier live processing
  claim after a transient outcome-write failure, while retaining UUID token
  fencing; expired claims now receive a 15-second retry grace period and the
  neutral `EXECUTION_PROCESSING_LEASE_EXPIRED` outcome
- added integration coverage for corrupt job identity variants, more than one
  reconciliation batch of corrupt jobs, durable retry exhaustion across
  restarts and concurrent workers, active-claim fencing, and the production
  consumer/recovery race after a one-time outcome persistence failure
- did not evaluate conditions or execute log, task, email, HTTP, or AI actions

### Phase 3 — Milestone 4 Durable Outbox Dispatch

- added a worker-side PostgreSQL outbox dispatcher with safe concurrent claims, UUID lease ownership, stale-lease recovery, and bounded retry/backoff
- added BullMQ production of strict `{ executionId }` jobs using the execution UUID as the deterministic job ID
- mark outbox rows published only after queue acknowledgement; Redis failures retain pending work and redacted errors until recovery or the attempt limit
- added migration `0004_mushy_mandarin.sql` for outbox claim tokens without modifying migrations 0000–0003
- added disposable PostgreSQL and Redis integration coverage for one dispatch, crash-gap duplicate submission, concurrent dispatchers, outage recovery, bounded failure, and clean dispatcher shutdown
- made worker readiness verify the migrated outbox relation and updated the disposable infrastructure gate to migrate before testing Linux startup and SIGTERM shutdown
- added Redis to CI services; hosted GitHub Actions remains unverified
- replaced the deprecated `docker stop --time` gate flag with `--timeout`
- independently reviewed and committed as `b7250a6`
- did not add a BullMQ consumer, execution or step status changes, condition evaluation, or actions

### Phase 3 — Milestone 3 Transactional Manual Execution Creation

- added an authenticated manual test endpoint that returns HTTP 202 with an execution ID
- locked membership and the tenant-scoped workflow while atomically creating the server-built snapshot, copied steps, and pending outbox row
- added optional `Idempotency-Key` handling that returns the original execution without duplicate rows
- changed workflow deletion with retained history to `409 WORKFLOW_HAS_EXECUTIONS`
- added PostgreSQL integration coverage for authorization, workflow state and trigger rules, tenant isolation, snapshot independence, rollback, idempotency, and deletion conflicts
- did not add Redis access, outbox dispatch, BullMQ production or consumption, condition evaluation, or action execution

### Phase 3 — Milestone 2 Execution Contracts and Migration

- added shared Zod contracts for execution and step statuses, immutable workflow and step snapshots, persisted execution steps, and the minimal `{ executionId }` queue job
- added `workflow_executions`, `execution_steps`, and `execution_queue_outbox` in migration `0003_chilly_texas_twister.sql`
- added tenant-consistent workflow execution foreign keys, restrictive workflow history deletion, immutable step copies without mutable step foreign keys, idempotency and ordering indexes, and lifecycle checks
- constrained each durable outbox payload to the matching execution ID and added dispatch lookup state without dispatching jobs
- added focused shared contract and PostgreSQL integrity tests, including direct coverage for execution idempotency, retry bounds, and timestamp ordering; no execution API, BullMQ producer/consumer, or workflow action behavior was added
- clarified that Docker Compose, Redis, and worker readiness passed the later Milestone 1 gate while hosted GitHub Actions remains unverified

### Phase 3 — Milestone 1 Infrastructure Gate

- statically verified the existing PostgreSQL and Redis Compose definitions, configurable host ports, health checks, and persistent volumes
- added a Windows PowerShell 5.1 compatible disposable infrastructure gate with dynamically selected host ports, unique Compose resource names, single-pass cleanup, and failure diagnostics
- verified PostgreSQL and Redis health plus `services:check` before and after a clean container recreation
- verified PostgreSQL and Redis marker persistence through the volume-backed restart
- verified worker Redis readiness and graceful SIGTERM shutdown with exit code 0
- verified that the gate removed only its disposable containers, network, volumes, worker image, and temporary build context
- selected `npm.cmd` explicitly to avoid the installed `npm.ps1` shim's unsupported `InvocationInfo.Statement` access on Windows PowerShell 5.1
- recorded hosted GitHub Actions as separately unverified because no hosted run is available

### Phase 2 Remediation

- added required `expectedVersion` checks for workflow configuration updates and `409 WORKFLOW_VERSION_CONFLICT` responses that preserve newer definitions
- added editor dirty-state detection, save-before-activate enforcement, discard confirmations, and page-unload protection
- added PostgreSQL checks for positive workflow versions, nonnegative step order, and condition/action type consistency in migration `0002_sticky_joseph.sql`
- added focused concurrency, tenant status-action, deactivation version, database constraint, and editor draft-protection tests
- recorded that the original Phase 2 implementation was committed as `57255fc`

### Phase 2 — Workflow CRUD

- added Drizzle workflows and workflow steps schema with a versioned migration
- added shared trigger, condition, action, and retry validation schemas
- added member-scoped workflow CRUD, activation validation, linear ordering, and version tracking
- added a workflow list and ordered editor to the React organization workspace
- added PostgreSQL API integration coverage for workflow authorization, CRUD, validation, activation, and ordering

### Phase 1 — Authentication and Organizations

- made PostgreSQL and Redis host ports configurable, defaulting PostgreSQL to 5433
- added Drizzle users, sessions, organizations, and memberships schema with a versioned migration
- added scrypt password hashing, database-backed opaque sessions, HTTP-only cookies, and auth routes
- added transactional organization creation, membership-scoped reads, owner role changes, and last-owner protection
- added React authentication and organization screens with a local `/api` proxy
- added PostgreSQL-backed API integration tests and a CI PostgreSQL test service

### Phase 0 — Repository Foundation

- created npm TypeScript workspaces for the web, API, worker, shared, and config packages
- added a React/Vite/Tailwind starter, Fastify health route, and separate Redis-aware worker process
- added Zod environment validation, shared health contract, Drizzle client and empty migration structure
- added PostgreSQL and Redis Docker Compose services with persistent volumes
- added Vitest smoke tests, root checks, GitHub Actions CI, lockfile, and Git hygiene
- updated setup and architecture documentation; local Docker validation remains pending

### Planning

- defined project scope
- defined local-first development strategy
- defined monorepo architecture
- defined initial database model
- defined initial API surface
- defined security baseline
- defined phased roadmap
- defined AI coding and handoff protocol
