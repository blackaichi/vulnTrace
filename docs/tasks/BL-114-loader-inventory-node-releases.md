# BL-114 — Repeat BL-111's loader inventory on Node 20 and 26 (CI's releases)

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-114
- **Branch**: `bl-114-loader-inventory-node-releases`
- **Base SHA**: `3cfe09d1f7541c14ac8f0ac67b062bc94dc587d7` (BL-111's merge, PR #120)
- **Commits**: (filled in by the last commit)
- **Superseded by**: —

## Project context

Lane C. BL-111 inventoried what Node's own loader reads and writes by
inheritance on the builtin prototypes
(`scripts/bl111-loader-writes-options/inventory.md`), and appended a
proposed decision to ADR 0010 ("Proposed decision — BL-111"): (B) a
closure-wide rule over the stores that reach the loader, or (C) a stated
trust boundary. The project owner has not decided yet. BL-113 implements
the decision.

The inventory is a claim about Node v22.11.0, the only release installed
where BL-111 ran. CI runs Node 20 and 26 (`.github/workflows/ci.yml`).
The inventory found one data read that redirects a load:
- an ES module load reads its load context's `source` by inheritance, so
  `Object.prototype.source = <text>`, a plain primitive store, replaces
  the module's source;
- with the analyzer this is `UNKNOWN` on v22.11.0, because there only
  `import()` reaches it, and `import()` already widens the closure;
- none of BL-111's options counts a primitive store.

The backlog row asks whether a release that can `require()` an ES module
makes it live with no `import()`.

### Premises (AGENTS.md § D)

- **"On a release with `require()` of an ES module, `Object.prototype.source`
  may replace a statically required ES module's source."** Measured before
  this file was written, with real Node (a premise check, not yet
  committed):
  - on v20.20.2, v22.23.4, v20.19.0, v22.12.0 and v24.0.0, `require()` of
    an ES module with no static import is **not** replaced;
  - on those releases, its **static dependency** is replaced;
  - v24.12.0 to v24.22.1 and v26.0.0 to v26.12.1 replace neither;
  - v22.11.0 throws `ERR_REQUIRE_ESM`.

  So the row's premise is true in a narrower form. In BL-092's decoy
  setup the analyzer answers `NOT_AFFECTED` (family B), where real Node
  v20.20.2 and v22.23.4 call the target: a live false `NOT_AFFECTED`
  (RWF-158 below).
- **"BL-111's oracle records hold on CI's releases."** Measured false.
  - **The cases:** `inherited-read.source-string` and
    `inherited-read.source-unspelled-prototype`
    (`tests/oracle/bl111-loader-inherited-reads.cases.ts`) assert that
    real Node calls the target.
  - **Node 26:** on CI it does not. PR #120's Node 26 job failed on
    exactly these two cases, and the pull request was merged with that
    check red. `main` fails CI on Node 26.
  - **Cause:** v26's loader gives its load contexts a null prototype.
- **"The loader differs by version."** True, and it differs within one
  major line. On 24.x the route closes between v24.11.1 and v24.12.0. The
  load context `getModuleJobForRequire` builds is
  `{ format, importAttributes }` in v24.11.1 (`esm/loader.js:480`) and
  gets `__proto__: null` in v24.12.0.

## Task

### Problem

Every claim BL-111 made about real Node is a claim about v22.11.0. A
route BL-111 found `UNKNOWN` on v22.11.0 is a live false `NOT_AFFECTED`
on CI's Node 20. Two BL-111 records are false on CI's Node 26.

### Why it matters

Soundness: RWF-158 is a live false `NOT_AFFECTED` on CI's Node 20, on the
current 22.x line, and on v24.0.0 to v24.11.1. Defect class B: the
analyzer assumes Node's loader runs over Node's own builtins. The stored
value is a primitive under a spelled name, so none of BL-111's options
(A), (B) or (B′) sees it. The owner's pending decision must account for
it.

### What to do

This is a measurement task. It changes no analyzer behaviour in `src/`.

1. **Repeat the inventory** on v20.20.2 and v26.12.1 (CI's), and on
   v22.23.4 and v24.22.1 (the current LTS lines):
   - BL-111's `setup.sh`, `probe-inherited.cjs` and `gadgets.cjs`, with a
     workload that `require()`s an ES module, with and without a static
     dependency (BL-111 lists `require(esm)` as not reached);
   - compare the recorded hits with v22.11.0's, by operation and loader
     function, ignoring line numbers.

   The tooling goes in `scripts/bl114-loader-inventory-releases/` and the
   results in its `releases.md`.
2. **Bound each live route by release:** the first release where it
   opens and where it closes on each line, bisected where a line changes,
   with the loader source that explains it.
3. **RWF-158**: open-soundness-defect records in BL-092's decoy setup
   (`tests/oracle/bl114-require-esm-inherited-source.*`) with a no-store
   control.
   - Real Node's ground truth is asserted per release, from the measured
     table.
   - A release outside it fails loudly ("measure it"). It is never
     skipped.
4. **RWF-159**: make BL-111's two `inherited-read.source-*` cases assert
   the ground truth of the release they run on, from the same table. Each
   case keeps its sound expected verdict (`UNKNOWN`). On a release where
   real Node does not call the target, the case states the `UNKNOWN` as a
   precision cost.
5. **Measure BL-111's patches** (`A.patch`, `B.patch`, `Bliteral.patch`)
   against RWF-158's records: does any option see it?
6. **Run the oracle suite** under each release measured, as CI does.
7. **Records**:
   - FINDINGS: RWF-158 and RWF-159, and an append to RWF-156;
   - a note appended to ADR 0010 on BL-111's proposed decision;
   - OPEN-DEBTS, the backlog (BL-113's scope), progress and the scorecard.

## Boundaries

### Do not touch

- `src/`: the analyzer's behaviour. The patches are applied only to
  measure.
- BL-111's proposed decision text in ADR 0010 (append only), and
  BL-094's pending decision.
- `.github/workflows/ci.yml`'s Node matrix.
- Other tasks' worktrees and branches.

### STOP conditions

- A route is live on a release CI runs and a fix would need the owner's
  BL-111 decision: register it, keep it as an open-soundness-defect
  record, and report it prominently. Do not fix it here.
- A BL-111 record cannot be made correct on every CI release without
  changing its expected verdict to a wrong one: stop, `NEEDS_DECISION`.

## Acceptance criteria

- [ ] `scripts/bl114-loader-inventory-releases/` reproduces the inventory
      on any installed release, and `releases.md` records the four
      releases' hits compared with v22.11.0's.
- [ ] Each live route is bounded by release, with a source-level reason.
- [ ] RWF-158 has open-soundness-defect records whose ground truth is
      asserted per release, and a release outside the measured table fails.
- [ ] BL-111's `inherited-read.source-*` cases pass on v20, v22 and v26.
      `npm run test:oracle` passes under v20.20.2, v22.11.0 and v26.12.1.
- [ ] BL-111's three patches are measured against RWF-158's records.
- [ ] FINDINGS, ADR 0010 (append), OPEN-DEBTS, the backlog, progress and
      the scorecard are updated.
- [ ] `src/` is unchanged on the branch.

## Gates

The full set in `AGENTS.md` § I, unrelaxed, on the local v22.11.0.
`npm run test:oracle` is also run under v20.20.2 and v26.12.1 (CI's
releases). No analyzer change, so the graph, proof and verdict
differentials are zero by construction (`node scripts/differential.mjs`
confirms it). The validation baseline is D-09's six.

## Report

In the format of `AGENTS.md` § J. Add the release table and RWF-158
prominently, as a live false `NOT_AFFECTED` on CI's Node 20.
