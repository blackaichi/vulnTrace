# BL-111 — Design: Node's own loader writes its lookup arrays through replaceable builtins

## Status

- **Status**: READY_FOR_REVIEW (report verdict `NEEDS_DECISION`: the project
  owner decides ADR 0010's "Proposed decision — BL-111")
- **Backlog ID**: BL-111
- **Branch**: `bl-111-loader-writes-builtins`
- **Base SHA**: `71c62e00cace54d72f04b9891e0e14b91cfa81a5` (BL-110's merge, PR #119)
- **Commits**:
  - `docs(tasks): BL-111 task file — design: Node's own loader writes its state through replaceable builtins (RWF-156)`
  - `test(BL-111): the loader's inherited reads and writes, inventoried from Node's own source and against real Node; three closure-wide rules as patches, measured`
  - (this commit) `docs(BL-111): ADR 0010 proposed decision — (B) a closure-wide rule or (C) a trust boundary; RWF-156 widened, the independent audit, debts, backlog (BL-113, BL-114), progress, scorecard`
- **Superseded by**: —

## Project context

Lanes C and A. RWF-156 (found by BL-096's independent audit, rounds 2–4)
is a live false `NOT_AFFECTED`, pre-existing on `main`. A module that
installs one of the following receives Node's own loader state and
redirects a later `require`:

- an index or `paths` setter on `Object.prototype`;
- a Proxy as `Array.prototype`'s [[Prototype]];
- an `Array.prototype.constructor` whose species is a Proxy;
- an `extensions` or `cache` setter.

That state is the combined lookup array, a `Module`'s `paths`, and the
`require.extensions` and `require.cache` registries. The program uses none
of it. Six oracle records in `tests/oracle/bl096-module-paths-read-only.*`
hold it open. BL-110's allow-list over the uses of the list cannot see it,
because there is no use.

The backlog row names the options to weigh:

- a closure-wide fact, "a loaded file may define an accessor on a builtin
  prototype under any name, change its [[Prototype]], or store its
  `constructor`", which widens the closure. That fact is complete only as
  the escape row's relation (ADR 0008, BL-081's decision record), which is
  not certified (BL-094's proposed decision is pending).
- a narrower fact over the stores that real Node's loader writes can
  reach, measured against them.

### Premises (AGENTS.md § D) — to verify before relying on them

- **"Only accessors, [[Prototype]] changes and `constructor` stores
  matter."** Assumed by the row; to be measured. Node's loader may also
  read a DATA property by inheritance (a prototype-pollution gadget),
  which a plain data store on `Object.prototype` would set. The row's
  predicate would miss that.
- **"The routes are the ones RWF-156 lists."** To be measured by an
  inventory of the loader's own JavaScript (`process.binding("natives")`
  exposes it offline), not taken from the audit's examples.
- **"314 of 450 packages have an escaping store."** BL-096's census (an
  assignment-only lower bound). To be re-measured for each candidate rule.
  The cost that decides is the corpus verdict differential, not a package
  count.
- **Node versions.** Only v22.11.0 is installed locally, and CI runs Node
  20 and 26. The loader's code differs by version, so an inventory is a
  claim about v22.11.0 unless measured on more.

## Task

### Problem

The module-load closure is called complete when every loaded file's own
loader constructs are accounted for. Node's loader runs JavaScript that
reads and writes ordinary objects and arrays. A loaded file that changes
what those reads and writes do (an accessor, a Proxy, a species, possibly
a data property) changes which module a later `require` loads, with no
loader construct in any file.

### Why it matters

Soundness: each case is a live false `NOT_AFFECTED`. Defect class B: the
analyzer assumes Node's loader runs over Node's own builtins.

### What to do

This is a decision task. It measures and recommends, and changes no
analyzer behaviour in `src/`.

1. **Inventory**, from Node v22.11.0's own loader source and against real
   Node: every operation in the CommonJS and ES module loaders, and in the
   package.json reader, that can run code a module installed, or read a
   value a module stored, on an object the loader creates or receives.
   Classify each by the store that reaches it:
   - an accessor on a builtin prototype;
   - a [[Prototype]] change;
   - a species or `constructor` store;
   - a DATA property read by inheritance (a gadget).

   Confirm each class end to end with an oracle case in BL-092's decoy
   setup, kept as an open-soundness-defect record.
2. **Prototype** the candidate closure-wide rules as patches under
   `scripts/bl111-loader-writes-options/`, from the broadest to the
   narrowest:
   - (A) any store the escape row counts as one onto an object not proven
     the program's own;
   - (B) only the store forms the inventory shows can reach the loader;
   - further tiers as the measurements suggest.
3. **Measure** each prototype, each reported separately:
   - the inventory's oracle cases, where no case real Node calls may be
     `NOT_AFFECTED`;
   - the other suites, counting each control that loses precision;
   - the graph, proof and verdict differentials over the corpora;
   - a census over the 3,838 `node_modules` files.
4. **Recommend.** Append a "PROPOSED — requires project-owner decision"
   section to ADR 0010.
5. **Independent audit** (WORKFLOW § 1.5).
6. **Records:** FINDINGS (RWF-156 append, and any new finding), OPEN-DEBTS,
   backlog (the implementation task), progress and the scorecard. Report
   `NEEDS_DECISION`.

## Boundaries

### Do not touch

- The analyzer's committed behaviour (`src/`). The prototypes are
  patches, applied only for measurement.
- BL-094's pending decision on the escape row, and the escape row itself.
  An option may consume its relation but not change it.
- Other tasks' worktrees and branches.

### STOP conditions

- A prototype gives `NOT_AFFECTED` where real Node calls the target: do
  not recommend it without its fix.
- The inventory finds a live false `NOT_AFFECTED` outside RWF-156's
  mechanism: register it and report it prominently.
- Every sound option costs a large share of corpus proofs. Report the
  trade-off as the owner's decision, with no recommendation forced.

## Acceptance criteria

- [x] The inventory lists, for Node v22.11.0, every loader operation of
      the classes above with its source location, and each class has a
      real-Node oracle case.
- [x] Each option is a patch applicable to the base, measured as above
      and reported separately.
- [x] ADR 0010 carries an appended PROPOSED section.
- [x] RWF-156 is updated by an append, and every new finding is
      registered.
- [x] `src/` is unchanged on the branch.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: no analyzer change,
so the branch differential is zero by construction; the validation
baseline is D-09's six.

## Report

In the format of `AGENTS.md` § J, verdict `NEEDS_DECISION`.

## Corrections

**2026-10-26.**
- **The row's premise that only accessors, [[Prototype]] changes and
  `constructor` stores matter is measured false.** The loader also reads
  data properties by inheritance, and `Object.prototype.source`, a plain
  primitive store, replaces an ES module's source in real Node. It is not
  live with the analyzer on v22.11.0, and the inventory records it.
- **"Further tiers as the measurements suggest"** became (B′), the
  literal-name rule. It was measured only to price what the computed-key
  clause costs, and it is unsound.
- **The trust boundary (C)** is added as an option because the sound rules
  cost half of the real-world proofs (STOP condition 3: no recommendation
  is forced).
- **The independent audit (one round, `BLOCKED`, partial).** The auditor's
  run stopped before it ran any reproductions. Its main finding, from
  reading the code, is that the prototype rules recognise storing builtins
  by name, so an indirectly reached one is missed. A follow-up measurement
  confirmed three such forms as live false `NOT_AFFECTED`s on the base and
  under `B.patch`. At the project owner's direction the task is finished as
  a write-up:
  - the ADR, FINDINGS, OPEN-DEBTS, `results.md` and BL-113 state that the
    prototypes are not sound detectors;
  - they state that a sound (B) identifies storing builtins by identity;
  - the measured forms are described, not committed as fixtures.

