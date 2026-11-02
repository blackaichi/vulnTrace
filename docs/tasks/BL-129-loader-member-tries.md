# BL-129 — Try end to end the loader-touched members BL-128 classified by call site (`require()` of an ES module, `import()`, the CommonJS loader's `path` members)

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-129
- **Branch**: `bl-129-loader-member-tries`
- **Base SHA**: `1512b65830baaa5a8e02b6cedecfca08ac67c890` (BL-128's merge, PR #130)
- **Commits**: <!-- filled in by the last commit (READY_FOR_REVIEW) -->
- **Superseded by**: —

## Specification

- The backlog row (BL-129, discovered in BL-128) and
  `scripts/bl128-loader-member-routes/results.md` § 2 (a) and (b); the
  question it answers is ADR 0010, "Note — task BL-128" (for (W-loader)
  and (R)), on "Proposed decision — BL-122".
- **What it is.** For each member whose value BL-128 found to be a path,
  a URL or a source the loader loads (§ 2 (a)), and for the
  `cjs-module-lexer` globals (§ 2 (b)): change it in BL-092's decoy setup,
  on every installed release and in each load form that touches it, and
  record whether real Node then calls the affected top-level instance's
  target, and what the analyzer answers. A live false `NOT_AFFECTED` is an
  open-soundness-defect record and a finding.
- **Order.** The project owner put BL-129 ahead of `BL-126` (2026-11-03):
  `BL-126` waits for the owner's decision on BL-122.

## Premises to verify (AGENTS.md § D)

- **"§ 2 (a)'s members are candidates, untried"** (BL-128). To try each.
  `URL.prototype.pathname` is RWF-162's (BL-113); `path.resolve`,
  `fs.realpathSync`, `fs.readFileSync` and `fs.openSync` are RWF-163's
  (BL-122): not re-tried here.
- **"A lexed reexport is resolved and read for its names, not run"**
  (BL-128 § 2 (b), from Node's source). To try: a change to `JSON.parse`
  or `eval` while an ES module imports a CommonJS module with a
  `require("…")` reexport.
- **"`import()` widens the closure, so its members are not live false
  `NOT_AFFECTED`s"** (BL-122 results § 2; BL-128 premise 4, not
  measured). To measure, with a literal specifier.
- **Releases.** Only v22.11.0 runs the oracle locally, where `require()`
  of an ES module throws; the twelve releases under
  `/data/tools/node-releases` run the routes script.

## Boundaries

- No analyzer change in `src/`; no change to SOUNDNESS-CONTRACT § 1 or to
  ADR 0010's proposed options (a note on what was measured only).
- A route the analyzer misses is an open-soundness-defect record, never an
  expectation; its control asserts the sound verdict.
- STOP conditions: a live false `NOT_AFFECTED` that no ADR 0010 option
  covers (report `STOPPED_ON_FINDING` only if it changes the owner's
  question, otherwise register it); a premise that changes BL-126's scope.

## Acceptance criteria

- [ ] Every member of § 2 (a) and (b) is tried end to end, by release and
      load form, and classified: live (real Node calls the target), or
      tried and not live (with the attempt that shows it).
- [ ] Each live route is an oracle case: an open-soundness-defect record
      where the analyzer answers `NOT_AFFECTED`, with a control that keeps
      its proof; a route live only on releases the local oracle does not
      run asserts its ground truth through `node-release-routes.ts`.
- [ ] The routes' release dependence is in `tests/oracle/node-release-routes.ts`.
- [ ] Findings, ADR 0010 (a note), backlog, progress and the scorecard are
      updated; the answer for (W-loader) and (R) is stated.

## Gates and report

No analyzer change: the graph, proof and verdict differentials are
expected to be 0. The validation baseline is unchanged.

## Account

<!-- Filled in while working. -->
