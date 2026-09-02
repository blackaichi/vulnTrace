# Fixture: commonjs-reassigned-declaration-export (RWF-013b)

The permanent fixture for **RWF-013b — a CommonJS export bound, by name,
to a reassigned FUNCTION DECLARATION**.

It is the sibling of `fixtures/commonjs-stale-alias-export/` (RWF-013) and
exists because that fix was incomplete: RWF-013 closed the defect for
`var`/`let`/`const` bindings only, and the identical defect survived
through a declaration form JavaScript reassigns just as freely.

Its purpose is one specific outcome: this scan returned a **false
`NOT_AFFECTED`** on the tree that already contained RWF-013, carrying a
complete Family C `confirmedUnreachableTarget` proof.

## Shape

```text
node_modules/fixture-lib/index.js
  function parse(input) { ... }             <-- SAFE fallback, a FUNCTION
                                                DECLARATION literally named "parse"
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

## Why RWF-013 did not catch this

RWF-013 classified an identifier's provenance by asking *how the name was
declared*: it built a `variableDeclaredNames` set from
`ts.isVariableDeclaration` alone, and a name absent from that set was
reported "unmodeled" — silence — which leaves the legacy name fallback
available.

A `function` declaration is not a variable declaration, so a reassigned one
fell through, **even though the same fact collector had already recorded
the reassignment** in its `reassignedNames` set. The fallback then searched
by name and found the stale declaration, which here is even easier to hit
than RWF-013's case: the declaration is *literally named* `parse`, with no
`inferAssignedName` inference required.

Two further facts make it bind rather than merely be searched for:

1. The real implementation in `lib/parse.js` is anonymous, so **no correct
   node anywhere in the package carries the name `parse`** — the target
   sweep has nothing better to find.
2. The stale declaration is called by nothing, so it is trivially
   unreachable, and a correct reachability search over it yields a
   confident `NOT_AFFECTED`.

As in RWF-013, every stage was right about the node it was handed. The node
was wrong. The call graph was never fooled: `parseSync` resolves through
RWF-004a to `lib/parse.js`'s function and that edge is present.

## Expected result

- A rule targeting `{module: "fixture-lib", export: "parse"}` is
  **UNKNOWN** — never `NOT_AFFECTED`.
- `mapExportsToFunctions` attributes `parse` to **nothing**, even though a
  function declaration of exactly that name is present and indexed.
- The export binding carries `localIdentifierProvenanceRefused: true`.
- No `confirmedUnreachableTarget` evidence is produced at all.

## Negative controls, in the same fixture

1. **The sibling export must not change.** `parseSync` is a plain RWF-004a
   whole-module re-export, so the refusal has nothing to apply to it.
2. **The real implementation stays reachable**, so the test cannot pass for
   the wrong reason (a broken graph rather than corrected attribution).
3. **Wrong PackageInstance.** A finding pinned to a different install
   location of the same package name must never read `AFFECTED` here.

The fixture must not execute during static analysis.
