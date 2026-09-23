# OpsFlow Architecture

## 1. Architecture Overview

OpsFlow uses a local-first, service-oriented monorepo architecture.

The diagram below is the intended product architecture. Phase 2 contains React
authentication, organization, and workflow management views plus Fastify API
routes. Phase 3 Milestone 1 verified local PostgreSQL, Redis, and worker
readiness. Milestone 2 adds immutable execution snapshots, execution step
state, and a durable queue outbox in PostgreSQL. Milestone 3 adds transactional
manual test execution creation. Milestone 4 adds the worker-side durable
outbox dispatcher and BullMQ producer. No BullMQ consumer, execution state
processor, or workflow step execution is implemented yet.

```text
Browser
  |
  v
React Web App
  |
  v
REST API
  |
  +--------------------+
  |                    |
  v                    v
PostgreSQL           Redis
                       |
                       v
                    BullMQ
                       |
                       v
                    Worker
                       |
        +--------------+--------------+
        |              |              |
        v              v              v
    HTTP Action    Mock Email      AI Provider
```

## 2. Applications

### `apps/web`
Responsibilities:
- user interface
- authentication screens
- workflow management
- execution history
- organization management
- API consumption

The web app must not contain trusted authorization logic.

### `apps/api`
Responsibilities:
- authentication
- authorization
- organization context
- CRUD operations
- workflow validation
- webhook intake
- queue submission
- audit log creation

The API should remain responsive and avoid executing long-running workflow actions directly.

### `apps/worker`
Responsibilities:
- claim committed queue outbox records
- publish execution IDs to BullMQ
- consume queued workflow jobs
- evaluate workflow conditions
- execute workflow actions
- persist step state
- apply retry policies
- record errors
- emit execution progress events

## 3. Shared Packages

### `packages/shared`
Contains:
- shared TypeScript types
- enums
- Zod schemas
- API payload types
- workflow definition types

### `packages/config`
Contains:
- environment validation
- shared lint or TypeScript configuration where useful

It also exports a reusable Redis client factory. The API owns its
Drizzle and node-postgres client in `apps/api/src/db/client.ts`; the worker uses
a bounded node-postgres pool for outbox claims. Both Node processes validate
their required URLs at startup. The API health route is a liveness response and
does not imply PostgreSQL or Redis readiness; `npm run services:check` tests
both connections explicitly. API routes call services, which use dedicated
auth, organization, and workflow repositories. Organization reads join membership for the
current user; member role changes lock the organization row in a transaction.
The web app uses the Vite `/api` proxy locally so browser cookies remain on a
single origin.

Phase 2 workflow routes parse shared Zod schemas, delegate to a workflow
service, and reuse the Phase 1 organization membership check. Workflow queries
also scope IDs to `organization_id`, including reads, updates, status changes,
and deletes. The editor sends a full ordered step array through one PATCH
endpoint; the API validates and replaces the step set in a transaction.
Workflow steps are configuration only. They do not call providers, enqueue
work, or create execution records.

Configuration PATCH requests include the version the editor loaded. The
repository locks the workflow row, compares that expected version, and returns
HTTP 409 rather than overwriting a newer definition. The editor compares its
draft with the loaded definition, blocks activation until changes are saved,
and confirms before actions that discard an unsaved draft.

Phase 3 execution contracts live in `packages/shared`. An execution snapshot
captures the workflow version, trigger configuration, and ordered step
definitions. Each `execution_steps` row copies its source step identity, type,
name, configuration, and retry configuration without a foreign key to mutable
`workflow_steps`. Queue jobs contain only `executionId`. The durable outbox row
stores that same minimal payload so later dispatch can occur after the
execution transaction commits without placing a replaceable workflow
definition in Redis.

The manual test execution route keeps authorization and creation within one
PostgreSQL transaction. It locks the requesting user's membership and the
tenant-scoped workflow, accepts only active manual workflows, builds the
snapshot on the server, then inserts the execution, copied steps, and outbox
row atomically. An optional `Idempotency-Key` maps retries to the original
execution. The route returns after commit and does not require Redis.

The worker runs an outbox dispatcher module. Each dispatcher transaction uses
`FOR UPDATE SKIP LOCKED` to claim one available row with a UUID lease token, so
multiple instances can publish different rows safely. It validates the stored
minimal payload, submits a BullMQ job whose deterministic ID is the execution
UUID, and marks the row published only after `Queue.add` succeeds. A crash in
that gap leaves a reclaimable lease; resubmission uses the same job ID and is
deduplicated by BullMQ. Redis failures release the lease and schedule bounded
exponential backoff. The worker does not consume the queued job in Milestone 4.

## 4. Workflow Model

A workflow consists of:

```text
Trigger
  |
  v
Condition(s)
  |
  v
Action 1
  |
  v
Action 2
  |
  v
...
```

The Phase 2 model is linear: all conditions precede all actions. Submitted
step array positions become consecutive zero-based `step_order` values.
Activation requires at least one action and a complete trigger. Drafts can
contain zero steps. A successful configuration change increments `version`;
status changes do not. Steps are replaced as a set when their configuration
changes, so their IDs are not stable across an edited step set. Execution rows
therefore retain an immutable workflow definition snapshot, while execution
step rows copy their source definitions and treat `workflow_step_id` as
provenance rather than a foreign key.

Do not build a complex graph editor during MVP.

The data model should still allow future branching by keeping steps explicit and ordered.

## 5. Execution Lifecycle

1. An event enters the system.
2. The API validates the event.
3. An execution row is created.
4. A background job is added to Redis/BullMQ.
5. The worker loads the workflow definition.
6. The worker evaluates conditions.
7. Eligible actions run sequentially.
8. Each step persists status and result data.
9. The execution is marked completed or failed.
10. The UI reads the execution state from the API.

Milestone 2 implements the storage contracts for steps 3 and 8 and the outbox
needed between steps 3 and 4. Milestone 3 implements atomic execution, copied
step, and outbox creation for manual tests. Milestone 4 dispatches committed
outbox rows for step 4. Job consumption and status transitions remain separate
milestones.

## 6. Reliability Rules

### Idempotency
Manual test execution creation accepts an optional `Idempotency-Key` header.
Keys are unique per workflow, and a replay returns the original execution ID.
Webhook executions should use the same persisted contract when implemented.

### Retries
Retry configuration should include:
- maximum attempts
- delay
- exponential backoff where appropriate

### Failure Isolation
A worker crash should not corrupt workflow state.

Execution creation and its queue outbox insert share one PostgreSQL
transaction. The dispatcher retries unpublished outbox rows with a finite
attempt count, a stale-lease timeout, and bounded backoff. The outbox enforces
one payload per execution and the payload contains only the execution ID.
BullMQ job consumption and workflow processing remain future work.

### Observability
At minimum, record:
- execution ID
- workflow ID
- organization ID
- job ID
- step ID
- status
- start time
- completion time
- error type
- error message

## 7. Provider Abstractions

External services should be accessed through provider interfaces.

Example:

```ts
interface AiProvider {
  classify(input: ClassificationInput): Promise<ClassificationResult>;
}
```

Implementations could include:
- MockAiProvider
- AnthropicAiProvider
- OpenAiProvider

The workflow engine must not depend directly on a specific AI vendor.

## 8. Deployment Readiness

Local development should use Docker Compose.

Future production deployment may separate:
- web
- API
- worker
- PostgreSQL
- Redis

No code should assume all services run on localhost.

## 9. Architecture Rules

AI coding agents must preserve these rules:

1. Route handlers stay thin.
2. Business logic belongs in services.
3. Database access is centralized through repositories or well-defined data modules.
4. Authorization is enforced in the API.
5. Queue jobs reference persisted entities rather than containing large uncontrolled payloads.
6. Environment variables are validated at startup.
7. Shared domain types must not be duplicated across apps.
8. New integrations must be behind provider interfaces.
