| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-12 | `vuln-lib` (synthetic fixture) | A call/`new` whose callee resolves to a Node builtin, but which receives a function-valued argument, emits no edge | false NOT_AFFECTED — see below | **Fixed** (A-3a) — see below |

## PRM-12 — A call/`new` whose callee resolves to a Node builtin, but which receives a function-valued argument, emits no edge

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** same mechanism as AUD-01 (there labeled class B); not separately labeled in this report
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** A — call graph

`fs.readFile(__filename, lib.parse)` and similar builtin-bound calls emit no edge to the function-valued argument at all, so family C certifies `lib.parse` unreachable although Node invokes it. Reproduced end to end (`builtin-callback` fixture, part of 96/96 loud-fixture-verified cases). An existing test (`call-graph.test.ts:274`/`:380`) covers builtins with no callback and an inline-callback-only case, but not this failing shape.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-12`) and § 4 (`builtin-callback`)`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task A-3a, 2026-10-01): Fixed.** A builtin module's
member is identified through the binder's own declaration authority
(`SymbolBindingBuiltin` now carries the member path) and accounted by the
builtin table: `fs.readFile` is not a documented invoking builtin, so an
attributable callback -- an import (`lib.parse`), a same-file function, a
destructured `readFile`'s argument -- gets a POSSIBLE edge, and the
finding is `UNKNOWN` with `possible_invocation`, never `NOT_AFFECTED`
(`tests/oracle/a3a-escaped-values.test.ts`, `escaped.fs.readFile.*`,
failing on the base). The two tests this record names changed as ADR
0008 § 8 expected: a builtin handed only primitives stays edge-free, now
with a `primitive_only_arguments` proof; an inline callback handed to
`fs.readFile` gets a possible edge where VT-213 gave it a resolved one.

---

