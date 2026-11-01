| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-22 | `vuln-lib` (synthetic fixture) | The loader classifier's alias lookup for module/eval/vm-style capabilities is first-match and scope-blind | false NOT_AFFECTED — see below | Open |

## PRM-22 — The loader classifier's alias lookup for module/eval/vm-style capabilities is first-match and scope-blind

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** A
**Proof family affected:** A
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** C — capability flow and resolution

`resolveSingleAssignmentValue` in `loader-constructs.ts` uses the same first-match, scope-blind alias lookup that comparable fixes already removed from other resolution paths; here it still governs whole-file capability shadowing. Not independently reproduced beyond PRM-21's shared fixture; the comment justifying it cites two precedents both since removed as soundness defects.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-22`) and § 4 (`wholefile-shadow-require-alias`)`. Not fixed here; this section records the finding only, per this task's boundaries.

---


**Note (task BL-110, 2026-10-26).** For the lookup list, the forms of this
record that BL-096 measured now give `UNKNOWN`: a `const` alias of the list whose name another declaration shares (`audit2.alias-name-collision`), because an alias is exempt only when its own name resolves to the list. The record stays
Open for every other capability.

