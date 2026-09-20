# OpsFlow

OpsFlow is a local-first workflow automation platform designed as a portfolio-grade full-stack engineering project.

It allows users to define event-driven workflows such as:

> When an inbound event occurs, evaluate conditions, execute one or more actions, record the result, and surface the execution history in the dashboard.

The project is intentionally designed to demonstrate production-style engineering concepts without requiring paid hosting during development.

## Goals

OpsFlow should demonstrate:

- Full-stack TypeScript development
- Multi-tenant architecture
- Role-based access control
- Event-driven workflow execution
- Background job processing
- Retry and failure handling
- Webhooks and third-party integration patterns
- Audit logging
- Real-time or near-real-time execution updates
- API design
- Database design and migrations
- Automated testing
- Docker-based local development
- Clean documentation and AI-assisted development discipline

## Current Deployment Strategy

For the initial portfolio phase:

- Frontend runs locally
- Backend runs locally
- PostgreSQL runs locally
- Redis runs locally
- Background workers run locally
- Source code is intended for a public GitHub repository
- No paid deployment is required

Deployment is postponed. Public GitHub is the initial portfolio showcase.

## Run locally

Requirements: Node.js 22.12 or newer, npm 10, and Docker Compose.

```bash
cp .env.example .env
docker compose up -d
npm ci
npm run db:migrate
npm run services:check
npm run dev
```

The web app is at `http://127.0.0.1:5173`, and the API health check is at
`http://127.0.0.1:4000/health`. Register, sign in, and create an organization
in the web app. The worker connects to Redis and waits; job processing begins
in Phase 3. PostgreSQL uses host port 5433 by default to avoid a local 5432
conflict, while its container still uses 5432. The sample password in
`.env.example` is for local development only. Change `POSTGRES_PASSWORD` and
the password in `DATABASE_URL` together if you change it.

Useful root commands: `npm run lint`, `npm run typecheck`, `npm test`,
`npm run build`, and `npm run format:check`. See `docs/DEVELOPMENT.md` for details.

## Stack

### Frontend
- React
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui, TanStack Query, and React Router remain planned for later phases

### Backend
- Node.js
- TypeScript
- Fastify
- Zod
- PostgreSQL
- Drizzle ORM

### Infrastructure
- Redis
- BullMQ (planned for Phase 3)
- Docker
- Docker Compose
- GitHub Actions

### Optional AI
- Anthropic or OpenAI API
- Mock AI provider for cost-free development
- Local model support may be added later

## Repository Structure

```text
opsflow/
├── apps/
│   ├── web/
│   ├── api/
│   └── worker/
├── packages/
│   ├── shared/
│   └── config/
├── docs/
│   ├── REQUIREMENTS.md
│   ├── ARCHITECTURE.md
│   ├── DATABASE.md
│   ├── API.md
│   ├── SECURITY.md
│   ├── DEVELOPMENT.md
│   ├── ROADMAP.md
│   ├── AI_INSTRUCTIONS.md
│   ├── HANDOFF.md
│   └── CHANGELOG.md
├── docker-compose.yml
├── .env.example
└── README.md
```

## Development Philosophy

OpsFlow is not intended to be a giant feature-heavy SaaS.

The priority is to build a smaller set of workflows with strong engineering quality:

- predictable architecture
- clear boundaries
- robust error handling
- clean code
- tests
- documentation
- reproducible local setup

## Core Demo Flow

The first portfolio-ready workflow should demonstrate:

1. A user creates an organization.
2. The user creates a workflow.
3. The workflow defines a trigger.
4. The workflow defines one or more conditions.
5. The workflow defines one or more actions.
6. A test event is submitted.
7. The event is queued.
8. A worker processes the workflow.
9. Each step records its result.
10. The UI shows the final execution status and logs.

## Status

Phase 1 authentication and organizations are implemented. Workflow behavior and
related domain tables have not started. Docker Compose has not been run on the
implementation machine; Phase 1 migrations and integration tests were verified
against an isolated local PostgreSQL test database.

See `docs/ROADMAP.md` for implementation milestones.
