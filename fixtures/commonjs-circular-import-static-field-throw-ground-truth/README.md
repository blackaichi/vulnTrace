# RWF-018 runtime ground truth: a circular `require()` observes a dangerous export bypassed by a throwing call in a class STATIC FIELD initializer

This fixture is **not** scanned by VulnTrace's own test suite — it is a plain
Node.js program, run directly with `node entry.js`. It is the RWF-018
counterpart of
`fixtures/commonjs-circular-import-initializer-throw-ground-truth/`, and it
differs from that one in exactly one respect: the resolvable,
always-throwing local call is not the initializer of a variable
declaration, it is the initializer of a **class `static` field**:

```js
class C {
  static x = bail();
}
```

Everything else — the circular observer, the dangerous export published
first, the later `module.exports = safeOp` — is held identical on purpose,
so the run below isolates the single question RWF-018 asks: *does evaluating
a class definition execute its static field initializers, and can that end
module evaluation?* It does. Evaluating a class definition runs each static
element — `static { ... }` blocks and `static x = ...` field initializers
alike — in declaration order, as part of that evaluation. Reaching the class
therefore necessarily invokes `bail()`, the class definition never
completes, `C` is never bound, and nothing below it runs.

The fixture also carries the **negative control in the same process**
(`c.js`), because the whole soundness argument turns on the distinction:
an *instance* field initializer with the identical call does **not** run at
class-definition time.

## The shape

```js
// a.js
function dangerousOp(input) { return danger.explode(input); }
function bail() { throw new Error("a.js: bail() always throws"); }

module.exports = dangerousOp;   // published first
const b = require("./b");       // circular: b.js requires a.js BACK, here
class C {                       // class evaluation -> static field runs
  static before = "initialized before the throw";
  static x = bail();            // -> throws -> a.js's load fails
  static after = "NEVER initialized";
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
// c.js -- the INSTANCE-field control, one token different
module.exports = dangerousOp;
class C { x = bail(); }         // installs an initializer; runs nothing
module.exports = safeOp;        // REACHED -- and genuinely authoritative
```

`a.js` requires `b.js`, and `b.js` requires `a.js` right back — a genuine
CommonJS circular dependency. Node's own documented circular-require
semantics hand `b.js` whatever `a.js`'s `module.exports` currently holds AT
THE MOMENT of the circular `require()` call, not the module's eventual final
value. Since `a.js` assigns `module.exports = dangerousOp` before requiring
`b.js`, `b.js` retains a live reference to the dangerous branch.

## Running it

```
$ node entry.js
[a.js] publishing dangerousOp as module.exports
[a.js] requiring ./b (circular back-reference to a.js)
[b.js] retained from circular require(a): dangerousOp
[a.js] evaluating `class C { static x = bail(); }` -- about to throw

=== after require('./a') ===
a.js load threw: a.js: bail() always throws
a.js's own export (safeOp) observed by entry.js: undefined

=== cyclic observer b.js ===
b.js retained the DANGEROUS export: dangerousOp

=== calling the retained dangerous export ===
vulnerable sink executed, result: EXPLODED:payload-from-entrypoint

=== instance-field control ===
[c.js] class C evaluated WITHOUT calling bail(); publishing safeOp
c.js exported: safeOp (safeOp -- the class did not throw)
c.js's instance field throws only on construction: c.js: bail() always throws (instance field, on construction)

=== re-requiring ./a after its throw ===
[a.js] publishing dangerousOp as module.exports
[a.js] requiring ./b (circular back-reference to a.js)
[a.js] evaluating `class C { static x = bail(); }` -- about to throw
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
2. **Class evaluation executes the static field initializer.** `a.js`
   prints `evaluating \`class C { static x = bail(); }\` -- about to throw`
   immediately before the class declaration executes, and never prints the
   line after it (`[a.js] class C evaluated, C.x = ...`) — the class
   definition does not complete, so `C` is never bound. `static before` had
   already initialized and `static after` never did, which is the
   declaration-order execution this depends on.
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
7. **An INSTANCE field is genuinely different, in the same process.**
   `c.js` holds the identical always-throwing call in an instance field.
   Its class definition completes, `[c.js] class C evaluated WITHOUT
   calling bail()` is printed, `module.exports = safeOp` really does run,
   and `require("./c")` returns `safeOp`. The call only throws when
   `new C()` is evaluated later, on a caller's decision. So an instance
   field must NOT withdraw a later export's authority — doing so would be a
   false refusal, not conservatism.

## Why this matters for RWF-018

RWF-016 taught VulnTrace that a resolvable, always-throwing local call ends
module evaluation exactly as a literal `throw` would, and RWF-017 taught it
that the call's syntactic position does not change that. Both recognised the
call only in *statement* positions (`bail();` and `const x = bail();`). A
class static field initializer is neither: it hangs off a
`PropertyDeclaration`, and it is executed by *class evaluation*, which is
itself part of module evaluation.

Before RWF-018, VulnTrace considered `module.exports = safeOp` DEFINITELY
reached and authoritative, reported `safeOp` as the module's exported
identity with `dangerousOp` unreachable, and could issue a Family C negative
proof — a false `NOT_AFFECTED` for a package that reaches the sink on every
load taking this branch.

See `tests/validation/FINDINGS.md`'s RWF-018 entry and the analyzer-facing
fixture `fixtures/commonjs-static-field-throwing-call-export-authority/`
(wired into VulnTrace's own test suite) for the static-analysis side of this
fix.
