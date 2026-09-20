# OpsFlow Requirements

## 1. Product Summary

OpsFlow is a workflow automation platform for creating and executing event-driven automation rules.

The initial version is designed for portfolio use and local development. It must be architected so that deployment can be added later without major rewrites.

## 2. Primary Users

### Organization Owner
Can:
- create and manage an organization
- invite or manage members
- create workflows
- enable or disable workflows
- view execution history
- manage organization settings

### Organization Member
Can:
- view workflows
- create or edit workflows if permitted
- test workflows
- inspect execution logs

Initial MVP may use Owner and Member only.

## 3. Core Functional Requirements

### Authentication
The system must support:
- user registration
- user login
- user logout
- secure password hashing
- session-based authentication
- session invalidation

### Organizations
Users must be able to:
- create an organization
- belong to one or more organizations
- switch active organization
- assign member roles

### Workflows
Users must be able to:
- create a workflow
- rename a workflow
- add a description
- enable or disable a workflow
- define a trigger
- define zero or more conditions
- define one or more actions
- save workflows as drafts
- test workflows
- delete workflows

### Triggers

MVP trigger types:
- manual test event
- inbound webhook
- scheduled trigger

### Conditions

MVP conditions should support:
- equals
- not equals
- contains
- greater than
- less than
- exists
- does not exist

### Actions

MVP action types:
- log message
- HTTP request
- create internal task
- send mock email
- AI text classification or extraction through a provider abstraction

The AI action must support a mock provider so development does not require paid API usage.

### Workflow Execution
The system must:
- create an execution record
- enqueue the workflow execution
- process workflow steps asynchronously
- store step inputs and outputs
- mark each step as pending, running, completed, skipped, or failed
- store error information
- support retry rules
- record timestamps

### Execution History
Users must be able to:
- view workflow executions
- filter by status
- inspect individual execution details
- inspect step-by-step execution results
- view failure reasons

### Audit Logs
The system must record important actions such as:
- workflow created
- workflow updated
- workflow enabled
- workflow disabled
- workflow deleted
- organization member role changed
- workflow executed manually

## 4. Non-Functional Requirements

### Security
- passwords must never be stored in plain text
- authentication cookies must be HTTP-only
- secrets must not be committed to Git
- authorization must be enforced server-side
- organization data must be tenant-isolated
- external HTTP actions must include SSRF protections before production deployment
- sensitive values should be redacted in logs where practical

### Reliability
- jobs must not silently disappear
- failed steps must record useful error details
- retries must be bounded
- duplicate webhook deliveries should be handled safely where possible

### Maintainability
- all shared types should live in a common package
- business logic should not be embedded directly in route handlers
- database migrations must be versioned
- configuration must come from environment variables
- new trigger and action types should be extendable without rewriting the workflow engine

### Testing
The project should include:
- unit tests for workflow evaluation
- integration tests for critical API endpoints
- execution tests for worker behavior

## 5. Out of Scope for MVP

Do not implement initially:
- billing
- paid subscriptions
- enterprise SSO
- complex drag-and-drop visual workflow canvas
- marketplace
- mobile app
- production-scale distributed infrastructure
- dozens of external integrations

These may be considered later.

## 6. Portfolio Success Criteria

The project is portfolio-ready when:

- local setup works from documented instructions
- the system supports a complete trigger-to-action workflow
- asynchronous execution works through a queue
- failures and retries are visible
- execution history is inspectable
- organization authorization is enforced
- the repo contains screenshots or demo media
- tests pass
- GitHub Actions validates the repository
- documentation accurately matches the implementation
