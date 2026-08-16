# TASK-025 — E2E Vertical Slice

## Goal

Complete the first end-to-end vertical slice.

## Read first

- `AGENTS.md`
- `docs/SDD.md`
- `docs/DEFINITION-OF-DONE.md`
- `docs/SDD.md § 24-35`

## Acceptance Criteria

- A known vulnerable fixture produces AFFECTED.
- Unused vulnerable symbol produces NOT_AFFECTED.
- Dynamic target produces UNKNOWN.

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
