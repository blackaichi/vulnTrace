# Definition of Done

A task is complete only when:

- implementation matches the task;
- relevant unit/integration tests exist;
- existing tests remain green;
- typecheck passes;
- lint/format checks pass;
- no unsafe target-code execution was introduced;
- errors are represented using project conventions;
- public interfaces are documented;
- evidence/source locations are preserved where applicable;
- no out-of-scope feature was silently added.

## MVP release gate

All 30 tasks complete or explicitly deferred with an ADR.

Required commands should be documented in README and reproducible locally.

Required end-to-end scenarios:

1. vulnerable and reachable -> AFFECTED;
2. vulnerable and unreachable -> NOT_AFFECTED;
3. dynamic/ambiguous -> UNKNOWN;
4. direct ESM;
5. CommonJS;
6. transitive dependency;
7. JSON schema validation.
