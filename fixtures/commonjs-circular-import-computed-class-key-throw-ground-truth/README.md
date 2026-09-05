# RWF-019 runtime ground truth: a circular `require()` observes a dangerous export bypassed by a throwing call in a class element's COMPUTED KEY

This fixture is **not** scanned by VulnTrace's own test suite — it is a plain
Node.js program, run directly with `node entry.js`. It is the RWF-019
counterpart of
`fixtures/commonjs-circular-import-static-field-throw-ground-truth/`, and it
differs from that one in exactly one respect: the resolvable,
always-throwing local call is not in a **value** position at all. It is a
class element's **computed key**, and the element carries **no `static`
modifier**:

```js
class C {
  [bail()] = 1;
}
```

Everything else — the circular observer, the dangerous export published
first, the later `module.exports = safeOp` — is held identical on purpose,
so the run below isolates the single question RWF-019 asks: *does evaluating
a class definition evaluate its elements' computed property names, even for
elements whose value or body is deferred?* It does. A computed property name
is evaluated by ClassDefinitionEvaluation, in declaration order, as each
element is defined — the key has to exist before the element can be
installed on the class or its prototype. Reaching the class therefore
necessarily invokes `bail()`, the class definition never completes, `C` is
never bound, and nothing below it runs.

**Why this is a different rule from RWF-018, not a widening of it.** RWF-018
turns on the static/instance distinction, and that distinction is real — but
it is about when the element's **VALUE** runs. The **KEY** of that very same
element runs immediately either way. The fixture proves both halves in one
process:

```js
class C { x = bail(); }     // completes: an instance field VALUE is per-instance
class C { [bail()] = 1; }   // throws:    the same element's KEY is definition-time
```

So a rule that required `static` would miss the majority of this family.

## The shape

```js
// a.js
function dangerousOp(input) { return danger.explode(input); }
function bail() { throw new Error("a.js: bail() always throws"); }

module.exports = dangerousOp;   // published first
const b = require("./b");       // circular: b.js requires a.js BACK, here
class C {                       // class evaluation -> computed keys run
  [tag("before")] = "evaluated before the throw";
  [bail()] = 1;                 // -> throws -> a.js's load fails
  [tag("after")] = "NEVER evaluated";
}
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
class C {
  x = bail();                   // instance field VALUE: installs, runs nothing
  m() { bail(); }               // method BODY: runs on invocation
}
function configure() {          // never called at module scope
  class Deferred { [bail()] = 1; }
}
module.exports = safeOp;        // REACHED -- and genuinely authoritative
```

`a.js` requires `b.js`, and `b.js` requires `a.js` right back — a genuine
CommonJS circular dependency. Node's own documented circular-require
semantics hand `b.js` whatever `a.js`'s `module.exports` currently holds AT
THE MOMENT of the circular `require()` call, not the module's eventual final
value. Since `a.js` assigns `module.exports = dangerousOp` before requiring
`b.js`, `b.js` retains a live reference to the dangerous branch.

`forms.js` additionally evaluates **every** class-element form carrying the
same computed key, plus the deferred-position controls, so the claim "a
computed key is class-definition time whatever the element is" is a
measurement rather than an assertion.

## Running it

```
$ node entry.js
[a.js] publishing dangerousOp as module.exports
[a.js] requiring ./b (circular back-reference to a.js)
[b.js] retained from circular require(a): dangerousOp
[a.js] evaluating `class C { [bail()] = 1; }` -- about to throw
[a.js]   computed key evaluated: before

=== after require('./a') ===
a.js load threw: a.js: bail() always throws
a.js's own export (safeOp) observed by entry.js: undefined

=== cyclic observer b.js ===
b.js retained the DANGEROUS export: dangerousOp

=== calling the retained dangerous export ===
vulnerable sink executed, result: EXPLODED:payload-from-entrypoint

=== deferred-position control ===
[c.js] class C evaluated WITHOUT calling bail(); publishing safeOp
c.js exported: safeOp (safeOp -- the class did not throw)
c.js's instance field throws only on construction: c.js: bail() always throws (deferred positions only)
c.js's deferred class throws only when configure() runs: c.js: bail() always throws (deferred positions only)

=== every class-element form, measured ===
  static [bail()] = 1                            -> THREW at definition time: bail
  [bail()] = 1                                   -> THREW at definition time: bail
  [bail()]() {}                                  -> THREW at definition time: bail
  static [bail()]() {}                           -> THREW at definition time: bail
  get [bail()]() {}                              -> THREW at definition time: bail
  set [bail()](v) {}                             -> THREW at definition time: bail
  async [bail()]() {}                            -> THREW at definition time: bail
  *[bail()]() {}                                 -> THREW at definition time: bail
  [(bail())] = 1  (parenthesized)                -> THREW at definition time: bail
  [bail?.()] = 1  (optional call)                -> THREW at definition time: bail
  class declaration, not expression              -> THREW at definition time: bail
  CONTROL  x = bail()      (instance field VALUE) -> completed
  CONTROL  m() { bail(); } (method BODY)         -> completed
  CONTROL  get x() { bail(); }                   -> completed
  CONTROL  class in an uncalled function         -> completed
  CONTROL  nested class inside an instance field -> completed

=== computed keys evaluate in declaration order ===
  keys actually evaluated, in order: safe, bail

=== re-requiring ./a after its throw ===
[a.js] publishing dangerousOp as module.exports
[a.js] requiring ./b (circular back-reference to a.js)
[a.js] evaluating `class C { [bail()] = 1; }` -- about to throw
[a.js]   computed key evaluated: before
require('./a') re-threw deterministically: a.js: bail() always throws
-> safeOp is NEVER the module's exported value on this code path.
```

(Captured verbatim from a real `node` run — Node.js v26.7.0, built-in
CommonJS loader, no mocking.)

## What this proves, fact by fact

1. **The dangerous export is assigned before the class is evaluated.**
   `[a.js] publishing dangerousOp as module.exports` is printed first, and
   the circular `require("./b")` happens while it is still the module's
   value.
2. **Class evaluation executes the computed keys.** `a.js` prints
   `evaluating \`class C { [bail()] = 1; }\` -- about to throw` immediately
   before the class declaration executes, then prints
   `computed key evaluated: before` — the FIRST key really did run — and
   never prints `after` or the line following the class. The class
   definition does not complete, so `C` is never bound. That is the
   declaration-order key evaluation this depends on, and `forms.js`'s
   `keys actually evaluated, in order: safe, bail` shows it directly: the
   key after the abrupt one never ran.
3. **`bail()` throws**, and its exception propagates out of the class
   definition and out of `a.js`'s own `require()` — `entry.js`'s first
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
7. **Every element form behaves the same way.** Static field, INSTANCE
   field, instance method, static method, getter, setter, `async` method,
   generator method, the parenthesized key and the optional call `[bail?.()]`
   all threw during class definition, in a class declaration and in a class
   expression alike. So this is a key-POSITION rule, not a static-element
   rule.
8. **The deferred positions are genuinely different, in the same process.**
   `c.js` holds the identical always-throwing call in an instance field's
   VALUE, in a method BODY, and in a class defined inside an uncalled
   function. Its class definition completes, `[c.js] class C evaluated
   WITHOUT calling bail()` is printed, `module.exports = safeOp` really does
   run, and `require("./c")` returns `safeOp`. The call throws only when
   `new C()` or `configure()` is later evaluated, on a caller's decision. So
   those positions must NOT withdraw a later export's authority — doing so
   would be a false refusal, not conservatism.
9. **A nested class inside an instance field is a control too.**
   `class Outer { field = class Inner { [bail()] = 1; }; }` **completed**:
   the outer instance field never evaluates at class-definition time, so the
   inner class is never evaluated. VulnTrace nonetheless reports a cutoff
   there — see the over-approximation note in
   `tests/validation/FINDINGS.md`'s RWF-019 entry. It is the pre-existing
   RWF-018 traversal behaviour, unchanged, and it errs toward UNKNOWN.

## Why this matters for RWF-019

RWF-016 taught VulnTrace that a resolvable, always-throwing local call ends
module evaluation exactly as a literal `throw` would; RWF-017 taught it that
the call's syntactic position does not change that; RWF-018 carried it into
a class **static field's initializer**. All three read the call out of a
VALUE position, and a computed key is not one.

Before RWF-019, VulnTrace considered `module.exports = safeOp` DEFINITELY
reached and authoritative, reported `safeOp` as the module's exported
identity with `dangerousOp` unreachable, and could issue a Family C negative
proof — a false `NOT_AFFECTED` for a package that reaches the sink on every
load taking this branch.

See `tests/validation/FINDINGS.md`'s RWF-019 entry and the analyzer-facing
fixture `fixtures/commonjs-computed-class-key-throwing-call-export-authority/`
(wired into VulnTrace's own test suite) for the static-analysis side of this
fix.
