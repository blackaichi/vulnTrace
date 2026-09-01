# Fixture: commonjs-stale-alias-export (RWF-013)

The permanent fixture for **RWF-013 — a CommonJS export bound, by name, to
the stale initializer of a variable the file has already reassigned**.

Its purpose is one specific outcome: this scan returned a **false
`NOT_AFFECTED`** before RWF-013, carrying a complete Family C
`confirmedUnreachableTarget` proof. A false `NOT_AFFECTED` is a
high-severity soundness defect, so the shape is pinned here permanently.

## Shape

```text
node_modules/fixture-lib/index.js
  let parse = function (input) { ... }      <-- SAFE fallback, ANONYMOUS,
                                                indexed under the name "parse"
  parse = require("./lib/parse")            <-- reassigned, unconditionally
  exports.parse     = parse                 <-- the rule's target
  exports.parseSync = require("./lib/parse")<-- the same function object,
                                                statically resolvable (RWF-004a)
        |
        v
node_modules/fixture-lib/lib/parse.js
  module.exports = function (input) { ... }  <-- the real implementation, ANONYMOUS
```

`src/index.cjs` calls `fixture.parseSync(input)`.

## Runtime truth: AFFECTED

`index.js` assigns `parse = require("./lib/parse")` unconditionally before
exporting, so `exports.parse` and `exports.parseSync` are the **same
function object** — `lib/parse.js`'s. The application calls it directly.
The symbol a rule targeting `{module: "fixture-lib", export: "parse"}`
names is therefore genuinely invoked.

## Why the pre-fix answer was NOT_AFFECTED

Two facts had to line up, and in real CommonJS code they routinely do:

1. **The stale fallback is anonymous**, so source indexing names it after
   the variable it was assigned to (`inferAssignedName`) — giving it the
   name `parse`, which is exactly the export name the rule asks for.
2. **The real implementation is anonymous too**, so no *correct* node
   anywhere in the installed package carries the name `parse`. The target
   sweep in `resolveTargetNodes` has nothing better to find.

`mapExportsToFunctions` then fell through to
`index.functions.find(fn => fn.name === localKey)` and bound the rule
target to the fallback — a function nothing calls. The reachability search
correctly proved *that node* unreachable, and the verdict layer correctly
turned a complete unreachability proof into `NOT_AFFECTED`. Every stage was
right about the node it was handed; the node was wrong.

Note that the call graph was never fooled: `parseSync` resolves through
RWF-004a to `lib/parse.js`'s function, and that edge is present in the
graph. The defect was purely in target attribution.

## Expected result

- A rule targeting `{module: "fixture-lib", export: "parse"}` is
  **UNKNOWN** — never `NOT_AFFECTED`.
- `mapExportsToFunctions` attributes `parse` to **nothing**, even though a
  same-named function is present in the file and indexed.
- The export binding carries
  `localIdentifierProvenanceRefused: true` — the analyzer examined the
  identifier's binding and rejected it, which is a different fact from
  never having modeled it (a `function` declaration, a class alias, a
  direct anonymous export).
- No `confirmedUnreachableTarget` evidence is produced at all: an
  unresolved target must not reach a reachability search.

`AFFECTED` would also be acceptable if the analyzer could authoritatively
resolve the reassigned value; it cannot, and resolving it is out of scope
(RWF-012 alias chains, RWF-004b cross-package re-export).

## Negative controls, in the same fixture

1. **The sibling export must not change.** `parseSync` is a plain RWF-004a
   whole-module re-export, not an identifier binding, so RWF-013's refusal
   has nothing to apply to it and must leave it exactly as it was.
2. **The real implementation stays reachable.** `lib/parse.js`'s anonymous
   function must still be a resolved call-edge target — otherwise the test
   would be passing for the wrong reason (a broken graph rather than a
   corrected attribution).
3. **Wrong PackageInstance.** A finding pinned to a different install
   location of the same package name must never read `AFFECTED` off this
   instance's nodes.

The fixture must not execute during static analysis.
