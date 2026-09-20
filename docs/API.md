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

It does not check database or Redis readiness. The authentication and
organization endpoints below are implemented in Phase 1; later sections remain
planned contracts.

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

## 3. Workflows

The endpoints in this section and below are planned and have not been implemented.

### GET `/api/organizations/:organizationId/workflows`

Lists workflows.

### POST `/api/organizations/:organizationId/workflows`

Creates a workflow.

### GET `/api/organizations/:organizationId/workflows/:workflowId`

Returns workflow details.

### PATCH `/api/organizations/:organizationId/workflows/:workflowId`

Updates workflow metadata or configuration.

### DELETE `/api/organizations/:organizationId/workflows/:workflowId`

Deletes or archives a workflow.

### POST `/api/organizations/:organizationId/workflows/:workflowId/activate`

Activates a workflow.

### POST `/api/organizations/:organizationId/workflows/:workflowId/deactivate`

Deactivates a workflow.

### POST `/api/organizations/:organizationId/workflows/:workflowId/test`

Creates a test execution.

## 4. Executions

### GET `/api/organizations/:organizationId/executions`

Lists executions.

Supported filters may include:
- workflowId
- status
- from
- to

### GET `/api/organizations/:organizationId/executions/:executionId`

Returns execution details and steps.

## 5. Webhooks

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

## 6. Internal Tasks

### GET `/api/organizations/:organizationId/tasks`

Lists generated tasks.

### PATCH `/api/organizations/:organizationId/tasks/:taskId`

Updates task status.

## 7. Audit Logs

### GET `/api/organizations/:organizationId/audit-logs`

Returns audit entries.

## 8. API Error Format

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

## 9. HTTP Rules

- use correct HTTP status codes
- avoid leaking internal stack traces
- validate request bodies
- enforce authorization server-side
- paginate list endpoints before large datasets become possible
