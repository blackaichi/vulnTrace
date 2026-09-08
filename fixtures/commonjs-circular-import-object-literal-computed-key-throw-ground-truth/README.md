# RWF-024 runtime ground truth: a circular `require()` observes a dangerous export bypassed by a throwing call in an OBJECT LITERAL's COMPUTED KEY

This fixture is **not** scanned by VulnTrace's own test suite — it is a plain
Node.js program, run directly with `node entry.js`. It is the RWF-024
counterpart of
`fixtures/commonjs-circular-import-computed-class-key-throw-ground-truth/`
(RWF-019), and it differs from that one in exactly one respect: the
resolvable, always-throwing local call is a COMPUTED KEY on an OBJECT
LITERAL, not a class element at all:

```js
const o = {
  [bail()]: 1,
};
```

Everything else — the circular observer, the dangerous export published
first, the later `module.exports = safeOp` — is held identical on purpose,
so the run below isolates the single question RWF-024 asks: *does
evaluating an object literal evaluate its elements' computed property
names, even for elements whose value or body is deferred?* It does. For
every property in an `ObjectLiteral`'s `PropertyDefinitionList`, in source
order, ECMAScript's `PropertyDefinitionEvaluation` evaluates the computed
key expression and converts it to a property key **before** that
property's value (or the method/getter/setter it names) is defined on the
new object. Reaching the object literal therefore necessarily invokes
`bail()`, the object literal never finishes constructing, `o` is never
bound, and nothing below it runs.

**Why this is a different rule from RWF-019, not a widening of it.**
RWF-019's computed key is evaluated by `ClassDefinitionEvaluation`, an
abstract operation that only ever runs for a `class`. This fixture's
computed key is evaluated by an entirely different abstract operation —
`ObjectDefinePropertyOrThrow` chains inside plain object construction —
that runs for every object literal in the language, class or no class in
sight. The two rules read the identically-kinded AST node
(`PropertyAssignment`/`MethodDeclaration`/`GetAccessorDeclaration`/
`SetAccessorDeclaration`) but are distinguished by checking the element's
PARENT, and neither is a special case of the other.

**Why this is also NOT a widening of RWF-018's static/instance line.**
RWF-018 turns on a real distinction for a class: an INSTANCE field's VALUE
is deferred to construction, while a STATIC field's VALUE runs immediately.
An object literal has no comparable per-instance deferral for an ORDINARY
property's VALUE at all — every property of an object literal, key and
value alike, evaluates immediately when the literal itself is evaluated.
`forms.js`'s own control proves this directly: `{ x: bail() }` **throws**,
unlike a class's `{ x = bail(); }`, which completes. What genuinely defers
in an object literal is a method/getter/setter's **BODY** (runs only when
invoked) and a computed key inside an object literal that is never built
at all (inside an uncalled function, or — as the one accepted
over-approximation, matching RWF-019's identical class-nested-in-instance-
field case — nested inside a class's own INSTANCE field initializer).

## The shape

```js
// a.js
function dangerousOp(input) { return danger.explode(input); }
function bail() { throw new Error("a.js: bail() always throws"); }

module.exports = dangerousOp;   // published first
const b = require("./b");       // circular: b.js requires a.js BACK, here
const o = {                     // object construction -> computed keys run
  [tag("before")]: "evaluated before the throw",
  [bail()]: 1,                  // -> throws -> a.js's load fails
  [tag("after")]: "NEVER evaluated",
};
function safeOp(input) { return "safe:" + input; }
module.exports = safeOp;        // UNREACHABLE on this path
```

```js
// b.js -- the cyclic observer
const retainedFromA = require("./a"); // a.js is mid-evaluation; Node hands
                                       // back its CURRENT module.exports --
                                       // dangerousOp, not safeOp
module.exports = { retained: retainedFromA };
```

```js
// c.js -- the DEFERRED-position control
module.exports = dangerousOp;
const o = {
  m() { bail(); },               // method BODY: runs on invocation
};
function configure() {           // never called at module scope
  return { [bail()]: 1 };
}
module.exports = safeOp;         // REACHED -- and genuinely authoritative
```

`a.js` requires `b.js`, and `b.js` requires `a.js` right back — a genuine
CommonJS circular dependency. Node's own documented circular-require
semantics hand `b.js` whatever `a.js`'s `module.exports` currently holds AT
THE MOMENT of the circular `require()` call, not the module's eventual final
value. Since `a.js` assigns `module.exports = dangerousOp` before requiring
`b.js`, `b.js` retains a live reference to the dangerous branch.

`forms.js` additionally evaluates **every** object-literal element form
carrying the same computed key, plus the deferred-position and NOT-deferred
controls, so the claim "a computed key is object-construction time whatever
the element is" is a measurement rather than an assertion.

## Running it

```
$ node entry.js
[a.js] publishing dangerousOp as module.exports
[a.js] requiring ./b (circular back-reference to a.js)
[b.js] retained from circular require(a): dangerousOp
[a.js] evaluating `const o = { [bail()]: 1 }` -- about to throw
[a.js]   computed key evaluated: before

=== after require('./a') ===
a.js load threw: a.js: bail() always throws
a.js's own export (safeOp) observed by entry.js: undefined

=== cyclic observer b.js ===
b.js retained the DANGEROUS export: dangerousOp

=== calling the retained dangerous export ===
vulnerable sink executed, result: EXPLODED:payload-from-entrypoint

=== deferred-position control ===
[c.js] object literal evaluated WITHOUT calling bail() from a KEY; publishing safeOp
c.js exported: safeOp (safeOp -- the object literal's own key did not throw)
c.js's method body throws only when called: c.js: bail() always throws (deferred positions only)
c.js's deferred object literal throws only when configure() runs: c.js: bail() always throws (deferred positions only)

=== every object-literal element form, measured ===
  { [bail()]: 1 }  (PropertyAssignment)                                    -> THREW at construction time: bail
  { [bail()]() {} }  (MethodDeclaration)                                   -> THREW at construction time: bail
  { get [bail()]() {} }  (GetAccessor)                                     -> THREW at construction time: bail
  { set [bail()](v) {} }  (SetAccessor)                                    -> THREW at construction time: bail
  { async [bail()]() {} }  (async method)                                  -> THREW at construction time: bail
  { *[bail()]() {} }  (generator method)                                   -> THREW at construction time: bail
  { [(bail())]: 1 }  (parenthesized)                                       -> THREW at construction time: bail
  { [bail?.()]: 1 }  (optional call)                                       -> THREW at construction time: bail
  CONTROL  { x: bail() }  (ORDINARY VALUE -- NOT deferred, unlike a class instance field) -> THREW at construction time: bail
  CONTROL  { m() { bail(); } }  (method BODY -- deferred until called)     -> completed
  CONTROL  { get x() { bail(); } }  (getter BODY -- deferred until read)   -> completed
  CONTROL  object literal in an uncalled function                          -> completed
  CONTROL  object literal nested inside a class INSTANCE field             -> completed

=== computed keys evaluate in source order, before values ===
  keys/values actually evaluated, in order: safe-key, bail

=== re-requiring ./a after its throw ===
[a.js] publishing dangerousOp as module.exports
[a.js] requiring ./b (circular back-reference to a.js)
[a.js] evaluating `const o = { [bail()]: 1 }` -- about to throw
[a.js]   computed key evaluated: before
require('./a') re-threw deterministically: a.js: bail() always throws
-> safeOp is NEVER the module's exported value on this code path.
```

(Captured verbatim from a real `node` run — Node.js v22.11.0, built-in
CommonJS loader, no mocking.)

## What this proves, fact by fact

1. **The dangerous export is assigned before the object literal is
   evaluated.** `[a.js] publishing dangerousOp as module.exports` is
   printed first, and the circular `require("./b")` happens while it is
   still the module's value.
2. **Object construction executes the computed keys.** `a.js` prints
   `evaluating \`const o = { [bail()]: 1 }\` -- about to throw` immediately
   before the object literal executes, then prints
   `computed key evaluated: before` — the FIRST key really did run — and
   never prints `after` or the line following the object literal. The
   object literal never finishes constructing, so `o` is never bound. That
   is the declaration-order key evaluation this depends on, and `forms.js`'s
   `keys/values actually evaluated, in order: safe-key, bail` shows it
   directly: neither the later key nor the abrupt property's own VALUE ever
   ran.
3. **`bail()` throws**, and its exception propagates out of the object
   literal and out of `a.js`'s own `require()` — `entry.js`'s first
   `require("./a")` throws `"a.js: bail() always throws"`.
4. **The later `safeOp` assignment is skipped.** `aExports` is `undefined`
   after the throw, `[a.js] publishing safeOp` is never printed, and
   re-requiring `./a` re-runs the module from scratch (Node evicts a module
   that threw during its first load) and re-throws *deterministically* —
   `safeOp` is not a fluke miss, it is unreachable on every load that takes
   this branch.
5. **The cycle retains the dangerous export.** `b.js` finished loading
   successfully, is fully cached, and `entry.js`'s own `require("./b")`
   (after `a.js`'s `require()` already threw) returns it with
   `retained === dangerousOp` intact.
6. **The vulnerable sink is called.** `entry.js` calls `b.retained(...)`,
   which is `dangerousOp(...)`, which calls `danger.explode(...)` and
   returns real output (`"EXPLODED:payload-from-entrypoint"`) — not a
   dead-code path, a live call.
7. **Every element form behaves the same way.** PropertyAssignment,
   MethodDeclaration, GetAccessor, SetAccessor, an `async` method, a
   generator method, the parenthesized key and the optional call
   `[bail?.()]` all threw during object construction. So this is a
   key-POSITION rule, not a form-specific rule.
8. **An ordinary property's VALUE is NOT deferred — unlike a class instance
   field.** `CONTROL { x: bail() }` **threw**, at construction time,
   exactly like the computed-key forms. This is the fact that makes
   RWF-024 distinct from a mechanical copy of RWF-018/019's static/instance
   line: an object literal has no per-instance deferral for anything.
   VulnTrace's own rule still does not model this VALUE position (see
   `tests/validation/FINDINGS.md`'s RWF-024 entry) — it is recorded as a
   deliberate, narrow, adjacent gap, not silently assumed safe.
9. **The deferred positions are genuinely different, in the same process.**
   `c.js` holds the identical always-throwing call in a method BODY and in
   an object literal built inside an uncalled function. Its object literal
   completes, `[c.js] object literal evaluated WITHOUT calling bail() from
   a KEY` is printed, `module.exports = safeOp` really does run, and
   `require("./c")` returns `safeOp`. The call throws only when `o.m()` or
   `configure()` is later evaluated, on a caller's decision. So those
   positions must NOT withdraw a later export's authority — doing so would
   be a false refusal, not conservatism.
10. **A nested object literal inside a class instance field is a control
    too.** `class { field = { [bail()]: 1 }; }` **completed**: the outer
    instance field never evaluates at class-definition time, so the inner
    object literal is never evaluated. VulnTrace nonetheless reports a
    cutoff there — the identical, already-accepted over-approximation
    RWF-019 documents for a class nested in the same position (see
    `tests/validation/FINDINGS.md`'s RWF-024 entry). It errs toward
    UNKNOWN, never toward a false negative proof.

## Why this matters for RWF-024

RWF-016 through RWF-022 taught VulnTrace that a resolvable, always-throwing
local call ends module evaluation exactly as a literal `throw` would, in
every VALUE position and class-definition-time position those tasks
modeled. RWF-019 specifically proved this for a class element's computed
key — but its own rule structurally excludes an object literal's
identically-shaped element, because the object literal's `MethodDeclaration`
is the same AST node KIND with a different PARENT. RWF-019's own audit
recorded this exclusion as a separate, still-open finding rather than
silently widening its rule to cover it.

Before RWF-024, VulnTrace considered `module.exports = safeOp` DEFINITELY
reached and authoritative whenever the only bypassing construct above it
was an object literal's throwing computed key, reported `safeOp` as the
module's exported identity with `dangerousOp` unreachable, and could issue
a Family C negative proof — a false `NOT_AFFECTED` for a package that
reaches the sink on every load taking this branch.

See `tests/validation/FINDINGS.md`'s RWF-024 entry and the analyzer-facing
fixture
`fixtures/commonjs-object-literal-computed-key-throwing-call-export-authority/`
(wired into VulnTrace's own test suite) for the static-analysis side of this
fix.
