| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-37 | `vuln-lib` (synthetic fixture) | A tagged-template call (`` tag`x` ``) gets no call-graph edge at all | false NOT_AFFECTED — see below | **Fixed** (A-1) — see below |

## PRM-37 — A tagged-template call (`` tag`x` ``) gets no call-graph edge at all

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** not classified in the report
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** A — call graph

`walkFile` classifies only `CallExpression` and `NewExpression` nodes; a `TaggedTemplateExpression` (`` lib.parse`x` ``) is neither, so it receives no edge at all — not even an unresolved one. Family C certifies the tagged function unreachable although Node invokes it. **ID assigned by task `record-soundness-audits`** from an unnumbered mechanism in round 1 § 5 item 1, per that task's Step 2.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 5 item 1 ("tagged template")`. Not fixed here; this section records the finding only, per this task's boundaries.

### Status update — fixed by task A-1 (2026-09-28)

**Status:** **Fixed** (task `A-1`, ADR 0008 § 2's tagged-template row).
Supersedes the Status line above.

A `TaggedTemplateExpression` is now an invocation site
(`tagged_template`): after the shared loader classification, its tag is
resolved exactly like a call's callee, and an unattributable tag gets an
unknown edge. VT-213's inline-callback fallback (PRM-13) is deliberately
not extended to it. The loader classification of the tag also closed a
second defect this task found, RWF-057. Reproduced against real Node,
failing on the base commit `c5ca885` and passing after:
`tests/oracle/a1-invocation-sites.test.ts` (`tagged-template.*`).

The tag is accounted from the owner that EVALUATES the template, which
differs from the walk's owner in two positions (task A-1 audit, finding
2): in an instance field initializer it is the class's constructor, and
in an accessor body -- which has no node of its own until A-4 -- the
account is withdrawn to unknown. Oracle cases
`tagged-template.instance-field-*`.

**The cost of the constructor attribution (task A-1 audit, round 2).**
A site in an instance field initializer is reachable only when the
class's construction is. Where construction is not modelled --
`Reflect.construct(A, [])`, or any ambient or builtin API a class is
handed and constructs -- it is not: `` class A { f = lib.parse`x`; }
Reflect.construct(A, []); `` is a family-C false `NOT_AFFECTED` on the
branch (the base also answers `NOT_AFFECTED`, having no tag edge at all;
A-1's first round, attributing the tag to the module, answered
`AFFECTED`). Explicit and implicit constructor bodies already carry the
same exposure; the hole is AUD-01's (an ambient callee handed a function
value gets no edge), closed by A-3, whose acceptance now requires such a
class to reach its constructor node (`docs/REMEDIATION-PLAN.md` § 5a, "A-1
additions to lane-A acceptance").

**What remains open at these sites (task A-1 audit, finding 5).** The
new account resolves its callee through the SAME authorities a call's
callee uses, so their open defects reach it too: PRM-20 (a trailing
member chain is truncated -- `class S extends lib.safe.Inner {}`,
`` lib.safe.Inner`x` `` and `@lib.safe.Inner class X {}` each resolve to
`lib.safe` and remain a family-C false `NOT_AFFECTED`, measured by the
audit on base and branch), PRM-104 (a reassigned `function` declaration),
PRM-16/17 (VT-210's higher-order parameter) and PRM-18 (VT-208's static
receiver type). They are fixed once, for every site, by A-5 and A-6.

**Status update (task A-3a, 2026-10-01).** The `Reflect.construct` case
above is closed: `Reflect.construct` is a documented invoking builtin
(ADR 0008 § 4) whose first argument it CONSTRUCTS, so a class passed to
it gets a resolved edge to its constructor node, explicit or implicit,
and `` class A { f = lib.parse`x`; } Reflect.construct(A, []); `` is
`AFFECTED` (`tests/oracle/a3a-escaped-values.test.ts`,
`constructed.Reflect.construct.*`, failing on the base).

---

