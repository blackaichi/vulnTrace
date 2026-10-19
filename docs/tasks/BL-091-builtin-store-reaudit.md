# BL-091 — Re-audit BL-081's post-round-10 fixes and the builtin-store class (RWF-122, RWF-123)

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-091
- **Branch**: `bl-091-builtin-store-reaudit`
- **Base SHA**: `5de489375f0babf3f6f2a3ea4c9d789d271739e9` (BL-081's merge, PR #108)
- **Commits**:
  - `docs(tasks): BL-091 task file — re-audit BL-081's post-round-10 fixes and the builtin-store class`
  - `perf(BL-091): round 10's observations — one shared list for unfollowable stores, the memo keyed by an unresolved name's cause, M23 pinned`
  - `test(BL-091): the re-audit's live false NOT_AFFECTEDs, against real Node — RWF-124, RWF-126, RWF-127, RWF-128`
  - `fix(BL-091): a class is the program's own only when what it inherits from is — RWF-124, RWF-126, RWF-127, RWF-128`
  - (this commit) `docs(BL-091): records — RWF-124..132, the re-audit's three rounds and the independent audit, ADR 0008 note, debts, backlog (BL-092..095), progress, scorecard`
- **Superseded by**: —

## Project context

Lane A (ADR 0008 § 2's escape row; ADR 0008's decision record "BL-081: a
store onto an object not proven to be the program's own is an escape").
BL-081 (PR #108, merged 2026-10-18) made a store an escape unless the
object it writes onto is proven to be one the program created
(`src/code-intelligence/escape-row.ts`, `isProvenFreshObject`), over a
closed list of store forms, with own-member and `prototype` / `exports`
key bookkeeping. Its independent audit ran ten rounds and never certified
the class; each round found live false `NOT_AFFECTED`s, every one also
`NOT_AFFECTED` on the base.

By the project owner's decision of 2026-10-18 round 10 was the last. Its
two findings were fixed after it, as its auditor proposed, without a
further round:

- **RWF-122** (`tests/validation/FINDINGS.md`): `builtinMayStoreUnderModelKey`
  read a `prototype` / `exports` key through fewer forms than
  `escapingValuesOf` reads a value. The fix makes the key reader follow
  `?:`, `||`, `&&`, `??`, the comma operator and `=`.
- **RWF-123**: `storesOnto`'s memo was keyed by binding, spelling and
  kind; an answer computed inside a `with` body (where
  `definitionsDenotedBy` follows nothing) was reused outside it. The fix
  adds "inside a `with` body" to the memo key.

FINDINGS RWF-110, RWF-063 and RWF-120 stay "fixed in part" until the class
is re-audited. Round 10 also left three non-blocking observations (PR #108
body, "Round 10's non-blocking observations"; backlog row `BL-091`):

1. the `unknown`-list cost in `computeStoresOnto`: roughly quadratic when
   many stores sit on bases whose aliases cannot be followed (recorded as
   10 s at 800 such stores);
2. the memo key for unresolved names: every unresolved name shares the
   key's `entry` bucket, so a parameter named `exports` and the module's
   `exports` may share one memo slot (no route measured);
3. the equivalent mutant M23: `denotedDefinitionOf`'s `value` branch
   duplicates `definitionsDenotedBy`, so removing it changes no answer.

### Premises (AGENTS.md § D) — to verify before relying on them

- The RWF-122 and RWF-123 oracle cases
  (`rwf063.prototype-set-by-object-assign-under-a-conditional`,
  `…-under-a-spread-conditional`,
  `fresh.prototype-proof-looked-up-from-a-with-body`) exist on `main` and
  pass. Present in `tests/oracle/bl081-builtin-replaced-without-name.cases.ts`
  (checked); pass to be measured.
- Observation 1's figure (10 s at 800) is the round-10 auditor's
  measurement, not re-measured. Assumed until measured.
- Observation 2 has no measured route. Assumed harmless until probed.
- Observation 3's equivalence is BL-081's claim. To re-check.

## Task

### Problem

A soundness rule that eleven fix rounds kept widening is on `main` with
its last two fixes unaudited and its class uncertified. A further gap in
the same class is a live false `NOT_AFFECTED` (family C).

### Why it matters

Soundness first: every finding of BL-081's audit was a false
`NOT_AFFECTED`, the critical failure. Defect classes A (RWF-123: an answer
keyed by spelling), B (a store the escape row does not read is assumed to
store nothing) and C (RWF-122: a conditional key collapsed to its literal
form). Observation 1 is performance (never proof authority), but a
quadratic cost on real packages makes a scan time out, and a timeout
policy can become a soundness question.

### What to do

1. **Re-audit** (fresh context, no BL-081 implementation history): try to
   break RWF-122's and RWF-123's fixes and the class — every store form,
   freshness proof, own-member route, builtin-call key and memo — with
   every claimed gap measured against real Node v22.11.0 through the
   oracle harness, and checked on the base `5de4893`.
2. **Fix what the re-audit finds within the class** (the escape row, the
   freshness proofs, their bookkeeping): failing-first oracle cases with
   E-1's loud fixture and controls, then the fix, with a mutation caught
   by a named test for each new rule.
3. **Observation 1**: measure the cost with an operation-count test
   (ARCHITECTURE § 10); if it grows faster than linearly in the number of
   such stores, index it so it does not, without changing any answer.
4. **Observation 2**: probe for a route against real Node. A route is a
   finding (fix it as in step 2); no route is recorded as measured.
5. **Observation 3**: re-check the equivalence; if it holds, remove the
   duplicate branch or keep it with the reason, whichever leaves one
   source for the relation (no speculative refactoring beyond that).
6. **Records**: FINDINGS (append to RWF-122, RWF-123 and, by the re-audit's
   outcome, RWF-110, RWF-063, RWF-120; new RWF entries for new findings),
   ADR 0008's BL-081 decision record (an appended note, not a rewrite),
   OPEN-DEBTS, backlog, progress, scorecard.
7. **Independent audit of this task's diff** (WORKFLOW § 1.5), separate
   from step 1's re-audit.

## Boundaries

### Do not touch

- The export model (`module-model.ts`; lane E: `BL-082`, `BL-083`).
- RWF-121's resolved callback edge (`BL-090`, needs a decision).
- The loader capabilities (lane C).
- Other worktrees and branches.

### STOP conditions

- The re-audit finds a gap whose fix lies outside the escape row and its
  bookkeeping (for example a whole-program value flow, lane C's C-3):
  register it, `STOPPED_ON_FINDING` or a backlog row.
- **Round bound.** BL-081 took ten rounds without convergence. This task
  runs at most three re-audit rounds (step 1). If the third still finds new
  live false `NOT_AFFECTED`s in the class, they are registered, fixed only
  if already measured, and the task reports `NEEDS_DECISION` on whether
  the "unless proven" rule needs a structural change rather than further
  point fixes.
- A fix would move a corpus verdict into `NOT_AFFECTED`, or withdraw an
  edge from a case that real Node reaches.

## Acceptance criteria

- [ ] The three RWF-122 / RWF-123 oracle cases pass on the branch, and the
      premises above are each recorded as measured or corrected.
- [ ] A fresh-context re-audit ran; its rounds, verdicts and findings are
      recorded (FINDINGS and the pull request).
- [ ] Every live false `NOT_AFFECTED` it found inside the class has an
      oracle case failing on the base and answering `UNKNOWN` on the
      branch, with real Node calling the target, or is registered with a
      backlog row under the STOP conditions.
- [ ] Observation 1 is measured with an operation-count test, and the
      cost is linear in the number of such stores (or the reason it cannot
      be is recorded).
- [ ] Observation 2 is probed against real Node; the result is recorded.
- [ ] Observation 3 is re-checked; the duplicate is resolved or its
      reason recorded.
- [ ] No controls lost: every existing oracle and unit test passes, none
      inverted without real-Node grounding.
- [ ] Graph, proof and verdict differentials reported separately.
- [ ] Independent audit of the diff run; its verdict is in the pull
      request.

## Gates

The full set in `AGENTS.md` section I, unrelaxed (`node scripts/gates.mjs`).
The validation baseline is OPEN-DEBTS D-09's six known failures (`RWB-03`,
`RWB-05`, `RWB-09a`, `RWB-09b`, `VAL-002`, `VAL-003`), case by case. The
expected differentials: verdict 0; proof 0; graph changes only where a
new escape adds an edge.

## Report

In the format of `AGENTS.md` section J (`docs/WORKFLOW.md` § 5). Add: the
re-audit's rounds and verdicts, and whether the class is now certified.

## Corrections and outcome (appended by the last commit)

- **Premises, measured.** The three RWF-122 / RWF-123 oracle cases pass
  on `5de4893`. Observation 1 is real (640,000 store reads at 800 stores,
  N squared, in the copy and in the callers' walk), but "10 s at 800" was
  not reproduced: 4.5–5.3 s on a loaded machine. Observation 2 is a real
  latent defect (RWF-125). The answer to the question "can a parameter
  named `exports` share the module's memo slot" is yes. No end-to-end
  false `NOT_AFFECTED` was found: the store through the alias is an
  escape of its own. **Observation 3's premise was false:** M23 is not an
  equivalent mutant. `resolveNamedBinding` follows an alias chain of up
  to about twelve hops in one step, and `definitionsDenotedBy` follows
  four, so the branch is kept and documented, and a test now kills the
  mutant.
- **The re-audit: three rounds, each BLOCKED, the class not certified.**
  Round 1 (about 190 shapes): RWF-122's and RWF-123's fixes held, and it
  found RWF-124. Round 2 (an interrupted auditor's leads, then about 70
  shapes): RWF-126. Round 3 (about 270 shapes, the last the round bound
  allows): RWF-127 and RWF-128 in the class, and RWF-129 and RWF-130 in the
  loader (lane C, outside this task: registered, backlog `BL-092`). Every
  finding was also `NOT_AFFECTED` on BL-081's base. The four in the class
  are fixed (RWF-127 in part: see the independent audit below) with failing-first oracle cases (26 live false `NOT_AFFECTED`s,
  `tests/oracle/bl091-builtin-store-reaudit.test.ts`). As the STOP
  condition requires, the task asks the project owner the structural
  question (backlog `BL-094`).
- **One premise of a test was false.** BL-081's unit rows "`this` in a
  static field initializer / static block (the class)" proved a class
  derived from an undeclared `B` the program's own. That is RWF-126's
  defect, so the rows were re-grounded on a declared `class B {}`.
- **Mutations.** Each new rule is killed by a named test. These were run:
  `return true` for `!isDerived(cls)` (RWF-124); `hasOwnStaticChain`
  always true (RWF-126); the TypeScript static-field store removed
  (RWF-127); `classPrototypeIsStable` always true, its computed-key guard
  removed, and the class `prototype` store check removed (RWF-128); the
  memo key's cause removed (RWF-125); the `fresh@` memo removed (the
  operation-count test); and the shared list dropped from `hasStores` and
  from `everyStoreValueIsFresh`. **Equivalent:** the shared list dropped
  from `storeValueDefinitions`. A store through a base that cannot be
  followed is itself an escape, and an escaping store under a `prototype`
  or `exports` key makes its value opaque by another rule. The branch is
  kept (BL-081's removal of a "redundant" rule reopened RWF-122), and the
  reason is in its test.
- **Precision.** No corpus verdict, proof or graph moved (139 cases). On
  every `node_modules` package
  (`scripts/bl081-builtin-store-escape-corpus.mjs`, against `5de4893`), no
  clean graph node was lost; unknown edges went 661,160 → 661,183 and
  possible edges 84,690 → 84,718. The TypeScript-only rules (RWF-127,
  RWF-128) are not measured on real TypeScript: installed packages are
  JavaScript, and no TypeScript corpus exists. Their cost is the oracle
  case `cost.static-field-of-a-derived-class-under-define-semantics`.
- **The independent audit of the diff: BLOCKED, then fixed in part.** It
  found a regression of this branch, an unbounded recursion in
  `classPrototypeIsStable` (`(C as any).prototype = this` in a TypeScript
  constructor stopped the scan with a stack overflow, exit 3, where the base
  answered `UNKNOWN`). It also found a quadratic cost in the same function.
  Both are fixed, with failing-first unit tests. It also found two more
  stores TypeScript's emit makes, RWF-131 (a namespace merged with a class)
  and RWF-132 (a field named `__proto__`), live and pre-existing. Both
  were measured against real Node. They come after the round bound, so
  they are registered, not fixed (backlog `BL-095`, P0), and RWF-127 is
  "fixed in part". The fix of the regression was re-audited by a narrow
  further round (see the pull request).
- **Found and not acted on:** two pre-existing super-linear costs (the
  re-entrant `storesOnto` path, and `isFresh` exponential in stores per
  binding; backlog `BL-093`); a JavaScript source compiled with loose class
  fields (RWF-127, not measured; in `BL-094`).
