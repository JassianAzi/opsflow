# Changelog

All notable project changes should be recorded here.

This project uses milestone-oriented development rather than strict semantic versioning during the initial build.

## Unreleased

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
