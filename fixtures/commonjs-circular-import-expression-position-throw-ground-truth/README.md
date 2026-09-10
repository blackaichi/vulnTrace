# RWF-026 runtime ground truth: a circular `require()` observes a dangerous export bypassed by a throwing call in a NECESSARILY EVALUATED EXPRESSION POSITION

This fixture is **not** scanned by VulnTrace's own test suite — it is a plain
Node.js program, run directly with `node entry.js`. It is the RWF-026
counterpart of
`fixtures/commonjs-circular-import-object-literal-computed-key-throw-ground-truth/`
(RWF-024), and it differs from that one in exactly one respect: the
resolvable, always-throwing local call is not written in any single
privileged syntactic slot at all. It is an ordinary operand of an ordinary
expression:

```js
sink(before(), bail(), after());
```

Everything else — the circular observer, the dangerous export published
first, the later `module.exports = safeOp` — is held identical on purpose,
so the run isolates the single question RWF-026 asks: *does normal
completion of this expression REQUIRE evaluating that call?* Here it does.
ECMAScript's `EvaluateCall` evaluates every argument, left to right, into an
argument list **before** the callee is ever entered, so `sink` is never
called, `after()` never runs, the statement never completes, and nothing
below it runs either.

## Why this is a different rule from RWF-016/017/018/019/020/024

Each of those recognises a definitely-abrupt call in one named POSITION: a
bare expression statement, a declarator's whole initializer, a class static
field's initializer, a class element's computed key, a class's `extends`
heritage, an object literal's computed key. Every one of them is a shape
test on the node that directly holds the call.

RWF-026 asks a different question, one no shape test can answer: given an
expression that is being evaluated at module time, must evaluating it reach
an already-proven definitely-abrupt call before it can complete normally?
That is a property of ECMAScript evaluation ORDER over operand positions,
not of which AST slot the call happens to sit in. RWF-026 does **not** widen
which calls can be proven abrupt — that stays RWF-016's exact-local-callee
proof, consumed here unchanged. It widens only WHERE such a proven call is
necessarily evaluated.

## The soundness rule, and why no evaluation order is needed for it

An expression completes normally only if every operand position the language
REQUIRES it to evaluate completes normally first. So if any required operand
cannot complete normally, neither can the enclosing expression — regardless
of which operand runs first:

```js
safe() + bail();
```

Either `safe()` completed (so `bail()` is reached and throws) or it did not
(so the `+` never completes either way). Both readings agree. `positions.js`
still MEASURES the real order for thirteen forms, because pinning it keeps
the documented reading of each form honest — but the analyzer's proof does
not rest on it.

## The precision boundary this fixture exists to defend

A position is required only when the enclosing expression cannot complete
normally WITHOUT evaluating it. These are NOT required, and `c.js` plus
`positions.js`'s second table prove each one completes under real Node:

- a logical operator's RIGHT operand (`flag && bail()`) and a logical
  assignment's RHS (`z ||= bail()`) — both short-circuit;
- either arm of a conditional expression (`flag ? bail() : safe()`);
- anything inside a function: a function/arrow body, a callback, a
  method/getter/setter body, a **default parameter**;
- a class **instance** field initializer (`class C { f = bail(); }`), which
  is per-construction, unlike the **static** field and static block in the
  first table, which are class-definition time;
- a `for` loop's UPDATE expression and a `do`/`while`'s condition, neither of
  which is reached until the body has completed;
- an argument or index guarded by an OPTIONAL CHAIN
  (`undefined?.m(bail())`, `undefined?.[bail()]`), skipped entirely on a
  nullish base;
- a call caught by an enclosing `try`/`catch`.

`bail?.()` is on the REQUIRED side, and correctly: an optional call
short-circuits only on a nullish CALLEE, and the analyzer only ever resolves
a hoisted function declaration or a never-reassigned `const`-bound function
expression, neither of which can be nullish.

## The shape

```js
// a.js
function dangerousOp(input) { return danger.explode(input); }
function bail() { throw new Error("a.js: bail() always throws"); }

module.exports = dangerousOp;   // published FIRST
const b = require("./b");       // b requires us back and retains it

sink(before(), bail(), after());   // arguments evaluate BEFORE sink is entered

module.exports = safeOp;        // NEVER REACHED
```

## Run it

```sh
node entry.js
```

Observed under real Node (v22.11.0):

- `require('./a')` throws; `a.js`'s exported value is never `safeOp`;
- `b.js`, requiring `a.js` back mid-evaluation, retains `dangerousOp` and
  calls it successfully — the reachable vulnerable sink;
- `before()` runs and `after()` never does, and `sink` is never entered;
- all **45** required positions in `positions.js` throw;
- all **20** conditional/deferred positions complete;
- `c.js`, the conditional/deferred control, completes and publishes `safeOp`.

The analyzer must therefore refuse to treat `a.js`'s later
`module.exports = safeOp` as authoritative, while continuing to treat
`c.js`'s as exactly that.
