| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| RWF-013b | any CommonJS file that reassigns an exported `function`/`class` DECLARATION | RWF-013 classified an identifier's provenance by asking how the name was DECLARED, so a reassigned function/class declaration was reported "unmodeled" — silence — and still fell through to the legacy name search, even though the same fact collector had already recorded the reassignment | **Soundness** — the identical false `NOT_AFFECTED` with a complete Family C proof, surviving RWF-013 | **Fixed (RWF-013b)** |

## RWF-013b — A reassigned FUNCTION/CLASS DECLARATION's stale node is attributed to the export by name

**Status: Fixed.**

**Discovered:** the independent post-merge soundness audit of RWF-013,
which found that RWF-013 closed only part of the defect it targeted.

**Symptom:** the same false `NOT_AFFECTED` RWF-013 was written to
eliminate — a complete Family C `confirmedUnreachableTarget` proof, with
`reachableSubgraphComplete: true`, over a function the module does not
export — reproduced end-to-end on the tree that already contained RWF-013:

```js
function parse(input) { return "safe:" + input; }  // stale
parse = require("./lib/parse");                    // real, unconditional
exports.parse = parse;
exports.parseSync = require("./lib/parse");        // what the app calls
```

**Root cause.** RWF-013's tri-state classifier answered the question
*"was this identifier's provenance examined and rejected?"* by consulting
`CommonJsFacts.variableDeclaredNames`, a set populated exclusively from
`ts.isVariableDeclaration`. A name bound by a `function` or `class`
declaration is absent from that set, so `classifyLocalBinding` returned
`"unmodeled"` — silence, which deliberately leaves the legacy name
fallback available — and the fallback then found the stale declaration
under exactly the exported name and bound it.

The decisive detail is that **the fact needed to refuse was already
collected**. `collectFacts` builds a `reassignedNames` set in the same
walk (via `markAssigned`, covering `=`, `+=`, `||=`, `??=`, `++`/`--`,
destructuring targets and `for..of` variables), but RWF-013 consumed it
only when filtering `localBindings` — a map built exclusively from
variable declarations. So the model observed the reassignment and then
discarded it for every non-variable declaration form.

This shape is *easier* to mis-bind than RWF-013's, not harder: RWF-013's
stale node was an anonymous function expression that acquired the
variable's name through `inferAssignedName`, whereas a function
declaration is literally named the exported name with no inference at all.

**Fix.** `reassignedNames` is now part of `CommonJsFacts`, and
`classifyLocalBinding` consults it FIRST — before anything that depends on
how the name was declared:

```ts
if (facts.reassignedNames.has(name)) {
  return { kind: "refused" };
}
```

Ordering is the substance of the fix, not an implementation detail. The
question "does this file write to this name?" is answerable without
knowing the declaration form, and it is the question that actually decides
whether the name is a stable alias. Asking "how was it declared?" first is
what let a reassigned declaration escape.

**Why reassignment is authoritative across declaration forms.** JavaScript
rebinds a `function` declaration and a `class` declaration exactly as
freely as a `var`. `function f() {} f = g;` is legal, common in
feature-detection and lazy-initialisation code, and plainly visible to any
reader of the file. A CommonJS export carries the value the binding holds
*at export time*, so a declaration that has been assigned away from is not
the exported value — and nothing about its declaration keyword changes
that. The previous model encoded a distinction the language does not make.

**Coverage.** The refusal reaches every identifier-valued export form —
`module.exports = fn`, `exports.foo = fn`, `module.exports.foo = fn`,
`module.exports = { foo: fn }` and `module.exports = { fn }` — because an
author picks the spelling and leaving one path open leaves the defect
open. It also covers conditional reassignment and every compound/implicit
write `markAssigned` already records.

**Deliberately unchanged.** No verdict thresholds, Family A/B/C semantics,
`reachableSubgraphComplete`, `ModuleLoadClosure`, `AnalysisProofContext`,
exactly-one proof schema, evidence field or reason identifier. Family C
was never wrong; it was handed a stale target, and the correction belongs
entirely in export attribution. The refusal marker stays internal and
unserialized. Alias chains past one hop (RWF-012) and cross-package
re-export (RWF-004b) remain out of scope and equally conservative.

**Un-reassigned declarations are untouched.** `function fn() {}
module.exports = fn`, `class C {} module.exports = C`, and the whole
class-member attribution chain that rests on them still resolve by name:
they are never written to, so they stay `"unmodeled"`.

**Blast radius, measured.** A parser-based sweep of every validation
fixture, vendored package and adversarial fixture (736 files walked, 418
containing a CommonJS export construct) found **zero** real vendored
occurrences of a reassigned, exported function/class declaration — the
only two matches are this task's own fixtures. Benchmark delta is
therefore **zero**: 10 PASS / 7 KNOWN_FAIL / 0 UNEXPECTED / 17 total,
unchanged, with `RWB-02` and `RWB-09a` still `AFFECTED` and `ADV2-067` /
`ADV2-068` / `ADV2-069` still passing.

**Known SOUND_PRECISION_LOSS (unchanged from RWF-013, documented not
fixed).** The refusal is name-based, not scope-sensitive, so a same-named
binding in an unrelated scope refuses an export that a scope-aware model
would allow: a nested `var` of the same name, a sibling block declaration,
a `catch` binding, or a function declaration coexisting with an unrelated
variable of that name. All of these fail toward `UNKNOWN`, never toward a
verdict, and none moved a benchmark case. Broadening this into
scope-sensitive binding resolution is deliberately NOT part of this task.

**Performance.** The fix adds one `Set.has` lookup to a code path that
already had the facts in hand: no new traversal, no per-target rescan.
Measured on the 9,000-declaration single-file fixture, the `collectFacts`
walk costs 61.8ms before and 57.8ms after (noise), and
`scan-performance`'s single-large-file case runs 1.6-2.3s against its
4,500ms threshold both before and after.

The audit also suggested guarding `commonJsPropertyExportRhs` with
`if (!ts.isIdentifier(rhs))` to avoid a facts walk that `usableFactsOf`
previously short-circuited for require-free files. That guard turns out
**not to be applicable**: the right-hand side is only obtainable *from*
`collectFacts`'s own `propertyRhsByName` map, so there is nothing to test
before the walk has happened. Restoring the short-circuit would also be
unsound — it is valid only for re-export *origins*, which always bottom
out at a literal `require()`, whereas a reassignment needs no `require()`
anywhere in the file (`function fn() {} fn = x; exports.fn = fn;`). The
walk is inherent to answering the question, and the measurement above is
the cost of answering it.

---

