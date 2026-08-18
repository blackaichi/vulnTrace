# VulnTrace — Historical Bootstrap Material

This directory holds the original implementation handoff used to bootstrap
VulnTrace's MVP: a "coding agent kit" of task specs and prompts, written
before any of `src/` existed. All 30 tasks are complete; this is kept as a
historical record of how the project was originally scoped and built, not
as active guidance.

For the project's current state, start at the repository root `README.md`
and `AGENTS.md` instead. For the v0.2 remediation work that followed the
MVP (VT-201 through VT-217, closing the gap the two adversarial validation
suites found), see `remediation/v0.2/` (kept locally, not part of the
public repository history).

## Contents

- `START-HERE.md` — the original agent onboarding document and read order.
- `manifest.json` — the kit's own metadata (name, task count, primary docs).
- `tasks/001-bootstrap.md` .. `tasks/030-mvp-release.md` — one spec per
  original MVP task, in implementation order:

  | Task | Title |
  |---|---|
  | 001 | Bootstrap |
  | 002 | Configuration |
  | 003 | Domain Models |
  | 004 | Test Infrastructure |
  | 005 | package.json Parser |
  | 006 | package-lock Parser |
  | 007 | Dependency Graph |
  | 008 | SBOM Boundary |
  | 009 | OSV Provider |
  | 010 | Vulnerability Normalizer |
  | 011 | Vulnerability Matching |
  | 012 | Manual Symbol Rules |
  | 013 | TypeScript Project Loader |
  | 014 | AST / Source Index |
  | 015 | Import / Export Model |
  | 016 | Module Resolution |
  | 017 | Symbol Binding |
  | 018 | Call Graph |
  | 019 | Entrypoints |
  | 020 | Reachability |
  | 021 | Verdict + Evidence |
  | 022 | CLI |
  | 023 | JSON Output |
  | 024 | Fixture Suite |
  | 025 | E2E Vertical Slice |
  | 026 | Coverage / Diagnostics |
  | 027 | Cache / Reproducibility |
  | 028 | Security Hardening |
  | 029 | Performance Baseline |
  | 030 | MVP Release |

- `prompts/` — the two prompt templates used to drive task-by-task
  implementation (`MASTER-IMPLEMENTATION-PROMPT.md`,
  `TASK-PROMPT-TEMPLATE.md`).

## Integrity check

`npm run validate:history` (`scripts/validate-history.mjs`) confirms all
30 task files and the kit's required docs are still present.
