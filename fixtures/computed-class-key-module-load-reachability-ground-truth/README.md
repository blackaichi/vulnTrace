# RWF-023 runtime ground truth: which class-definition-time expressions execute during module evaluation

This fixture is **not** scanned by VulnTrace's own test suite — it is a plain
Node.js program, run directly with `node entry.js`. Every claim it makes is
`assert`ed, not printed: a wrong answer fails the process, and the table it
prints at the end is the record of a run that already passed.

It exists because RWF-023 is a **reachability** finding, not an
export-authority one. Every finding from RWF-014 through RWF-022 asks *which
export write is authoritative*; this one asks a prior question — *which code
does the analyzer believe runs at load time at all?* Answering that from a
reading of the specification would be exactly the kind of assumption this
repository does not accept, so the answer is measured in a real engine.

## The claim

> A computed property **key** on a class element is evaluated by
> ClassDefinitionEvaluation, as the element is defined, for **every** element
> kind. The element's **body** or **value** is not.

RWF-019 already relies on the first half in the *abrupt* direction: a
computed key that throws ends module evaluation. RWF-023 is the
*reachability* direction of the same fact — a computed key that **calls**
something has called it, on every load, and the callee's body is executed
code.

## What the run settles

**All eight element forms evaluate their key.** Instance field, static
field, instance method, static method, getter, setter, `async` method and
generator method. There is no static/instance split here and no
method/field split: the key has to exist before the element can be
installed, whatever the element is.

```js
class C { [key()] = 1; }        // key runs
class C { [key()]() {} }        // key runs
class C { get [key()]() {} }    // key runs
class C { async [key()]() {} }  // key runs
```

**The key is an ordinary expression.** Parenthesized, nested in another
call, a sequence, a template substitution, a short-circuit operand — all of
them run, which is why RWF-023 routes the key through the call graph's
normal expression traversal instead of pattern-matching a bare `key()`.

**A conditional class is still reachable.** `if (flag) { class C { [key()]() {} } }`
runs the key whenever the branch is taken. Reachability is a MAY-execute
question; RWF-019's cutoff is a MUST-execute one. The two must not share
predicates, and this fixture is where the difference is made concrete.

**Heritage runs first, then keys in declaration order, then static blocks.**
Measured, not assumed:

```
heritage -> key1 -> key2 -> staticblock
```

**A computed key runs even when the heritage value is invalid.** This is the
interaction the independent RWF-022 audit turned up, and it is the reason
RWF-023 could not be folded into that task:

```js
class C extends makeInvalid() { [key()]() {} }   // key runs, THEN TypeError
```

RWF-022 correctly withdraws the authority of any export written below that
statement. That is a statement about later exports, and it says nothing
about the sink the key has already reached. A target must not be lost
because a cutoff family fired further down the same line.

**A static field initializer and a static block are class-definition time.**
A class nested inside either really is defined during module evaluation, so
its own computed key runs too.

## What the run rules OUT

These are the controls that keep RWF-023 sound rather than merely
permissive. Not one of them reaches the sink at module load, and the
identical computed key is used in every case — only the *position of the
class definition* changes:

| shape | runs at load? |
| --- | --- |
| class in an uncalled function / arrow / callback | no |
| class in a method, getter or constructor body | no |
| nested class held by an **instance** field | no |
| object literal held by an **instance** field | no |
| class in a method or setter **parameter default** | no |
| a dangerous call in a method body | no |
| a dangerous call in an **instance** field's VALUE | no |
| a dangerous call in a getter body | no |

The instance-field row is the important one, and it is the difference
between a fix and an over-approximation. The *enclosing* class really is
being defined at module load — a rule that stopped at "the class is at
module scope" would root this key wrongly and manufacture a false
`AFFECTED`:

```js
class Outer {
  field = class Inner { [key()]() {} };   // Inner is NOT defined at load
}
```

The last three rows restate RWF-018's line, unchanged: the same element's
**key** is definition-time while its **value** is per-instance.

## Key versus body, in one class

The final assertion pins the distinction that makes the whole family
tractable — the key runs at definition, the body runs only when called, and
constructing an instance is not enough:

```js
class WithBody {
  [(danger.explode("KEY"), "x")]() { danger.explode("BODY"); }
}
// after definition:      ["KEY"]
// after new WithBody():  ["KEY"]
// after instance.x():    ["KEY", "BODY"]
```

## End to end

`subject.js` is the canonical shape as a real CommonJS module. The last
block `require()`s it and asserts that the sink is reached with **no call
into the module at all** — no entrypoint, no exported function invoked, no
conditional export. Loading it is sufficient. It then asserts that module
evaluation completed and that the key's return value really was installed
as the property name, so the shape is a working module and not a
contrivance that only half-executes.

## Running it

```
node entry.js
```

Measured on node v26.7.0.
