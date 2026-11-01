| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-60 | `vuln-lib` (synthetic fixture) | `unsupported_*` reasons are treated as never widening the closure, but four capability-receiver shapes let them load a new module | false NOT_AFFECTED — see below | Open |

## PRM-60 — `unsupported_*` reasons are treated as never widening the closure, but four capability-receiver shapes let them load a new module

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** A (same premise as PRM-105/106: a member/call result on a capability is treated as opaque rather than as the capability itself)
**Proof family affected:** A
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** C — capability flow and resolution

`module-load-closure.ts`'s premise is that `unsupported_construct`/`dynamic_member_access` reasons are "bounded to values and modules already discovered" and so cannot introduce a new module. Of 22 capability-routing shapes tested, 4 give a family-A false NOT_AFFECTED: `[require][0](name)`, `require.bind(null)`, `[Function][0]`, and `Function` reached by a computed key or `Reflect.get`. Root causes are PRM-105 and PRM-106; the same premise restated at `graph.ts` is PRM-109.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-2.md § 5 ("PRM-60 FALSE")`. Not fixed here; this section records the finding only, per this task's boundaries.

---

