# BL-114 — Repeat BL-111's loader inventory on Node 20 and 26 (CI's releases)

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-114
- **Branch**: `bl-114-loader-inventory-node-releases`
- **Base SHA**: `3cfe09d1f7541c14ac8f0ac67b062bc94dc587d7` (BL-111's merge, PR #120)
- **Commits**:
  - `docs(tasks): BL-114 task file — repeat BL-111's loader inventory on CI's Node releases; require(esm) makes the inherited source read live (RWF-158)`
  - `test(BL-114): BL-111's loader inventory by Node release; open records for RWF-158 and RWF-160 and a v20 trySelf route of RWF-156; BL-111's records read the running release's ground truth (RWF-159)`
  - (this commit) `docs(BL-114): ADR 0010 note on BL-111's proposed decision, debts, backlog (BL-113 scope, BL-115), progress`
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

## Corrections

**2026-10-27.**
- **More routes than the row asked about.** The repeated inventory found
  two inherited reads besides `source`, and both were measured:
  - v20's `trySelf` reads `data` / `path`: live with getters, and
    `NOT_AFFECTED` with the analyzer. It is RWF-156's class, so it was
    appended there with an open-soundness-defect record, not given a new ID.
  - `conditions` (v22.23.4 and later): live in real Node, but not with the
    analyzer, which already answers `UNKNOWN` for a load through
    `require.resolve` with options. It has no record.
- **BL-111's scripts were extended, not only reused.**
  `probe-inherited.cjs` takes an opt-in `--require-esm`, and `setup.sh`
  writes the two ES modules it needs. Without the flag the workload is
  BL-111's, unchanged.
- **More releases than the four named.** The release table also measured
  the first releases with `require()` of an ES module unflagged (v20.19.0,
  v22.12.0), each line's first release (v24.0.0, v26.0.0), and the v24
  edge (v24.11.1 / v24.12.0, bisected).
- **`tests/oracle/node-release-routes.test.ts`** was added. It pins the
  table's version comparison, because a wrong comparison would assert a
  ground truth real Node never gave.
- **"BL-111's records pass on v20, v22 and v26"** is answered for
  v20.20.2, v22.11.0, v22.23.4, v24.22.1 and v26.12.1.
- **The independent audit, round 1: `BLOCKED`.** It found that BL-114 had
  mislabelled one inventory access.
  - **The access:** `get Object.prototype paths @ Module.load`, on
    v22.23.4, v24 and v26. BL-114 had described it as "the property
    RWF-156's setter already reaches".
  - **What it is:** `this.paths ??= …` keeps an inherited lookup list, so
    a plain data store redirects every later load. That is a live false
    `NOT_AFFECTED` on CI's Node 26.
  - **Registered as RWF-160** (the route is a plain data read, not a
    setter, so it gets its own ID), with three open-soundness-defect records
    and a control, and a `RELEASE_ROUTES` entry. Gadget G3 measures it, and
    v22 was bisected (opens at v22.15.0).
  - **Patches:** measured under BL-111's three patches.
  - **Records:** the ADR 0010 note, OPEN-DEBTS, BL-113's scope and the
    backlog.

  The audit's documentation finding was fixed as well: v20's `require()`
  route goes through `getModuleJobForRequire` (`esm/loader.js:439`), not
  `#createModuleJob`. Its other findings confirmed RWF-158's release
  table, the patch results, `routeLive`'s design and that `src/` is
  unchanged.
- **RWF-160's define record** defines `paths` as writable. With a
  non-writable inherited `paths`, `makeRequireFunction`'s assignment of
  `resolve.paths` throws ("Cannot assign to read only property 'paths'",
  `helpers:360` on v26.12.1). The load then fails, and real Node does not
  call the target (measured). Its recorded observation was measured: `unknownEdges` 4, one
  more than the plain store's 3, for the `defineProperty` call.
- **The independent audit, round 2: `CERTIFIED`** (HEAD `15ca8c6`).
  - **Verified:** RWF-160's records on base `src/` under v22.14.0,
    v22.15.0, v26.12.1 and v20.20.2. Also the bisected edge against real
    Node, the patch results, `routeLive`, and that `src/` is unchanged.
  - **One should-fix, applied:** `inherited-paths.data-store`'s
    description said `helper.js` "keeps the inherited list as its own".
    It reads the inherited list: `??=` assigns nothing.
  - **Notes:** `esm/translators`' `module.paths ??=` does not widen
    RWF-160 in what the audit measured. No other inherited read on CI's
    releases redirects a load in what it re-checked.
  - **Three more store forms of RWF-160** were measured live on v26.12.1:
    `Object.assign` onto `Object.prototype`, a computed key reached
    through `Object.getPrototypeOf(module.exports)`, and the store made in
    another module. RWF-160's section now says its records are a sample,
    and BL-113's sweep covers them.
