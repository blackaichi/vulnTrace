# TASK-012 — Manual Symbol Rules

## Goal

Implement manual vulnerable-symbol rules.

## Read first

- `AGENTS.md`
- `docs/SDD.md`
- `docs/DEFINITION-OF-DONE.md`
- `docs/SDD.md § 11-14`

## Acceptance Criteria

- Rules validate against schema.
- Rules map vulnerability IDs to package symbols.
- Rule loading is deterministic.

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
