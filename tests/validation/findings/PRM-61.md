| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-61 | `vuln-lib` (synthetic fixture) | Export forwarding resolves to the first "own" binding of a name, which a later `module.exports` replacement or property write can make stale | false NOT_AFFECTED (one shape also gave a false AFFECTED on its first run) — see below | **Fixed** (E-1's model; the hop gated by E-2) — see below |

## PRM-61 — Export forwarding resolves to the first "own" binding of a name, which a later `module.exports` replacement or property write can make stale

**Status:** Open
**Failure class:** false NOT_AFFECTED (one shape also gave a false AFFECTED on its first run)
**Defect class:** not classified in the report
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** E — export model

`export-forwarding.ts` takes the first own binding per name, while the export map used elsewhere takes last-write-wins; when a module first sets `exports.run = require('./a').run` and then replaces the whole `module.exports = {...}` object (or the reverse order), the forwarding hop can point at a binding a later write superseded. Round 1 left this UNVERIFIED; round 2 settles it FALSE (`p2-61-stale-exports-after-replace`, `p2-61-replace-after-property`).

Full reproduction: `docs/audits/2026-09-premise-sweep-round-2.md § 5 ("PRM-61 FALSE")`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task E-2, 2026-10-14): Fixed -- by E-1's model; the hop
is now gated too.** Re-measured against real Node v22.11.0 on E-2's base
`4bb6c86` (E-1's merge): neither reproduced shape is live. `exports.run =
require("./safe").run; module.exports = require("./danger");` answers
`UNKNOWN` (real Node calls `parse`), the order that gave the false
`AFFECTED` answers `UNKNOWN`, and `module.exports = require("./danger");
exports.run = require("./safe").run;` answers a correct `AFFECTED`: E-1's
write set (`applyExportWriteSet`) leaves at most one named binding per
name on its decided path and drops a write to a stale export object, so
the hop's first-match `find` no longer had a stale binding to find. ADR
0009 § 8's E-2 row therefore named a closed shape. The hop itself still
did not consult the write set, which left RWF-105 (below) live; E-2 gates
it: an own name forwards only when every own binding carries one origin,
and a whole-module re-export forwards no name the write set records. The
three shapes are `prm61.*` in `tests/oracle/e2-forwarding-write-set.test.ts`.

---

