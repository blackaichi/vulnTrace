# RWF-022 runtime ground truth: a circular `require()` observes a dangerous export bypassed by a class whose heritage VALUE is invalid

This fixture is **not** scanned by VulnTrace's own test suite — it is a plain
Node.js program, run directly with `node entry.js`, and every claim it makes
is **asserted** with `node:assert/strict` rather than printed. It exits `0`
only if real Node behaves exactly as VulnTrace's model says it does.

It is the RWF-022 counterpart of
`fixtures/commonjs-circular-import-class-heritage-throw-ground-truth/`
(RWF-020), and it differs from that one in exactly one respect, which is the
whole point of the task:

```js
// RWF-020 -- the CALL is abrupt
function bail() { throw new Error("boom"); }
class C extends bail() {}

// RWF-022 -- the call RETURNS NORMALLY; the returned VALUE is invalid
function notAConstructor() { return 1; }
class C extends notAConstructor() {}
```

Both end module evaluation. They do so for **different reasons**, and
conflating them is the mistake this fixture exists to prevent. RWF-020 asks
*"does evaluating the heritage expression complete?"* — here it does.
RWF-022 asks the separate question *"is the value it produced usable as a
superclass?"* — here it is not, so ClassDefinitionEvaluation throws
`TypeError: Class extends value 1 is not a constructor or null`.

## The shape

```js
// a.js
function dangerousOp(input) { return danger.explode(input); }
function notAConstructor() { return 1; }   // returns NORMALLY, every time

module.exports = dangerousOp;   // published first
const b = require("./b");       // circular: b.js requires a.js BACK, here
class C extends notAConstructor() {   // call returns 1 -> heritage invalid
  [tag("computed key")] = 1;          //   -> TypeError -> load fails
  static x = tag("static field");
}
function safeOp(input) { return "safe:" + input; }
module.exports = safeOp;        // UNREACHABLE on this path
```

```js
// b.js -- the cyclic observer
const retainedFromA = require("./a");   // gets a.js's CURRENT module.exports
module.exports = { retained: retainedFromA };
```

## What `node entry.js` asserts

1. `dangerousOp` was assigned to `module.exports`.
2. The circular importer `b.js` retained **that exact value** (`dangerousOp`,
   by identity — and explicitly *not* `safeOp`).
3. The heritage call was reached and `notAConstructor`'s body was entered.
4. The call **returned normally**, with `1` — asserted by running the same
   factory in isolation. This is the fact RWF-020 cannot use.
5. The **class definition** threw `TypeError`, matching
   `/^Class extends value 1\b/` and `/is not a constructor or null/`.
6. No class element **initializer** ran, and `C` was never bound — see the
   asymmetry note below.
7. `module.exports = safeOp` never ran; `require("./a")` yielded no value at
   all, and nothing anywhere observed `safeOp`.
8. The retained dangerous export, when invoked, **reaches the vulnerable
   sink** (asserted against a call counter inside `danger.js`).
9. Re-`require`ing the failed module re-throws deterministically — a failed
   CommonJS load is not cached as a success — so `safeOp` is *never* this
   module's exported value on this code path.

Plus a negative control (`c.js`) and a 31-row measured table (`forms.js`).

## The asymmetry worth knowing about

This was **measured, not assumed**, and it is the one place the two families
genuinely differ in observable behavior:

| heritage failure | computed KEY | static field init | static block | class bound |
| --- | --- | --- | --- | --- |
| RWF-020 — the call throws | not evaluated | not evaluated | not evaluated | no |
| RWF-022 — the value is invalid | **evaluated** | not evaluated | not evaluated | no |

When the call itself throws, the exception escapes from inside the heritage
expression and nothing else in the class is ever reached. When the call
returns, evaluation proceeds far enough for V8 to evaluate the class body's
computed property **keys** before it performs the `IsConstructor` check on
the superclass value — so a computed key runs, then the `TypeError` is
thrown. Field initializers and static blocks never run either way.

RWF-020's own README says a throwing heritage "leaves the element list
entirely unevaluated". That statement is correct **for RWF-020** and does not
carry over to RWF-022; the table above is the accurate joint statement.

**None of this weakens the analyzer's cutoff.** The cutoff rests on exactly
one fact — *the class definition does not complete, so no later top-level
statement runs* — and that fact holds identically in both rows. The
computed-key difference is about what happens *inside* the class statement,
which the cutoff never claimed anything about.

## The negative control (`c.js`)

Held identical to `a.js` except that every heritage value is valid, so the
module completes and its **later, safe** export really is authoritative.
Withdrawing authority here would be a false refusal — the failure mode
RWF-022 is most exposed to:

- `extends makeBase()` → returns a class;
- `extends makeCtor()` → returns an ordinary function;
- `extends makeNull()` → returns `null`, which `extends` **accepts** (and the
  fixture asserts the resulting prototype chain really does terminate);
- `extends maybeBase(true)` → two returns, one of them invalid — not
  definitely anything, and must stay unclassified;
- `class Deferred extends notAConstructor() {}` inside an uncalled
  `configure()` → deferred, and asserted to throw only when `configure()` is
  actually invoked.

## The measured value table (`forms.js`)

31 rows, each asserting `completed` or `threw:TypeError`. It covers every
category RWF-022 classifies (number, bigint, string, template, boolean,
object literal, array literal, arrow, async/generator/async-generator
function values, bare `return;`, empty body, concise arrow body), every
category it must **refuse** to classify (`null`, class, ordinary function),
the three callee-identity cases (`async`, generator, async generator), direct
non-call heritage, and two shapes it deliberately leaves **unmodeled**
(`Base.bind(null)`, `new Proxy({}, {})`) so the fixture records what is being
left on the table rather than hiding it.

Two rows are worth calling out because they look like they might go the other
way and do not:

- `{ __proto__: Function.prototype }` — sets the object's **prototype**, but
  `[[Construct]]` is an internal method, not an inherited property. Still not
  a constructor.
- `{ constructor: function () {} }` — a `constructor` **property** has
  nothing to do with constructability either.

## Run it

```console
$ node entry.js
...
ALL RWF-022 GROUND-TRUTH ASSERTIONS PASSED
$ echo $?
0
```

Measured under `node v26.7.0`.
