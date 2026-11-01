| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-38 | `vuln-lib` (synthetic fixture) | Implicit protocol invocations (`toString`/`valueOf` coercion, thenable resolution, `Symbol.iterator`) invoke user code with no call-graph edge | false NOT_AFFECTED — see below | **Fixed** (A-4) — see below |

## PRM-38 — Implicit protocol invocations (`toString`/`valueOf` coercion, thenable resolution, `Symbol.iterator`) invoke user code with no call-graph edge

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** not classified in the report
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** A — call graph

The same `walkFile` gap as PRM-37 means an object's `toString()` invoked by string coercion, a thenable's `then()` invoked by `await`, and a `[Symbol.iterator]()` generator invoked by `for…of` all run real code with no edge at all, so family C certifies each unreachable. Round 1 reproduced `toString` coercion, thenable/`await` and the iterator protocol via `for…of`; the same mechanism also covers spread, destructuring, `yield*` and `Array.from` over an iterable (not independently reproduced there). Round 2 separately reproduces and numbers `Symbol.hasInstance` (PRM-112) and `Symbol.asyncIterator` (PRM-113). **ID assigned by task `record-soundness-audits`** from an unnumbered mechanism in round 1 § 5 item 2, per that task's Step 2.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 5 item 2 ("implicit protocol calls")`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task A-4, 2026-10-04): Fixed.** A definition under a
key that may be a protocol member's is the invocation site
`protocol_member` (`src/code-intelligence/protocol-members.ts`): a method
gets a possible edge from the owner that evaluates its definition; a
property, class field or store (`o.toString = f`,
`C.prototype.valueOf = f`, `o[k] = f`) a possible edge to each
attributable function its value carries, and an unknown `protocol_value`
edge for a value it cannot attribute; a destructuring or `for…of` store
into such a member an unknown edge. A key is a protocol key unless proven
otherwise (a literal not in the list, a number, a private name, another
well-known symbol or a `Symbol(…)` / `Symbol.for(…)` through the ambient
`Symbol`, through stable `const`s): a computed key the analyzer cannot
read may be `"toString"` at run time. A getter under a protocol key is
also accounted for what it returns (`{ get then() { return f; } }`). The
iterator's own `next` / `return` / `throw` were added to the list by the
project owner's decision of 2026-10-04 (RWF-068). An ES module's exports
are the properties of its namespace object, so an exported function,
variable or export specifier under a protocol name is a definition too
(`${ns}`, `await ns`; found by task A-4's independent audit); exports are
live bindings, so one the file writes again (an assignment, or a second
declaration of the name, `var` included), or declares by destructuring,
gets an unknown edge (its re-audits). Outside the
list, and so still open: `constructor` / `Symbol.species`, which `await`
reaches (RWF-070). Reproduced against real
Node in `tests/oracle/a4-protocol-members.test.ts` (coercion by a
template, `+`, unary `+`; object-literal, class, instance-field,
computed-key and stored members; thenables through `await` and an async
`return`; `for…of`, spread, destructuring and `yield*`): each a false
`NOT_AFFECTED` on the base, `UNKNOWN` on the branch.

---

