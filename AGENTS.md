# AGENTS.md — VulnTrace

## Mission

Implement VulnTrace as an open-source JavaScript/TypeScript vulnerability-specific
reachability and impact analysis engine.

## Source of truth

When documents conflict, use this priority:

1. `docs/SDD.md`
2. `docs/DEFINITION-OF-DONE.md`
3. current task file
4. `docs/MVP-IMPLEMENTATION-PLAN.md`
5. other documentation

If the repository contains code that conflicts with the SDD, do not silently
change the architecture. Record the discrepancy and follow the task.

## Engineering rules

- TypeScript strict mode.
- Prefer small pure functions.
- Keep domain models independent from CLI and providers.
- Keep provider-specific data behind interfaces.
- Do not couple OSV parsing directly to the verdict engine.
- Keep AST/parser implementation behind analysis interfaces.
- Never execute target application code during static analysis.
- Do not run package lifecycle scripts from target projects.
- Validate all external input.
- Preserve source locations in evidence whenever possible.
- Every uncertainty must be represented explicitly.
- Tests are required for every behavior change.

## Verdict rules

Allowed verdicts:

- `AFFECTED`
- `NOT_AFFECTED`
- `UNKNOWN`

Never infer `NOT_AFFECTED` merely because the analyzer failed to resolve something.

## Scope discipline

MVP includes:

- JavaScript
- TypeScript
- Node.js
- ESM
- CommonJS
- package.json
- package-lock.json
- OSV
- manually authored vulnerable-symbol rules
- module resolution abstraction
- symbol resolution
- basic call graph
- reachability
- evidence
- JSON output

MVP excludes:

- runtime tracing
- eBPF
- exploit generation
- automatic patching
- multi-language support
- full taint analysis
- browser bundler analysis
- LLM-dependent verdicts
- automatic CVE-to-symbol inference

## Task workflow

For each task:

1. Read the task.
2. Inspect relevant SDD sections.
3. Inspect existing implementation.
4. Implement the smallest coherent change.
5. Add/adjust tests.
6. Run formatting/lint/typecheck/tests/build as applicable.
7. Verify all acceptance criteria.
8. Do not start the next task until the current task is complete.

## Output discipline

When reporting completion, include:

- files changed;
- behavior implemented;
- tests run;
- test result;
- known limitations;
- any SDD discrepancy discovered.
