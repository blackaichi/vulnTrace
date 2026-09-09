# RWF-025 runtime ground truth: which local bindings an assignment TARGET rebinds

This fixture is **not** scanned by VulnTrace's own test suite — it is a plain
Node.js program, run directly with `node entry.js`. Every claim below is
`assert`ed in-process, so the run either prints one line and exits `0` or
exits non-zero naming the first false claim.

```
$ node fixtures/destructuring-computed-key-assignment-target-ground-truth/entry.js
RWF-025 ground truth: all assertions passed
```

It exists because RWF-025 turns on a distinction that is easy to state and
easy to get wrong in an AST walk: an assignment target's syntax tree
contains both the **destinations** the assignment writes to and the
**expressions the language merely evaluates** in order to work out what
those destinations are. The two are independent, and the reassigned-name
collector may only record the first kind.

## Part 1 — `roles.js`: the seven measured rows

| shape | key expression evaluated? | key's own binding rebound? | target rebound? |
| --- | --- | --- | --- |
| `({ [key()]: target } = source)` | yes | **no** | yes |
| `({ [bail()]: target } = source)` where `bail` throws | yes (it throws) | — | no |
| `({ [bail()]: bail } = source)` | yes, with the OLD value | — | **yes** |
| `({ target = fallback() } = source)` | yes | **no** | yes |
| `[holder[key()]] = values` | yes | **no** | **nothing local**; `holder.slot` is written |
| `holder[key()] = value` | yes | **no** | **nothing local**; `holder.slot` is written |
| shorthand / aliased / nested / rest / array / array-rest / defaulted | — | — | all seven rebind |

Row 3 is the one that rules out the lazy fix. It is tempting to suppress
every identifier that appears anywhere under a computed property name; row 3
shows why that is wrong. In `({ [bail()]: bail } = source)` the name `bail`
occurs twice in two different roles: the key occurrence is evaluated (with
the old value — the call really happens, `calls === 1`) and rebinds nothing,
while the property-value occurrence is a genuine destination and really does
rebind it. A correct collector must distinguish the roles, not the name.

Rows 5 and 6 are the shape a corpus scan of real vendored packages actually
finds. `rollup`, `vite`, `chai` and `esquery` all ship statements of the form
`someMap[someLocalFunction(arg)] = value`. Nothing local is rebound by them:
a property of `someMap` is written, and both `someMap` and
`someLocalFunction` hold exactly what they held before.

## Part 2 — `lib.js` / `observer.js` / `danger.js`: why the poisoning is a false NOT_AFFECTED

`lib.js` is the RWF-024 fixture family with one statement added:

```js
({ [keyFor(bail)]: seen } = REGISTRY);
```

It runs on every load, completes normally, and rebinds exactly one binding —
`seen`. `bail` appears in it only as an argument to the key-producing call.

Further down, `lib.js` publishes `module.exports = dangerousOp`, is observed
by a circular `require()`, and then evaluates
`const mode = { [keyFor(safeOp)]: "fast", [bail()]: 1 };`. The run asserts:

- `require("./lib")` throws `fast mode is not supported here` — so
  `module.exports = safeOp`, the last statement in the file, **never runs**;
- the cyclic observer captured `dangerousOp` **by identity**
  (`observer.captured.name === "dangerousOp"`);
- calling that captured value reaches the sink
  (`danger.reachedCount()` goes `0 → 1`);
- re-`require`ing the failed module re-throws deterministically, because
  Node does not cache a module whose evaluation threw.

So a verdict of NOT_AFFECTED reached by attributing the module's export to
`safeOp` is not merely imprecise — it names a value that this load never
produced, for a package that reaches the sink through the value a real
consumer holds.

Before RWF-025, the single added destructuring statement was enough to
produce exactly that verdict: it recorded `bail` as locally reassigned, which
made `bail`'s identity unresolvable for the **whole file**, which withdrew
RWF-024's cutoff, which handed `module.exports = safeOp` an authority it does
not have. Deleting that one statement — and changing nothing else — restored
the sound answer, which is what identifies the cache poisoning as the cause
rather than the abrupt position itself.
