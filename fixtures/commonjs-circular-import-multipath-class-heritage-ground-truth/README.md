# RWF-027 ground truth — multi-path class-definition completion

Run it:

```
node entry.js
```

It exits 0 only if real Node behaves exactly the way VulnTrace's multi-path
class-heritage model says it does. Every claim is `assert`ed, not printed.

Measured under **node v22.11.0**.

## What this fixture proves that the RWF-020 and RWF-022 ones do not

RWF-020's fixture shows a heritage call that **always throws**. RWF-022's
shows a heritage call that **always returns one invalid value**. Each asks
about a single ending.

This one has a factory with **two** endings, and neither existing rule can
say anything about it:

```js
function maybe(flag) {
  if (flag) {
    throw new Error("boom");   // ending 1
  }
  return 1;                    // ending 2
}

class C extends maybe(FLAG) {}
```

- `cannotCompleteNormally(maybe)` is **false** — one path returns. RWF-020
  declines.
- `classifyExactCallReturnValue(maybe)` is **`"unknown"`** — the body is not a
  single unconditional return. RWF-022 declines.

Yet **every** path prevents the class definition from completing, for two
*different* reasons:

| `FLAG` | the call | the class definition | later `module.exports = safeOp` |
| --- | --- | --- | --- |
| truthy | `throw Error: boom` | never entered | **never runs** |
| falsy | returns `1`, **normally** | `TypeError: Class extends value 1 is not a constructor or null` | **never runs** |

`a.js` measures the truthy path and `a-falsy.js` the falsy one, each inside
its own real circular-require graph, because proving one flag value fatal
proves nothing about the path *set*. "A TypeError happened" is not the
assertion here; "no flag value ever published `safeOp`" is.

## The distinction the whole task rests on

RWF-027 does **not** prove "this call cannot complete normally". Assertion 3
in `entry.js` calls the very same factory outside any heritage position and
checks that `maybe(false) === 1`, without throwing. The call is perfectly
ordinary.

What is proven is narrower and different:

> evaluating **this class heritage** cannot lead to a normally completed
> class definition.

So `maybe(FLAG);` as a plain statement stays exactly as unproven as RWF-016
leaves it, and the analyzer must not treat module evaluation as ending there.
`module-model.multipath-class-definition-completion.test.ts` pins that
boundary.

## The negative control is the load-bearing half

`c.js` is deliberately parallel to `a.js`: every factory in it also has two
endings, but each keeps **one** ending that leaves the class definition able
to complete —

| factory | endings | class definition |
| --- | --- | --- |
| `throwOrBase` | throw, `Base` | **completes** on the falsy path |
| `invalidOrBase` | `1`, `Base` | **completes** |
| `invalidOrNull` | `1`, `null` | **completes** — `class C extends null {}` is legal |
| `throwOrNull` | throw, `null` | **completes** |
| `nestedWithValidLeaf` | `Base` two levels down, throw, `2` | **completes** at `(true, true)` |

`entry.js` asserts all five classes were really bound and that `c.js`
published `safeOp`. Withdrawing authority for any of them would be an
overreach — reporting a class definition that demonstrably completes as
fatal — and that is the failure mode RWF-027 is most exposed to.

`null` in particular must never be folded in with the non-constructable
values; the fixture checks that `ExtendsInvalidOrNull`'s prototype chain
really is terminated by `Object.getPrototypeOf(...) === null`.

## The full outcome matrix

`forms.js` runs every row against **every** relevant flag combination,
performs the real class definition with the value that ending produced, and
compares "no combination completes" against what VulnTrace's model claims.
Ten rows are fatal on every path (including `throw + throw`, implicit
`undefined` fallthrough, a bare `return;`, an empty body and an all-fatal
nested `if`); six keep a good path and must be refused. `entry.js` asserts
zero mismatches.
