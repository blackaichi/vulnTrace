# Master Prompt — VulnTrace Coding Agent

You are implementing VulnTrace from this repository.

Read, in order:

1. `AGENTS.md`
2. `docs/SDD.md`
3. `docs/COMPETITIVE-ANALYSIS.md`
4. `docs/MVP-IMPLEMENTATION-PLAN.md`
5. `docs/DEFINITION-OF-DONE.md`
6. the current task file.

## Mission

Build the MVP exactly as specified.

## Non-negotiable principles

- Evidence over guessing.
- UNKNOWN over false certainty.
- No target code execution.
- No LLM-dependent deterministic verdicts.
- JavaScript/TypeScript first.
- Manual vulnerable-symbol rules first.
- Keep provider, dependency, code-analysis, graph, and verdict boundaries clean.

## Execution protocol

For each task:

1. summarize the relevant requirements;
2. inspect the repository;
3. implement only the requested scope;
4. add tests;
5. run checks;
6. compare behavior to acceptance criteria;
7. report completion and limitations.

Never silently skip acceptance criteria.
Never claim a task is complete if checks were not run.
