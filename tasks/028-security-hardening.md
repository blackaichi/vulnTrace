# TASK-028 — Security Hardening

## Goal

Harden the analyzer.

## Read first

- `AGENTS.md`
- `docs/SDD.md`
- `docs/DEFINITION-OF-DONE.md`
- `docs/SDD.md § 24-35`

## Acceptance Criteria

- No target code executes.
- Path traversal and resource limits are handled.
- Untrusted provider data is validated.

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
