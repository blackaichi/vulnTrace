# RWF-016 runtime ground truth: a circular `require()` observes a dangerous export a throwing call bypasses

This fixture is **not** scanned by VulnTrace's own test suite — it is a plain
Node.js program, run directly with `node entry.js`, whose only job is to
establish REAL RUNTIME TRUTH for the scenario RWF-016 fixes: that a later,
syntactically-unconditional `module.exports = safeOp` write can be genuinely
bypassed by a local, resolvable, always-throwing call (`bail()`), AND that
the earlier, more dangerous export it leaves behind is not merely a
theoretical possibility — a real CommonJS consumer can observe and retain
it, and call into the vulnerable sink through it.

## The shape

```js
// a.js
function dangerousOp(input) { return danger.explode(input); }
function bail() { throw new Error("a.js: bail() always throws"); }

module.exports = dangerousOp;   // published first
const b = require("./b");       // circular: b.js requires a.js BACK, here
bail();                         // never returns -- a.js's load itself fails
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
semantics (see the Node.js docs' "Cyclic modules" section) hand `b.js`
whatever `a.js`'s `module.exports` currently holds AT THE MOMENT of the
circular `require()` call, not the module's eventual final value. Since
`a.js` assigns `module.exports = dangerousOp` before requiring `b.js`,
`b.js` retains a live reference to the dangerous branch.

## Running it

```
$ node entry.js
[a.js] publishing dangerousOp as module.exports
[a.js] requiring ./b (circular back-reference to a.js)
[b.js] retained from circular require(a): dangerousOp
[a.js] calling bail() -- about to throw

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
[a.js] calling bail() -- about to throw
require('./a') re-threw deterministically: a.js: bail() always throws
-> safeOp is NEVER the module's exported value on this code path.
```

(Captured verbatim from a real `node` run; reproduced with Node.js's
built-in CommonJS loader, no mocking.)

## What this proves, fact by fact

1. **The earlier dangerous export is observable.** `b.js`'s own
   `require("./a")` call returns `dangerousOp`, proven by
   `retainedFromA.name === "dangerousOp"`.
2. **`bail()` throws**, and its exception propagates out of `a.js`'s own
   `require()` — `entry.js`'s first `require("./a")` throws
   `"a.js: bail() always throws"`.
3. **The later `safeOp` export is never reached.** `a.js`'s own exports
   (`aExports`) is `undefined` after the throw — `module.exports = safeOp`
   is dead code on this path, and `require("./a")` called again
   afterwards re-runs `a.js` from scratch (Node evicts a module that threw
   during its first load from `require.cache`) and re-throws
   *deterministically* — `safeOp` is not a fluke miss, it is unreachable on
   every load that takes this branch.
4. **The cyclic observer retains the dangerous value**, independent of
   `a.js`'s own eventual (failed) completion: `b.js` finished loading
   successfully, is fully cached, and `entry.js`'s own `require("./b")`
   (after `a.js`'s `require()` already threw) returns it with
   `retained === dangerousOp` intact.
5. **The vulnerable sink executes.** `entry.js` calls `b.retained(...)`,
   which is `dangerousOp(...)`, which calls `danger.explode(...)` and
   returns real output (`"EXPLODED:payload-from-entrypoint"`) — not a
   dead-code path, a live call.

## Why this matters for RWF-016

Before RWF-016, VulnTrace's static model treated `bail()` as an ordinary
call with no effect on control flow, so it considered
`module.exports = safeOp` DEFINITELY reached and authoritative — and would
report `safeOp` (and only `safeOp`) as the module's exported identity, with
`dangerousOp` unreachable. This fixture demonstrates that is not merely
imprecise but actively unsound for a coherent, realistic consumption
pattern: a sibling module in the same package graph, participating in an
ordinary circular dependency, can and does retain the dangerous branch and
use it — while `safeOp` is never the module's value at all on this path.

See `tests/validation/FINDINGS.md`'s RWF-016 entry and the analyzer-facing
fixture `fixtures/commonjs-local-throwing-call-export-authority/` (wired
into VulnTrace's own test suite) for the static-analysis side of this fix.
