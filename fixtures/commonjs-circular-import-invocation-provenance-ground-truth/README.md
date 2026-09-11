# RWF-028 ground truth — invocation / provenance soundness

Real-`node`, asserted evidence for RWF-028 (P0-E). Run it:

```bash
node fixtures/commonjs-circular-import-invocation-provenance-ground-truth/entry.js
```

It exits `0` only if real Node behaves exactly the way VulnTrace's
invocation/provenance model says it does. Nothing here is printed without
also being asserted.

## What it proves

`a.js` is RWF-016's fixture with exactly one thing changed: the call that
ends module evaluation is a **one-hop const alias**, not a bare call.

```js
function bail() { throw new Error("boom"); }
const alias = bail;

module.exports = dangerousOp;   // published first
const b = require("./b");       // circular: b.js retains dangerousOp
alias();                        // <- ends module evaluation here
module.exports = safeOp;        // NEVER RUNS
```

Every ingredient RWF-016 needs was already present and already proven —
`bail` is a local, never-reassigned function declaration whose body throws
on every path. The only thing RWF-016 could not do was say *which*
function `alias()` enters, and on that alone it kept the later export's
authority and answered `NOT_AFFECTED` with a complete Family C proof for a
package that reaches the sink on every load.

`entry.js` asserts, in order:

1. `alias()` entered **`bail`'s own body** (the identity claim, measured
   through the trace log, not inferred from the abort), the load threw
   `Error: boom`, and `module.exports = safeOp` never ran;
2. `const alias = f` binds the *same function object* as `f`;
3. the circular importer really retained `dangerousOp` **by identity**, and
   calling it really reaches the vulnerable sink;
4. a failed load re-throws coherently on re-`require`;
5. the boundaries this rule must not cross — an `async` callee returns a
   rejected promise rather than throwing synchronously, a generator body
   does not start on call, and `new` on an arrow/`async`/generator throws
   `TypeError` **without entering the body** (measured with a body-entry
   flag, so "the arrow's body ran" cannot be claimed); plus duplicate
   object keys resolving in source order, last write winning, both ways
   round.

## The outcome matrix

`forms.js` writes **47 real modules** to disk, loads each with real `node`,
and measures the only thing that matters: did evaluation reach the later
export write?

- **15 proven cutoffs** — rows RWF-028 claims, every one of which genuinely
  aborts. A row that VulnTrace proves but that *completes* would be a false
  AFFECTED, and the matrix fails on it.
- **23 refused rows that genuinely complete** — the safe alias, the
  reassigned alias and object binding, the overwritten and safe-last
  duplicate property, the escaping object, the safe inner shadow, the
  conditional/returning/catching/deferring wrappers, the `async` and
  generator callees in every provenance form, the caught and deferred
  contexts, and an unrelated safe call in a file that also declares a
  throwing callable. Proving any of these would invent a verdict.
- **9 documented precision gaps** — rows real `node` aborts and this
  analyzer declines to prove: source rebinding after alias capture, `new`
  on a non-constructable callable (three forms), an object method
  shorthand, a class constructor body, and the forms past the documented
  one-alias-hop / two-wrapper-hop / static-member bounds. These cost
  precision, never soundness, and are listed in `tests/validation/FINDINGS.md`
  under RWF-028's remaining limitations. The matrix asserts the gap list
  itself, so it cannot silently drift.
