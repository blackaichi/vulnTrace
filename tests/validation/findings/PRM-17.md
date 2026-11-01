| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-17 | `vuln-lib` (synthetic fixture) | A higher-order parameter's reassignment inside the function body is never checked before its call sites are treated as authoritative | false NOT_AFFECTED — see below | **Fixed** (A-5a) — see below |

## PRM-17 — A higher-order parameter's reassignment inside the function body is never checked before its call sites are treated as authoritative

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** C (explicitly labeled class C in the report)
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** A — call graph

VT-210's invariant requires every call site to be accounted for, but does not check whether the parameter itself is reassigned inside the function (`fn = fn || lib.parse; return fn("x")`). The reassignment collapses to the call-site value and misses the reassigned one. The same mechanism resurfaces later through the `arguments[0]` alias (round 2, KNOWN PRM-17).

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-17`) and § 4 (`higher-order-reassigned-parameter`)`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task A-5a, 2026-10-04): Fixed.** VT-210 refuses a
parameter whose name is written anywhere in its function, in any
assignment form, including in a nested closure. That includes writes
through a value-free wrapper (`(fn) = f`, `[(fn)] = [f]`, `fn! = f`,
`(fn as any) = f`), which the name scanner (`buildAssignedNames`)
missed until task A-5a's independent audit. It also refuses a function
that mentions `arguments` or `eval` or holds a `with` statement. A sloppy-mode
`arguments[0] = v` writes the parameter it aliases without an assignment
to its name, and a direct `eval` or a `with` body can write any name.

Reproduced against real Node in
`tests/oracle/a5a-resolution-authority.test.ts` (`vt210.reassigned-*`,
`vt210.arguments-alias`, `audit.parenthesized-*-parameter-write`): six
false `NOT_AFFECTED` on the base, `UNKNOWN` on the branch. The closure
write was already `UNKNOWN` on the base and is kept as a guard.

The same work found RWF-071 (a spread argument before the parameter's
position) and RWF-073 (a TypeScript `this` parameter shifting the
position).

---

