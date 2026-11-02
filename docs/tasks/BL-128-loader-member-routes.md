# BL-128 — Try end to end the builtin members Node's loaders touch that BL-122 did not (`require()` of an ES module, `import()`)

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-128
- **Branch**: `bl-128-loader-member-routes`
- **Base SHA**: `f4408fe00d55c1b43803e665d14491c0fb9b08b3` (BL-122's merge, PR #129)
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Specification

- The backlog row (BL-128, discovered in BL-122) and ADR 0010, "Proposed
  decision — BL-122", § "What was measured" ("Not measured end to end")
  and § "What any option leaves open" ("Touched members not tried end to
  end"). BL-122's inventory is
  `scripts/bl122-trust-boundary-reach/results.md` § 1 and
  `reach-releases.md`; its end-to-end cases are
  `tests/oracle/bl122-trust-boundary-reach.*`.
- **What it is.** For every member BL-122's inventory lists as touched by
  Node's loaders and that BL-122 did not reproduce end to end, try, against
  real Node on every installed release, whether a change to it makes real
  Node call the target in BL-092's decoy setup, and what the analyzer
  answers. A live false `NOT_AFFECTED` is an open-soundness-defect record
  and a finding. The result tells the owner, for ADR 0010's options,
  whether (W-loader) — which leaves the globals inside the claim — or (R)
  leaves a live route.
- **Order.** BACKLOG § 1 puts `BL-126` first. `BL-126` implements the
  owner's decision on BL-122, which is not recorded yet; the project owner
  approved doing BL-128 first (2026-11-02).

## Premises to verify (AGENTS.md § D)

- **"BL-122's inventory lists what the loaders touch."** Partly false, as
  measured at the start of this task (call sites recorded with a stack per
  call, v20.19.0 to v26.12.1): `probe-reach.cjs` computes the workload's
  paths (`path.join`, `url.pathToFileURL`) and stringifies its result
  (`String(…)`) while recording is on, so its table lists the probe's own
  calls as the loaders'. `globalThis.String()`, attributed to the ES module
  loader on every release, has no loader call site. To correct and
  regenerate; a record found false is a finding (AGENTS.md § C).
- **"The globals the ES module loader calls"** (ADR 0010, (W-loader)).
  Measured call sites: `JSON.parse`, `eval`, `Array`, `Set`, `Promise`,
  `RegExp`, `Object.create` and `Promise.resolve` are called by
  `cjs-module-lexer` only (state containers, and `decode` of the string
  literal of a `require("…")` reexport), when an ES module imports a
  CommonJS module. Whether a lexed reexport can choose a load is to try.
- **"`process.env` is a candidate."** Its one read
  (`getModuleJobForRequire`) is `process.env.WATCH_REPORT_DEPENDENCIES`, a
  `--watch` notification; to state, not assume, with the other members
  whose value reaches no load choice.
- **"`import()`'s members are not live false `NOT_AFFECTED`s, because the
  analyzer widens the closure on `import()`"** (BL-122 results § 2). To
  measure, including a literal specifier.
- **Releases.** Only v22.11.0 runs the oracle locally, where `require()`
  of an ES module throws; CI runs Node 20 and 26. The twelve releases
  under `/data/tools/node-releases` (BL-114's) run the routes script.

## Boundaries

- No analyzer change in `src/`; no change to SOUNDNESS-CONTRACT § 1 or to
  ADR 0010's proposed options (a note on what was measured only).
- A route the analyzer misses is an open-soundness-defect record, never an
  expectation; its control asserts the sound verdict.
- STOP conditions: a live false `NOT_AFFECTED` that is not of a class an
  ADR 0010 option already covers (report `STOPPED_ON_FINDING` only if it
  changes the owner's question, otherwise register it); a premise that
  changes BL-126's scope.

## Acceptance criteria

- [ ] Every member of BL-122's inventory not reproduced by BL-122 is
      classified, by release and workload: a live route (real Node calls
      the target), tried and not live, or reaching no load choice (with the
      call site that shows it).
- [ ] The inventory's probe artifacts are corrected and the table
      regenerated; the correction is registered.
- [ ] Each live route that reaches the analyzer's family-B proof is an
      oracle case: an open-soundness-defect record where the analyzer
      answers `NOT_AFFECTED`, with a control that keeps its proof.
- [ ] The routes' release dependence is in `tests/oracle/node-release-routes.ts`.
- [ ] Findings, ADR 0010 (a note), backlog, progress and the scorecard are
      updated; the answer for (W-loader) and (R) is stated.

## Gates and report

No analyzer change: the graph, proof and verdict differentials are
expected to be 0. The validation baseline is unchanged.

## Account
