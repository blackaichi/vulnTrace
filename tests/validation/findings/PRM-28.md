| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-28 | `vuln-lib` (synthetic fixture) | A computed export key (`[K]: danger`) is resolved against a same-file `const` binding chosen scope-blind | false NOT_AFFECTED — see below | **Fixed** (E-1) — see below |

## PRM-28 — A computed export key (`[K]: danger`) is resolved against a same-file `const` binding chosen scope-blind

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** A
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** E — export model

`module.exports = { ..., [K]: danger }` resolves `K` to whichever same-file `const K` binding is found first, regardless of which one is actually in scope at that literal (a function-local `const K = "other"` can be picked over the module-scope `const K = "run"` really in effect). Family C certifies the real `run` export unreachable.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-28`) and § 4 (`export-map-computed-key-scope`)`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task E-1, 2026-10-13): Fixed.** Both measured shapes (a
function's and a block's own `const K` before the module-scope one) were
live. `resolveComputedPropertyNameLiteral` resolves the key's identifier
lexically, from the key, to one `const` declared before it. ADV2-028 stays
`AFFECTED` (`control.computed-module-const-dangerous`). `tests/oracle/e1-export-write-set.test.ts`
(`prm28.*`).

---

