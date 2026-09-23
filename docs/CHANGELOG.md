# Changelog

All notable project changes should be recorded here.

This project uses milestone-oriented development rather than strict semantic versioning during the initial build.

## Unreleased

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
