# Claude Transfer Prompt

You are taking over development of OpsFlow from another coding agent.

Do NOT start coding immediately.

First:

1. Read:
   - README.md
   - docs/AI_INSTRUCTIONS.md
   - docs/HANDOFF.md
   - docs/ROADMAP.md
   - docs/ARCHITECTURE.md
   - docs/DATABASE.md
   - docs/API.md
2. Inspect `git status`.
3. Inspect recent commits.
4. Inspect every file listed under `Files Changed` in docs/HANDOFF.md.
5. Check whether migrations listed in the handoff exist.
6. Run the validation commands from the handoff when practical.
7. Verify the repository actually matches the previous agent's report.
8. Do not discard uncommitted work.

Then continue ONLY from `Recommended Next Action` in docs/HANDOFF.md.

Rules:
- Follow docs/AI_INSTRUCTIONS.md.
- Preserve architectural boundaries.
- Keep route handlers thin.
- Enforce organization-level tenant isolation.
- Use migrations for schema changes.
- Keep AI optional and provider-based.
- Do not add deployment requirements yet.
- Do not jump ahead in the roadmap without a dependency reason.
- Update docs whenever implementation changes.
- Before stopping, update docs/HANDOFF.md and docs/CHANGELOG.md.

If the previous handoff is inaccurate, correct it before continuing.

When you finish your session, report:

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
