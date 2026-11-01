| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-19 | `vuln-lib` (synthetic fixture) | A derived class's synthesized implicit default constructor gets no edge to the resolved base constructor | false NOT_AFFECTED — see below | **Fixed** (A-1) — see below |

## PRM-19 — A derived class's synthesized implicit default constructor gets no edge to the resolved base constructor

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** not classified in the report
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** A — call graph

`source-index.ts`'s implicit-constructor synthesis assumes an implicit constructor "provably does nothing" and gives the synthesized node no outgoing edges; but a base class's real constructor still runs via the implicit `super()` call. `class Sub extends Base {}` with `new Sub()` certifies `Base`'s constructor body (which calls `lib.parse`) unreachable.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-19`) and § 4 (`implicit-super-constructor`)`. Not fixed here; this section records the finding only, per this task's boundaries.

### Status update — fixed by task A-1 (2026-09-28)

**Status:** **Fixed** (task `A-1`, ADR 0008 § 2's implicit-`super` row).
Supersedes the Status line above.

A derived class with no constructor is now an invocation site
(`implicit_super`, `src/code-intelligence/invocation-sites.ts`): its
synthesized implicit-constructor node gets exactly one account, the
base constructor, resolved through the same authorities as `new Base()`
(ADR 0008 § 4: "resolved, because the language guarantees the call"), or
an unknown edge when the base is not attributable. The false premise in
`source-index.ts` ("an implicit constructor provably does nothing") is
corrected in place. Reproduced against real Node, failing on the base
commit `c5ca885` and passing after:
`tests/oracle/a1-invocation-sites.test.ts` (`implicit-super.*`: local
base and a chain → `AFFECTED`; an unattributable base → `UNKNOWN`; a
never-constructed subclass → `NOT_AFFECTED`, the precision control).
Graph level: `src/code-intelligence/call-graph.invocation-account.test.ts`.

**What remains open at these sites (task A-1 audit, finding 5).** The
new account resolves its callee through the SAME authorities a call's
callee uses, so their open defects reach it too: PRM-20 (a trailing
member chain is truncated -- `class S extends lib.safe.Inner {}`,
`` lib.safe.Inner`x` `` and `@lib.safe.Inner class X {}` each resolve to
`lib.safe` and remain a family-C false `NOT_AFFECTED`, measured by the
audit on base and branch), PRM-104 (a reassigned `function` declaration),
PRM-16/17 (VT-210's higher-order parameter) and PRM-18 (VT-208's static
receiver type). They are fixed once, for every site, by A-5 and A-6.

**Not closed by this status (RWF-060).** When the base is an ambient or
builtin constructor (`class P extends Promise {}`, a `stream.Readable`
subclass), the implicit constructor forwards `new P(...)`'s arguments to
it, and a callback among them runs. That is accounted, like `new
Promise(...)` itself, by the unproven `ambient_global_callee` /
`builtin_module_callee` account, and is registered as RWF-060 (task A-3).

---

