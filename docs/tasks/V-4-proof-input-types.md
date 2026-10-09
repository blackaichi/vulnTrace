# V-4 — Proof-input types (`ClosureCorroboration`, `AttributedTarget`) and mutation tests

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: V-4
- **Branch**: v-4-proof-input-types
- **Base SHA**: f9c62ec852e014f4408d2f9a29248c3e311f0360
- **Commits**:
  - `674d7e3` docs(tasks): V-4 task file — branded proof-input types and mutation tests
  - `3a1de64` test(V-4): a closure marked incomplete with no reason withdraws families B and C
  - `4da456f` fix(V-4): families B and C are built only from branded proof inputs
  - `220455d` test(V-4): the proof-input cast census; VT-INV-V-corroboration registers predicates 1-3, 5 and the brands
  - (this commit) docs(V-4): records — lane V complete, plan § 5a, debts, RWF-082, backlog, progress, scorecard
- **Superseded by**: —

## Project context

Fourth and last task of lane V of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 11),
after [`V-3`](V-3-identity-keyed-roots.md) (PR #88, merged 2026-10-08).
B-6 and D-01 depend on it.

The specification is
[ADR 0011](../adr/0011-negative-proof-corroboration.md): invariant V
(§ 1) and its predicates 1-4, Amendment V-1's predicate 5, § 2's
structural gate ("proof inputs become unforgeable types", "mutation
tests", the `VT-INV-V-corroboration` registration) and § 8's V-4 row:
scope "`src/domain/evidence.ts` types, `verdict.ts` constructors";
reproductions that flip "none new; locks V-1..V-3"; tests that change
"`verdict.f2-proof-guards.test.ts`, `verdict.f4-proof-mutation.test.ts`
gain cases".

What the earlier lane-V tasks bound to V-4 (REMEDIATION-PLAN § 5a):

- "V-1 additions": `ClosureCorroboration` should carry predicate 5 (every
  loaded module's top level reached) beside predicate 1; `AttributedTarget`
  has one producer fewer to type.
- "V-2 additions": the call-graph guard reads the incompleteness list
  only, not `closure.complete` (V-2's independent audit, finding 2). No
  production closure has `complete: false` with an empty list, so the
  branded `ClosureCorroboration` should check both halves of predicate 1,
  and a mutation test should build that shape.
- "V-3 additions": register predicates 1-3 and the branded proof-input
  types under `VT-INV-V-corroboration`.

No finding is closed: V-4 is a structural lock. It closes no PRM, AUD or
RWF record.

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

- **True** (code read): `callGraphNegativeProofBlockers`
  (`src/analysis/module-load-closure.ts`) returns the distinct reasons of
  `closure.incompleteness` and never reads `closure.complete`; it is the
  only closure check family C passes through in `buildFinding`. Family B's
  per-target corroboration in `checkReachability` reads
  `closure.complete` and instance membership, and the same
  `callGraphNegativeProofBlockers` guard runs before family B is issued,
  so family B checks both halves; family C checks only the list.
- **True** (code read): neither family B nor family C requires
  `closure.rootFiles.length > 0`. Invariant V says "gate-eligible". A
  zero-root closure is refused by `buildGateEligibleModuleLoadClosure` and
  dropped by `createAnalysisProofContext` (the F4 family-A row
  `closure_roots_empty_so_gate_ineligible` records the latter), so this is
  defence in depth, not a reproduced defect.
- **True** (code read): both family B and family C evidence objects are
  object literals in `buildFinding`, typed by structural interfaces in
  `src/domain/evidence.ts`; any code can build one. Measured by a scratch
  edit (reverted): branding `ConfirmedAbsentInstance` and
  `ConfirmedUnreachableTarget` breaks exactly those 2 production
  constructions and 7 test fixtures (`html-report.test.ts`,
  `html-report.security.test.ts`, `output.test.ts`,
  `result-schema.negative-proof.test.ts`).
- **True** (code read): no phantom target remains. V-1 deleted Site B's
  phantom; family C's target nodes come from `findExportNodeInFile` and
  `findExportNodeThroughForwarding`, both of which return nodes of the
  graph. So there is no `UnattributedTarget` producer to type (§ 2's
  third type); the family-C constructor accepts only an `AttributedTarget`.
- **To measure**: whether a closure `{ complete: false, incompleteness: [] }`
  under an otherwise valid family-C baseline is `NOT_AFFECTED` on the base
  at the `buildFinding` level (expected yes, by the code read above).
- **Out of scope, recorded**: family A reads `closure.complete` and not
  the incompleteness list, and the F4 family-A control row
  `incompleteness_recorded_without_clearing_complete` certifies that
  (`invalidates: false`). ADR 0011's predicate 1 is stated for families B
  and C only. V-4 does not change family A; doing so would reopen a
  certified control (`docs/WORKFLOW.md` § 7).

## Task

### Problem

ADR 0011's predicates 1, 3 and 5 are enforced today by checks scattered
through `checkReachability` and `buildFinding`, and the evidence objects
they guard are plain object literals. Nothing stops a later change from
building a family B or C evidence object on a path that skipped a check,
and one half of predicate 1 (`closure.complete`) is not read for family C
at all. A violation is a test failure at best, when ADR 0011 § 2 asks for
a compile error.

### Why it matters

Soundness. A family B or C evidence object built without its
corroboration is a false `NOT_AFFECTED`. V-1..V-3 made the checks hold;
V-4 makes skipping them unrepresentable. Defect classes (AGENTS.md § F):
the corroboration is keyed by exact `PackageInstanceId` and by graph-node
membership (class A), and a closure's two completeness fields are read
together rather than one standing for both (class B).

### What to do

1. **Tests first.** At `buildFinding` level and in the F4 harness, a
   family-C baseline whose closure says `complete: false` with no recorded
   reason; shown `NOT_AFFECTED` on the base, `UNKNOWN` after. A
   type-level test (`@ts-expect-error`) that an object literal of
   `ConfirmedAbsentInstance` / `ConfirmedUnreachableTarget` does not
   compile, run by `npm run typecheck`.
2. **Branded proof inputs, in `src/analysis/verdict.ts`**:
   - `ClosureCorroboration`, produced by exactly one function from the
     context's closure and the finding's `packageInstance`: closure
     present, `complete === true`, `incompleteness.length === 0`,
     `rootFiles.length > 0` (predicate 1, both halves, gate-eligible),
     recording `instanceLoaded`. A refusal reports the existing blockers
     (`callGraphNegativeProofBlockers`), and `module_load_closure_unavailable`
     for a closure that is present but not a usable corroboration (no new
     reason token, ADR 0011 § 3).
   - The family-C closure corroboration carrying predicate 5 beside
     predicate 1 (V-1's binding), produced only from a
     `ClosureCorroboration`, the graph and the entrypoints.
   - `AttributedTarget`, produced only from a node that is a member of the
     analyzed graph (predicate 3).
   - Each carries a nominal brand (compile time) and a module-private
     runtime mark (a cast is detected and fails closed), the pattern of
     `AnalysisProofContext` (VT-CONTRACT-03).
3. **Evidence constructors**: `ConfirmedAbsentInstance` only from a
   `ClosureCorroboration` showing the exact instance not loaded;
   `ConfirmedUnreachableTarget` only from the family-C corroboration and an
   `AttributedTarget` of the same graph. The two interfaces in
   `src/domain/evidence.ts` gain a nominal brand, so an object literal is a
   compile error. Test fixtures that build a serialized finding state the
   assertion explicitly.
4. **A structural gate** against the cast loophole: a Foundation test,
   through the TypeScript checker, that no production type assertion in
   `src/` asserts a type containing a branded proof type, outside the
   constructors themselves (with a self-test, so it cannot go blind).
5. **Mutation tests** (ADR 0011 § 2): each corroboration check deleted in
   production source, one at a time, caught by a named test moving to a
   false `NOT_AFFECTED` (or to a wrong family). Predicates 1, 2, 3, 4 and 5,
   the runtime marks and the brands. Listed in the pull request.
6. **Register** predicates 1-3, 5 and the branded types under
   `VT-INV-V-corroboration` (`src/testing/foundation-invariants.ts`).
7. **Records**: REMEDIATION-PLAN § 5a "V-4 additions", OPEN-DEBTS where
   lane V's state is described, the backlog, `docs/progress.md`, the
   scorecard (regenerated).

## Boundaries

### Do not touch

- Family A's gate (see the premise above), the export model (lane E), the
  loader classifier (lane C), the provider/CLI paths (lane B).
- The locked `rwf-046-require-binding-authority` worktree.
- The serialized output shape: `schemas/result.schema.json` and every
  emitted field stay byte-identical; a brand is type-level only.

### STOP conditions

- A production path builds family B or C evidence that cannot be routed
  through the corroboration without changing a verdict on the corpora
  (graph, proof or verdict differential non-zero) — report it as a
  finding.
- Target nodes that are not members of the analyzed graph reach family C
  (would mean a phantom survived V-1) — `STOPPED_ON_FINDING`.
- Any change that would reopen a certified control row.

## Acceptance criteria

- [ ] Family B and family C evidence objects are built only by
      constructors that require a branded `ClosureCorroboration` (both
      halves of predicate 1, gate-eligible, `instanceLoaded` recorded),
      and, for family C, predicate 5 and an `AttributedTarget` from a node
      of the analyzed graph.
- [ ] An object literal of `ConfirmedAbsentInstance` or
      `ConfirmedUnreachableTarget` is a compile error (a `@ts-expect-error`
      test checked by `npm run typecheck`).
- [ ] A forged (cast) proof input fails closed to `UNKNOWN` at runtime.
- [ ] A closure with `complete: false` and an empty incompleteness list
      withdraws family C (failing on the base, passing after), in
      `verdict.f2-proof-guards.test.ts` and as an F4 row.
- [ ] A structural gate finds no production type assertion to a branded
      proof type outside the constructors, with a self-test.
- [ ] Each corroboration check, deleted by a mutation, is caught by a
      named test (listed in the pull request).
- [ ] Predicates 1-3, 5 and the branded types are registered under
      `VT-INV-V-corroboration`.
- [ ] Graph, proof and verdict differentials over the 139 corpus cases
      are all 0; the validation baseline is the documented five.
- [ ] The serialized output is unchanged (the schema tests pass
      unmodified in what they assert).

## Gates

The full set in `AGENTS.md` section I, unrelaxed. Expected: differentials
0 / 0 / 0 (no production closure has the shapes V-4 newly refuses); the
validation baseline exactly `RWB-03`, `RWB-05`, `RWB-09b`, `VAL-002`,
`VAL-003`.

## Report

In the format of `AGENTS.md` section J (`docs/WORKFLOW.md` § 5), in
exactly that order. Add: the mutation list, each with the named test that
caught it.

## Corrections (2026-10-09)

Appended once the work was done; the text above is as written at the
start (`docs/tasks/README.md`).

- **"Branded proof inputs, in `src/analysis/verdict.ts`" and "§ 8: types in
  `src/domain/evidence.ts`".** Measured: `src/domain/` imports nothing
  outside itself, and a `ClosureCorroboration` holds a `ModuleLoadClosure`
  (`src/analysis/`). The three proof-input types live in `verdict.ts` with
  their producers; only the two evidence brands are in `evidence.ts`.
- **The producers and constructors are exported**, not module-private as
  item 2's pattern ("module-private runtime mark") might suggest: the mark
  is private, the functions are not. Exporting them is safe by
  construction -- every producer checks its predicate, and every
  constructor refuses an unmarked input -- and it lets each refusal have a
  named unit test (`verdict.proof-inputs.test.ts`), which is what makes the
  defence-in-depth checks mutation-catchable at all.
- **No `UnattributedTarget`** (ADR 0011 § 2's third type): V-1 deleted the
  phantom, so nothing would produce one.
- **"A forged (cast) proof input fails closed to `UNKNOWN` at runtime"**
  holds for the three proof INPUTS. The two evidence objects carry no
  runtime mark (they are serialized output); for them the brand, the cast
  census and review are the layers, and the census states the routes it
  cannot see.
- **The independent audit blocked the first version** on two in-scope
  holes, both fixed on this branch: the cast census missed mapped wrappers
  and function types, and a production import of `src/testing/`'s
  fixtures; predicate 3 was checked only for the first unreachable target
  node. It also found the predicate-4 mutation missing (added) and three
  refusals whose deletion compiled (now each a compile error, by
  `satisfies`).

### Acceptance criteria, answered

- Families B and C built only by constructors from branded inputs: **yes**.
- An object literal of either evidence type is a compile error: **yes**
  (and of each proof input).
- A forged proof input fails closed at runtime: **yes** for the three proof
  inputs; the evidence objects have no runtime mark (above).
- `complete: false` with an empty list withdraws family C, failing on the
  base: **yes** (F2 and F4).
- A structural gate with a self-test: **yes** (`proof-input-casts.test.ts`).
- Each corroboration check, deleted, caught by a named test: **yes**,
  twenty-five mutations (the pull request lists them).
- Predicates 1-3, 5 and the brands registered: **yes**.
- Differentials 0 / 0 / 0 over 139 cases; validation baseline the
  documented five: **yes** (the pull request).
- Serialized output unchanged: **yes** (same keys, order and values;
  brands are declarations only).
