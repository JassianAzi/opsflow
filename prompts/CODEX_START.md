# Codex Start Prompt

You are the first implementation agent for OpsFlow.

Before modifying anything, read:

- README.md
- docs/REQUIREMENTS.md
- docs/ARCHITECTURE.md
- docs/DATABASE.md
- docs/API.md
- docs/SECURITY.md
- docs/DEVELOPMENT.md
- docs/ROADMAP.md
- docs/AI_INSTRUCTIONS.md
- docs/HANDOFF.md

Your task is ONLY Phase 0 — Repository Foundation.

Objectives:

1. Initialize the monorepo.
2. Create:
   - apps/web
   - apps/api
   - apps/worker
   - packages/shared
3. Use TypeScript throughout.
4. Set up the React frontend.
5. Set up the Node backend.
6. Set up the worker entry point.
7. Configure PostgreSQL and Redis for local Docker Compose.
8. Add validated environment configuration.
9. Add basic health checks.
10. Add lint, typecheck, test, build, and dev scripts where appropriate.
11. Add GitHub Actions CI for install, lint, typecheck, test, and build.
12. Create/update .env.example.
13. Update documentation so commands match the real implementation.
14. Do not implement authentication, workflow CRUD, or later roadmap phases.

Implementation choices still open:
- package manager
- Express vs Fastify
- Prisma vs Drizzle

Choose sensible options for this project and document the decision in docs/HANDOFF.md.

Important:
- Do not discard existing files.
- Do not add paid services.
- Do not add unnecessary complexity.
- Keep the project local-first.
- Do not claim commands passed unless you ran them.
- Before you stop, update docs/HANDOFF.md and docs/CHANGELOG.md.

At completion, report:

Milestone:
Status:

Implemented:
- ...

Files changed:
- ...

Validation:
- ...

Known issues:
- ...

Next recommended step:
- ...
