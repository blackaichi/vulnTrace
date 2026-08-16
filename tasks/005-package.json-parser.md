# TASK-005 — package.json Parser

## Goal

Parse package.json safely.

## Read first

- `AGENTS.md`
- `docs/SDD.md`
- `docs/DEFINITION-OF-DONE.md`
- `docs/SDD.md § 11-14`

## Acceptance Criteria

- Name/version/scripts/dependencies/exports/imports can be read.
- No package script is executed.

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
