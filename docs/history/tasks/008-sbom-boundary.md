# TASK-008 — SBOM Boundary

## Goal

Create the SBOM ingestion boundary.

## Read first

- `AGENTS.md`
- `docs/SDD.md`
- `docs/DEFINITION-OF-DONE.md`
- `docs/SDD.md § 11-14`

## Acceptance Criteria

- CycloneDX input can map into the normalized dependency graph.
- SBOM parsing is isolated from the core graph.

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
