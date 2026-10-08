# V-3 — Identity-keyed roots; an unmaterialized symbol is incompleteness; name-lookup census gate

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: V-3
- **Branch**: v-3-identity-keyed-roots
- **Base SHA**: 5302d024f67f3965a9190358eaa7207819df0c58
- **Commits**:
  - `055b94b` docs(tasks): V-3 task file — identity-keyed roots, unmaterialized symbol, name-lookup census
  - `a95fdf3` test(V-3): identity-keyed roots and the name-lookup census — real-Node, integration and Foundation tests
  - `9b30775` fix(V-3): materialize every entrypoint root by declaration position (PRM-25, PRM-31)
  - (this commit) docs(V-3): records — PRM-25 and PRM-31 fixed, RWF-079..081, plan § 5a, debts, backlog, progress, scorecard
- **Superseded by**: —

## Project context

Third task of lane V of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 10),
after [`V-1`](V-1-site-b-closure-corroboration.md) (PR #86) and
[`V-2`](V-2-traversal-truncated-blocks-negative-proof.md) (PR #87, merged
2026-10-08). `V-4` and `E-3` depend on it.

The specification is
[ADR 0011](../adr/0011-negative-proof-corroboration.md): invariant V
(§ 1) -- a negative proof is built only from facts keyed by exact
identity, declaration identity (file + source position) for graph nodes --
and its predicate 4, "every entrypoint root is materialized by declaration
position, and a configured `symbol` that does not materialize is root
incompleteness"; § 2's name-keyed-lookup census; § 3's fail-closed row
"configured symbol not materialized → `identity_unresolved`,
`entrypoint_root_incomplete`"; § 4's third modeled exception (a `{file,
symbol}` entrypoint the export map attributes exactly keeps its narrowed
root); § 6's reopened decision VT-205 / P0-Z ("a `{file, symbol}` root has
nothing to be incomplete about"); and § 8's V-3 row. What V-1 and V-2 left
for V-3 is in REMEDIATION-PLAN § 5a, "V-1 additions" (the census records
`graphPackageInstances` as `refuse-only` in effect, with its caveat).

Finding closed: PRM-25 (`tests/validation/FINDINGS.md`; reproductions
`symbol-entry-unmaterialized`, `symbol-entry-name-match`,
`docs/audits/2026-09-premise-sweep-round-1.md` § 3 and § 4).

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

- **True, measured** (real Node v22, the oracle harness): PRM-25 is live in
  both directions. With `{file: "src/index.js", symbol: "main"}`:
  - `module.exports = { main: run }`, `run` calls the target: Node calls
    it; VulnTrace answers `NOT_AFFECTED`, family C
    (`symbol-entry-unmaterialized`: no node is named `main`, and the
    symbol branch reports the derivation complete).
  - the same plus `function helper() { function main() {...} }`: the
    nested decoy is the root; a false `NOT_AFFECTED` when only `run`
    calls the target, a false `AFFECTED` when only the decoy does
    (`symbol-entry-name-match`).
- **New, measured: the same defect without a symbol.** A plain file
  entrypoint whose export binds `run`
  (`module.exports = { main: run, helper }`), next to a nested
  `function run` inside `helper`: `entrypointSourceNodes` roots the first
  node NAMED `run` -- the nested one -- and the requirement for `main` is
  satisfied by that same name, so the derivation is called complete and
  family C certifies the real `run`'s target unreachable: a false
  `NOT_AFFECTED` that Node refutes. Same mechanism (identifier text
  reaches a root authority, defect class A), same function; registered as
  `RWF-079` and closed here, since predicate 4 covers every root, not
  only a symbol's.
- **True** (code read): the name-keyed lookups in `entrypointSourceNodes`
  are the symbol lookup, the candidate-name roots and the
  requirement-satisfaction check (ADR § 2's `1105`, `1149`, `1190`, at
  today's lines 1311, 1355, 1395); `findExportNodeInFile`'s synthetic
  fallback (`318`, ADR's `303`) is gated by a test-only flag.
- **True** (measured, module-model probe): an export written inside a
  function body (`function setup() { exports.main = run }`) produces a
  binding whose requirement names `run`; the nested `run` is the value,
  yet a name lookup finds the module-scope `run` first. A root resolved
  by name, even restricted to module scope, is the wrong node there.
- **To check while implementing**: ADR § 2's census line list against
  today's code (`module-model.ts:6004, 6100`; `call-graph.ts:1694`); § 8's
  claim that the two VT-205 unit tests in `verdict.test.ts` need a real
  file.

## Task

### Problem

A configured entrypoint symbol, and every export root of a file
entrypoint, is found by comparing a graph node's `name` with a string.
A name that matches nothing, or matches another declaration of the same
spelling, yields an empty or wrong root set, and an exhaustive search of
the wrong space is reported as a complete proof. A configured symbol that
does not materialize is reported as complete by construction.

### Why it matters

Soundness: a false `NOT_AFFECTED` (family C over a wrongly rooted
subgraph) and a false `AFFECTED` (a path from a decoy root Node never
calls). Defect class A (AGENTS.md § F): identifier text reaches a root
authority.

### What to do

1. **Tests first, failing on the base**: real-Node oracle cases for
   PRM-25 (both directions) and RWF-079, with both controls; unit tests
   over `entrypointSourceNodes` through `buildFinding`; the two VT-205
   tests in `verdict.test.ts` over a real file.
2. **Identity-keyed roots.** `entrypointRootCandidates` resolves each
   requirement's provenance names LEXICALLY, from the export write's own
   site (the binding declaration that scope owns, never a same-named
   declaration elsewhere), to the position of the callable that
   declaration denotes; a name the site does not resolve to a callable
   declaration, a site inside a function body, and the exported-name
   fallback (no provenance, RWF-011) materialize nothing. The widening
   candidates of a withdrawn export resolve their identifiers the same
   way. `entrypointSourceNodes` then roots and checks materialization by
   POSITION only.
3. **A configured symbol** is rooted through the export bindings whose
   canonical name is the symbol, by the same requirements; a symbol no
   binding publishes, or whose requirement does not materialize, is root
   incompleteness (`unresolved_entrypoint_root_candidate`, reason
   `entrypoint_root_incomplete`); a forwarding, computed-name or
   re-export incompleteness that could publish the symbol applies to it.
4. **The census**: a Foundation test lists every expression in
   `src/analysis/` and `src/code-intelligence/` that finds a graph node or
   indexed function by comparing its `name`, or a package instance by its
   package name, each with its declared direction; a new one, a removed
   one or a changed one fails. Registered in
   `src/testing/foundation-invariants.ts`.
5. Records: FINDINGS (PRM-25 fixed, RWF-079 found and fixed),
   REMEDIATION-PLAN § 5a "V-3 additions", ADR 0011 § 8 notes if needed,
   OPEN-DEBTS, backlog, progress, scorecard.

## Boundaries

### Do not touch

- Target attribution (`findExportNodeInFile`, `mapExportsToFunctions`,
  PRM-26): lane E (`E-1`). The census records it as open.
- V-4's scope (branded proof-input types, mutation tests of the
  corroboration checks).
- Family A, B and C's own guards.

### STOP conditions

- A verdict that moves toward `NOT_AFFECTED` on any corpus case or
  oracle case, other than PRM-25's false `AFFECTED` direction.
- A precision cost on the corpora that is not explained by a named shape.

## Acceptance criteria

- [ ] PRM-25: both directions answer the sound verdict against real Node
      (the unmaterialized symbol `UNKNOWN`, `entrypoint_root_incomplete`,
      or the correct verdict; the decoy never rooted), with controls.
- [ ] RWF-079: the file-entrypoint decoy no longer satisfies a root
      requirement; the sound verdict against real Node, with controls.
- [ ] `entrypointSourceNodes` performs no name-keyed node lookup.
- [ ] A configured symbol that does not materialize is root
      incompleteness, on a real file and on an unreadable one.
- [ ] The name-lookup census is a Foundation test, registered, and fails
      on a new, removed or redirected lookup.
- [ ] A mutation restoring a name-keyed root lookup is caught by a named
      test.
- [ ] The VT-205 tests run over a real file.
- [ ] Differentials reported; validation baseline unchanged.
- [ ] Records updated.

## Gates

The full set in `AGENTS.md` section I, unrelaxed. Expected: no verdict
toward `NOT_AFFECTED` on the corpora; the validation baseline (`RWB-03`,
`RWB-05`, `RWB-09b`, `VAL-002`, `VAL-003`) unchanged.

## Report

In the format of `AGENTS.md` section J (`docs/WORKFLOW.md` § 5).

## Corrections (task V-3, 2026-10-08)

Measured while implementing:

1. **"RWF-079, new" was false: it is PRM-31.** The file-entrypoint decoy
   the premises call new is `PRM-31` (open; the round-1 reproduction
   `entry-root-decoy`, a class method witnessing
   `exports.run = registry.impl`), which the plan assigned to `E-3`. ADR
   0011 § 2 assigns the same lookup (`1190`, the witness by node name) to
   this lane, and predicate 4 cannot hold while it stands, so V-3 closes
   PRM-31; `E-3` keeps PRM-32. `RWF-079` is used instead for a defect V-3
   did find and did not fix: a whole-module export of an opaque value
   emits no root requirement, and the property export it overwrites still
   witnesses the name (backlog `BL-053`, P1). Acceptance criterion 2 reads
   PRM-31.
2. **The exported-name fallback is no longer a root or a witness.**
   `exp.localName ?? exp.exportedName` rooted and witnessed by the public
   name; RWF-011 already denies it provenance, and E-3's row says "may
   widen but not witness". Under V-3 it does neither: a position is the
   only root, and the exported name declares none. Measured cost: 0 on the
   corpora; `exports.main = registry.impl` next to a `function main` is
   `UNKNOWN` (it was a false `NOT_AFFECTED`).
3. **An export written inside a function body resolves no name** (step 2
   says so; the measurement behind it): the module model collects such a
   write's names by a whole-file, name-keyed walk, so a name resolved at
   the write's site may not be the one the walk read. Fail-closed. Cost:
   `function setup() { function run() {...}; exports.main = run } setup()`
   is `UNKNOWN` where Node does call `run` (the oracle case expects
   `UNKNOWN`; resolving the nested write lexically gave the precise
   `AFFECTED` there, measured, but the same rule would root the nested
   `run` when nothing calls `setup` and the export is never written -- an
   `AFFECTED` path Node need never take -- so it was not taken). The
   withdrawn widening resolves its identifiers lexically from the
   identifier itself, and only outside function bodies. AS FIRST WRITTEN
   this item said such a write's binding "fails closed instead" -- false
   for a whole-module binding, which has no requirement; see "Independent
   audit" below, finding 1.
4. **The census has a fourth direction, `open`.** ADR 0011 § 2 lists
   three (`widen-only`, `refuse-only`, `test-flag-only`); PRM-26's
   `mapExportsToFunctions` lookup and its callers are none of them, so
   each is listed `open` with its finding and the task that removes it
   (E-1), rather than called sound. ADR § 2's line list, checked against
   today's code, is in REMEDIATION-PLAN § 5a, "V-3 additions".
5. **The two VT-205 unit tests** in `verdict.test.ts` needed a real file,
   as ADR § 8 said; they read a temporary one whose declarations sit where
   the synthetic nodes say. A third test there pins the unreadable-file
   rule.
6. **A TypeScript overload set** was rooted at its first signature by the
   name lookup (no body, so no edges); `lexicalDeclarationOf` treats the
   set as its implementation.
7. **Real-Node cases: twelve, then twenty-one with the audits', not seven**: the five PRM-25 shapes beyond
   the two round-1 ones, PRM-31's round-1 reproduction and its variants,
   each measured wrong on the base.

## Independent audit (fresh context), and what changed

First round, on 49320df: **BLOCKED**. Each finding, re-measured here
against real Node (`tests/oracle/v3-identity-keyed-roots.test.ts`, the
"V-3 audit" cases) and through `buildFinding`
(`verdict.identity-keyed-roots.integration.test.ts`, "shapes its
independent audit found"):

1. **Blocking, a regression of the first fix: a deferred whole-module
   write lost its root silently.** `function setup() { module.exports = {
   main: run } } setup()` (and a class static block) was `AFFECTED` on the
   base and family-C `NOT_AFFECTED` on 49320df: the withdrawn whole-module
   binding has no requirement, and the widening dropped the identifier
   inside a function body without a word. Fixed: whatever the widening
   cannot name a callable for -- an identifier inside a function body, one
   with no single callable declaration, a refused one, a non-identifier
   value that may be callable, a spread or accessor property -- is root
   incompleteness (`unresolved_entrypoint_root_candidate`, with its
   location), never nothing; a method property is rooted at its position.
   Those shapes are now `UNKNOWN` -- a precision cost against the base's
   `AFFECTED` (the root it found by spelling), stated in the cases.
2. **An ESM default export with no recorded local** (`export default run`,
   `export default function () {}`, `export default () => ...`) emitted no
   requirement, so `{file, symbol: "default"}` and a plain ESM file
   entrypoint were family-C `NOT_AFFECTED` over a target Node calls, on the
   base too. Fixed in `entrypointRootCandidates`: such a binding requires a
   root, read off the `export default` statement itself (an identifier is a
   provenance name; a function or class is its position).
3. **A refused (reassigned) binding was witnessed by its stale
   declaration**, on the base too (`let main = a; main = b; exports.main =
   main`). Fixed: a refused binding's provenance names neither root nor
   witness; the requirement fails closed. `lexicalDeclarationOf`'s doc no
   longer calls a position "a starting point the search widens from" only.
4. **The census detected one syntactic form.** The scanner now finds a
   name read (`.name`, `?.name`, `["name"]`; `.className` of a class
   owner) that is compared, switched on, handed to a key lookup or put in
   an array, any destructuring of the key, calls of arrow and const
   helpers, and files at any depth; the self-test plants each form. It
   found one unlisted lookup, `findExportedClassMembers`'
   `exportedClassNames.has(fn.memberOf.className)` (`widen-only`: a
   target too many, a false-`AFFECTED` risk). `resolveAliasedValue`'s
   `refuse-only` claim, checked: a match withholds the import-based answer
   and leaves the same-file LEXICAL resolver, which reads no name. The
   header says what is not caught.
5. **`exports.main = run; var run = function () {}`** (Node: `main` is
   `undefined`) became a false `AFFECTED` in symbol mode. Fixed: a
   function value, the model's own position included, roots and witnesses
   only when it is evaluated before the export reads it (a hoisted
   function declaration always is).
6. Documentation overclaims: corrected (items 1, 3 and 4 above; the
   acceptance answers below).

Second round, on 75fa833: **BLOCKED**, three findings, each re-measured
here (the "V-3 audit 2" oracle cases; "shapes its second independent
audit found" in the integration test):

1. **An ESM `export default run` whose `run` the file reassigns** was
   witnessed by the stale declaration -- the refused-binding rule did not
   reach the new default path. Fixed generally: a name the file assigns
   anywhere (over-approximate: any scope, any assignment form
   `isNameAssignedWithin` covers) declares no root and witnesses nothing.
2. **A CommonJS whole-module write republishing the symbol**
   (`exports.main = a; module.exports = { main: run }` conditionally, or
   `run.main = run; module.exports = run`, or through an alias) was
   dropped by the symbol filter as the `default` export: family-C
   `NOT_AFFECTED` over a target Node calls, as on the base. Fixed: in
   symbol mode (any symbol but `default`), a CommonJS whole-module binding
   makes the symbol's roots incomplete -- the symbol is `X[symbol]`, which
   no binding of it attributes.
3. **A withdrawn symbol binding rooted the file-wide widening**, every
   other export's values included: a false `AFFECTED` the first fix
   introduced (`if (c) exports.main = safe-caller; exports.other =
   parse-caller`). Fixed: a withdrawn symbol binding is root
   incompleteness; the widening roots nothing in symbol mode. A precision
   cost against the base's (correct) `NOT_AFFECTED` there.

Non-blocking, recorded: the second audit's finding 4 -- `exports.main =
a; module.exports = make()` with no `default` binding recorded at all --
is another RWF-079 shape (added there).

Third round, on 9312350: **CERTIFIED**. 104 real-Node probes on the
branch and the base: none worse on the branch, no false `AFFECTED`, no
hole found in the three new rules. Its non-blocking findings, all the
same on the base: `this.main =` / an alias of `exports` (PRM-32, open,
E-3); a whole-module write through an alias of `module` (recorded); an
export written by another module (registered as RWF-081, E-4); a later
string key or getter in an export literal, and a spread in a whole-module
literal (PRM-27, open, E-1); an ESM destructured export (registered as
RWF-080, `BL-054`); the properties of a whole-module value for a plain
file entrypoint (added to RWF-079, with the modelling question it raises,
for the project owner). Its one comment point (the symbol branch's "an
export-object mutation" means one the model detects) is corrected.

## Acceptance criteria, answered

- PRM-25, both directions, sound against real Node with controls: **yes**
  (the `symbol.*` cases).
- PRM-31 (correction 1): **yes** (the `file.*` cases).
- `entrypointSourceNodes` performs no name-keyed lookup: **yes** (the
  census asserts it).
- An unmaterialized symbol is root incompleteness, on a real file and an
  unreadable one: **yes** (for `default` since the audit's finding 2).
- The census is a Foundation test, registered, failing on a new, removed
  or moved lookup: **yes** (`VT-INV-V-corroboration`).
- A mutation restoring a name-keyed root lookup is caught by named tests:
  **yes** (fifteen mutations, each caught by a named test; listed in the pull request).
- The VT-205 tests run over a real file: **yes**.
- Differentials reported; validation baseline unchanged: **yes**.
- Records updated: **yes**.

