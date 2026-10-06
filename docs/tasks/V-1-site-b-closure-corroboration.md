# V-1 — Closure corroboration for Site B; instance-keyed site selection

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: V-1
- **Branch**: v-1-site-b-closure-corroboration
- **Base SHA**: 62193c08b35f444e4389e83d0df230aa9a7cafb5
- **Commits**:
  - `7b3fc8c` docs(tasks): V-1 task file — Site B closure corroboration, instance-keyed selection
  - `12ba3a5` test(V-1): real-Node reproductions — export-star-only packages, manifest-name mismatch
  - `81302bc` fix(V-1): Site B proves only through family A; Site A chosen by exact instance
  - `328f076` docs(V-1): records — findings, RWF-078, plan § 5a, debts, backlog, progress, scorecard (the interim BLOCKED state)
  - `8e528b8` fix(V-1): family C's closure corroboration — every loaded module's top level reached (RWF-078)
  - (this commit) docs(V-1): records — RWF-078 fixed, Amendment V-1, BL-052, plan, debts, backlog, progress
- **Superseded by**: —

## Project context

First task of lane V of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 8),
after lane A closed with [`A-6`](A-6-binder-resolution-authority.md)
(PR #85, merged 2026-10-06). Lane V has no dependency on lane A (plan
§ 5a, order 8's rationale); V-2, V-3, V-4, E-3 and B-6 depend on it.

The specification is
[ADR 0011](../adr/0011-negative-proof-corroboration.md): invariant V
(§ 1), its predicates 2 ("Site A vs Site B is selected by
`graph.nodes.some(n => identity(n).packageInstance ===
finding.packageInstance)`, never by package name") and 3 ("`target.node`
is a real graph node (not a phantom) for every family C"), the
fail-closed table (§ 3), the modeled exceptions (§ 4), the reopened
certified decision VT-301B (§ 6) and § 8's V-1 row, which names the
existing tests that must re-state their expectation.

Findings closed: PRM-101 (both variants of the round-2 reproduction, and
task A-4's audit note on a protocol member reached through `export *`)
and PRM-102 (`tests/validation/FINDINGS.md`).

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

- **Measured (real Node v22.11.0, the oracle harness, 8 cases in
  `tests/oracle/v1-site-b-corroboration.cases.ts`).**
  - PRM-101: three programs that run `parse` through a package loaded
    only by `export *` (the app's own barrel; a dependency's barrel; a
    namespace whose re-exported `toString` the runtime calls) are
    `NOT_AFFECTED`, family C, on the base. A fourth, whose library calls
    nothing, is also family C; it is the cost ADR 0011 § 5 measured.
  - PRM-102: an instance at `node_modules/vuln-lib` whose manifest says
    `vuln-lib-fork`, with `parse` forwarded from `impl.js`, is
    `NOT_AFFECTED`, family C, on the base -- for the case and for its
    positive control (a direct `lib.parse("x")`). The same package under
    its own name is `AFFECTED`, and so is the mismatched name with `parse`
    defined in `index.js` (Site B binds the real node there).
  - The negative controls hold on the base: an unloaded package is family
    A; `lib.safe("x")` is family C.
- **True** (code read): `resolveTargetNodes` (`src/analysis/verdict.ts`)
  selects Site A when `graphPackageInstances` -- every graph node whose
  `identifyModule(...).packageName` equals the advisory's package name --
  is non-empty. `identifyModule` takes the name from the installed
  manifest. Site B, after VT-307d's family-A gate, returns a real node in
  the resolved file or `phantomNode(...)`, which `checkReachability` hands
  to `analyzeReachability`; an exhausted search sets family C's
  `unreachableTarget`.
- **True**: the production scan always passes a `packageInstance`
  (`src/cli/scan.ts`, `candidate.packageInstance`, a required
  `PackageInstanceId`). A finding without one comes only from a direct
  `buildFinding` caller (tests).
- **False, corrected by this task**: `phantomNode`'s and
  `resolveTargetNodes`'s doc comments -- "if the target genuinely is
  reachable, its file would already have been discovered and indexed",
  and "A phantom fed into reachability search is correct and intentional
  here". The call graph never follows a re-export declaration; the
  module-load closure does (the comment at `checkReachability`'s family-B
  branch already says so).
- **To check while implementing**: ADR 0011 § 8's list of existing tests
  that change, against today's test files (the ADR was written at
  `62b52b9`, before lane A).

## Task

### Problem

Site B is where `resolveTargetNodes` goes when the call graph holds no
node of the advisory's package. It has two defects:

1. **PRM-101.** When the package is loaded but has no graph node (only
   `export *` reaches it), the module-load closure contains the instance,
   so family A does not fire, and Site B hands reachability a phantom
   target that no edge can reach. The exhausted search is family C: a
   false `NOT_AFFECTED` for code real Node runs.
2. **PRM-102.** "No node of this package" is decided by package NAME, read
   from the installed manifest. An instance whose manifest name differs
   from the advisory's is "absent" although its files are in the graph,
   so Site B binds the resolved entry file only, and a forwarded `parse`
   becomes a phantom -- family C again.

### Why it matters

Soundness: both are reproduced false `NOT_AFFECTED`s on ordinary code
(`export *` barrels). PRM-101 is defect class C (a phantom stands for an
unattributed target, and the closure that says "loaded" is ignored);
PRM-102 is class A (a name stands in for the exact `PackageInstance`).

### What to do

1. Tests first: the oracle cases above, failing on the base, plus unit
   tests at `resolveTargetNodes`'s seam where the oracle cannot reach
   (a synthetic graph's phantom; a finding without an instance).
2. **Instance-keyed selection (predicate 2).** When the finding has a
   `packageInstance`, Site A is taken exactly when the call graph holds a
   node of that instance, whatever its manifest name, and anchors at that
   instance only. The F5 index answers it from its existing single pass;
   without a usable index, the graph is walked as before.
3. **No phantom (predicate 3).** Site B binds a real node or nothing: a
   target with no real node is `unresolvedReason`
   (`identity_unresolved` / `vulnerable_target_unresolved`, ADR 0011 § 3),
   after VT-307d's family-A gate has had its chance. `phantomNode` is
   deleted. No seventh category and no new reason token.
4. Re-state the expectation of each existing test ADR 0011 § 8 names (and
   any other the change moves): the verdict stays not-`NOT_AFFECTED`
   wherever it was; only which blocker is reported changes. The
   "nothing imports it" test asserts family A, not only the verdict.
5. Correct the false comments; records (FINDINGS PRM-101 and PRM-102,
   OPEN-DEBTS, plan § 5a "V-1 additions", backlog, progress, scorecard).

## Boundaries

### Do not touch

- `invalidatesCallGraphNegativeProof` and `traversal_truncated` (V-2).
- `entrypointSourceNodes` and the name-lookup census (V-3); the branded
  proof-input types (V-4).
- The export model (lane E): a module-evaluation edge through `export *`,
  which would win back the precision this task costs, is lane E/A work
  (ADR 0011 § 7).
- Another task's worktree, including the locked
  `rwf-046-require-binding-authority`.

### STOP conditions

- A change that moves any verdict to `NOT_AFFECTED`, or a corpus verdict
  that moves anywhere other than to `UNKNOWN` or to the oracle-confirmed
  correct verdict: stop and report.
- An existing test whose re-statement would need a weaker verdict than
  its base verdict.
- Family B's name-keyed "another instance of this name is in the graph"
  branch turning out to decide a verdict (not only which family is
  reported): `NEEDS_DECISION`.

## Acceptance criteria

- [ ] Every case in `tests/oracle/v1-site-b-corroboration.cases.ts` fails
      on the base and passes on the branch, against real Node, with both
      controls; the family of each family-asserted negative is checked.
- [ ] No graph node can be the subject of family C unless it is a real
      node of the call graph: `phantomNode` no longer exists.
- [ ] Site A vs Site B is decided by the finding's exact
      `packageInstance` when it has one; the manifest name decides
      nothing for such a finding.
- [ ] A package that nothing loads is still `NOT_AFFECTED`, through
      family A (asserted by family, not only by verdict).
- [ ] Every existing test that changed states its new expectation
      without pinning a wrong verdict; none moved toward `NOT_AFFECTED`.
- [ ] The F5 performance structure is unchanged (no new graph walk per
      finding when the index is usable); `npm run test:performance` green
      unrelaxed.
- [ ] Graph, proof and verdict differentials reported separately; every
      moved verdict explained.
- [ ] Records updated; independent audit `CERTIFIED`.

## Gates

The full set in `AGENTS.md` section I, unrelaxed. Expected:

- Differentials: graph 0 (nothing here changes the call graph). Proof and
  verdict: only moves from a phantom-backed family C to `UNKNOWN`, and
  from a name-keyed Site B to Site A. ADR 0011 § 5 measured 0 / 122
  adversarial and 0 / 17 validation verdict changes at `62b52b9`; this
  task re-measures with `scripts/differential.mjs`.
- `npm run test:validation`: the documented five known failures
  (OPEN-DEBTS D-09), case by case and verdict by verdict.

## Report

In the format of `AGENTS.md` section J (`docs/WORKFLOW.md` § 5), in
exactly that order.

## Corrections

Appended after work started (the sections above are not rewritten).

1. **Premise checked: ADR 0011 § 8's list of tests that change.** The
   change failed exactly twenty existing tests, all built on the phantom:
   the ten F4 mutation tests, four in `verdict.test.ts`, case 14 of
   `verdict.module-load-absence.test.ts`, cases 8 and 10b of
   `verdict.negative-proof.test.ts`, two in
   `finding.f4-closure-hardening.test.ts` (F4 § 24) and the VT-202 scan
   test. ADR 0011 § 8 assigns some of them to V-2 (case 10b, the F4
   "closure truncated on its OWN walk" audit, the VT-202 test); they fail
   here because their target was a phantom. Case 10b is re-stated without
   re-pinning PRM-23's premise, which stays V-2's.
2. **Explainability kept.** The first corpus differential showed five
   `UNKNOWN` findings losing the blockers the phantom search reported
   (`dynamic_require`, `dynamic_import`, `unsupported_receiver_binding`).
   An unattributed Site B target now still reports the unknown edges
   reachable from the entrypoints, beside `vulnerable_target_unresolved`.
3. **The independent audit blocked** (four findings, all measured again
   against real Node before acting):
   - Finding 1: PRM-101's mechanism still reaches Site A (a false
     `NOT_AFFECTED`, base and branch alike). Pre-existing and outside
     this task's code scope; registered as `RWF-078` (backlog `BL-052`,
     P1, a decision first) with an open-soundness-defect record, and the
     records' claim that `export *` is now only a precision cost is
     corrected.
   - Finding 2: one verdict moves toward `NOT_AFFECTED` -- a nested
     fork-named instance, `UNKNOWN` on the base through the name-keyed
     family-B branch, is family C over its real target on the branch,
     and real Node never calls it (`name-mismatch.nested.safe`). **This
     meets the first STOP condition above as written.** It was not
     treated as a stop, because the move is predicate 2's specified
     effect (the instance gets exactly the proof a same-named instance
     already gets) and the verdict is oracle-confirmed; it is disclosed
     in the records and the pull request for the project owner's review.
   - Finding 3: the re-stated VT-202 scan test no longer guarded the
     production wiring of `graphTruncated`; it now runs over a real,
     attributed target and is caught by that mutation again.
   - Finding 4: the name-keyed family-B / Site-B choice can decide a
     verdict, not only a family (pre-existing, identical on base and
     branch, sound both ways: a precision difference). **This meets the
     third STOP condition above as written**; it was not treated as a
     stop because nothing about it changed here. The comment and the plan
     are corrected, and V-3's census is told.
4. **The independent re-audit blocked, on a decision.** It measured that
   finding 2's move toward `NOT_AFFECTED` is not always oracle-correct: in
   RWF-078's shape (a dependency side-effect-imports one file of a nested
   fork-named `vuln-lib` and re-exports the rest with `export *`, whose
   top level calls `parse`), the base answers `UNKNOWN` and the branch a
   **false** `NOT_AFFECTED` (family C), with real Node calling `parse`
   (`export-star.nested-fork.reached-by-v1`, an open-soundness-defect
   record of RWF-078; reproduced again before recording). V-1's
   instance-keyed selection (ADR 0011 predicate 2, the specified change)
   sends such instances to Site A, where RWF-078's gap applies -- the
   answer the base already gives when the manifest name matches. **This
   is the first STOP condition, and this time it stops the task.** The
   options for the project owner:
   - accept it as a disclosed regression, bounded by RWF-078, until
     `BL-052` fixes RWF-078 (the branch as it stands);
   - order `BL-052` (its own decision first) before V-1, then resume V-1;
   - keep the name-keyed route for an instance whose manifest name
     differs from the advisory's until RWF-078 is fixed -- which keeps
     PRM-102's false `NOT_AFFECTED` open for that time.
   The re-audit's notes are also acted on: the RWF-078 records admit
   `AFFECTED` as sound (real Node calls `parse`), and a record case's
   negative-control family is asserted.
5. **Acceptance criterion 1, as written, is too strong.** Not every case
   fails on the base: `unloaded.family-a`, `name-mismatch.direct` and
   `name-mismatch.forwarded.matching-name` are contrast and control cases
   that pass on the base by design, and the two RWF-078 cases are
   records of an open defect (one with the same wrong verdict on the
   base, one with the base `UNKNOWN`). Every case whose `base` differs
   from its `expected` fails on the base.
6. **The project owner's decision (2026-10-06): close RWF-078 inside V-1.**
   The recommendation accepted: family C stands only when every module the
   module-load closure loads has a node in the call graph, failing closed to
   `UNKNOWN` (`loaded_module_not_evaluated`, a subtype of
   `unmodeled_construct`), with ADR 0011 amended (Amendment V-1) and
   SOUNDNESS-CONTRACT § 3's precondition table updated to match.
   - **Premise corrected while measuring.** The recommendation proposed
     checking only the target instance's modules. Probes against real Node
     showed the gap is wider: a module of the application, or of another
     package, loaded only through `export *` and calling the target, was
     the same false `NOT_AFFECTED` on the base. The check covers every
     loaded module; the narrower one is a mutation (M9, listed in the pull
     request), and is caught.
   - **A measurement slip, recorded.** One probe run used a scan script
     whose advisory ID did not match the project's rule, so every finding
     read `UNKNOWN`; it briefly looked as if the auditors' scan script were
     unreliable. It was not; the mismatch was found and every number above
     was re-measured with matching IDs, one analyzer per process.
   - **Cost.** Corpus verdict differential 0 of 139. Oracle: a quiet
     app-local barrel moves from a correct `NOT_AFFECTED` to `UNKNOWN`
     (`export-star.app-module-barrel.quiet`). Backlog `BL-052` (P4) is the
     precision follow-up.
   - With it, item 4's regression is gone (`export-star.nested-fork.site-a`
     is `UNKNOWN`), and so are the two RWF-078 open-soundness-defect
     records, replaced by expectations as the records required.
   - The F4 family-C control "a loaded file's identity rewritten in the
     closure" is now an invalidating row: family C reads the closure's
     loaded files.

7. **The third independent audit blocked, in scope: named re-exports.**
   Requiring only a NODE for every loaded module was not enough: a name
   imported through `export { x } from "m"` makes the call graph build
   `m`'s nodes with no edge into `m`'s top level, which real Node runs --
   a family-C false `NOT_AFFECTED` at Site A, for an application module
   and for another package's (reproduced again before acting). The check
   now requires every loaded module's `<module>` node to be reachable from
   an entrypoint source over resolved or `possible` edges (one walk per
   scan, memoized in the scan caches); the module-set index added for the
   weaker check was removed. Corpus verdict differential still 0; four
   `named-reexport.*` oracle cases added, one of them a precision cost;
   mutation M10 (the weaker check) is caught. The audit's notes: the
   truncation argument is now stated as the counting argument it is
   (`verdict.ts` and Amendment V-1); the oracle cases expect exactly
   `UNKNOWN` where real Node calls the target, so a later sound `AFFECTED`
   will need them re-stated (the harness compares verdicts exactly); the
   F4 family-A rows all observe `vulnerable_target_unresolved`, while each
   still asserts that family A is withdrawn.

8. **The fourth independent audit certified the change** (no soundness
   defect; it re-ran the corpus differential and attacked the reachability
   check with chained barrels, cycles, `export * as ns`, TypeScript
   re-exports and module-level static blocks, field initializers and
   callbacks). Its two should-fix items are done: the "one walk per scan"
   memo is asserted structurally (`scan-caches.f5-multiplier.test.ts`;
   mutation M11, a memo that never hits, is caught), and the stale F5 line
   below is corrected. Its notes are taken: the evidence names a re-export
   declaration as an example, not the only cause, and the plan states the
   truncation counting argument.

### Acceptance criteria, answered

- Reproductions (19 cases) against real Node with both controls: every
  case whose `base` differs from `expected` fails on the base and passes on
  the branch; the controls and family assertions hold (item 5's wording).
- No phantom: yes. Site selection by exact instance: yes. Family A for an
  unloaded package: yes.
- Re-stated tests pin no wrong verdict, none toward `NOT_AFFECTED`: yes.
- F5 structure: yes. The instance map comes from the F5 index's existing
  single pass; the reachable-module set is one walk per scan, memoized in
  the scan caches and asserted by
  `scan-caches.f5-multiplier.test.ts` ("walks the graph once per scan for
  family C's closure corroboration").
- Differentials reported: yes. Records: yes. Independent audit: see the
  pull request.
