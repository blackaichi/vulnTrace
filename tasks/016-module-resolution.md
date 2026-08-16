# TASK-016 — Module Resolution

## Goal

Implement module resolution abstraction.

## Read first

- `AGENTS.md`
- `docs/SDD.md`
- `docs/DEFINITION-OF-DONE.md`
- `docs/SDD.md § 15-18`

## Acceptance Criteria

- Relative and package imports resolve.
- ESM/CJS and package exports are tested.
- TypeScript paths are tested.

## Constraints

- Keep the task scoped.
- Do not add runtime execution.
- Do not replace UNKNOWN with NOT_AFFECTED.
- Add regression tests for discovered bugs.

## Completion report

Include:
- files changed;
- tests run;
- results;
- limitations;
- any architectural discrepancy.
