# AI Coding Instructions

This file is mandatory reading for any AI coding agent working on OpsFlow.

Applies to:
- Codex
- Claude
- ChatGPT
- other coding agents

## 1. Project Objective

OpsFlow is a portfolio-grade workflow automation platform.

The project should demonstrate strong software engineering rather than maximum feature count.

Do not turn the project into a generic CRUD dashboard.

## 2. Read Before Coding

Before making changes, read:

1. `README.md`
2. `docs/REQUIREMENTS.md`
3. `docs/ARCHITECTURE.md`
4. `docs/DATABASE.md`
5. `docs/ROADMAP.md`
6. `docs/HANDOFF.md`
7. relevant source files

If `HANDOFF.md` contains unresolved work, resolve or explicitly account for it before starting unrelated work.

## 3. Architecture Constraints

Preserve these rules unless the user explicitly approves a redesign:

- React + TypeScript frontend
- Node.js + TypeScript backend
- PostgreSQL database
- Redis + BullMQ for queued execution
- separate API and worker responsibilities
- shared domain types
- tenant isolation by organization
- local-first development
- optional AI provider
- public GitHub repository
- no paid deployment requirement during initial development

## 4. Scope Discipline

Work on one roadmap milestone at a time.

Do not:
- implement future phases early without a clear dependency
- add unnecessary libraries
- introduce billing
- build a complicated workflow canvas
- add dozens of integrations
- rewrite working architecture without justification

## 5. Code Quality Rules

- TypeScript strict mode where practical
- no unexplained `any`
- validate external input
- use parameterized database queries or ORM safely
- keep route handlers thin
- keep business logic in services
- use meaningful names
- avoid duplicated domain constants
- use environment variables for configuration
- do not hardcode credentials
- preserve backward compatibility within the current milestone where practical

## 6. Database Rules

When schema changes:
- create a migration
- update `DATABASE.md`
- update seed data if necessary
- document migration commands in the handoff

Never silently change schema assumptions.

## 7. Testing Rules

For each milestone:
- add tests for core logic
- run existing tests
- run typecheck
- run lint
- run build where practical

If something cannot run, state exactly why in `HANDOFF.md`.

Never claim tests pass unless they were actually run.

## 8. Documentation Rules

Update affected documentation in the same change.

At minimum:
- architecture changes -> `ARCHITECTURE.md`
- schema changes -> `DATABASE.md`
- endpoint changes -> `API.md`
- milestone completion -> `ROADMAP.md`
- agent stopping point -> `HANDOFF.md`
- significant completed change -> `CHANGELOG.md`

## 9. Handoff Rule

Before stopping work, the AI agent MUST update `docs/HANDOFF.md`.

This is mandatory even if the milestone is complete.

The handoff must include:

- current milestone
- completed work
- files changed
- migrations added
- commands run
- test results
- known issues
- unfinished work
- exact recommended next action
- assumptions made
- important architectural decisions

## 10. Source of Truth Priority

If sources conflict, use this order:

1. explicit latest user instruction
2. current working implementation
3. `HANDOFF.md`
4. architecture and requirements docs
5. roadmap
6. older comments or stale documentation

If the implementation and documentation disagree, fix the documentation or surface the discrepancy.

## 11. Agent Transfer Protocol

When a new AI agent begins:

1. inspect Git status
2. read `HANDOFF.md`
3. inspect the latest commits
4. read files listed under "Files Changed"
5. run the validation commands listed in the handoff when practical
6. confirm the repository state matches the handoff
7. continue from "Recommended Next Action"

Do not blindly trust the previous agent.

Verify.

## 12. No Destructive Guessing

Do not:
- delete code you do not understand
- reset the repository
- discard uncommitted work
- rewrite migrations
- change environment configuration unexpectedly

If the repository contains unexpected changes, preserve them and document them.

## 13. End-of-Milestone Response Format

When reporting to the user, use:

```text
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
```

Keep the user-facing report concise.

The detailed state belongs in `HANDOFF.md`.
