| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-29 | `vuln-lib` (synthetic fixture) | A property write inside a called `configure()` function is not seen as competing with the export map | false NOT_AFFECTED — see below | **Fixed** (deferred writes: BL-064; `this` writes: E-1) — see below |

## PRM-29 — A property write inside a called `configure()` function is not seen as competing with the export map

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** C (explicitly labeled class C in the report)
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** E — export model

`exports.configure = function(){ exports.run = danger; }; exports.run = safe; exports.configure();` has `exports.run = safe` textually last, but the deferred write inside `configure()` (invoked before the module finishes) actually wins at runtime. The export map's last-write-wins rule only looks at source position, not execution order.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-29`) and § 4 (`export-map-configure-write`)`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task E-1, 2026-10-13): Fixed.** Re-measured: the three
deferred-write shapes were already `UNKNOWN` on the base (BL-064's window:
a deferred competing write opens it at the start of the file). Two further
shapes were live: a `this.run = …` write in an exported or literal method
called as `w.configure()` (the method's `this` IS the exports object). E-1's
census counts every `this` write in a non-arrow function as a write of its
name (`method-this-write`). `tests/oracle/e1-export-write-set.test.ts` (`prm29.*`).

---

