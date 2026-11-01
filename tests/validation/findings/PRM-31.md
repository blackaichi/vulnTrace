| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-31 | `vuln-lib` (synthetic fixture) | Root-requirement materialization matches a candidate node by AST name text, so a same-named decoy elsewhere satisfies it | false NOT_AFFECTED — see below | **Fixed** (V-3) — see below |

## PRM-31 — Root-requirement materialization matches a candidate node by AST name text, so a same-named decoy elsewhere satisfies it

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** A
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** E — export model

A `class Cli { run() { return "decoy"; } }` (an unrelated method named `run`) satisfies the root-witness requirement for an `exports.run = registry.impl` entrypoint, because the witness check matches by name text rather than declaration identity. With the requirement satisfied by the decoy, the real `registry.impl` root is never registered and family C certifies it unreachable.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-31`) and § 4 (`entry-root-decoy`)`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task V-3, 2026-10-08): Fixed.** Assigned to lane E (task
E-3) by the plan; ADR 0011 § 2 assigns the same lookup -- the
root-requirement witness by node name, `verdict.ts`'s former `1190` -- to
lane V, and predicate 4 ("every entrypoint root is materialized by
declaration position") cannot hold while it stands, so task V-3 removed
it. A root requirement is satisfied only by a node at one of its
POSITIONS: a function value's own, or the callable a provenance name (the
binding's local, the end of its alias chain) declares at the export's site,
resolved lexically. The exported name is no provenance (RWF-011) and
witnesses nothing; a name an export written inside a function body uses
resolves nothing (the whole-file, name-keyed collection of such names
need not agree with the write's scope). The roots themselves are found by
position too: a plain file entrypoint used to root the FIRST node named
like each candidate, so a nested function of the same spelling became the
root and the real one was never searched.

Measured on the base (`5302d02`) against real Node v22
(`tests/oracle/v3-identity-keyed-roots.test.ts`, file entrypoints, the
host calling `main`): the round-1 reproduction `file.entry-root-decoy`
(a class method `main` witnessing `exports.main = registry.impl`), a
module-scope function the exported name spells
(`file.no-provenance-export`), a nested `run` rooted instead of the
exported one (`file.nested-decoy.safe`) and an export written inside a
function (`file.nested-write`) were family-C `NOT_AFFECTED` over a target
Node calls; a nested `main` that calls the target and never leaves its
function made `{ main }` `AFFECTED` (`file.nested-decoy.calls`). On the
branch: `UNKNOWN` (`entrypoint_root_incomplete`), `UNKNOWN`, `AFFECTED`,
`UNKNOWN` and family-C `NOT_AFFECTED`. What remains for E-3 is the write
set itself (PRM-32, and RWF-079, found by this task).

V-3's independent audit then found, and V-3 fixed, two more of the same
kind. A whole-module export written at load inside a function or a class
static block (`function setup() { module.exports = { main: run } }
setup()`) has no requirement of its own; its root came from the withdrawn
widening by spelling (`AFFECTED` on the base), and the first fix dropped it
silently (family-C `NOT_AFFECTED`): every value the widening cannot name a
callable for is now root incompleteness (`UNKNOWN`, a precision cost
against the base). And a binding the file reassigns (`let main = a; main =
b; exports.main = main`) was witnessed by its stale declaration, family-C
`NOT_AFFECTED` on the base: a refused binding's names now witness nothing
(`UNKNOWN`). Real-Node cases: the "V-3 audit" cases of the same oracle
test.

---

