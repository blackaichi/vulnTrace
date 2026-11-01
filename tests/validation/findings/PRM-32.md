| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-32 | `vuln-lib` (synthetic fixture) | `this.X = ...` at module scope and an aliased `const api = module.exports; api.run = ...` are invisible to root-requirement detection | false NOT_AFFECTED — see below | Open |

## PRM-32 — `this.X = ...` at module scope and an aliased `const api = module.exports; api.run = ...` are invisible to root-requirement detection

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** not classified in the report
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** E — export model

Root detection recognizes `module.exports = X` and `exports.X = ...` forms, but `this.run = run` at module scope and an aliased `const api = module.exports; api.run = run` are both invisible, so the module is reported as having zero export roots (complete, none missing) although Node runs exactly this code as the module's real export. Family C certifies the real handler unreachable.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-32`) and § 4 (`entry-root-unseen-export-writes`)`. Not fixed here; this section records the finding only, per this task's boundaries.

---

