# TASK-027 — Cache / Reproducibility

## Goal

Add deterministic caching.

## Read first

- `AGENTS.md`
- `docs/SDD.md`
- `docs/DEFINITION-OF-DONE.md`
- `docs/SDD.md § 24-35`

## Acceptance Criteria

- OSV/cache keys include tool and input versions.
- Cache can be disabled.
- Results are reproducible.

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
