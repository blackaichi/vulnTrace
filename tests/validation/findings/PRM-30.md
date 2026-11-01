| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-30 | `vuln-lib` (synthetic fixture) | A `module.exports = {...}` literal unpacking wins over a later `module.exports.run = danger` member write | false NOT_AFFECTED — see below | **Fixed** (E-1) — see below |

## PRM-30 — A `module.exports = {...}` literal unpacking wins over a later `module.exports.run = danger` member write

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** not classified in the report
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** E — export model

`module.exports = { parse, safe, run: safe }; module.exports.run = danger;` keeps the literal-unpacked `safe` as the published `run` rather than the later member write `danger`, because the two write forms are not ordered against each other by source position. Family C certifies `danger` unreachable although it is the module's real last-written, real-called export.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-30`) and § 4 (`export-map-literal-then-member-write`)`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task E-1, 2026-10-13): Fixed.** Both shapes were live,
and the mirror image (`module.exports = { run: dangerousOp };
module.exports.run = safeOp;`) was a false `AFFECTED`. `applyExportWriteSet`
orders a name's writes on the FINAL export object, with `exports` tracked
through `exports = module.exports = …`; a write to a replaced object is
ignored. `tests/oracle/e1-export-write-set.test.ts` (`prm30.*`, `control.literal-then-member-write-safe`,
`control.stale-exports-write`).

---

