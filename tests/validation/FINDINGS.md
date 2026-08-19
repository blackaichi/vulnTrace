# Real-World Validation Findings

A running log of every gap discovered by scanning real, npm-installed
packages against real CVEs/GHSAs (`tests/validation/`) — kept up to date
after every validation run, per the same discipline as the adversarial
suites: a disagreement between VulnTrace and an independently-researched
oracle is recorded here and the case is kept failing (`knownFailure: true`
in `cases/cases.json`), never silently fixed away or hidden.

Each entry is a candidate for a future remediation task, not yet
implemented. Nothing in this file changes analyzer behavior by itself.

## Benchmark design note (not a VulnTrace defect) — `RWB-09b`

`RWB-09b`'s expected verdict (`NOT_AFFECTED`, for the patched `semver@7.5.2`
instance) is a case where the *benchmark's own oracle design* doesn't
match how VulnTrace actually represents "not vulnerable." The real scan
result for that instance is **`NO_FINDING`** — no findings-array entry at
all — not an explicit finding carrying verdict `NOT_AFFECTED`. This is
**correct, intentional VulnTrace behavior**: `buildFinding` (`src/analysis
/verdict.ts`) returns `undefined` (no finding emitted) whenever
`matchResult === "not_affected"` (a package instance confidently outside
every vulnerable range) — the same behavior that keeps a scan's `findings`
array free of noise for the overwhelming majority of a project's
dependencies that were never vulnerable in the first place. `RWB-09b`'s
`findingSelector`-based lookup (matching `tests/validation/validation
.test.ts`'s existing convention for every other case) can only ever find
`NOT_AFFECTED`/`AFFECTED`/`UNKNOWN` inside an *existing* findings-array
entry — it has no way to represent "the correct answer is that no finding
should exist at all." Per the task instructions governing this benchmark
implementation ("do not change expected verdicts unless the benchmark
design is proven factually incorrect — stop and report instead"), `RWB-09
b`'s `expected` field is left as `NOT_AFFECTED` and the case is marked
`knownFailure: true` rather than silently reshaping the oracle or the
runner. A future revision of the case format (see `docs/VALIDATION-
STRATEGY.md § 7`'s already-proposed additional fields) should add an
explicit way to assert "no finding for this instance" as its own expected
outcome, distinct from an explicit `NOT_AFFECTED` verdict.

## Status

| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| RWF-001 | `lodash` (the main package) | UMD `module.exports` assignment via a locally-aliased variable is invisible to export detection | Precision only — degrades to UNKNOWN in both directions, never a false AFFECTED/NOT_AFFECTED | Open, not yet scoped as a task |
| RWF-002 | any (`node-forge` isolates it cleanly) | One unresolved/dynamic construct *anywhere* in an entrypoint's reachable call graph forces `UNKNOWN` for every vulnerability checked against that entrypoint, even when the construct is entirely unrelated to the target | Precision, but broad real-world reach — real applications routinely contain constructs the call graph can't fully model | Open, not yet scoped as a task |
| RWF-003 | `minimist` | `module.exports = function (...) {...}` (an anonymous function expression, not a named local declaration) isn't matched by export-to-function resolution | Precision only — degrades to UNKNOWN, never a false verdict | Open, not yet scoped as a task |
| RWF-004 | `qs`, `debug`→`ms`, `semver` | An exported value that is itself a re-export of a function declared in a *different* file (same-package sibling file or a different package entirely) is never chased to its real declaration | Precision only — degrades to UNKNOWN, never a false verdict | Open, not yet scoped as a task |
| RWF-005 | `trim-newlines` | TypeScript module resolution prefers a package's hand-authored `.d.ts` over its real `.js` implementation when resolving a bare specifier from a plain `.js` importer | Precision only — degrades to UNKNOWN (analysis operates on a file with no real function bodies) | Open, not yet scoped as a task |
| RWF-006 | `fast-xml-parser` | A webpack-bundled, `Object.defineProperty`-getter-defined class export isn't recognized as a constructible/method-bearing target | Precision only — degrades to UNKNOWN, never a false verdict | Open, not yet scoped as a task |

---

## RWF-001 — UMD-style `module.exports` assignment via a locally-aliased variable is never recognized

**Discovered:** scanning real `lodash@4.17.15` against real GHSA-29mw-wpgm-hmr9 / CVE-2020-28500 (ReDoS in `trim`/`trimEnd`/`toNumber`).

**Symptom:** `VAL-002` and `VAL-003` (`tests/validation/cases/cases.json`) both return `UNKNOWN` for `lodash#trim` — one case where `trim()` is genuinely, directly called (correct answer: `AFFECTED`), and one where it's genuinely never called (correct answer: `NOT_AFFECTED`). Both directions are wrong, but both are *safe* wrong answers (UNKNOWN, never a false AFFECTED or false NOT_AFFECTED) — this is a precision gap, not a soundness violation.

**Root cause, confirmed by reading the actual installed `node_modules/lodash/lodash.js`:**

Real `lodash.js` does not export via an object literal (`module.exports = { trim, ... }`) or a direct `module.exports = <name>` assignment. It uses classic UMD boilerplate, feature-detecting the module system into local variables first:

```js
var freeExports = typeof exports == 'object' && exports && !exports.nodeType && exports;
var freeModule = freeExports && typeof module == 'object' && module && !module.nodeType && module;
// ... (~17000 lines later)
(freeModule.exports = _)._ = _;
```

`describeCommonJsExportTarget` (`src/code-intelligence/source-index.ts`) only recognizes a `module.exports = ...` assignment when the assignment target's own root identifier is *literally* `module` (`node.left.expression.text === "module"`). Here the assignment is `freeModule.exports = _` — `freeModule` is a separate local variable, not the literal `module` identifier — so this assignment is never recognized as a CommonJS export at all. The module falls back to having no named export table entry for `trim` (or anything else `lodash.js` attaches to `_` internally via scattered `lodash.trim = trim;`-style assignments throughout the file), so `resolveTargetNodes` can never find it — `unresolved_target`, which correctly (per SDD §3.3/§5) becomes `UNKNOWN` rather than a guess.

**Why this matters:** this is the single most common real-world idiom for a package that needs to work under CommonJS, AMD, *and* browser globals without a bundler — and `lodash` (the literal package, not per-method variants like `lodash.template`) is one of the most-installed packages in the entire npm ecosystem. Contrast with `lodash.template@4.5.0` (`VAL-001`), which uses a plain `module.exports = template;` — the exact pattern already handled — and resolves correctly to `AFFECTED` with a full two-hop evidence path.

**Relevant files:** `src/code-intelligence/source-index.ts` (`describeCommonJsExportTarget`, `findLastModuleExportsAssignment`-equivalent logic), `src/code-intelligence/module-model.ts` (`buildExportBindings`).

**Proposed direction (not scoped, not implemented):** recognize `<localIdentifier>.exports = ...` as a CommonJS export assignment when `<localIdentifier>` is itself a local variable whose own initializer is provably `module` (or a boolean/ternary expression that resolves to `module`, matching the exact UMD feature-detection idiom above) — a bounded, same-file, single-hop resolution in the same spirit as VT-214's alias tracking, not a general points-to change. Whether it's also worth tracing property assignments made *after* the export point (`lodash.trim = trim;` deep inside the file, before the module boundary is even known) is a separate, likely larger question the fix should scope explicitly rather than assume.

**MVP-readiness relevance:** does not violate any of the invariants checked by either adversarial suite (still 79/79, 100% — this finding is exclusively from the real-world suite). Confirms the real-world suite is already earning its keep: this pattern is absent from all 79 synthetic scenarios.

---

## RWF-002 — One unresolved construct anywhere in the reachable graph forces `UNKNOWN`, even when unrelated to the target being checked

**Discovered:** scanning real `node-forge@1.3.3` (`RWB-06`) against real GHSA-2328-f5f3-gj25 / CVE-2026-33896, in a fixture whose application code has **zero relationship to node-forge at all**.

**Symptom:** `RWB-06`'s entrypoint (`src/index.js`) is a single trivial function that never imports or references `node-forge`:

```js
function formatAuthHeader(token) {
  return `Bearer ${token.trim()}`;
}
module.exports = { formatAuthHeader };
```

The expected verdict is `NOT_AFFECTED` (node-forge is genuinely never touched). The actual verdict was `UNKNOWN`, with the single diagnostic `unsupported_construct at .../src/index.js#formatAuthHeader@5:1` — line 5 is the `return` statement's template literal containing `token.trim()`.

**Root cause, confirmed by direct isolation:** a copy of the fixture was made with the only change being `token.trim()` → plain string concatenation (`"Bearer " + token`, no method call at all). Re-scanning that isolated copy — **still with `node-forge` equally unimported and equally never referenced** — produced the correct `NOT_AFFECTED`, with zero diagnostics:

```
$ diff:  return `Bearer ${token.trim()}`;   →   return "Bearer " + token;
verdict: UNKNOWN → NOT_AFFECTED
```

This proves the mechanism precisely: `checkReachability`'s search (`src/analysis/verdict.ts`) walks the *entire* call graph reachable from an entrypoint, and per its own documented contract (the `buildFinding` docstring: `"unreachable" — which TASK-020 only returns once a search is fully exhausted with no blocking uncertainty`), encountering **any** edge the call graph can't classify anywhere in that reachable subgraph — even one with no path toward the rule's actual target — sets `sawUnknown = true` for the whole search, which downstream becomes `UNKNOWN` rather than a confident `NOT_AFFECTED`. In this case, `String.prototype.trim()` — a completely ordinary built-in method call, unrelated to node-forge in every way — was itself an "unsupported_construct" the call graph couldn't classify, and that alone was sufficient to suppress the correct verdict.

**Why this matters:** this is architecturally the *correct*, deliberately conservative behavior per `AGENTS.md`'s core rule (never infer `NOT_AFFECTED` merely because something failed to resolve) — but its blast radius is much larger than that rule's original framing suggests. It means **any** construct the call graph doesn't fully model, anywhere in an entrypoint's reachable code — not just code touching the vulnerable dependency — prevents a confident `NOT_AFFECTED` for *every* vulnerability checked against that entrypoint. Real-world application code is dense with exactly this kind of construct (as this same benchmark run also shows: anonymous functions, cross-file re-exports, bundler output — `RWF-003`/`RWF-004`/`RWF-006`). This is very likely a *compounding* factor behind several of this run's other `UNKNOWN` results (`RWB-01`, `RWB-02`, `RWB-03`, `RWB-05`, `RWB-08`, `RWB-09a`) in addition to each of those cases' own primary resolution gap — fixing only the primary gap in each of those cases may not be sufficient by itself if other, unrelated unresolved constructs remain anywhere else in the same reachable subgraph.

**Relevant files:** `src/analysis/verdict.ts` (`checkReachability`, `buildFinding`), `src/analysis/reachability.ts` (`analyzeReachability`'s `unknown`-state propagation).

**Proposed direction (not scoped, not implemented):** this is a genuine soundness-vs-precision tradeoff, not simply a bug to fix — narrowing it (e.g., scoping "blocking uncertainty" to unresolved edges that lie on *some* path toward the target, rather than anywhere in the reachable subgraph) would need careful analysis to confirm it can't introduce a false `NOT_AFFECTED`. Flagging the tradeoff itself as the finding, not prescribing a fix.

**MVP-readiness relevance:** does not violate any adversarial-suite invariant (still 79/79) — the adversarial fixtures are, by construction, minimal and free of incidental unresolved constructs, so this behavior was invisible to them. This is the highest-value finding from this benchmark run precisely because it was invisible to synthetic testing.

---

## RWF-003 — `module.exports` assigned as an anonymous function expression isn't matched to a function node

**Discovered:** scanning real `minimist@1.2.5` (`RWB-02`) against real GHSA-xvch-5gv4-984h / CVE-2021-44906.

**Symptom:** `parseArgs()` calls `minimist(argv)` directly — a plain call to the package's default export, one same-file hop from the entrypoint. Expected `AFFECTED`; actual `UNKNOWN`, with `unresolved_target at .../src/cli.js#parseArgs@6:1` plus dozens of `unsupported_construct` diagnostics pointing into `minimist`'s own internal implementation (the call graph attempts to walk into the callee and can't classify its internals either).

**Root cause, confirmed by reading the real installed `node_modules/minimist/index.js`:**

```js
module.exports = function (args, opts) {
    if (!opts) opts = {};
    ...
};
```

Contrast with `url-parse` (`RWB-04`, which correctly resolved `AFFECTED`): `module.exports = Url;` where `Url` is a **named, locally-declared function** (`function Url(address, location, parser) {...}`). `mapExportsToFunctions` (`src/code-intelligence/module-model.ts`) resolves an export by looking up `index.functions.find(fn => fn.name === localKey)` — a **name-based** lookup against the file's own indexed function declarations. `minimist`'s default export is an anonymous function expression assigned directly as the `module.exports` value; it has no name to match against, so this lookup fails and the export resolves to a phantom node instead of the real function.

**Why this matters:** `module.exports = function (...) {...}` is an extremely common, idiomatic CommonJS pattern for single-purpose packages that don't bother naming their sole exported function — `lodash.template`/`url-parse` (both handled correctly) happen to use named functions/identifiers, but plenty of real packages don't.

**Relevant files:** `src/code-intelligence/module-model.ts` (`mapExportsToFunctions`), `src/analysis/verdict.ts` (`findExportNodeInFile`).

**Proposed direction (not scoped, not implemented):** when an export's value is an anonymous function/arrow expression with no local name, match against the expression's own AST node directly (already indexed somewhere in `source-index.ts`'s function table under a synthetic or positional key) rather than requiring a name match at all — a targeted extension to `mapExportsToFunctions`, not a broader resolution rewrite.

**MVP-readiness relevance:** does not violate any adversarial-suite invariant (still 79/79) — no existing adversarial fixture uses a bare anonymous-function `module.exports` value.

---

## RWF-004 — An exported value re-exported from a different file (same package or a different package) is never chased to its real declaration

**Discovered:** scanning real `qs@6.10.1` (`RWB-05`), real `debug@2.0.0`/`ms@0.6.2` (`RWB-08`), and real `semver@7.5.1`/`7.5.2` (`RWB-09a`/`RWB-09b`).

**Symptom, `qs` (the clearest case):** `toQueryString()` calls only `qs.stringify(filters)` — the *safe*, unrelated export; `qs.parse` (the vulnerable one) is never referenced at all. Expected `NOT_AFFECTED`; actual `UNKNOWN` for **both** the vulnerable and the safe finding, with `unresolved_target at .../src/serialize-filters.js#toQueryString@6:1` — the diagnostic points at the *safe* call site, confirming the failure is in resolving `qs.stringify` itself, unrelated to the rule's own target (`qs.parse`).

**Root cause, confirmed by reading the real installed `node_modules/qs/lib/index.js`:**

```js
var stringify = require('./stringify');
var parse = require('./parse');
var formats = require('./formats');
module.exports = { formats: formats, parse: parse, stringify: stringify };
```

Both `parse` and `stringify` are **local variables whose values come from `require()`ing other files** (`lib/parse.js`, `lib/stringify.js`) — not functions declared within `lib/index.js` itself. `mapExportsToFunctions`'s same-file name lookup (see `RWF-003`) has no way to find them, since the real function bodies live in different files entirely.

**Same mechanism, two real-world variants confirmed:**
- **`semver@7.5.1`/`7.5.2` (`RWB-09a`/`RWB-09b`):** `module.exports = { Range: require('./classes/range'), ... }` — the re-exported value is referenced *inline* in the object literal, not even via an intermediate variable. Both the vulnerable (`7.5.1`) and patched (`7.5.2`) instances hit this identically (`unresolved_target` at both `isCompatible@8:1` and `isLegacyCompatible@12:1`).
- **`debug@2.0.0` → `ms@0.6.2` (`RWB-08`):** the hardest variant — `debug.js:14`: `exports.humanize = require('ms');`. Here the re-export crosses a **package boundary**, not just a file boundary within one package. `src/code-intelligence/module-model.ts` already documents (in `mapExportsToFunctions`'s own comment) that "chasing a re-export to its ultimate source file is not attempted here" — this finding confirms that limitation is real and reachable from genuine, common real-world code (not just theoretical), and additionally shows it applies to the intra-package sibling-file case (`qs`, `semver`), not only the documented cross-package case.

**Why this matters:** splitting a package's implementation across multiple files and assembling `module.exports` from `require()`d pieces is one of the most common real-world CommonJS authoring patterns — arguably more common than a single-file implementation for any package past trivial size. `RWF-001` (lodash) is a *related but distinct* mechanism (a local alias of the `module` identifier itself defeats export-assignment *detection*); this finding is about the *assigned value's provenance* crossing a file boundary, defeating export-to-function *resolution*, even when the assignment itself (`module.exports = {...}`) is textbook-recognizable.

**Relevant files:** `src/code-intelligence/module-model.ts` (`mapExportsToFunctions`'s documented, confirmed-real limitation), `src/analysis/verdict.ts` (`findExportNodeInFile`).

**Proposed direction (not scoped, not implemented):** when an export's local binding resolves to a `require(...)` call expression (directly, or via one level of local-variable indirection), follow that `require()` to the target file and repeat the same-file function lookup there — a bounded, one-or-few-hop chase (matching `VT-214`'s existing alias-tracking precedent), not unbounded points-to analysis. The cross-package (`RWB-08`) variant is strictly harder (crosses into a different package's own `node_modules` resolution) and may warrant being scoped as a separate, later step from the same-package sibling-file case (`RWB-05`, `RWB-09`).

**MVP-readiness relevance:** does not violate any adversarial-suite invariant (still 79/79) — no adversarial fixture splits a vulnerable library's implementation across multiple files.

---

## RWF-005 — TypeScript module resolution prefers a package's `.d.ts` over its real `.js` implementation

**Discovered:** scanning real `trim-newlines@3.0.0` (`RWB-01`) against real GHSA-7p7h-4mm5-852v / CVE-2021-33623.

**Symptom:** `normalize()` calls `trimNewlines.end(userInput)` directly and unconditionally — the simplest possible reachable-call shape in this entire benchmark. Expected `AFFECTED`; actual `UNKNOWN`, with `coverage.modulesResolved: 0`, `modulesUnresolved: 1` — the `require("trim-newlines")` import itself failed to resolve to anything usable, not merely the specific `.end` export.

**Root cause, confirmed via a direct call to VulnTrace's own `createModuleResolver`/`loadTsProject`:**

```
resolver.resolve("trim-newlines", <referenceFile>)
  -> { kind: "resolved",
       resolvedFileName: ".../node_modules/trim-newlines/index.d.ts",
       packageId: { name: "trim-newlines", version: "3.0.0", subModuleName: "index.d.ts" } }
```

TypeScript's module resolution resolved the bare specifier `"trim-newlines"` to the package's **hand-authored `index.d.ts`** (a real, separate type-declaration file `trim-newlines` ships — `declare const trimNewlines: {...}; export = trimNewlines;`) instead of its real `index.js` implementation. A `.d.ts` file has no function bodies — only type signatures — so every downstream step (call-graph construction, `findExportNodeInFile`) operating on this resolved file finds nothing real to analyze. Contrast with `url-parse`/`minimist`/`ini` (none of which ship a `.d.ts`), which all resolve straight to their real `.js`.

**Why this matters:** shipping a separate, hand-authored `.d.ts` alongside plain JavaScript (rather than JSDoc-derived inline types) is a common, idiomatic practice for small, dependency-free utility packages — `trim-newlines` is a representative example, not an edge case. Any such package would hit this same resolution-level failure before export-matching (`RWF-003`/`RWF-004`) is even reached.

**Relevant files:** `src/code-intelligence/module-resolver.ts` (`createModuleResolver`, the underlying `ts.resolveModuleName`/`ts.LanguageServiceHost` configuration it wraps), `src/code-intelligence/ts-project.ts` (`loadTsProject`'s compiler options — likely the `moduleResolution`/`allowJs`/declaration-preference settings governing this choice).

**Proposed direction (not scoped, not implemented):** either adjust the underlying `ts.CompilerOptions` VulnTrace's project uses (there is a documented TypeScript-level knob for preferring `.js` over co-located `.d.ts` in certain resolution modes) or, when a resolution lands on a `.d.ts`, explicitly fall back to probing for a sibling `.js`/`.cjs` file with the same base name before giving up — needs investigation into which is the more correct, general fix rather than a `trim-newlines`-specific patch.

**MVP-readiness relevance:** does not violate any adversarial-suite invariant (still 79/79) — no adversarial fixture package ships a separate `.d.ts`. This is the single most surprising finding in this run given how simple the underlying code pattern is.

---

## RWF-006 — Webpack-bundled, getter-defined class exports aren't recognized as constructible/method-bearing targets

**Discovered:** scanning real `fast-xml-parser@5.3.3` (`RWB-03`) against real GHSA-37qj-frw5-hhjh / CVE-2026-25128.

**Symptom:** `parseFeed()` constructs `new XMLParser({processEntities: true, htmlEntities: true})` and calls `.parse(xmlText)` on it — a real, live-reproduced two-step (construct, then call) reachable path, structurally identical in shape to the already-working `adv2-020-instance-method`/`adv-020-constructor-invocation` synthetic fixtures. Expected `AFFECTED`; actual `UNKNOWN`, with `unresolved_target` and `unsupported_construct` at the application's own `parseFeed@8:1` call site.

**Root cause, confirmed by reading the real installed CJS bundle `node_modules/fast-xml-parser/lib/fxp.cjs`:**

```js
(()=>{"use strict";var t={d:(e,i)=>{for(var n in i)t.o(i,n)&&!t.o(e,n)&&Object.defineProperty(e,n,{enumerable:!0,get:i[n]})}, ...};
var e={};t.r(e),t.d(e,{XMLBuilder:()=>lt,XMLParser:()=>tt,XMLValidator:()=>pt});
...
module.exports=e
```

This is real webpack-library-mode bundler output: `XMLParser` is exposed via `Object.defineProperty(e, "XMLParser", { get: () => tt, enumerable: true })` — a **dynamically defined getter property**, not a plain assignment (`module.exports.XMLParser = ...`) or an ESM `export class XMLParser`. The adversarial suites' synthetic class fixtures (`vt2-vuln-lib`, `adv-vuln-lib`) all use plain ESM `export class` declarations, compiled straightforwardly; none exercise bundler-generated getter-property output.

**Why this matters:** shipping a webpack (or Rollup/esbuild)-bundled single-file CJS build as the package's real `require()` entry — while keeping separate, unbundled ESM source for `import` consumers — is an increasingly common real-world publishing pattern for dual-format packages (`fast-xml-parser`'s own `package.json` `exports` map does exactly this: `require` → `./lib/fxp.cjs`, `import` → `./src/fxp.js`). A project statically analyzing the `require()` path specifically will hit the bundled getter-based shape, not the original source.

**Relevant files:** `src/code-intelligence/source-index.ts` (whatever recognizes exported class/constructor declarations — needs to additionally recognize `Object.defineProperty(target, name, { get: () => X })` as an export-equivalent binding to `X`), `src/code-intelligence/module-model.ts`.

**Proposed direction (not scoped, not implemented):** recognize the specific `Object.defineProperty(<exportsObject>, "<name>", { get: () => <identifier> })` shape (or its minified equivalent, matched structurally rather than by exact minified variable names) as equivalent to a plain `<exportsObject>.<name> = <identifier>` assignment for export-resolution purposes — narrow and pattern-specific, not a general getter-evaluation feature.

**MVP-readiness relevance:** does not violate any adversarial-suite invariant (still 79/79) — no adversarial fixture ships bundler-generated output; all are hand-authored source.
