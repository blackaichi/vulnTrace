| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-13 | `vuln-lib` (synthetic fixture) | VT-213's inline-callback rescue displaces the unresolved edge for an otherwise-unattributable callee instead of adding to it | false NOT_AFFECTED — see below | **Fixed** (A-5a) — see below |

## PRM-13 — VT-213's inline-callback rescue displaces the unresolved edge for an otherwise-unattributable callee instead of adding to it

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** not classified in the report
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** A — call graph

When a call's callee cannot be attributed but exactly one argument is an inline arrow, VT-213 resolves the call to that arrow and the callee's own unknown edge is never emitted, so family C certifies the callee-side target unreachable.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-13`) and § 4 (`inline-callback-displacement`)`. Not fixed here; this section records the finding only, per this task's boundaries.

**Pinned test:** `call-graph.test.ts` VT-213 ("someUtterlyArbitraryMethodName") expects exactly this displacement as its recorded result; AGENTS.md § G forbids pinning a false premise as an expected result going forward.

**Appended by task A-3a (2026-10-01): the same fabricated edge also
yields a false `AFFECTED`.** VT-213's resolved edge to the one inline
callback claims the unattributable callee calls it. When the callee does
not:

```js
function run(setTimeout) { setTimeout(() => lib.parse("x")); }
run(function never(f) {}); // AFFECTED; Node never calls parse
```

Measured against real Node (v22.11.0) with the oracle harness. The same
program with the parameter named `cb` is a false `AFFECTED` on the base
`51c980c` as well; with the name `setTimeout` the base answered
`NOT_AFFECTED` only because VT-201 matched the NAME against the
ambient-global list and gave the call no edge at all. Task A-3a made
ambient identity lexical, which unmasks the VT-213 edge for that name
too. Recorded as an open-soundness-defect record owned by this finding
(`tests/oracle/a3a-escaped-values.cases.ts`,
`identity.parameter-named-setTimeout`: expected `NOT_AFFECTED`,
admissible `NOT_AFFECTED` or `UNKNOWN`), for task A-5. The same edge is
unmasked, and recorded the same way, wherever A-3a refuses a builtin's
identity and the callee becomes unattributable: a `setTimeout` replaced
by a destructuring assignment
(`audit.destructured-setTimeout-never-calls`) or by
`globalThis.setTimeout = () => 0` in the same file
(`reaudit.global-object-member-replaces-invoking-builtin`).


**Status update (task A-5a, 2026-10-04): Fixed.** VT-213's inline-callback
fallback (`resolveInlineCallbackArgument`) is deleted. An unattributable
callee keeps its unknown edge, and the one inline callback it is handed
gets the escape row's `possible` edge (`withEscapesAtUnknownCallee`, ADR
0008 § 2): its body is searched, never part of an `AFFECTED` path. The
pinned test (`call-graph.test.ts`, "someUtterlyArbitraryMethodName") now
asserts the callee's unknown edge it omitted. The three
open-soundness-defect records this finding owned in
`tests/oracle/a3a-escaped-values.cases.ts`
(`identity.parameter-named-setTimeout`,
`audit.destructured-setTimeout-never-calls`,
`reaudit.global-object-member-replaces-invoking-builtin`) are deleted and
assert `UNKNOWN`. That is the sound verdict for an unattributable callee:
the graph cannot show it never calls its argument. Reproduced against real
Node in `tests/oracle/a5a-resolution-authority.test.ts` (`vt213.*`): two
false `NOT_AFFECTED` and one fabricated `AFFECTED` on the base, all three
`UNKNOWN` on the branch.

**The receiver-bound builtins VT-213 stood in for.** Deleting VT-213 alone
turned ADV2-018 (`[1, 2, 3].map(() => dangerousOp())`) and ADV2-024
(`Promise.resolve().then(() => dangerousOp())`) from `AFFECTED` into
`UNKNOWN`. ADR 0008 § 5 had measured "0 adversarial" for this change, but
its prototype kept the resolved callback edge and only added the callee's
unknown edge (§ 8 says the pinned test "still passed under the
prototype"). That kept edge is itself fabricated.

By the project owner's decision of 2026-10-04, ADR 0008 § 4's
receiver-bound documented invoking builtins (`receiverBoundBuiltinOf`)
now give a resolved edge, but only on a proven receiver:

- an array literal with a first element, calling an iteration method
  (`reduce` / `reduceRight` with two elements or an initial value);
- `Promise.resolve()` of a value that carries no function, calling
  `then` / `finally`;
- `Promise.reject(…)`, calling `catch`, `then`'s second argument or
  `finally`.

Each is refused when the file writes that member. Both adversarial cases
are `AFFECTED` again.

On the base VT-213 also fabricated `AFFECTED` for a callback real Node
never runs. Each of these is `UNKNOWN` on the branch (`receiver.*`):

- an empty array;
- a hole;
- `reduce` on one element;
- an in-file `Array.prototype.map` patch;
- `Promise.resolve().catch`;
- a never-settling thenable.

These builtins share RWF-063's open case (a builtin monkeypatched through
a parameter or a container, backlog `BL-039`) with the global builtins.
They also share a precision limit with them, which the re-audit
measured. When another file replaces the method with one that never calls
its callback (`Array.prototype.forEach = function () {};`), the stored
function gets its own edge, so no negative is hidden. The resolved edge
to the callback stays, though, which makes the verdict a false `AFFECTED`.
Execution order is not modelled either: a callback queued just before
`process.exit()` is still `AFFECTED`, as it is for the timers.

---

