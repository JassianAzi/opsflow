# OpsFlow Architecture

## 1. Architecture Overview

OpsFlow uses a local-first, service-oriented monorepo architecture.

The diagram below is the intended product architecture. Phase 2 currently
contains React authentication, organization, and workflow management views;
Fastify API routes for those features; six PostgreSQL tables; and a separate
worker process that checks Redis connectivity. No queue or workflow execution
is implemented yet.

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
Drizzle and node-postgres client in `apps/api/src/db/client.ts`; the worker can
add database access when execution work begins. Both Node processes validate
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
changes, so their IDs are not stable across an edited step set. Future
execution records will need a versioned definition snapshot or equivalent
before retaining references to historic steps.

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

## 6. Reliability Rules

### Idempotency
Webhook executions should support an idempotency key when possible.

### Retries
Retry configuration should include:
- maximum attempts
- delay
- exponential backoff where appropriate

### Failure Isolation
A worker crash should not corrupt workflow state.

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
