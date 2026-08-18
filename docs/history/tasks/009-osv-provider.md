# TASK-009 — OSV Provider

## Goal

Implement OSV provider adapter.

## Read first

- `AGENTS.md`
- `docs/SDD.md`
- `docs/DEFINITION-OF-DONE.md`
- `docs/SDD.md § 11-14`

## Acceptance Criteria

- OSV responses are fetched through a provider interface.
- Network failures are explicit.
- Provider payloads are not leaked into domain code.

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
