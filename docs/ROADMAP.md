# OpsFlow Roadmap

The roadmap is intentionally milestone-based so each AI coding agent can complete one coherent unit of work before handing off.

## Phase 0 — Repository Foundation (implemented)

Goals:
- initialize monorepo
- create web, API, and worker apps
- configure TypeScript
- configure linting and formatting
- create shared package
- create Docker Compose for PostgreSQL and Redis
- add `.env.example`
- create basic health endpoints
- create CI checks

Exit criteria:
- repository installs
- services boot
- TypeScript passes
- CI passes

Implementation note: install, lint, typecheck, tests, and build passed locally.
The API and web dev server responded locally. Docker was unavailable during
Phase 0, but PostgreSQL, Redis, and worker readiness subsequently passed the
Phase 3 Milestone 1 infrastructure gate. CI workflow is present but has not run
on GitHub.

## Phase 1 — Authentication and Organizations (implemented)

Goals:
- database migration system
- users
- sessions
- organizations
- organization memberships
- registration
- login
- logout
- organization creation
- organization switching

Exit criteria:
- authenticated user can create and access an organization
- unauthorized organization access is rejected
- tests cover critical authorization behavior

Phase 1 implementation and PostgreSQL integration tests passed against an
isolated local test cluster. Frontend registration, login, logout,
organization list, create, and selection are implemented. Docker Compose and
worker readiness subsequently passed the Phase 3 Milestone 1 infrastructure
gate. Hosted GitHub Actions remains unverified.

## Phase 2 — Workflow CRUD (implemented)

Goals:
- workflow tables
- workflow steps
- create workflow
- edit workflow
- add trigger
- add conditions
- add actions
- activate/deactivate workflow
- workflow validation

Exit criteria:
- a workflow can be fully configured and persisted

Phase 2 schema, API, shared validation, editor, and PostgreSQL integration
tests are implemented. Activation changes state but does not execute. The
frontend does not expose optional HTTP headers, AI output schema, or retry
settings yet, though the API validates and stores them. Docker Compose, Redis,
and worker readiness subsequently passed the Phase 3 Milestone 1 infrastructure
gate. Hosted GitHub Actions remains unverified.

## Phase 3 — Queue and Worker

Progress:
- Milestone 1 complete: disposable PostgreSQL and Redis health, persistence,
  application connectivity, worker readiness, and graceful shutdown verified
- Milestone 2 complete: shared execution snapshot and queue payload contracts,
  execution tables, and durable queue outbox migration
- Milestone 3 complete: authenticated manual test execution creation atomically
  stores the execution snapshot, copied steps, and pending outbox row
- outbox dispatch, BullMQ production/consumption, and execution state
  transitions remain pending

Goals:
- connect the existing Redis client to BullMQ
- BullMQ setup
- job queue
- worker process
- workflow execution rows
- execution step rows
- execution status transitions

Exit criteria:
- manual test event queues successfully
- worker processes the job
- results persist

## Phase 4 — Conditions and Core Actions

Implement:
- condition evaluator
- log action
- internal task action
- mock email action

Exit criteria:
- workflows can conditionally execute actions
- step-level results are visible

## Phase 5 — Webhook Trigger

Goals:
- public webhook endpoint
- public webhook identifier
- endpoint secret
- idempotency handling
- queue execution

Exit criteria:
- an external HTTP request can trigger a workflow locally

## Phase 6 — HTTP Action

Goals:
- configurable HTTP request action
- timeout
- response limits
- structured result
- local safety restrictions

Exit criteria:
- workflow can call an approved external or test endpoint

## Phase 7 — AI Provider Abstraction

Goals:
- AI provider interface
- mock provider
- optional Anthropic/OpenAI provider
- structured validation

AI must remain optional.

Exit criteria:
- project works with `AI_PROVIDER=mock`
- real provider can be enabled through environment configuration

## Phase 8 — Execution Dashboard

Goals:
- execution list
- status filters
- execution details
- step timeline
- error view
- retry visibility

Exit criteria:
- workflow behavior can be demonstrated visually

## Phase 9 — Audit Logs and Polish

Goals:
- audit log UI
- consistent empty states
- loading and error states
- demo seed data
- screenshots
- README improvement

## Phase 10 — Portfolio Hardening

Goals:
- unit tests
- integration tests
- worker tests
- GitHub Actions
- Docker-based reproducibility
- architecture diagram
- demo recording instructions
- cleanup
- accessibility review

## Future Deployment Phase

Not part of the initial build.

Potential work:
- deploy frontend
- deploy API
- deploy worker
- managed PostgreSQL
- managed Redis
- production secrets
- observability
- rate limiting
- HTTPS
