# RWF-017 runtime ground truth: a circular `require()` observes a dangerous export bypassed by a throwing call in a VARIABLE INITIALIZER

This fixture is **not** scanned by VulnTrace's own test suite — it is a plain
Node.js program, run directly with `node entry.js`. It is the RWF-017
counterpart of
`fixtures/commonjs-circular-import-throwing-export-ground-truth/`, and it
differs from that one in exactly one respect: the resolvable,
always-throwing local call is not a bare `bail();` expression statement, it
is the **initializer of a variable declaration**:

```js
const result = bail();
```

Everything else — the circular observer, the dangerous export published
first, the later `module.exports = safeOp` — is held identical on purpose,
so the run below isolates the single question RWF-017 asks: *does abrupt
module-evaluation behavior depend on whether the CallExpression happens to
be wrapped in an ExpressionStatement?* It does not. JavaScript evaluates a
declarator's initializer as part of executing the declaration, so reaching
the statement necessarily invokes `bail()`, the declaration never completes,
`result` is never bound, and nothing below the statement runs.

## The shape

```js
// a.js
function dangerousOp(input) { return danger.explode(input); }
function bail() { throw new Error("a.js: bail() always throws"); }

module.exports = dangerousOp;   // published first
const b = require("./b");       // circular: b.js requires a.js BACK, here
const result = bail();          // initializer evaluated -> throws -> a.js's load fails
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
[a.js] evaluating `const result = bail()` -- about to throw

=== after require('./a') ===
a.js load threw: a.js: bail() always throws
a.js's own export (safeOp) observed by entry.js: undefined

=== cyclic observer b.js ===
b.js retained the DANGEROUS export: dangerousOp

=== calling the retained dangerous export ===
vulnerable sink executed, result: EXPLODED:payload-from-entrypoint

=== re-requiring ./a after its throw ===
[a.js] publishing dangerousOp as module.exports
[a.js] requiring ./b (circular back-reference to a.js)
[a.js] evaluating `const result = bail()` -- about to throw
require('./a') re-threw deterministically: a.js: bail() always throws
-> safeOp is NEVER the module's exported value on this code path.
```

(Captured verbatim from a real `node` run; reproduced with Node.js's
built-in CommonJS loader, no mocking.)

## What this proves, fact by fact

1. **The dangerous export is assigned before the initializer runs.**
   `[a.js] publishing dangerousOp as module.exports` is printed first, and
   the circular `require("./b")` happens while it is still the module's
   value.
2. **The initializer invokes `bail()`.** `a.js` prints
   `evaluating \`const result = bail()\` -- about to throw` immediately
   before the declaration executes, and never prints the line after it
   (`[a.js] const result bound to: ...`) — the declaration does not
   complete, so `result` is never bound.
3. **`bail()` throws**, and its exception propagates out of `a.js`'s own
   `require()` — `entry.js`'s first `require("./a")` throws
   `"a.js: bail() always throws"`.
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

## Why this matters for RWF-017

RWF-016 taught VulnTrace that a resolvable, always-throwing local call ends
module evaluation exactly as a literal `throw` would — but only recognised
that call in one syntactic position, a bare `ExpressionStatement`. This
fixture shows the identical runtime consequence arising from the identical
call in an initializer position, which RWF-016 did not see: before RWF-017,
VulnTrace considered `module.exports = safeOp` DEFINITELY reached and
authoritative, reported `safeOp` as the module's exported identity with
`dangerousOp` unreachable, and could issue a Family C negative proof — a
false `NOT_AFFECTED` for a package that reaches the sink on every load
taking this branch.

See `tests/validation/FINDINGS.md`'s RWF-017 entry and the analyzer-facing
fixture `fixtures/commonjs-initializer-throwing-call-export-authority/`
(wired into VulnTrace's own test suite) for the static-analysis side of this
fix.
