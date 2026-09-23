# Changelog

All notable project changes should be recorded here.

This project uses milestone-oriented development rather than strict semantic versioning during the initial build.

## Unreleased

### Phase 3 — Milestone 4 Durable Outbox Dispatch

- added a worker-side PostgreSQL outbox dispatcher with safe concurrent claims, UUID lease ownership, stale-lease recovery, and bounded retry/backoff
- added BullMQ production of strict `{ executionId }` jobs using the execution UUID as the deterministic job ID
- mark outbox rows published only after queue acknowledgement; Redis failures retain pending work and redacted errors until recovery or the attempt limit
- added migration `0004_mushy_mandarin.sql` for outbox claim tokens without modifying migrations 0000–0003
- added disposable PostgreSQL and Redis integration coverage for one dispatch, crash-gap duplicate submission, concurrent dispatchers, outage recovery, bounded failure, and clean dispatcher shutdown
- made worker readiness verify the migrated outbox relation and updated the disposable infrastructure gate to migrate before testing Linux startup and SIGTERM shutdown
- added Redis to CI services; hosted GitHub Actions remains unverified
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
