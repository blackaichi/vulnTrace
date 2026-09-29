# A-2 — The `possible` edge kind: domain type, reachability semantics, `value_uncertainty` subtype

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: A-2
- **Branch**: a-2-possible-edge
- **Base SHA**: b7c8f574739806fb3df7d67a2bbcd76e636d6bc9
- **Commits**:
  - `c39def2` docs(tasks): A-2 task file — the possible edge kind
  - `b4ab0b9` feat(A-2): the possible edge kind — domain type, reachability semantics, possible_invocation
  - `a3e2f82` test(A-2): the possible edge — Decision 2's three halves, VT-300, verdicts, coverage, schema, differential
  - (this commit) docs(A-2): records — contract, plan § 5a, backlog, progress, scorecard
- **Superseded by**: —

## Project context

Second task of lane A of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 3). The
specification is [ADR 0008](../adr/0008-invocation-accounting-and-resolution-authority.md)
§ 8's A-2 row ("the `possible` edge kind: domain type, reachability
semantics, `value_uncertainty` subtype"; files `domain/graph.ts`,
`analysis/reachability.ts`, `domain/uncertainty.ts`, `schemas/` if the
edge kind is serialized; "`reachability.test.ts` gains the possible-edge
cases"), read with:

- § 1: "A **possible** edge is a new edge resolution kind (`kind:
  "possible"`, carrying its target). Reachability traverses it, so the
  code behind it is searched and its own unknown edges count. But a path
  that uses one can never be an `AFFECTED` path, and a target reached
  only through possible edges is `UNKNOWN`."
- § 3: "a target reached only through possible edges:
  `value_uncertainty` […] with a new subtype token such as
  `possible_invocation`. No seventh category."
- The project owner's Decision 2 (ADR 0008, "Decision record — project
  owner, 2026-09-26"), which task A-1 wrote into
  [`SOUNDNESS-CONTRACT.md`](../SOUNDNESS-CONTRACT.md) § 1 and § 3 and
  into the invariant map as `affected-path-resolved-edges-only`, worded
  as binding on this task. That invariant's note requires A-2 to extend
  its owner test "with the other two halves before it may emit one".

A-2 closes no finding by itself (ADR 0008 § 8: "none alone (enables A-3,
A-4)"). It introduces the edge kind and its semantics. The emitters are
A-3 (escaped function values, JSX) and A-4 (protocol members, accessor
bodies).

Premises, checked against `main` at the base SHA (`AGENTS.md` § D):

- **Measured.** `CallEdgeResolution` (`src/domain/graph.ts`) has two
  kinds, `resolved` and `unknown`. `analyzeReachability` follows
  `resolved` edges only and records every other edge as an unresolved
  blocker; it returns `unreachable` only when the resolved-reachable
  region is exhausted with no blocker.
- **Measured.** `collectReachableUnknownEdges` (the VT-300 guard's
  traversal, used by `hasReachableClosureWideningBlocker` in
  `verdict.ts` to withdraw family B) also follows `resolved` edges only.
  If it did not learn the new kind, a closure-widening construct behind
  a `possible` edge would be invisible to VT-300, and family B could
  stand on an instance that code might load: a false `NOT_AFFECTED`.
- **Measured.** The call graph's edges are not serialized in scan
  output. What is serialized: the uncertainty reason enum (twice, in
  `schemas/result.schema.json`: a finding's `unknownReasons` and an
  unreported candidate's reason) and `coverage`, whose
  `callsResolved`/`callsDynamic` count edges by resolution kind
  (`computeCoverage`).
- **Measured.** The differential tool (`scripts/differential-lib.mjs`,
  BL-029) renders every non-`resolved` edge as `? <reason>`, so a
  `possible` edge would render as `? undefined`, and it classifies a
  changed site only as withdrawn to unknown, unknown to resolved, or
  retargeted. Every lane task reports its graph differential with this
  tool, so A-3 and A-4 could not report their `possible` edges.
- **Measured.** Other consumers of an edge's resolution:
  `src/testing/proof-mutation.ts`'s `edgeTargets` (resolved only: a
  mutation that removes a node would leave a `possible` edge into it
  dangling) and `call-graph.ts`'s `deferredToAccessor` (maps `resolved`
  to `unknown`; a `possible` edge passing through it is already never
  part of an `AFFECTED` path, so it needs no change).
- **Plan statement that does not hold as written.**
  `REMEDIATION-PLAN.md` § 5.1 says lanes A and V are parallel-safe
  "provided A-2 does not edit `verdict.ts`; if it must, A-2 waits for
  V-3". The typed uncertainty channel from reachability to a finding is
  `checkReachability` in `verdict.ts`, which maps each
  `unresolvedEdges` reason to an `UncertaintyReason`. A target reached
  only through `possible` edges produces no unresolved edge, so without
  a mapping there the `UNKNOWN` would carry no `possible_invocation`
  reason, contradicting ADR 0008 § 3. A-2 therefore adds that one
  mapping to `verdict.ts`. The § 5.1 condition is a parallel-execution
  constraint. Tasks run one at a time (`docs/WORKFLOW.md` § 1.8), and no
  V task has started, so the conflict it guards against cannot arise.
  Reported as a deviation.

## Task

### Problem

ADR 0008's over-approximated invocations (an escaped function value
handed to code the graph does not model, a JSX component, a protocol
member, an accessor body) are invocations the program *may* perform.
Today the graph can express only `resolved` (which would manufacture an
`AFFECTED` from a path the program might not take) or `unknown` (which
blocks family C even when the over-approximated region provably cannot
reach the target, and does not search the code behind it). A-3 and A-4
need the third kind before they can emit anything.

### Why it matters

Soundness first. The edge kind decides two failure directions at once:

- a `possible` edge treated as `resolved` manufactures a false
  `AFFECTED` (SOUNDNESS-CONTRACT § 1 requires a concrete path);
- a `possible` edge treated as "not taken", or the code behind it left
  unsearched, manufactures a false `NOT_AFFECTED` (family C over an
  incomplete region; family B past a widening construct VT-300 cannot
  see).

Defect class C (AGENTS.md § F): a `possible` edge is exactly a
multi-valued fact ("this may run") that must never collapse to one value
("this runs" or "this does not run").

### What to do

1. **Domain type** (`src/domain/graph.ts`): add `{ kind: "possible";
   target }` to `CallEdgeResolution`. Its documentation states the
   semantics and what binds a producer: a `possible` edge is emitted
   only for an over-approximation ADR 0008 § 2 names, only to an
   attributable target, and only when the target's file is walked
   exactly as for a resolved edge (otherwise the region behind the edge
   looks searched and empty, which is how a false family C would
   appear). `ReachabilityResult`'s `unknown` state gains the witness path
   of a target reached only through `possible` edges.
2. **Reachability semantics** (`src/analysis/reachability.ts`):
   - `reachable` only through a path whose every hop is `resolved`;
     unchanged shortest-path behaviour;
   - `possible` edges traversed: the code behind them is searched, and
     its unknown edges are blockers;
   - a target reached, but only through a path using a `possible` edge:
     `unknown`, with a `possible_invocation` blocker naming the witness
     path;
   - a region behind `possible` edges that neither reaches the target nor
     contains an unknown edge: `unreachable` (family C stands);
   - for a graph with no `possible` edge, results are identical to the
     base, field by field and in the same order;
   - `collectReachableUnknownEdges` traverses `possible` edges too;
   - `computeCoverage` counts `possible` edges separately.
3. **Uncertainty subtype** (`src/domain/uncertainty.ts`):
   `possible_invocation`, category `value_uncertainty`. No seventh
   category. `verdict.ts`'s `checkReachability` maps the witness to it.
4. **Output schema**, additive only: `possible_invocation` in both
   reason enums; `coverage.callsPossible` as an optional property; the
   `reachableSubgraphComplete` description names the traversal it now
   rests on. The HTML report shows the new coverage count.
5. **Consumers**: the differential tool renders a `possible` edge and
   classifies site changes into and out of it; `proof-mutation.ts`'s
   `edgeTargets` counts a `possible` edge as pointing at its target.
6. **Tests**: the `affected-path-resolved-edges-only` owner gains the two
   missing halves; `reachability.test.ts` gains the possible-edge cases;
   the VT-300 traversal; verdict-level cases over real on-disk projects
   through the production `buildFinding` (families B and C, with a
   `possible` edge injected into a real graph, since no producer emits
   one yet); coverage, schema and differential-tool cases. Each mutation
   of the new semantics is caught by a named test.
7. **Records**: the SOUNDNESS-CONTRACT § 1 and § 3 parentheticals that
   say the kind "does not exist yet"; the invariant map's note;
   `REMEDIATION-PLAN.md` § 5a gains "A-2 additions to lane-A acceptance"
   (what binds A-3's and A-4's emitters); backlog, progress, scorecard.

## Boundaries

### Do not touch

- Every emitter: no production code emits a `possible` edge in this
  task. Escaped values, JSX, own-export calls (A-3), protocol members
  and accessors (A-4), resolution authorities (A-5, A-6).
  `deferredToAccessor` stays as it is (A-4 replaces it).
- The proof families' definitions and `buildFinding`'s proof selection,
  beyond the one uncertainty-reason mapping above.
- The locked `rwf-046-require-binding-authority` worktree.

### STOP conditions

- Any corpus differential (graph, proof or verdict) is non-zero: with no
  emitter, the corpora cannot contain a `possible` edge, so a non-zero
  differential means the change moved something it must not
  (`STOPPED_ON_FINDING`).
- The semantics require a non-additive output-schema change, or a change
  to a proof family's definition (`NEEDS_DECISION`).
- The independent audit blocks on something outside this scope.

## Acceptance criteria

- [ ] `CallEdgeResolution` has a `possible` kind carrying its target,
      documented with the producer obligations above.
- [ ] `analyzeReachability` reports `reachable` only through all-resolved
      paths; traverses `possible` edges; counts unknown edges behind
      them; answers `unknown` with a `possible_invocation` witness for a
      target reached only through `possible` edges; answers
      `unreachable` when the region behind them is clean and does not
      reach the target; and is unchanged on graphs without `possible`
      edges.
- [ ] `collectReachableUnknownEdges` traverses `possible` edges, so
      VT-300 sees a widening construct behind one (tested through
      family B on a real project).
- [ ] Through the production `buildFinding`, a target reached only
      through a `possible` edge is `UNKNOWN` carrying
      `value_uncertainty` / `possible_invocation`, never `AFFECTED` and
      never `NOT_AFFECTED`; a clean `possible` region leaves family C
      standing.
- [ ] `possible_invocation` is a `value_uncertainty` subtype; there are
      still six categories; the schema's two reason enums list it.
- [ ] Coverage counts `possible` edges in `callsPossible` (optional in
      the schema, so archived results still validate); the HTML report
      shows it.
- [ ] The differential tool renders `possible` edges and classifies site
      changes into and out of them.
- [ ] The `affected-path-resolved-edges-only` owner asserts all three
      halves of Decision 2; the invariant map's note no longer says the
      kind does not exist.
- [ ] Each mutation of the new semantics is caught by a named test.
- [ ] SOUNDNESS-CONTRACT § 1 and § 3 no longer say the kind does not
      exist; `REMEDIATION-PLAN.md` § 5a states what binds A-3's and
      A-4's emitters.
- [ ] Graph, proof and verdict differentials reported separately (all
      three expected 0); the validation baseline compared case by case
      (OPEN-DEBTS D-09).
- [ ] An independent audit returned `CERTIFIED`.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected differentials over
the 139 corpus cases: graph 0, proof 0, verdict 0 (no emitter exists).
Validation: exactly the five known failures of OPEN-DEBTS D-09.

## Report

In the format of `AGENTS.md` § J. Also report, in "Anything requiring
manual review": the `verdict.ts` deviation above, and the new optional
`coverage.callsPossible` output field.

## Corrections (2026-09-28)

Appended during the task; the text above is unchanged.

1. **The consumer list in "Project context" was incomplete.** It was
   measured over `src/` and `scripts/` only. The independent audit found
   a further consumer under `tests/`: the binding-grammar harness
   (`tests/binding-grammar/harness.ts`, `observe()`), which read every
   edge that was not `unknown` as `EXACT <target>`, so a resolved edge
   downgraded to `possible` would have passed as agreeing. Re-measured
   over `tests/` and every script: it is the only one (the other
   `resolution.kind` hits there are module resolutions). The harness now
   observes `POSSIBLE <target>`, and the guard makes every `POSSIBLE`
   observation a violation no disagreements row can silence — a
   fabrication unless it names the expected target.
2. **"identical to the base, field by field"** (What to do 2, and the
   acceptance criterion) holds for `analyzeReachability`'s result, apart
   from its `coverage`: every coverage object now also carries
   `callsPossible` (0 on a graph with no `possible` edge), so every scan's
   JSON gains that one field. The verbatim-base test compares with the
   current `computeCoverage` for that reason.

## Outcome (2026-09-29)

**Acceptance criteria**: all **yes**, with correction 2 above on "identical
to the base".

- `CallEdgeResolution` has `possible` (`src/domain/graph.ts`), documented
  with the three producer obligations.
- Reachability: two phases (`src/analysis/reachability.ts`). Checked on
  hand-built graphs, against a set-based oracle over 3,000 seeded random
  graphs (every outcome sampled more than 50 times), and byte for byte
  against a verbatim copy of the base algorithm on 3,000 graphs without
  `possible` edges.
- `collectReachableUnknownEdges` follows `possible` edges; family B is
  withdrawn by a widening construct behind one, on a real project.
- Through the production `buildFinding`: UNKNOWN with
  `value_uncertainty` / `possible_invocation`, never AFFECTED or
  NOT_AFFECTED; family C kept by a clean region, withdrawn by an unknown
  edge behind one (`src/analysis/verdict.possible-edge.test.ts`).
- Six categories; `possible_invocation` in both schema reason enums;
  `coverage.callsPossible` optional; the HTML report shows it.
- The differential tool renders `~> target` and classifies site changes
  into and out of `possible`, mixed sites included.
- `affected-path-resolved-edges-only`: two owners, all three halves; run
  by the Foundation gate.
- Mutations, each caught by named tests (the task's PR lists them):
  phase 1 following `possible` as resolved; `possible` edges never
  followed; unknown edges behind a `possible` edge dropped; the
  possible-only reach not reported; VT-300 skipping `possible` edges;
  `verdict.ts` dropping `possible_invocation`; coverage ignoring
  `possible`; `edgeTargets` ignoring `possible`. The phase-2 mutations
  were re-run after the phase-2 rewrite.
- Failing first: 30 of the new tests fail on the base implementation;
  all pass on the branch.
- Differentials (`node scripts/differential.mjs`, 139 cases): graph 0,
  proof 0, verdict 0, none unmeasured. Expected: nothing emits a
  `possible` edge yet, so this is not evidence of soundness (OPEN-DEBTS
  D-12).
- Validation: exactly the five known failures of OPEN-DEBTS D-09, each at
  its documented verdict.
- Independent audit: `CERTIFIED`, five non-blocking findings, all
  addressed in this task: the binding-grammar consumer (correction 1);
  a test for the graph mutators; phase 2 building a path per edge (now
  parent links and one materialized witness); the differential tool's
  mixed sites; two wording overclaims (correction 2, and a stale VT-300
  comment in `verdict.ts`).

**Deviations**: the `verdict.ts` mapping (see the premises); the
binding-grammar harness and guard, not in ADR 0008 § 8's file list, are
changed because they consume the edge kind.

**Discovered**: none.
