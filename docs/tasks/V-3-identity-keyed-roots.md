# V-3 — Identity-keyed roots; an unmaterialized symbol is incompleteness; name-lookup census gate

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: V-3
- **Branch**: v-3-identity-keyed-roots
- **Base SHA**: 5302d024f67f3965a9190358eaa7207819df0c58
- **Commits**: (filled in by the last commit)
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
