# VulnTrace Coding Agent Kit v0.6

> **Historical document.** This was the implementation handoff used to
> bootstrap VulnTrace's original MVP (TASK-001 through TASK-030, all
> complete). Kept for historical record -- see `docs/history/README.md`.
> For the project's current state, start at the repository root
> `README.md` and `AGENTS.md` instead.

This repository is the implementation handoff for an AI coding agent.

## Read order

1. `AGENTS.md`
2. `docs/SDD.md`
3. `docs/COMPETITIVE-ANALYSIS.md`
4. `docs/MVP-IMPLEMENTATION-PLAN.md`
5. `docs/DEFINITION-OF-DONE.md`
6. `docs/history/tasks/001-bootstrap.md`
7. Follow tasks in numerical order.

## Core product thesis

VulnTrace is a JavaScript/TypeScript vulnerability-specific reachability engine.

The key question is:

> Given a specific vulnerability, can the vulnerable behavior actually be reached by the application code?

The MVP must prove:

`dependency -> vulnerability -> vulnerable symbol -> code model -> call graph -> reachability -> evidence -> verdict`

## Important constraints

- Do not turn `UNKNOWN` into `NOT_AFFECTED`.
- Do not execute untrusted application code.
- Do not use an LLM as the source of truth for deterministic verdicts.
- Do not implement out-of-scope features merely because they seem useful.
- Keep vulnerability intelligence independent from code analysis.
- Prefer evidence and deterministic behavior over heuristics.

## First milestone

A fixture application must produce:

- `AFFECTED` when a known vulnerable symbol is reachable;
- `NOT_AFFECTED` when it is provably unreachable;
- `UNKNOWN` when dynamic/unsupported semantics prevent a safe conclusion.

The first milestone should work with a manually authored vulnerability rule.
