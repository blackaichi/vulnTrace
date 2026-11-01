| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-24 | `vuln-lib` (synthetic fixture) | A builtin loader that starts new execution (`cluster.fork`/`setupPrimary`) is not classified as a loader | false NOT_AFFECTED — see below | Open |

## PRM-24 — A builtin loader that starts new execution (`cluster.fork`/`setupPrimary`) is not classified as a loader

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** not classified in the report
**Proof family affected:** A
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** A — call graph

`cluster.fork()`/`setupPrimary({exec})` executes a separate worker file, but `cluster` is absent from the builtin loader-widening table, so the closure reports complete and family A certifies the worker's `vuln-lib` call unreachable. The comparable `child_process.fork()` of the same worker file IS treated as widening — the report flags this as a policy inconsistency (`SUPPORTED_MODEL_EXCLUSIONS` item 6 could be read either way), not a settled defect on its own.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-24`) and § 4 (`cluster-fork`)`. Not fixed here; this section records the finding only, per this task's boundaries.

**Correction (2026-09-26, task `remediation-reconciliation`):** the `Fix lane` line above states lane A. `docs/REMEDIATION-PLAN.md` § 2.2 assigns this finding to **lane C** (capability flow and resolution, ADR 0010's loader table, task **C-4**), which is authoritative for lane assignment — the plan was measured, this field was partly inferred (`REMEDIATION-PLAN.md` § 2, introduction). The `Fix lane` line is left as originally written, per this register's append-only discipline; follow the plan.

---

