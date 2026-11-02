# BL-128 — Try end to end the builtin members Node's loaders touch that BL-122 did not (`require()` of an ES module, `import()`)

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-128
- **Branch**: `bl-128-loader-member-routes`
- **Base SHA**: `f4408fe00d55c1b43803e665d14491c0fb9b08b3` (BL-122's merge, PR #129)
- **Commits**:
  - `docs(tasks): BL-128 task file — loader-touched members end to end`
  - `fix(BL-128): correct BL-122's reach inventory (RWF-164)`
  - (this commit) `docs(BL-128): loader-touched members by call site; records`
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

Measured on the base `f4408fe`, no change to `src/`.

- **The inventory's probe artifacts** (premise 1: false). With the probe's
  own work moved outside its recording window
  (`scripts/bl122-trust-boundary-reach/probe-reach.cjs`), its table,
  regenerated on the same thirteen releases, loses exactly eight rows and
  no other row changes: `path.join` (`cjs`, `require-esm`, `import`),
  `path.normalize` (`require-esm`, `import`), `url.pathToFileURL`
  (`import`), `globalThis.String` (`require-esm`, `import`). 52 distinct
  members, not 55; 43, not 45, without `import()`. Registered as RWF-164
  (fixed here); ADR 0010 gets a note, its proposed section is not edited;
  BL-122's `results.md` gets an appended correction.
- **Call sites** (premises 2 and 3). `scripts/bl128-loader-member-routes/callsites.cjs`
  records, per call, the first two stack frames outside itself, on all
  thirteen releases and both ES module workloads; it changes no value.
  The classification is `scripts/bl128-loader-member-routes/results.md`
  § 2: (a) the value is a path, a URL or a source the loader loads
  (`URL.prototype` members, `Buffer.allocUnsafe` / `allocUnsafeSlow`,
  `fs.readSync`, `fs/promises.readFile`, `path`'s `dirname`,
  `toNamespacedPath`, `posix`, `sep`, `isAbsolute`, `basename`); (b)
  `cjs-module-lexer` only — every global (O4) the loaders call; (c) a
  check, a format or bookkeeping (`process.env` is
  `WATCH_REPORT_DEPENDENCIES` on every release); (d) call site not
  recorded.
- **Premise 4** (`import()` widens the closure) was not measured: no
  analyzer run was made (Corrections).
- `node scripts/next-id.mjs` printed RWF-903 and later BL-130: it counts
  mentions (the synthetic RWF-900 range, and this task's own citations of
  RWF-164 and BL-129) as reservations, backlog `BL-125`'s defect. The
  register's highest ids were RWF-163 and BL-128, so this task took
  RWF-164 and BL-129.
- No independent audit: the row says `no`.

## Corrections

**2026-11-02 — scope narrowed by the project owner.** Writing the
end-to-end attempts (a script changing each member in BL-092's decoy
setup) was stopped partway by a safety filter, and was not resumed. The
project owner chose to narrow this task to what was measured: the
inventory's correction and the call-site classification, recorded as not
tried end to end, with the end-to-end tries moved to a new backlog row,
`BL-129`. Against the acceptance criteria above:

- criterion 1 (each member classified as live, tried and not live, or
  reaching no load choice): **in part** — classified by call site
  (results § 2), not by an end-to-end try;
- criterion 2 (artifacts corrected and registered): **yes** (RWF-164);
- criterion 3 (oracle cases for live routes): **no** — no route was
  tried (`BL-129`);
- criterion 4 (release dependence in `node-release-routes.ts`): **no** —
  no new route (`BL-129`);
- criterion 5 (records; the answer for (W-loader) and (R)): **yes**, the
  answer stated as unmeasured (ADR 0010, "Note — task BL-128").
