| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-01 | `vuln-lib` (synthetic fixture) | A function-valued argument to an ambient builtin (setTimeout, new Promise, process.nextTick, Array.from, …) gets no call-graph edge | false NOT_AFFECTED — see below | **Fixed** (A-3a) — see below |

## AUD-01 — A function-valued argument to an ambient builtin (setTimeout, new Promise, process.nextTick, Array.from, …) gets no call-graph edge

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** B
**Proof family affected:** C
**Severity:** Critical
**Fix lane:** A — call graph

A callback handed to an ambient global/builtin (`setTimeout`, `new Promise`'s executor, `process.nextTick`, `queueMicrotask`, `setImmediate`, `Array.from`, the `JSON.parse` reviver, `Reflect.apply`, a `global`/`globalThis` store, `process.on`+`emit`, or a named local) is matched by identifier text against a fixed global-name list before VT-213's inline-callback rescue runs, so no edge — resolved or unresolved — is ever emitted to it. Family C then certifies the callback's own code unreachable, although real Node invokes it.

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-01"`. Not fixed here; this section records the finding only, per this task's boundaries.

**Appended by task A-0 (2026-09-26).** Two surfaces of this mechanism
that sweep round 2 recorded here (`docs/audits/2026-09-premise-sweep-round-2.md`
§ 4: "defineProperty getter / setter (function expression)" and "Proxy
traps", both read directly there) were reproduced again on `main` at
`276a208`, this time run by builtins and operators, with the H-0 oracle
harness (loud fixture, positive and negative controls, real-Node ground
truth, Node v22.11.0). Each is a false `NOT_AFFECTED` by family C over a
complete subgraph, pinned as an open-soundness-defect record in
`tests/oracle/adr0008-coverage.test.ts`:

- **an `Object.defineProperty` getter (function expression) with
  `enumerable: true`**, read by `JSON.stringify(o)`,
  `Object.assign({}, o)`, `{...o}` and `Object.entries(o)`
  (cases `S2.defineProperty-enumerable.*`). Without `enumerable: true`
  the getter is non-enumerable, none of the four reads it (measured), and
  `main`'s `NOT_AFFECTED` is correct (`S2.defineProperty.*`, pinned as
  sound);
- **a Proxy handler whose traps are not protocol methods**:
  `Object.keys(p)` and `Object.getOwnPropertyNames(p)` → `ownKeys`;
  `"k" in p` → `has`; `JSON.stringify(p)` → `ownKeys`, and → `get`. The
  handler is written inline in `new Proxy(...)` (`S3.*`), and, for
  `Object.keys` and `in`, bound to a `const` first
  (`S3.*.named-handler`).

Whether ADR 0008 as written closes each shape is recorded in its
"Amendment A-0" section: the descriptor and inline-handler shapes are
closed by § 2's escape row; the named-handler `in` shape is closed by no
rule, because `in` is not an invocation-capable site and
`new Proxy(target, handler)` passes the Decision record's admission test
for the non-invoking allowlist (it runs no user code during the call).

**Status update (task A-3a, 2026-10-01): Fixed.** ADR 0008 § 2's escape
row, § 3's fail-closed default and § 4's documented invoking builtins
are implemented (`docs/tasks/A-3a-escaped-values.md`). A call or `new`
of a builtin proven to be one -- an ambient global no scope in the file
declares (by binding, no longer by spelling), a builtin module's member
through the binder's declaration authority, `require("<builtin>")` --
is accounted by the builtin table (`src/code-intelligence/builtin-callables.ts`):
a function it is handed gets a resolved edge at a documented invoking
position (`setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`,
`process.nextTick`, the `Promise` executor, `Reflect.apply`,
`Reflect.construct`, `Array.from`'s mapper) and a possible edge
elsewhere (`process.on`, the `JSON.parse` reviver, a property
descriptor's `get`, an inline Proxy trap); anything else non-primitive
it is handed gets an unknown edge unless its position is admitted to the
non-invoking allowlist, which `new Proxy` and `Proxy.revocable` never
are. A value stored on `globalThis` or another ambient builtin is an
escape too (PRM-114). Every shape the original record and the A-0
appendix list is reproduced against real Node in
`tests/oracle/a3a-escaped-values.test.ts` and
`tests/oracle/adr0008-coverage.test.ts`: failing on the base (26 of 28
new cases, each a false `NOT_AFFECTED`), `AFFECTED` or `UNKNOWN` on the
branch, never `NOT_AFFECTED`. A parameter named like a builtin (`JSON`)
is no longer taken for it: that shape was itself a false `NOT_AFFECTED`
through the spelling match (case `identity.parameter-named-JSON`).
Removing the spelling match also unmasks, for a parameter named
`setTimeout`, VT-213's fabricated resolved edge (PRM-13, appended
there). What remains of the monkeypatching surface is RWF-063.

---

