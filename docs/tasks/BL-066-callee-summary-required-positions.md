# BL-066 — The callee summary reads a concise body, every required statement position and the default parameters a call runs

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-066 (with `BL-067` folded in)
- **Branch**: bl-066-concise-arrow-callee-summary
- **Base SHA**: 1a93602ff6617752064a5de4db514db8ebf1434a
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

Discovered in [`BL-065`](BL-065-tagged-template-abrupt-tag.md) (PR #99,
merged 2026-10-12) by its independent audit, and registered there as
RWF-096 and RWF-097 (`tests/validation/FINDINGS.md`): two live family-C
false `NOT_AFFECTED`s, defect class C, P0, lane E (ADR 0009 § 1
clause 3). Five open-soundness-defect records pin them in
`tests/oracle/rwf096-callee-summary.test.ts`.

The backlog had two rows, `BL-066` (RWF-096) and `BL-067` (RWF-097). Both
are the same proof — the callee summary `callableAlwaysThrows`
(`src/code-intelligence/module-model.ts`) proving that invoking a local
callable cannot complete normally — and `BL-066`'s row named them as
candidates to combine. The project owner approved folding `BL-067` into
this task on 2026-10-13; `BL-067`'s row is `CANCELLED`, superseded by
this file, which carries every one of its criteria.

`BL-064` (RWF-094, a callee that MAY throw) waits on a project-owner
decision and is not touched: this task proves only MUST-throw callees.

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

- **Measured.** `callableAlwaysThrows` returns `false` for an arrow whose
  body is not a block before reading it (`fn.body` is not a `Block`).
- **Measured.** `classifyAbruptOutcome` answers `"throws"` only for a
  `throw` statement or an `ExpressionStatement` whose WHOLE expression is
  a definitely-abrupt invocation; every other statement kind except
  `return`, block, `if`, `try` and label answers `"normal"`, and a
  `return` answers `"returns"` whatever its expression.
- **Measured.** RWF-026's required-position walk
  (`expressionCannotCompleteNormally`) always asks
  `isDefinitelyAbruptCall`, i.e. callable depth `0`, so it cannot be
  reused inside a callable body as is; and its public entry
  (`necessarilyEvaluatesAbruptly`) opens with the per-file gate
  `fileHasDefinitelyAbruptCallable`, which itself calls the callee
  summary, so the summary must reach the walk WITHOUT the gate.
- **Measured.** A default parameter initializer is not read at all
  (`callableAlwaysThrows` reads `body.statements` only).
- **Measured against real Node v22.11.0.** `() => bail()` throws when
  called; `() => false && bail()` completes. `function w() { ok(bail()); }`,
  `function r() { return bail(); }` and
  `function c() { if (bail()) return 1; return 2; }` all throw when
  called. For `function dp(a, b = bail()) { return 1; }`: `dp()`, `dp(1)`,
  `dp(1, undefined)`, `` dp`x` `` (one argument, the strings array),
  `new dp()` and `new dp` throw; `dp(1, 2)` and `dp(...[1, 2])` complete.
  `function sh(bail, b = bail())` resolves `bail` to the PARAMETER
  (`sh(() => 1)` completes). A TypeScript `this` parameter is in the AST's
  `parameters` but erased at runtime (`function tp(this: unknown, b = …)`
  compiles to `function tp(b = …)`), so it shifts nothing.
- **Measured.** The cutoff's only consumer is
  `isDefinitelyReachedExportAssignment`: a new cutoff only withdraws a
  later export write's authority (toward `UNKNOWN`), never adds one.

## Task

### Problem

The callee summary misses callables that can only throw, so a module-time
invocation of one is not a module-evaluation cutoff and a later export
write stays authoritative, though real Node stops before it:

- RWF-096: a concise-bodied arrow is refused before its body is read.
- RWF-097: a block body is proven abrupt only from a literal `throw` or a
  bare invocation statement; a definitely-abrupt call in a required
  position of another statement (an argument, a substitution, a
  declarator initializer, a `return` expression, a statement header), and
  a default parameter initializer the call runs, are not seen.

### Why it matters

Soundness: false `NOT_AFFECTED`s with a complete family C proof (defect
class C: the export holds the earlier write's value on the loads the
invocation ends, and the analyzer keeps only the later write).

### What to do

1. **Failing first.** Delete the five RWF-096/RWF-097 open-soundness-defect
   records and assert `UNKNOWN` for each, with real Node calling the
   target. Add oracle cases for the further required positions (a
   declarator initializer, a `return` expression, an `if` condition, a
   concise arrow whose body is a required operand, a wrapper hop through a
   concise arrow, a default parameter reached by a tagged template and by
   a construction) and precision controls that must keep `NOT_AFFECTED`
   (a concise arrow whose call is in a MAY position, a default parameter
   the call supplies, a spread argument, a parameter-shadowed callee, a
   caught call inside the body, an `async` concise arrow). Show the new
   `UNKNOWN` cases failing on the base.
2. **The fix, `module-model.ts` only.**
   - Thread the callable depth through RWF-026's required-position walk,
     so the walk can be asked at a callable's depth without the per-file
     gate; the module-scope entry is unchanged (depth `0`, behind the
     gate).
   - `callableAlwaysThrows` reads a concise body as a required expression.
   - `classifyAbruptOutcome` asks the required-position walk for every
     statement's evaluated header the module-scope relation
     (`isDefinitelyAbruptCallStatement`) already models, plus a `return`
     expression, before deciding the statement's outcome.
   - `callableAlwaysThrows` takes the invocation's supplied argument count
     (unknown for a spread) and treats the initializer of every runtime
     parameter at or beyond it as required. The per-file gate asks with
     zero arguments, the call under which the most is evaluated, so it
     stays complete.
3. **Records.** FINDINGS RWF-096 and RWF-097 status updates (fixed),
   OPEN-DEBTS D-17, REMEDIATION-PLAN § 5a, backlog § 1 and § 2, progress,
   scorecard. Correct the doc comments whose premise the fix makes false.

## Boundaries

### Do not touch

- any production file other than `src/code-intelligence/module-model.ts`;
- the identity proof (`resolveInvocationTargetIdentity`,
  `resolveExactLocalCallable`, `scopeDeclares`);
- the MAY-throw question (RWF-094, `BL-064`) and its records: the summary
  stays MUST-only;
- another task's worktree.

### STOP conditions

- the fix moves any verdict toward `NOT_AFFECTED`, or moves any
  `AFFECTED`;
- a new case cannot be grounded against real Node;
- the performance smoke needs a threshold change, or the summary's cost
  shows a structural blow-up a bound does not already contain.

## Acceptance criteria

- [ ] The five RWF-096/RWF-097 open-soundness-defect records are deleted
      and their cases assert `UNKNOWN`, with real Node calling the target
- [ ] The further required positions and the precision controls are
      oracle cases with loud fixtures, both controls and real-Node ground
      truth
- [ ] Each new `UNKNOWN` case fails on the base commit and passes after
      the fix; each control keeps `NOT_AFFECTED`
- [ ] Mutations that remove the concise-body read, the statement-position
      read, and the default-parameter read are each caught by a named test,
      and so is one that ignores the supplied argument count
- [ ] Only `module-model.ts` changed under `src/` (besides tests)
- [ ] Graph, proof and verdict differentials reported separately; no
      verdict moves toward `NOT_AFFECTED`
- [ ] All gates green; validation at exactly the five documented failures

## Gates

The full set in `AGENTS.md` section I, unrelaxed.
`npm run test:validation` at exactly RWB-03, RWB-05, RWB-09b, VAL-002,
VAL-003. `node scripts/differential.mjs` against the base. Regenerate the
scorecard.

## Report

In the format of `AGENTS.md` section J.
