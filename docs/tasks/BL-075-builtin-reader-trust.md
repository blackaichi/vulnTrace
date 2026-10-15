# BL-075 — A builtin reader is no reader when the builtin is reachable without its name or patched by another module

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-075
- **Branch**: `bl-075-builtin-reader-trust`
- **Base SHA**: `0113347f7c4e746a00d3d46f67a571fe5b1f98f0` (BL-074's merge, PR #104)
- **Commits**:
  - `docs(tasks): BL-075 task file — a builtin reader is no reader when another module can replace the builtin`
  - `test(BL-075): no builtin is trusted with an export object, against real Node — RWF-104, RWF-112`
  - `fix(BL-075): an export object handed to a builtin is handed to code — RWF-104, RWF-112`
  - (this commit) `docs(BL-075): records — RWF-104 and RWF-112 fixed, RWF-110, 111, 113..115 found, ADR 0009 decision record (option (a)), D-09 (RWB-09a), plan § 5a, debts, backlog, progress, scorecard`
- **Superseded by**: —

## Project context

Lane E (ADR 0009 § 1; `docs/REMEDIATION-PLAN.md` § 5a). E-1 built the
export write set (`exportWriteSet`, `classifyObjectUse`,
`classifyHelperCall` in `src/code-intelligence/module-model.ts`). A use of
an export object that hands it to code makes the file's names
un-enumerable (`unenumerable`: attribution withdrawn); a use that only
reads it (`read`) does not. Three places trust that an ambient builtin
only reads what it is handed:

- `isBuiltinReaderCall`: `Object.<reader>(E)` (`OBJECT_READERS`),
  `Reflect.<reader>(E)` (`REFLECT_READERS`), and
  `<Builtin>.prototype.<hasOwnProperty|propertyIsEnumerable|isPrototypeOf>.call(E, …)`,
  directly or through a `const`-like alias;
- `isInertUse`'s `instanceof` arm: `E instanceof <Builtin>` runs the
  builtin's `Symbol.hasInstance`;
- the alias census (`classifyHelperCall` reused for an object later
  exported, `Object.keys(api)`).

Each is guarded only by `fileMayPatchBuiltins`, which looks at THIS file
and only at writes that spell the builtin's ambient name or the global
object.

**RWF-104** (found by E-1's audit, round 3; `tests/validation/FINDINGS.md`):
a builtin reached without its name (`({}).constructor.keys = …`,
`exports.constructor.keys = …`) or replaced by another module makes the
"reader" write the export. A live false `NOT_AFFECTED`, family C,
pre-existing.

**The decision.** The project owner was offered (a) drop the reader
allow-lists (an export object handed to a builtin is handed to code), or
(b) decide builtin patching over the module closure, with (a)
recommended unless (b) wins on measured precision by a clear margin, and
gave the go with that recommendation. As BL-063, BL-064 and BL-074 did,
this task records the choice as a decision record in ADR 0009 for the
owner to confirm by merging.

### Premises verified before this file was written (AGENTS.md § D)

Measured on the base `0113347` with the real-Node oracle harness (Node
v22.11.0), `wrap/index.js` writing `exports.run = safeOp`, the entry
calling `require("wrap").run("x")`:

1. **RWF-104 reproduces, and is wider than recorded.** Real Node calls
   `parse`; the analyzer answers `NOT_AFFECTED`, for: the two recorded
   same-file spellings (`({}).constructor.keys = function (o) { o.run =
   dangerousOp; … }`, the same through `exports.constructor`); a sibling
   module `wrap` loads that replaces `Object.keys` by name, or through
   `({}).constructor`; and **the entry itself** replacing `Object.keys`
   before it loads `wrap` -- a module outside `wrap`'s own closure. So
   option (b)'s "module closure" is the wrong set: builtins are shared by
   every module of the process, and the patcher need not be in the
   closure of the file it affects.
2. **The masked neighbours.** The same replacement of `Object.assign`,
   `Object.defineProperty` and `Object.freeze`, of `Object[Symbol.hasInstance]`,
   of `Object.prototype.hasOwnProperty`, and an accessor another module
   installs on `Object.prototype` (which intercepts a plain
   `exports.run = …`) were all `UNKNOWN` on the base, through the call
   graph's `escaped_value` / `unsupported_receiver_binding` backstop, not
   through the export model. Wrong at the export model, right at the
   verdict.
3. **A call-graph-side defect of the same root, out of this task's
   scope.** `({}).constructor.keys = function (o) { dangerousOp(o); … };
   Object.keys({});` (same file), the same in a sibling, and
   `function install(O) { O.keys = f; } install(Object);` in a sibling:
   real Node calls `parse`, the analyzer answers `NOT_AFFECTED`. No export
   object is involved: the call graph takes `Object.keys(…)` for the
   builtin, and A-3a's assignment escape row sees a patch only when it
   spells an ambient builtin's name. That is ADR 0008's invariant (lane A),
   not ADR 0009's; it is registered as a new finding and backlog row, not
   fixed here (§ 2 of `docs/WORKFLOW.md`: not required for this task, and
   its fix is a design decision of its own).

## Task

### Problem

The export census takes three builtin operations for reads of an export
object on the strength of this file's text alone. Builtins are shared by
every module of the process; any module -- this file through a spelling
the census does not see, a sibling, the entry, another package -- can
replace them before the operation runs. The replaced function receives the
export object and can write any name onto it, and the census still
attributes the name to this file's own write.

### Why it matters

Soundness: a live false `NOT_AFFECTED` (family C). Defect class B (the
binding `Object` is right; the value assumed for `Object.keys` is not what
real Node holds).

### What to do

1. Failing first: oracle cases for every live spelling of premise 1 and
   the masked neighbours of premise 2 (`tests/oracle/`), with E-1's loud
   fixture and controls, failing on the base.
2. Measure the precision cost of option (a) over `node_modules` and the
   corpora (a per-task corpus script, as BL-074's), against the base. (b)
   can save at most what (a) costs; if (a)'s cost does not leave room for
   (b) to win by a clear margin, take (a) without building (b).
3. Option (a): no export object handed to a builtin is read-only. The
   reader arm of `classifyHelperCall`, the `instanceof <Builtin>` arm of
   `isInertUse`, and the alias census's reader exemption stop trusting the
   builtin. Keep only what holds whatever any module did: the operator
   uses (`typeof`, `!`, a strict comparison, a condition, `k in E`, `C
   instanceof …` with the export object on the right is its own censused
   method).
4. Update the unit tests that pinned the old trust; each one inverted is
   grounded under real Node or labelled a precision cost.
5. Records: FINDINGS (RWF-104 status update; the call-graph finding as a
   new RWF), ADR 0009 decision record, REMEDIATION-PLAN § 5a "BL-075
   additions", OPEN-DEBTS, backlog, progress, scorecard.

## Boundaries

### Do not touch

- The call graph's builtin table and escape row (`builtin-callables.ts`,
  `call-graph.ts`): premise 3's defect is registered, not fixed.
- Other worktrees and branches.

### STOP conditions

- (a)'s measured cost is large enough that (b) could plausibly win by a
  clear margin: stop, report the numbers, `NEEDS_DECISION`.
- A fix requires changing the call graph or the proof families.
- The independent audit blocks on something outside the export model.

## Acceptance criteria

- [ ] Every live spelling of premise 1 has an oracle case that fails on
      the base and answers `UNKNOWN` on the branch, with real Node calling
      `parse`.
- [ ] Each masked neighbour of premise 2 has an oracle case asserting
      `UNKNOWN`.
- [ ] The unpatched control (`Object.keys(exports)` with nothing replacing
      it) is measured and its verdict on the branch is reported as a
      precision cost if it moves.
- [ ] No export object handed to an `Object` / `Reflect` reader, a
      prototype reader's `.call`, or the right of `instanceof <Builtin>` is
      censused as a read.
- [ ] The precision cost of (a) is measured and recorded, with the reason
      (b) was or was not built.
- [ ] Premise 3 is registered in FINDINGS with a backlog row.
- [ ] Graph, proof and verdict differentials reported separately.
- [ ] Independent audit run; its verdict is in the pull request.

## Gates

The full set in `AGENTS.md` section I, unrelaxed. The validation baseline
is the five known failures of OPEN-DEBTS D-09.

## Report

In the format of `AGENTS.md` section J (`docs/WORKFLOW.md` § 5).

## Corrections and outcome (appended by the last commit)

- **A premise of "What to do" step 3 was false.** It kept "`C instanceof
  …` with the export object on the right" among the uses that "hold
  whatever any module did", and the acceptance criterion said "the right
  of `instanceof <Builtin>`" where it meant the left. On the right, the
  object runs its own `Symbol.hasInstance`, which a plain object inherits
  from `Object.prototype`, writable by any module: RWF-112, a live false
  `NOT_AFFECTED` found by the independent audit (round 1), pre-existing,
  fixed here (`instanceof` is never inert). One narrowing keeps precision:
  a function or base class the file declares, on the right, inherits
  `Function.prototype`'s non-writable, non-configurable one (measured);
  it inherits RWF-114 and RWF-115's open debt (a write reaching the
  function without its name).
- **The precision premise of the decision changed.** Option (a) as first
  implemented lost 0 of 4,774 attributions; with RWF-112 fixed it loses 9
  (none from a builtin reader: each is a load that may load the file back,
  on the right of `instanceof`), 19 before the narrowing. (b) could keep
  none of them, so the choice stands. The cost reaches one validation
  case: **RWB-09a moves `AFFECTED → UNKNOWN`** (semver's `range.js` ↔
  `comparator.js` cycle), a sixth known validation failure recorded in
  OPEN-DEBTS D-09 pending the owner's decision, with backlog `BL-085` to
  restore it. `AGENTS.md` § I and `docs/WORKFLOW.md` § 3 still say five:
  left for the owner's decision, not edited here.
- **Option (b)'s premise was false** ("the module closure"): the entry,
  outside any file's closure, can replace a builtin (RWF-104's correction).
- **Out of scope, registered:** RWF-110 (a builtin replaced without its
  name runs with no call edge; P0, live, lane A; `BL-081`), RWF-111 (the
  define arm's trust; masked; `BL-082`), RWF-113 (`Object.prototype`
  members, methods and non-writable properties; masked; `BL-083`), RWF-114
  (`arguments.callee`; P0, live; `BL-084`), RWF-115 (`new.target`, a
  `constructor` chain; P0, live; `BL-086`). BL-074's audit findings
  RWF-107..109 were missing from the backlog's § 2 map; added.
- **The independent audit** blocked in round 1 (RWF-112, fixed), in round
  2 on the records' "0 of 4,774" (re-measured and corrected; it found
  RWF-114) and in round 3 on the narrowing's comment premise and the
  records' wording (corrected; it found RWF-115, and verified the 9 of
  4,774 independently). Every round found the code change sound: it only
  withdraws attribution.
