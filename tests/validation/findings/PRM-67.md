| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-67 | `vuln-lib` (synthetic fixture) | `SUPPORTED_MODEL_EXCLUSIONS` omits `--conditions` and `--import`/preload flags, so the model's stated scope is false | disclosure — see below | Open |

## PRM-67 — `SUPPORTED_MODEL_EXCLUSIONS` omits `--conditions` and `--import`/preload flags, so the model's stated scope is false

**Status:** Open
**Failure class:** disclosure
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** D — disclosure

`node --conditions=custom` (loading a package's custom exports condition) and `node --import ./preload.mjs` both call the vulnerable code on the fixture used, and both scans give a family-A NOT_AFFECTED correct for default Node runtime settings — but neither flag is disclosed as a scope limitation in `SUPPORTED_MODEL_EXCLUSIONS`. Recorded as a false disclosure statement, not a false verdict for the default case.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-2.md § 5 ("PRM-67 FALSE")`. Not fixed here; this section records the finding only, per this task's boundaries.

---

