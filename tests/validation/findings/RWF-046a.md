| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| RWF-046a | any file binding a require with an ARRAY pattern, a rest element, or (on the base commit too) a defaulted element — zero occurrences in the current corpus, which is why nothing caught it | RWF-046's first implementation accepted any `BindingElement` under a require-initialized `VariableDeclaration` and let `symbol-binder.ts` take `element.propertyName ?? element.name` as the exported name. Sound for an object shorthand, where the property and local names are the same token; unsound otherwise. An ARRAY element has no property name, so the LOCAL IDENTIFIER'S TEXT became the export name — the `identifier text → module source` substitution RWF-046 exists to remove, reintroduced inside the function that replaced the old table | **Soundness, fabricating direction. INTRODUCED, not pre-existing** — found by independent audit of branch head `e29a713` before it merged. `const [, run] = require("pkg"); run()` binds array index 1 and resolved to `pkg#run`; the base `b9bb81b` returns UNKNOWN. A false-AFFECTED vector whose fabricated key is whatever the local is spelled. The defaulted form (`const { run = fallback } = require("pkg")`) resolved on the BASE too, and is closed here as well. A scoped re-audit then measured FIVE further pre-existing base defects sharing the same root cause — see RWF-046b | **Fixed (RWF-046a)** — see below |

## RWF-046a — A binding element named an export by its LOCAL text

**Discovered:** by independent soundness audit of the RWF-046
implementation, on branch head `e29a713`, BEFORE that branch merged.
Not found by the corpus differential, not found by any gate, and not
designed in — this record exists partly to say so.

**Class: soundness, fabricating direction.**

**The ARRAY shapes are INTRODUCED by RWF-046's first implementation**;
the base commit `b9bb81b` returns UNKNOWN for every one of them.

> **This record as first written said the base "fails closed on every
> shape below". That is WRONG and is corrected in place rather than
> deleted.** It was already contradicted by this record's own
> defaulted-element row, and the scoped re-audit then measured four
> further shapes the base resolves — three of them by the SAME
> local-identifier-text substitution. The claim was written from the
> array reproduction and generalised without measuring. See
> **§ The base was not clean** below, which records each as its own
> closure rather than folding it into this one.

### The defect

RWF-046 replaced a name-keyed import table with declaration identity.
Its destructuring branch accepted any `BindingElement` whose
`parent.parent` was a require-initialized `VariableDeclaration`, and
`symbol-binder.ts` then took the exported name from:

```ts
element.propertyName ?? element.name
```

That fallback is sound for an object shorthand — JavaScript makes the
property name and the local name the same token. It is unsound for
every other binding element, and an ARRAY element has no property name
at all, so the **local identifier's text became the export name**:

```js
const [, run] = require("pkg");
run();                            // resolved to pkg#run
```

`run` binds array index 1. `pkg` is not iterable and this throws at
runtime. Position was ignored entirely; the only input to the answer
was the spelling of the local. That is precisely the
`identifier text → module source` substitution RWF-046 was written to
remove, reintroduced one layer in, inside the function that replaced
the old table.

| Shape | base `b9bb81b` | RWF-046 first impl. | after RWF-046a |
| --- | --- | --- | --- |
| `const [run] = require("pkg")` | UNKNOWN | **resolved `pkg#run`** | UNKNOWN |
| `const [, run] = require("pkg")` | UNKNOWN | **resolved `pkg#run`** | UNKNOWN |
| `const [other, run] = require("pkg")` | UNKNOWN | **resolved `pkg#run`** | UNKNOWN |
| `const { run = fallback } = require("pkg")` | resolved | resolved | UNKNOWN |
| `const { ...run } = require("pkg")` | UNKNOWN | UNKNOWN | UNKNOWN |

### The base was not clean — five further defects, each closed here

Measured by the scoped re-audit with a 36-shape grammar sweep run
against `b9bb81b` and against this branch. These are **PRE-EXISTING
defects that were on `main`**, distinct from the array shapes above,
and each is recorded as its own closure rather than folded into
RWF-046a:

| # | Shape | base `b9bb81b` | after RWF-046a | Closure |
| --- | --- | --- | --- | --- |
| **a** | `const { [k]: run } = require("pkg")` (computed key, variable) | **resolved `pkg#run`** — by LOCAL text | UNKNOWN | fabricated edge removed |
| **b** | `const { ["run"]: run } = require("pkg")` (computed key, literal) | **resolved `pkg#run`** — by LOCAL text | UNKNOWN | fabricated edge removed |
| **c** | `const { 0: run } = require("pkg")` (numeric key) | **resolved `pkg#run`** — by LOCAL text | UNKNOWN | fabricated edge removed |
| **d** | `const { "run": execute } = require("pkg")` (string-literal key) | **resolved `pkg#execute`** — the WRONG export, by LOCAL text | **resolved `pkg#run`** — correct | mis-attribution corrected |
| **e** | `let { run } = require("pkg"); run = null; run()` | **resolved `pkg#run`** — stale | UNKNOWN | stale provenance removed |

Row **d** is the sharpest: the base did not merely fail to resolve, it
resolved to a *different real export of the same package*. `execute`
exists in the fixture, so nothing downstream could tell the answer was
wrong.

The defaulted element in the table above belongs to this group too —
`extractRequireBindings` never checked `element.initializer`, so
`const { run = fallback } = require("pkg")` resolved to one target
although the binding has two possible runtime values.

### The shared root cause, and why it is the fourth of its kind

Every one of a, b, c, d is the same line in `source-index.ts`'s
`extractRequireBindings`:

```ts
const importedName =
  element.propertyName && ts.isIdentifier(element.propertyName)
    ? element.propertyName.text
    : element.name.text;        // <- the LOCAL name, as an export name
```

A property key that is not an `Identifier` — computed, numeric, or a
string literal — falls through to the binding's LOCAL name and that
name is published as the imported export name. The array case RWF-046's
first implementation introduced is the same substitution reached by a
different route: there the element had no property name at all.

**This is the FOURTH location of one defect class**: an identifier's
TEXT standing in for a resolved name.

| Finding | Where the text stood in |
| --- | --- |
| RWF-043 | a bare-name call matched the first same-named function in the file |
| RWF-045 | the destructuring bridge selected its pattern by the bound name |
| RWF-046 | the import table was keyed by `localName` |
| **RWF-046a / this section** | a binding element's LOCAL name became the EXPORT name — in the base index for non-identifier keys, and in the first remediation for array elements |

Four independent sites, four separate discoveries, each found only
after the previous one was closed. That is the evidence base for
treating local-text-as-resolved-name as a class to be gated
structurally rather than as four defects that happened to rhyme.

### Why it was the boundary, not the array case

Gating on `ts.isObjectBindingPattern(element.parent)` alone would have
answered the counterexample and left the family open: the same
text-for-key substitution is reachable through a rest element, and a
defaulted element still resolves two runtime values onto one target. So
the rule is stated as the proof required — a **static, single-valued
property of the module object** — mirroring clause for clause the
boundary RWF-045 draws for the destructuring bridge, because the two
read the same syntax and must not drift:

- parent is an `ObjectBindingPattern`;
- that pattern is the declaration's own `name` (a nested pattern's real
  member path is `pkg.api.run`, which no import binding models);
- no `dotDotDotToken` — a rest element holds the REMAINING properties;
- no initializer — a default is two possible values;
- the key is an `Identifier` or a string literal; computed and numeric
  keys refuse.

Everything else refuses to UNKNOWN under the existing `destructuring`
and `reassigned` reason tokens. No new reason code was added and no
seventh uncertainty category was created.

The guard lives in `named-bindings.ts`, the authority layer, and the
proved key is carried on the result instead of being re-derived
downstream. The shape checks were **removed** from `symbol-binder.ts`
rather than kept as a defensive mirror: a guard enforced twice is a
guard whose mutation test passes with either copy deleted.

### Why no gate caught it, stated plainly

The corpus contains **zero** instances of every shape involved.
Measured over the same 885 files as RWF-046's own prevalence table:

| Shape | Count |
| --- | --- |
| require declarations (literal specifier) | 902 |
| object-pattern requires | 28 |
| **array-pattern requires** | **0** |
| **rest elements on a require pattern** | **0** |
| **defaulted elements on a require pattern** | **0** |
| computed-key elements on a require pattern | 0 |
| nested pattern elements on a require pattern | 0 |
| parenthesized / cast require initializers (N1) | 0 |

So the graph differential could not have caught this, and it did not.
This is **D-12's rule, demonstrated a second time**: a soundness claim
must be discharged by a test that reproduces the MECHANISM, never by a
differential that failed to notice it. The first implementation's 13-edge
differential was accurate and told us nothing about this family. After
the remediation the differential is still exactly 13 edges, unchanged
line for line — the guards withdraw nothing in this corpus, because
there is nothing here for them to withdraw.

It also says something about the first implementation's test suite: 25
passing tests, four mutation controls, and none of them bound a name
with anything but an object shorthand or a rename. The new cases fix
that at the fixture level too — every package in § J exports every name
the cases bind, so a regression RESOLVES and fails loudly instead of
degrading to `unresolved_target`, which is still `unknown` and would
have hidden the hole exactly as before.

### N1 — the `unwrapTypeOnly` widening, withdrawn

The same audit noted that `requireCallInitializer` ran `unwrapTypeOnly`,
making `const m = (require("pkg"))` and `require("pkg") as any` resolve
where the base left them UNKNOWN. Sound, but a COVERAGE change smuggled
inside a soundness fix: untested, uncovered by the differential, and it
makes the differential unattributable. **Withdrawn from this branch**
and pinned by a test asserting the base behaviour, rather than
documented and kept. It is a candidate for its own item; it has zero
corpus occurrences either way.

### Mutation controls

The near-tautological PackageInstance mutation the first implementation
cited was replaced. Each of these weakens the authority itself, and each
is caught by NAMED tests:

| Mutation | Tests that fail |
| --- | --- |
| remove the `ObjectBindingPattern` guard | 3 (all three array-pattern cases) |
| remove the rest-element guard | 6 (2 unit + all 4 verdict-oracle assertions) |
| remove the default-initializer guard | 1 (the defaulted element) |
| resolve the specifier from the project root instead of the importing file | 7 — and the twin controls fail on the BORROW assertion (`expected [ Array(1) ] to deeply equal []`), naming the sibling install, not merely losing an edge |

### Status

**Fixed (RWF-046a).** RWF-045 is untouched and remains open; the two
remain separate authority layers.

**Correction, added by task `record-soundness-audits`:** RWF-045 has
since merged — see "RWF-045 — REMEDIATED" above. This section is left as
written because it was true when this section was recorded, before that
merge.

### Test obligation owed by this PR

The RWF-045 × RWF-046 cross-layer oracle has never run, because the two
boundaries live on branches that have never both been present. The two
partition cleanly by initializer shape — RWF-046's require path needs a
`require("literal")` initializer, RWF-045's bridge needs a
plain-identifier one, and a declaration has one or the other — so the
re-audit found no conflict and neither PR is blocked on it.

It is owed nonetheless, and **it is owed by this PR**: PR #60 (RWF-045)
merges first, so this branch is the second onto a tree carrying both,
and only there can the oracle actually run. The case to pin is the
composition
`const mod = require("pkg"); const { run } = mod; run()` — RWF-045
selects the exact source identifier, RWF-046 resolves that identifier's
declaration — together with the const-ness divergence: RWF-045's bridge
is `const`-only while RWF-046 uses the reassignment rule, so
`let { run } = require("pkg")` with no write resolves while
`let { run } = mod` does not. Both are sound; the asymmetry should be
asserted rather than discovered.

---

