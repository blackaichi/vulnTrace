| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-18 | `vuln-lib` (synthetic fixture) | The TypeScript checker's static apparent type of a receiver is used as the runtime receiver, even when reassigned | false NOT_AFFECTED — see below | **Fixed** (A-5b) — see below |

## PRM-18 — The TypeScript checker's static apparent type of a receiver is used as the runtime receiver, even when reassigned

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** B (explicitly labeled class B in the report)
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** A — call graph

`let inst = new Safe()` later reassigned to `new Danger()` before `inst.run()` is resolved through the checker's static apparent type of `inst` at its declaration, not its actual runtime value, so the resolution follows `Safe#run` and certifies `Danger#run` (which calls `lib.parse`) unreachable.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-18`) and § 4 (`checker-static-type-receiver`)`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task A-5b, 2026-10-05): Fixed.** VT-208 / VT-216's
checker-typed receiver (`resolveInstanceMethod`) is deleted, together with
the type-checked `ts.Program` it built. A method call gets a resolved edge
only from the receiver authority (`resolveReceiverMethod`,
`call-graph.ts`), the project owner's decision of 2026-10-04:

- a static call `C.m()` on a class bound through the graph's own class
  authority (the lexical `class` binding, or an exact import whose export
  is a class its own file never reassigns);
- an instance call `x.m()` on a `const` initialized by `new C(...)`
  (through `const` alias hops), `C` bound the same way;
- over a chain of plain class declarations: no decorator, no constructor
  `return`, every base a class bound the same way, every member name
  readable; a field of the name anywhere in an instance's chain, or an
  accessor or static field found before the method, refuses.

After the walk, a resolved method edge is withdrawn to the new unknown
reason `receiver_member_written` (`value_uncertainty`, non-widening) when
any prepared file may write the member (`member-writes.ts`): an
assignment in any form, a dynamic key, `__proto__`, `with`, or a
reflective mutator (`Object.defineProperty` / `defineProperties` /
`assign` / `setPrototypeOf`, `Reflect.set` / `defineProperty` /
`deleteProperty` / `setPrototypeOf`, `util.inherits`,
`__defineGetter__` / `__defineSetter__`), read by name, with `Object`,
`Reflect` or the global object used as a value writing any member. A
`__proto__` key a mutator copies (computed or shorthand; a plain
`__proto__:` key is the literal's prototype) writes any member. The edge
is also withdrawn when the export slot an imported class of the chain was
read from is written (`m.Lib = m.Evil` before `m.Lib.run()`). The call's
arguments then get the escape row's edges an unknown callee gets.

Every other receiver -- `this`, `super`, a parameter, a `let` / `var`, an
element access, a call result, an inline `new` -- keeps its unknown edge.
Reproduced against real Node in
`tests/oracle/a5b-receiver-member-writes.test.ts` (29 cases): 12 false
`NOT_AFFECTED` on the base, `UNKNOWN` on the branch (the five shapes of
REMEDIATION-PLAN § 5a, a constructor `return`, a same-class field, a
reassigned class name, `__proto__`, `with`, and a computed and a shorthand
`__proto__` key copied by `Object.assign`); eight regression guards and
five precision guards keep their verdicts. Four `audit.export-slot-*`
cases record a false `NOT_AFFECTED` the branch introduced and its
independent audit caught before the fix (`UNKNOWN` on the base, where
`m.Lib.run()` did not resolve at all). Each refusal and write form has a
named test in `call-graph.receiver-authority.test.ts`, and each of 45
mutations is caught by one. ADV-021, ADV2-020, ADV2-021, ADV2-022 and
ADV2-041 keep their verdicts.

**Not seen** (recorded, not fixed): a reflective mutator reached through a
value derived from a builtin with no spelling of `Object`, `Reflect` or a
mutator name (`({}).constructor[k]`, the global object as a sloppy
`this`); code the graph never prepared, which a resource limit or an
unresolved load leaves out (OPEN-DEBTS D-17's truncation and lane C); a
whole-module class export replaced by a later `module.exports = …`, which
the export attribution refuses today (the export write set's, PRM-29 /
PRM-30).

**Neighbouring shapes the re-audit measured, not A-5b's.** Four shapes are a
false `NOT_AFFECTED` on the base and on the branch alike, through the
import-chain binding (`bindCallee` / the export attribution), not through
the receiver authority: an unrelated `dummy.run = 1` write leaves them
unchanged, which would withdraw an edge the authority had made. They are
`exports.Api = i.Lib` followed by the importer's `m.Api = m.Evil;
m.Api.run()` (or a destructured `Api.run()`), a re-exported namespace
swapped by a called `swap()`, and `m.default = m.Evil; m.default.run()`.
Each is a member write on a module object followed by a call (RWF-047,
E-4) or a property write inside a called function (PRM-29, E-1), the
records lane E closes; the plain-function form `m.f = m.g; m.f()` is
RWF-047's own reproduction.

---

