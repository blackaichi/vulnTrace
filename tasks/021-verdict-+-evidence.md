# TASK-021 — Verdict + Evidence

## Goal

Implement verdict and evidence engine.

## Read first

- `AGENTS.md`
- `docs/SDD.md`
- `docs/DEFINITION-OF-DONE.md`
- `docs/SDD.md § 19-23`

## Acceptance Criteria

- AFFECTED is produced only with sufficient reachable evidence.
- NOT_AFFECTED requires adequate coverage.
- UNKNOWN is preserved for unresolved cases.

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
