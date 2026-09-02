# Fixture: commonjs-coincidental-export-name (RWF-011)

The permanent fixture for **RWF-011 — a CommonJS export bound to an
unrelated same-file function purely because the two share a name**.

Its purpose is one specific outcome: this scan returned a **false
`NOT_AFFECTED`** before RWF-011, carrying a complete Family C
`confirmedUnreachableTarget` proof with `reachableSubgraphComplete: true`.
A false `NOT_AFFECTED` is a high-severity soundness defect, so the shape is
pinned here permanently.

## Shape

```text
node_modules/fixture-lib/index.js
  function parse(input) { ... }              <-- SAFE, unrelated DECOY.
                                                 Never reassigned, never
                                                 exported, never called.
  const registry = { impl: require("./lib/parse") }
  exports.parse     = registry.impl          <-- the rule's target. An
                                                 UNMODELED member expression.
  exports.parseSync = require("./lib/parse") <-- the same function object,
                                                 statically resolvable (RWF-004a)
        |
        v
node_modules/fixture-lib/lib/parse.js
  module.exports = function (input) { ... }  <-- the real implementation, ANONYMOUS

node_modules/nested-consumer/node_modules/fixture-lib/index.js
  exports.parse = function (input) { ... }   <-- a SECOND installed instance,
                                                 same name AND same version.
                                                 Attributable and REACHABLE.
```

`src/index.cjs` calls `fixture.parseSync(input)` and, through
`nested-consumer`, the duplicate instance's `parse`.

Findings here are pinned to a specific `packageInstance`: two installs of
`fixture-lib@1.0.0` are present, and only the top-level one carries the
coincidental-name shape.

## Runtime truth: AFFECTED

`exports.parse` and `exports.parseSync` are the **same function object** —
both are `registry.impl`, i.e. `lib/parse.js`'s function. The application
calls it directly. The symbol a rule targeting
`{module: "fixture-lib", export: "parse"}` names is therefore genuinely
invoked.

## Why the pre-fix answer was NOT_AFFECTED

`mapExportsToFunctions`'s lookup key was
`binding.localName ?? binding.exportedName`, and a CommonJS *property*
export carried no `localName` at all. So the key for `exports.parse` was
the string `"parse"` — the export's **public name** — and the fallback
`index.functions.find(fn => fn.name === localKey)` found the decoy
declaration.

Nothing about that binding had any relation to the export's right-hand
side. `registry.impl` is a member expression this analyzer models no value
flow through; the correct answer for it is "unresolved". Instead the
public name went looking for a local symbol and found one, and:

1. the decoy is never called by anyone, so it is trivially unreachable;
2. Family C proved *that node* unreachable, completely and correctly;
3. the verdict layer correctly turned a complete unreachability proof into
   `NOT_AFFECTED`.

Every stage was right about the node it was handed. The node was wrong.

This is the distinct half of the defect class RWF-013/RWF-013b closed the
other half of. There the export's value **was** an identifier and the file's
own text contradicted it (a reassignment), so the refusal had a fact to act
on. Here nothing is reassigned and nothing is refused — `registry` is a
`const` that is never written to, so `localIdentifierProvenanceRefused` is
correctly absent. The export simply has **no provenance of any kind**, and
the defect was treating its public name as if that were provenance.

## Expected result

- A rule targeting `{module: "fixture-lib", export: "parse"}` is
  **UNKNOWN** — never `NOT_AFFECTED`.
- `mapExportsToFunctions` attributes `parse` to **nothing**, even though a
  same-named function is present in the file and indexed.
- The decoy's source location appears nowhere in the finding's target
  attribution.
- No `confirmedUnreachableTarget` evidence is produced at all: an
  unresolved target must not reach a reachability search.

`AFFECTED` would also be acceptable if the analyzer could authoritatively
resolve `registry.impl`; it cannot, and resolving it is out of scope
(no property-level value flow, and see RWF-012 alias chains / RWF-004b
cross-package re-export).

## Negative controls, in the same fixture

1. **The sibling export must not change.** `parseSync` is a plain RWF-004a
   whole-module re-export, so RWF-011's restriction has nothing to apply to
   it and must leave it exactly as it was.
2. **The real implementation stays reachable.** `lib/parse.js`'s anonymous
   function must still be a resolved call-edge target — otherwise the test
   would be passing for the wrong reason (a broken graph rather than a
   corrected attribution).
3. **No refusal flag.** The `parse` binding must carry
   `localIdentifierProvenanceRefused: undefined`, proving this fixture
   exercises RWF-011's own restriction and not RWF-013's.
4. **Duplicate PackageInstance, both directions.** `nested-consumer`
   installs a SECOND `fixture-lib@1.0.0` whose `parse` export has real
   provenance and IS called from the entrypoint. A finding pinned to the
   top-level instance must stay `UNKNOWN` — never borrowing that reachable
   same-named candidate across instances — while a finding pinned to the
   nested instance must still read `AFFECTED` on its own merits. The second
   half is what keeps the first from passing for a trivial reason.
5. **Wrong PackageInstance.** A finding pinned to an install location that
   does not exist at all must never read `AFFECTED` off this instance's
   nodes.

The fixture must not execute during static analysis.
