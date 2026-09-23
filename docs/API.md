# OpsFlow API Specification

Base path:

```text
/api
```

Phase 0 exception: `GET /health` is outside `/api` and returns a liveness
response, for example:

```json
{
  "status": "ok",
  "service": "api",
  "timestamp": "2026-09-20T12:00:00.000Z"
}
```

It does not check database or Redis readiness. Authentication, organizations,
and workflow configuration endpoints are implemented. Phase 3 Milestone 2
adds internal execution and queue payload schemas plus database storage only;
execution, webhook intake, tasks, and audit endpoints remain planned contracts.

The API may evolve during implementation. Any breaking changes must be reflected in this document.

## 1. Authentication

### POST `/api/auth/register`

Creates a user.

Returns HTTP 201 with a `user` object containing `id`, `email`, `displayName`,
and `createdAt`.
Email is trimmed and lowercased. Passwords must be 12–128 characters. A
duplicate email returns `409 EMAIL_ALREADY_REGISTERED`.

Request:

```json
{
  "email": "demo@example.com",
  "password": "example-password",
  "displayName": "Demo User"
}
```

### POST `/api/auth/login`

Creates an authenticated session.

Accepts `{ "email", "password" }`, returns `{ "user": ... }`, and sets an
HTTP-only `opsflow_session` cookie. Invalid credentials return
`401 INVALID_CREDENTIALS`.

### POST `/api/auth/logout`

Invalidates the current session.

Returns `204`, deletes the server-side session if present, and clears the
cookie. Calling it without a session is allowed.

### GET `/api/auth/me`

Returns the current authenticated user.

Returns `{ "user": ... }` or `401 UNAUTHORIZED`.

## 2. Organizations

### GET `/api/organizations`

Returns organizations the user belongs to.

Returns an `organizations` array. Each item contains `id`, `name`, `slug`,
`role`, and `createdAt`.

### POST `/api/organizations`

Creates an organization.

Accepts `{ "name": string }`. Returns `201 { "organization": ... }` with the
creator's role as `owner`. Organization and membership are inserted in one
transaction. The slug is derived from the name with a random suffix.

### GET `/api/organizations/:organizationId`

Returns one organization if the user is a member.

Non-members receive `404 ORGANIZATION_NOT_FOUND`.

### GET `/api/organizations/:organizationId/members`

Returns members.

Returns a `members` array for organization members only. Each item contains
`id`, `userId`, `email`, `displayName`, `role`, and `createdAt`.

### PATCH `/api/organizations/:organizationId/members/:memberId`

Updates member role.

Accepts `{ "role": "owner" | "member" }`. Only an owner can change a role.
The last owner cannot be demoted. Non-members receive 404; members without the
owner role receive `403 OWNER_REQUIRED`; last-owner demotion receives
`409 LAST_OWNER`.

## 3. Workflows (implemented in Phase 2)

Every route requires an authenticated member of `:organizationId`. Owners and
members have the same workflow permissions in Phase 2. A non-member receives
`404 ORGANIZATION_NOT_FOUND`; a workflow outside the given organization receives
`404 WORKFLOW_NOT_FOUND`.

### GET `/api/organizations/:organizationId/workflows`

Returns `{ "workflows": [...] }` ordered by latest update. Each summary has
`id`, `organizationId`, `name`, `description`, `status`, `triggerType`,
`triggerConfig`, `version`, `createdBy`, `createdAt`, and `updatedAt`.

### POST `/api/organizations/:organizationId/workflows`

Accepts `name` (1–120 characters), optional `description`, `triggerType`, and
optional `triggerConfig`. Returns HTTP 201 with `{ "workflow": ... }` including
an empty `steps` array. The status is always `draft` and version is `1`.

```json
{"name":"Follow up","description":"New lead review","triggerType":"manual","triggerConfig":{}}
```

### GET `/api/organizations/:organizationId/workflows/:workflowId`

Returns `{ "workflow": ... }` including ordered `steps`. Steps have `id`,
`workflowId`, zero-based `stepOrder`, `stepType`, nullable `actionType`, `name`,
`config`, `retryConfig`, `createdAt`, and `updatedAt`.

### PATCH `/api/organizations/:organizationId/workflows/:workflowId`

Requires `expectedVersion` and accepts any nonempty subset of `name`,
`description`, `triggerType`, `triggerConfig`, and `steps`. `expectedVersion`
must equal the version returned when the workflow was loaded. The comparison
is performed while the workflow row is locked. A stale value returns
`409 WORKFLOW_VERSION_CONFLICT` without changing the newer definition; clients
must reload and must not silently retry. The `steps` field is the complete ordered step
array, not a partial patch. Its position defines `stepOrder` starting at zero.
Conditions must precede actions. Each element contains `stepType`,
`actionType` (`null` for conditions), `name`, `config`, and optional
`retryConfig`. An edit replaces all step rows in one transaction; new IDs are
assigned if the step set changes. Omit `steps` to leave them unchanged. A
material configuration change increments `version` once; an equivalent update
does not. Active workflows must remain fully valid after an edit.

```json
{
  "expectedVersion": 3,
  "steps": [
    {"stepType":"condition","actionType":null,"name":"Is active","config":{"field":"customer.status","operator":"equals","value":"active"}},
    {"stepType":"action","actionType":"log","name":"Log","config":{"message":"Active customer"}}
  ]
}
```

### DELETE `/api/organizations/:organizationId/workflows/:workflowId`

Hard deletes a workflow and its steps. Returns HTTP 204. Execution history does
not exist yet. A missing workflow returns 404.

### POST `/api/organizations/:organizationId/workflows/:workflowId/activate`

Validates the persisted workflow and sets status to `active`. Returns
`{ "workflow": ... }`. Requires at least one action, conditions before
actions, valid step configs, and a complete trigger config. An invalid
definition returns `400 WORKFLOW_INVALID` with `details` containing field paths.
Activation is idempotent and does not enqueue or execute anything. Status
changes update `updatedAt` but do not increment `version`.

### POST `/api/organizations/:organizationId/workflows/:workflowId/deactivate`

Sets status to `inactive` and returns `{ "workflow": ... }`. Idempotent; does
not increment `version`.

### Trigger and step configuration

- `manual` and `webhook` use `{}` for `triggerConfig`; webhook intake is not
  implemented.
- `schedule` uses `{ "cron": "0 9 * * 1-5", "timezone": "UTC" }`. Cron is a
  five-field numeric expression: minute, hour, day of month, month, weekday.
  Lists, ranges, `*`, and strides are accepted; named weekdays and macros are
  not. `cron` may be omitted on a draft but is required for activation. The
  optional timezone is an IANA name; future scheduling should default to UTC.
- Conditions use `{ "field": "customer.status", "operator": "equals", "value": "active" }`.
  Operators: `equals`, `not_equals`, `contains`, `greater_than`, `less_than`,
  `exists`, `does_not_exist`. Existence operators omit `value`; numeric
  comparisons require a number.
- Actions: `log` uses `{ "message": "..." }`; `internal_task` uses
  `{ "title": "...", "description": "..." }`; `mock_email` uses
  `{ "to": "demo@example.com", "subject": "...", "body": "..." }`;
  `http_request` uses `{ "method": "GET", "url": "https://example.com", "headers": {}, "body": "..." }`;
  `ai` uses `{ "operation": "classify", "prompt": "...", "outputSchema": {} }`.
  `extract` is also an AI operation. The API stores these configurations only.
  HTTP credential headers such as `Authorization`, `Cookie`, and `X-API-Key`
  are rejected; do not put secrets elsewhere in workflow JSON.
- Action `retryConfig` may contain `maxAttempts` (1–10) and `delayMs`
  (0–3,600,000). It is stored only. Conditions use `{}` and do not retry.

The web editor currently exposes required action fields. Optional HTTP
headers, AI output schema, and retry settings are API-only for now.

## 4. Planned API (not implemented)

The internal workflow execution queue payload is strictly
`{ "executionId": "<uuid>" }`. Workflow definitions, trigger payloads, and
step configuration remain in PostgreSQL snapshots and are not copied into the
queue job. No route creates or dispatches this payload yet.

### POST `/api/organizations/:organizationId/workflows/:workflowId/test`

Creates a test execution.

## 5. Executions

### GET `/api/organizations/:organizationId/executions`

Lists executions.

Supported filters may include:
- workflowId
- status
- from
- to

### GET `/api/organizations/:organizationId/executions/:executionId`

Returns execution details and steps.

## 6. Webhooks

### POST `/api/hooks/:publicId`

Receives external webhook events.

Requirements:
- resolve webhook endpoint
- validate endpoint state
- optionally validate a signature or shared secret
- create execution
- queue job
- return quickly

Do not perform the workflow synchronously inside this route.

## 7. Internal Tasks

### GET `/api/organizations/:organizationId/tasks`

Lists generated tasks.

### PATCH `/api/organizations/:organizationId/tasks/:taskId`

Updates task status.

## 8. Audit Logs

### GET `/api/organizations/:organizationId/audit-logs`

Returns audit entries.

## 9. API Error Format

Preferred response:

```json
{
  "error": {
    "code": "WORKFLOW_NOT_FOUND",
    "message": "Workflow not found."
  }
}
```

Validation errors may include structured field details.

Phase 1 uses `400 VALIDATION_ERROR` for malformed input, `401 UNAUTHORIZED`
for missing or expired sessions, and `500 INTERNAL_ERROR` for unexpected
server errors. Internal database details are never returned to clients.

## 10. HTTP Rules

- use correct HTTP status codes
- avoid leaking internal stack traces
- validate request bodies
- enforce authorization server-side
- paginate list endpoints before large datasets become possible
