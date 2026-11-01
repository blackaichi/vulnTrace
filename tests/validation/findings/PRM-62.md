| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-62 | `vuln-lib` (synthetic fixture) | An ESM `let`-bound export reassigned after its declaration is attributed to its stale initial value | false NOT_AFFECTED — see below | **Fixed** (E-1) — see below |

## PRM-62 — An ESM `let`-bound export reassigned after its declaration is attributed to its stale initial value

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** C (a reassignable binding treated as single-valued)
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** E — export model

`export let run = function(x){ return safe(x); }; run = function(x){ return danger(x); };` is attributed to the initializer's stale `safe` value, with no reassignment refusal comparable to the CommonJS side's. A `configure()`-style deferred reassignment gives the same result. Round 1 left this UNVERIFIED because ESM function-expression export attribution did not yet exist to reproduce it against; round 2 confirms that attribution now exists and both variants give family C.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-2.md § 5 ("PRM-62 FALSE")`. Not fixed here; this section records the finding only, per this task's boundaries.

**Note (task A-4, 2026-10-04):** task A-4's independent audit measured
that the escape row (A-3a) and the protocol-member row (A-4) inherit this
attribution: an imported `let g` reassigned at load time in its module is
bound to its stale initializer whether it is called (`g()`), handed to a
builtin (`setTimeout(g, 0)`) or stored under a protocol key
(`{ toString: g }`, `export { g as toString }`) -- a possible edge to the
stale function, a false `NOT_AFFECTED` when only the later value calls
the target. Nothing A-4 adds is wrong in a way a plain call is not; lane E
fixes all of them together.


**Status update (task E-1, 2026-10-13): Fixed.** The positive control
needs a function-expression initializer (`export const run = safeOp` is not
attributed at all); with it, all three shapes were live (a module-scope
reassignment, one in an exported function, an export list of a reassigned
`let`). A local the file assigns anywhere attributes nothing and is marked
`exportAttributionWithdrawn`. `tests/oracle/e1-export-write-set.test.ts` (`prm62.*`).

---

