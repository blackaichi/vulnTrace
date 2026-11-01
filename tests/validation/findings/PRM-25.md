| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-25 | `vuln-lib` (synthetic fixture) | A configured `{file, symbol}` entrypoint is matched by node-name text; an unmatched symbol still reports the entrypoint root complete | false NOT_AFFECTED and false AFFECTED — see below | **Fixed** (V-3) — see below |

## PRM-25 — A configured `{file, symbol}` entrypoint is matched by node-name text; an unmatched symbol still reports the entrypoint root complete

**Status:** Open
**Failure class:** false NOT_AFFECTED and false AFFECTED
**Defect class:** A
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** V — verdict corroboration

A `{file, symbol: "main"}` entrypoint is matched against AST node names as text rather than through export/root-candidate resolution. When the real exported `main` is never found (`symbol-entry-unmaterialized`), the root is still reported complete and family C certifies the real handler unreachable. When a same-named decoy exists elsewhere in the file (`symbol-entry-name-match`), resolution can land on the decoy and issue a false AFFECTED for code Node never calls through that entrypoint.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-25`) and § 4 (`symbol-entry-unmaterialized`, `symbol-entry-name-match`)`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task V-3, 2026-10-08): Fixed.** A configured symbol is
rooted at the callables the export bindings whose canonical name is the
symbol publish, materialized by DECLARATION POSITION (ADR 0011 predicate
4): each binding's provenance names -- its local and the end of its alias
chain, never the exported name -- are resolved lexically at the export's
own site (`lexicalDeclarationOf`, `named-bindings.ts`) to the callable
they declare, and `entrypointSourceNodes` looks nodes up by that position
only. A symbol no binding publishes, a requirement that does not
materialize, a gap that names no export (`export *`, an export-object
mutation, a computed export name) and an entrypoint file that cannot be
read are root incompleteness (`unresolved_entrypoint_root_candidate`;
`identity_unresolved`, `entrypoint_root_incomplete`, ADR 0011 § 3).

Measured on the base (`5302d02`) against real Node v22
(`tests/oracle/v3-identity-keyed-roots.test.ts`): both round-1 shapes were
live -- `symbol.unmaterialized-name` and `symbol.nested-decoy.safe`
family-C `NOT_AFFECTED` over a target `main()` calls, and
`symbol.nested-decoy.calls` `AFFECTED` through a decoy Node never calls --
and so were five more the task added: a symbol published only through a
call's result (`symbol.opaque-export.decoy`), copied over by an
export-object mutation (`symbol.forwarded-over`), written inside a
function (`symbol.nested-write`), or published as a member read under a
name a module-scope function spells (`symbol.no-provenance-export`), all
family-C `NOT_AFFECTED`. On the branch: `AFFECTED` for the first two,
`NOT_AFFECTED` (family C) for the third, `UNKNOWN`
(`entrypoint_root_incomplete`) for the other five. A TypeScript overload
set is rooted at its implementation, which the name lookup missed (the
first node named `main` was a signature). Over the 139 corpus cases the
graph, proof and verdict differentials are all 0 (a zero corpus
differential is not evidence of soundness, OPEN-DEBTS D-12).

The certified decision this reopened (ADR 0011 § 6, VT-205 / P0-Z: "a
`{file, symbol}` root has nothing to be incomplete about") is corrected at
`entrypointSourceNodes`. ADR 0011 § 2's name-keyed-lookup census
(`src/testing/name-lookup-census.ts`, Foundation invariant
`VT-INV-V-corroboration`) keeps the entrypoint lookups by position.

V-3's independent audit then found, and V-3 fixed: an ESM default export
with no recorded local (`export default run`, an anonymous default
function or arrow) required no root, so `{file, symbol: "default"}` was
family-C `NOT_AFFECTED` over a target Node calls, on the base too; and a
function value assigned only after the export reads it
(`exports.main = run; var run = function () {}`, which publishes
`undefined`) witnessed the symbol, a false `AFFECTED` the first fix
introduced in symbol mode. Both are covered by
`verdict.identity-keyed-roots.integration.test.ts`. Its second audit
found three more, fixed by V-3: an ESM default identifier the file
reassigns was witnessed by its stale declaration (a name the file assigns
anywhere now declares no root); a CommonJS whole-module write that
republishes the symbol (`exports.main = a; module.exports = { main: run }`)
was dropped as the `default` export, family-C `NOT_AFFECTED` as on the
base (it now makes the symbol's roots incomplete); and a withdrawn symbol
binding rooted every other export's values, a false `AFFECTED` the first
fix introduced (a withdrawn symbol is now a root gap). Real-Node cases:
the "V-3 audit 2" cases of the oracle test.

---

