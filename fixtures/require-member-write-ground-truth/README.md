# RWF-047 runtime ground truth: what a member write on a required module actually does

This fixture is **not** scanned by VulnTrace's own test suite — it is a plain
Node.js program, run directly with `node entry.js`. Every claim below is
`assert`ed in-process, so the run either prints the measured table and exits
`0` or exits non-zero naming the first false claim.

```
$ node fixtures/require-member-write-ground-truth/entry.js
  ... (the table reproduced in RWF-047 § 3) ...
RWF-047 ground truth: all assertions passed
```

Measured on **node v22.11.0**.

It exists because RWF-047 had to be classified — fabricated-edge soundness
defect, or precision debt — and that distinction turns entirely on what the
runtime does. The analyzer's answer is only wrong relative to a ground truth
someone established. Nothing here is argued; all of it is executed.

## What is established

**Part 1 — the two directions.**

| row | shape | result |
| --- | --- | --- |
| D1 | `mod.run = patched; mod.run()` | calls the LOCAL `patched`; `pkg#run`'s body never runs |
| D2 | the same write with a vulnerable local | calls the LOCAL; the replaced export is still a real, callable function |
| D3 | `require("pkg") === require("pkg")` | the write is visible through every other require of the same instance |

D1 is the false-`AFFECTED` direction: the vulnerable code never executes.
D2 is the false-`NOT_AFFECTED` direction read the other way round, and the
assertion that matters in it is the second one — the displaced export
remains callable, which is *why* a stale attribution RESOLVES instead of
dangling, and therefore why it can hide.

D3 is why the displacement is not confined to one file. The CommonJS
require cache is process-wide, so `mod.run = wrapper` in one module changes
what every other consumer of `pkg` reaches.

**Part 2 — the widened shapes**, one row each for `Object.defineProperty`,
`delete`, a write through an alias, and a write performed inside a called
function. All four displace the export exactly as the direct write does.

`delete` is the odd one: the property is configurable, so the delete
succeeds and the following call is a `TypeError`. `pkg#run` is not called —
and neither is anything else.

W9 (`mod.execute = patched; mod.run()`) is the **negative control**:
`mod.run` is untouched, so the call really does reach `pkg#run`. It is what
makes the other rows a statement about a write to *the member being called*
rather than about member access in general.

**Part 3 — the displacement chain, executed.** `consumer.js` replaces a
SAFE export with a local wrapper whose body calls the vulnerable sink, then
calls through the replaced name. The run asserts that `danger#explode` is
reached and that `pkg#run` is not.

**Part 4 — ESM**, in its own process (`esm-probe.mjs`) because it needs
module code. Two rows that differ, and the difference is the point:

- `import * as ns` — a Module Namespace Exotic Object is sealed and its
  bindings are non-writable, so `ns.run = patched` is a **`TypeError`** in
  ESM's implicit strict mode. No displacement is possible.
- `import mod from "pkg"` where `pkg` is CommonJS — the default import *is*
  `module.exports`, an ordinary mutable object, and the write succeeds
  exactly as in the `require` case.

So ESM offers no protection at all in the shape real code actually uses.

## The loud-fixture rule

`node_modules/pkg` exports **every name any RWF-047 case binds, including
`patched`** (RWF-048 § 2). Against a package that does not export the name,
a stale or fabricated attribution degrades to `unresolved_target` and reads
as an honest UNKNOWN — the mechanism that concealed the RWF-046 array hole
behind a green suite. With the name present, a wrong attribution is a loud
`EXACT` that the analyzer-side tests can see and assert on.

## Where the analyzer-side measurements live

- `tests/binding-grammar/require-member-write.test.ts` — the graph-level
  widening table, each row naming the fixture row that grounds it.
- `src/analysis/verdict.require-member-write-authority.integration.test.ts`
  — the end-to-end verdict oracle for both directions, including the
  Family C displacement chain and its object-literal control.
- `tests/validation/FINDINGS.md` § RWF-047 — the classification.
- `docs/OPEN-DEBTS.md` D-16 — the open soundness blocker.
