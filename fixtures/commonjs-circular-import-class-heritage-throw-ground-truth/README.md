# RWF-020 runtime ground truth: a circular `require()` observes a dangerous export bypassed by a throwing call in a class's `extends` HERITAGE expression

This fixture is **not** scanned by VulnTrace's own test suite — it is a plain
Node.js program, run directly with `node entry.js`. It is the RWF-020
counterpart of
`fixtures/commonjs-circular-import-computed-class-key-throw-ground-truth/`,
and it differs from that one in exactly one respect: the resolvable,
always-throwing local call sits on no class **element** at all. It is the
class's **heritage expression**, and the class body is **empty**:

```js
class C extends bail() {}
```

Everything else — the circular observer, the dangerous export published
first, the later `module.exports = safeOp` — is held identical on purpose,
so the run below isolates the single question RWF-020 asks: *does evaluating
a class definition evaluate its `extends` expression, and when?* It does,
and it does so **first**. ClassDefinitionEvaluation evaluates the heritage
expression before it does anything else with the class: the superclass value
has to be in hand before the prototype chain can be built, so it runs
strictly before every computed key (RWF-019), every static field initializer
(RWF-018) and every static block (RWF-015). Reaching the class therefore
necessarily invokes `bail()`, the class definition never completes, `C` is
never bound, and nothing below it runs.

**Why this is a different rule from RWF-018/019, not a widening of either.**
Both of those predicates are handed a class ELEMENT — a `PropertyDeclaration`
for RWF-018, a `ClassElement` with a `ComputedPropertyName` for RWF-019. An
empty-bodied `class C extends bail() {}` has neither. The heritage clause is
the only class-definition-time expression that still runs when the class body
is completely empty, which is exactly why neither predecessor could see it.

## The shape

```js
// a.js
function dangerousOp(input) { return danger.explode(input); }
function bail() { throw new Error("a.js: bail() always throws"); }

module.exports = dangerousOp;   // published first
const b = require("./b");       // circular: b.js requires a.js BACK, here
class C extends bail() {        // heritage runs FIRST -> throws -> load fails
  [tag("computed key -- NEVER evaluated")] = 1;
  static x = tag("static field -- NEVER evaluated");
}
function safeOp(input) { return "safe:" + input; }
module.exports = safeOp;        // UNREACHABLE on this path
```

```js
// b.js -- the cyclic observer
const retainedFromA = require("./a");   // gets a.js's CURRENT module.exports
module.exports = { retained: retainedFromA };
```

## Run it

```console
$ node entry.js
```

## What the run proves

Measured under `node` v26.7.0, exit code 0:

1. **The dangerous export is assigned first.** `a.js` publishes
   `dangerousOp` as `module.exports` before anything else happens.
2. **The cycle retains the exact dangerous value.** `b.js` requires `a.js`
   back mid-evaluation and Node hands it `module.exports` as it currently
   stands: `b.js retained the DANGEROUS export: dangerousOp`.
3. **The class definition begins and the heritage expression runs.**
4. **`bail()` throws**, and the class definition aborts.
5. **The class body is never reached.** Neither the computed key nor the
   static field on that same class is evaluated — see the ordering section
   below, where this is measured rather than asserted.
6. **The later safe export never executes.** `a.js`'s load throws, and
   `entry.js` observes `a.js's own export (safeOp) ... undefined`.
7. **The retained dangerous export invokes the vulnerable sink.**
   `b.retained("payload-from-entrypoint")` returns
   `EXPLODED:payload-from-entrypoint`.
8. **Re-requiring is coherent.** `require("./a")` a second time re-throws
   deterministically — `safeOp` is never this module's exported value on
   this code path, on any load.

## Heritage evaluates BEFORE any class element

The ordering claim RWF-020 rests on is measured, not assumed. With a
throwing heritage:

```text
class definition threw: throwingBase() always throws
evaluated, in order: ["heritage"]
-> heritage ran first and NOTHING else ran: true
```

and with a harmless one, the elements do run — so the line above is
genuinely "heritage aborted it", not "elements never run here":

```text
with a harmless heritage: ["computed key","static field"] on D
```

## Every heritage form, measured in the same process

`forms.js` runs each form inside a `try` and reports whether the class
DEFINITION completed, and if not, **why** — because the "why" is the whole
point. Three of these throw for a reason RWF-020 deliberately does **not**
claim:

| Form | Outcome |
| --- | --- |
| `class C extends bail() {}` | `THREW: Error: bail() always throws` |
| `const C = class extends bail() {}` | `THREW: Error: bail() always throws` |
| `class C extends (bail()) {}` | `THREW: Error: bail() always throws` |
| `class C extends baseFactory() {}` **[control]** | `COMPLETED` |
| `class C extends null {}` **[control]** | `COMPLETED` |
| `class C extends asyncBail() {}` | `THREW: TypeError: Class extends value #<Promise> is not a constructor or null` |
| `class C extends generatorBail() {}` | `THREW: TypeError: Class extends value [object Generator] is not a constructor or null` |
| `class C extends notAConstructor() {}` | `THREW: TypeError: Class extends value 1 is not a constructor or null` |
| `class C extends conditionalBail() {}` (flag off) | `COMPLETED` |
| `class C extends conditionalBail() {}` (flag on) | `THREW: Error: conditionalBail() threw this time` |
| `function configure() { class C extends bail() {} }` | `COMPLETED` |
| `class Outer { field = class extends bail() {}; }` | `COMPLETED` |

The three `TypeError` rows are the reason RWF-020 is scoped to the
**call**, not to the heritage **value**:

- an `async` callee's `throw` becomes a rejected promise, so the CALL
  completes normally and the definition fails later, on the returned value;
- a generator callee's body does not run on call at all, so likewise;
- `notAConstructor()` returns `1` and fails for the identical reason.

All three genuinely do bypass a later export at runtime, but proving that
needs value/type interpretation VulnTrace does not have. They are recorded
as a separate open finding (invalid-heritage-result) in
`tests/validation/FINDINGS.md` rather than folded into RWF-020. The
`async` and generator exclusions come free and unchanged from RWF-016's
`cannotCompleteNormally`, which already refuses both callee shapes — so
RWF-020 reaches the correct answer on them for the correct reason.

## The negative controls (`c.js`)

`c.js` is `a.js` with the heritage made harmless, and it is required by the
same `entry.js` in the same process. Its class definitions complete,
`baseFactory()` is called and returns, `extends null` evaluates no call,
and the later export really is published:

```text
[c.js] baseFactory() called -- returns normally
[c.js] both class definitions completed WITHOUT throwing; publishing safeOp
c.js exported: safeOp
c.js's `extends null` class: N -- prototype is null
c.js's deferred class throws only when configure() runs: c.js: bail() always throws
```

Withdrawing export authority in any of those cases would be a **false
refusal**, not conservatism — which is what makes RWF-020 sound rather than
merely cautious.
