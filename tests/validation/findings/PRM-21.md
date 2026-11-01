| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-21 | `vuln-lib` (synthetic fixture) | A same-file `const` binding shadows an ambient global (`require`, `eval`, `process`, `module`) for the whole file | false NOT_AFFECTED — see below | Open |

## PRM-21 — A same-file `const` binding shadows an ambient global (`require`, `eval`, `process`, `module`) for the whole file

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** A
**Proof family affected:** A
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** C — capability flow and resolution

A same-file `const lib = r(name)` (where `r = require`) is read by `loader-constructs.ts` as a shadow of the ambient `require` identifier for the whole file, which never widens the module-load closure. Family A certifies the package absent from the closure, although `require` is not actually reassigned or made inaccessible. Reproduced together with PRM-22 as the `wholefile-shadow-require-alias` fixture.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-21`) and § 4 (`wholefile-shadow-require-alias`)`. Not fixed here; this section records the finding only, per this task's boundaries.

---

