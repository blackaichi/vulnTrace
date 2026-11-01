| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-03 | `vuln-lib` (synthetic fixture) | `process.getBuiltinModule(spec)` loads a builtin while the module-load closure reports complete | false NOT_AFFECTED — see below | Open |

## AUD-03 — `process.getBuiltinModule(spec)` loads a builtin while the module-load closure reports complete

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** B
**Proof family affected:** A
**Severity:** Critical
**Fix lane:** C — capability flow and resolution

`process.getBuiltinModule('module'|'child_process'|'worker_threads')` (every spelling: destructured, via `node:process`, stored and used later, from ESM) is absent from the builtin/loader specifier table, so the closure never widens for it and reports `complete: true` with no `vuln-lib` present. Family A then certifies the package absent from the load closure while Node genuinely loads and calls it through `Module.createRequire`.

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-03"`. Not fixed here; this section records the finding only, per this task's boundaries.

---

