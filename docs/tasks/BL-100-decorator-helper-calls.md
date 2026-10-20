# BL-100 — What TypeScript's decorator helpers do with a decorator's result (RWF-142)

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-100
- **Branch**: `bl-100-decorator-helper-calls`
- **Base SHA**: `9b8ea34cec750cdc6e3726c66c479040becc7bdf` (BL-099's merge, PR #113)
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

Lane A, invocation accounting (ADR 0008 § 2, the `Decorator` row: "the
decorator … is invoked at class definition: resolved or unknown"). Task
A-1 made a decorator's call a site (PRM-115). What TypeScript's emit does
with the decorator's RESULT is not modelled (`tests/validation/FINDINGS.md`,
RWF-142, a live false `NOT_AFFECTED`, family C, pre-existing; found by task
BL-095's independent audit, round 4). ADR 0008's decision record "BL-081"
names it as "still not covered".

### Premises (AGENTS.md § D) — measured before relying on them

Measured with the repository's own TypeScript 5.9.3 (`ts.transpileModule`,
targets ES2020 and ES2022, both decorator modes) and real Node v22.11.0,
and with the oracle harness on the base `9b8ea34`
(`tests/oracle/bl100-decorator-helper-calls.cases.ts`, each case's
`base`):

- RWF-142's two reproductions are live false `NOT_AFFECTED`s.
  **Confirmed.**
- What the helpers do with a decorator's result. **Measured**, and wider
  than the record says:
  - legacy (`experimentalDecorators`): `__decorate` installs a field's,
    method's or accessor's result with `Object.defineProperty` (a returned
    setter runs on a later store, the field's own assignment at ES2020
    included), and a class decorator's result REPLACES the class
    (`C = __decorate([dec], C)`); a parameter decorator's result is
    discarded (`__param` wraps it in a function returning nothing);
  - TC39: `__esDecorate` makes a field's result an initializer
    (`__runInitializers` calls it on the field's value), a method's result
    the method, an accessor's result's `get` / `set` / `init` the
    accessor's, and a class decorator's result the class.
- **Found while measuring** (registered by this task as RWF-149): because
  a class decorator's result replaces the class, `new C()`, an implicit
  `super(...args)` into `C` and `Reflect.construct(C, …)` construct the
  result, while the call graph resolves them to the declared constructor:
  a fabricated edge. Live on the base as false `AFFECTED`s (the declared
  constructor calls the target, the result does not) and as a false
  `NOT_AFFECTED` (an implicit `super` into a replaced base whose result
  calls it). Same mechanism, same fix: folded in.
- Already `UNKNOWN` on the base through other accounts (masked): a
  decorator factory (`@make()`, the site's unknown edge), TC39's
  `context.addInitializer(f)` (a call through a parameter), a method call
  on the instance (`unsupported_literal_receiver`), an explicit `super()`
  (`unsupported_construct`), a decorator reached through a re-export.
- Method lookups on a decorated class are already refused
  (`isPlainClass`, task A-5b): not changed.

## Task

### Problem

A decorator's call is accounted, but its result is taken to invoke
nothing, and a class decorator is taken to leave its class in place. At
run time the helpers install the result as an accessor, run it as an
initializer, make it the method, or make it the class.

### Why it matters

Soundness: live false `NOT_AFFECTED`s (family C), the critical failure,
and fabricated construction edges with false `AFFECTED`s. Defect class B
(the helpers' runtime behaviour is not modelled) and class C (a class
binding that may hold the decorator's result is collapsed to the declared
class).

### What to do

1. **Tests first**: the oracle cases, failing on the base, with the loud
   fixture `vuln-lib` and both controls (or a declared reason no negative
   control can be `NOT_AFFECTED`); controls that stay `NOT_AFFECTED` or
   `AFFECTED`.
2. **The decorator's result** (`call-graph.ts`): what a decorator may
   return is read from the function it denotes, by the escape row's own
   authority (`escapingValuesOf`, `escapeTargetOf`): its return
   expressions, or nothing when it has no `return` of a value. The values
   are handed to the helper at a non-admitted position (ADR 0008 § 2's
   escape row): a possible edge to each attributable function, an unknown
   edge for anything else. A decorator whose function cannot be read (a
   call's result, an async or generator function, an unattributable
   value) has an unknown result. A parameter decorator's result is
   discarded.
3. **The replaced class**: a construction of a class with a class
   decorator whose result is not proven to be nothing gets a possible edge
   to the declared constructor, never a resolved one, and the result's
   account. Applied wherever a class is constructed by its binding: `new`,
   an implicit `super`, a documented invoking builtin's construct.
4. Unit tests pinning each rule, and mutations each caught by a named test.
5. Differentials (graph, proof, verdict) and validation against
   OPEN-DEBTS D-09.
6. Records: FINDINGS (RWF-142 fixed; RWF-149 registered and fixed), ADR
   0008's decision record, OPEN-DEBTS, backlog, progress, scorecard.
7. Independent audit (WORKFLOW § 1.5).

## Boundaries

### Do not touch

- Reading the project's decorator mode or TypeScript target (BL-094's
  decision): the account covers both modes.
- The escape row's freshness proofs (`escape-row.ts`), except to reuse
  its value enumeration.
- An ES5 class's methods (RWF-143, BL-101); a namespace's declarations
  (BL-102, BL-103); a bodiless function declaration (BL-104).
- Other worktrees and branches.

### STOP conditions

- A corpus verdict moves away from its expected value, unless the moved
  case is itself wrong.
- The precision cost on real code is large enough to be a product decision
  (`NEEDS_DECISION`).
- An independent-audit finding outside what the helpers do with a
  decorator's result.

## Acceptance criteria

- [ ] Every case in `tests/oracle/bl100-decorator-helper-calls.cases.ts`
      answers its `expected` verdict with real Node's ground truth, and every
      case whose `base` differs from its `expected` failed on the base.
- [ ] The `control.*` cases keep their verdicts.
- [ ] Each rule is pinned by a named unit test, and each mutation of it is
      caught by one.
- [ ] The graph, proof and verdict differentials are reported separately; no
      corpus case moves away from its expected verdict.
- [ ] RWF-142 and RWF-149 are recorded as fixed.
- [ ] The independent audit certifies the change, or its findings are
      handled per WORKFLOW § 1.5.

## Gates

The full set in `AGENTS.md` § I, unrelaxed, run once on the final HEAD with
`node scripts/gates.mjs`. `npm run test:validation`'s baseline is OPEN-DEBTS
D-09's six known failures; no change is expected (the corpora are compiled
JavaScript, with no decorator syntax: to be measured).

## Report

In the format of `AGENTS.md` § J (`docs/WORKFLOW.md` § 5).
