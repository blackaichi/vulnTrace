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

## Benchmark methodology note — VT-303 cause-splitting

The independent audit (`docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md` § 9.2)
identified `RWB-06` and `RWB-09` as **cause-confounded**: each mixes an
intended thesis with one or more unrelated, independent mechanisms, so a
single pass/fail result can't tell an observer which one actually changed.
VT-303 added clean, single-cause siblings for both, **without modifying
either original fixture or its oracle**:

| Original (unchanged) | Confounds | New sibling | Isolates |
|---|---|---|---|
| `RWB-06` (UNREACHED_DEPENDENCY thesis) | UNREACHED_DEPENDENCY **+** an incidental `token.trim()` `unsupported_construct` (RWF-002) that drives the actual UNKNOWN result | `RWB-06A` | UNREACHED_DEPENDENCY alone — zero other unresolved/dynamic constructs anywhere in the reachable subgraph (verified: 2 graph nodes, 0 edges) |
| `RWB-09` (MULTI_INSTANCE thesis) | npm-alias identity (RWF-009) **+** cross-file re-export resolution (RWF-004) **+** (pre-VT-302) non-hermetic resolution (RWF-010, since fixed) **+** the NO_FINDING oracle-design limitation on the patched instance (RWB-09b, above) | `RWB-11a`/`RWB-11b` | package-instance discrimination alone — two real, unaliased, differently-versioned `url-parse` installs (one nested under a fixture-authored wrapper, one top-level), using the same whole-module-default-export target shape `RWB-04` already proves resolves cleanly, so export attribution can't be a second variable either |

Both original cases are kept exactly as they were — `RWB-06` remains the
RWF-002 exhibit (its blast-radius demonstration is the point: an entirely
unrelated built-in-method call, nothing to do with `node-forge`, is
sufficient to suppress the correct verdict), and `RWB-09` remains the
dedicated **ALIASED_INSTALL** stress case (reclassified here from its
original bare "MULTI_INSTANCE" label, now that a genuine, non-aliased
multi-instance case exists separately to compare against). Neither RWF-002,
RWF-004, RWF-009, nor RWF-010 is fixed by this task — see each finding's
own entry.

All four new cases (`RWB-06A`, `RWB-11a`, `RWB-11b`) currently **pass**,
each independently confirmed via direct call-graph/target-resolution
inspection (not verdict-only): `RWB-06A` — 0 graph edges, `node-forge`
never discovered; `RWB-11a` — a clean 3-hop evidence path to the `Url`
constructor, `packageId.name` correctly `"url-parse"` (no identity
mismatch); `RWB-11b` — the top-level instance is never discovered by the
call graph, and the 44 unrelated `unsupported_construct` edges elsewhere
in `url-parse`'s own internals (real, non-trivial production code) are
all non-closure-widening, so VT-300's guard correctly does not treat them
as a reason to doubt the `NOT_AFFECTED` conclusion.

## Status

| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| RWF-001 | `lodash` (the main package) | UMD `module.exports` assignment via a locally-aliased variable is invisible to export detection | Precision only — degrades to UNKNOWN in both directions, never a false AFFECTED/NOT_AFFECTED | Open, not yet scoped as a task |
| RWF-002 | any (`node-forge` isolates it cleanly) | One unresolved/dynamic construct *anywhere* in an entrypoint's reachable call graph forces `UNKNOWN` for every vulnerability checked against that entrypoint, even when the construct is entirely unrelated to the target | Precision, but broad real-world reach — real applications routinely contain constructs the call graph can't fully model | **Bypassed for unloaded packages (VT-307d)**; the underlying reachability-scoping tradeoff remains open — see below |
| RWF-003 | `minimist` | `module.exports = function (...) {...}` (an anonymous function expression, not a named local declaration) isn't matched by export-to-function resolution | Precision only — degrades to UNKNOWN, never a false verdict | **Fixed** — see below |
| RWF-004 | `qs`, `debug`→`ms`, `semver` | An exported value that is itself a re-export of a function declared in a *different* file (same-package sibling file or a different package entirely) is never chased to its real declaration | Precision only — degrades to UNKNOWN, never a false verdict | **Fixed — RWF-004a (same package) and RWF-004b (cross package)** — see below |
| RWF-005 | `trim-newlines` | TypeScript module resolution prefers a package's hand-authored `.d.ts` over its real `.js` implementation when resolving a bare specifier from a plain `.js` importer | Precision only — degrades to UNKNOWN (analysis operates on a file with no real function bodies) | **Fixed (VT-304)** |
| RWF-006 | `fast-xml-parser` | A webpack-bundled, `Object.defineProperty`-getter-defined class export isn't recognized as a constructible/method-bearing target | Precision only — degrades to UNKNOWN, never a false verdict | Open, not yet scoped as a task |
| RWF-007 | `RWB-10` (`fs`, `path`) | `ts.resolveModuleName` never resolves Node builtin specifiers (`fs`, `node:fs`, ...) — every builtin `require`/`import` call produced an `unresolved_module` edge, a **closure-widening** blocker, in essentially every real Node application | Precision, universal blast radius (also a soundness *prerequisite*: combined with RWF-002, no realistic Node application could ever reach `NOT_AFFECTED` while this stood) | **Fixed (VT-305)** |
| RWF-009 | `semver` (`RWB-09a`, npm alias `semver-vulnerable`) | `identifyModule()` derived package *identity* purely from the install *directory* name, not the installed package's own declared `package.json` `"name"` — an npm-aliased install (`"semver-vulnerable": "npm:semver@7.5.1"`) was therefore invisible to `graphPackageInstances(graph, "semver")` even though the call graph genuinely traversed it | **Soundness** — a genuinely-reached aliased instance was silently treated as `confirmedAbsentInstance` (VT-212's guard, meant for a never-touched instance), producing a false `NOT_AFFECTED` for a package that was, in fact, reached and vulnerable | **Fixed (VT-306)** |
| RWF-013 | any CommonJS file that reassigns an exported local (real shapes in `es-define-property`, `gopd`) | An export whose value is an identifier the file itself REASSIGNS fell through to a same-file name search, which lands on the binding's STALE initializer — an anonymous function expression is indexed under the name of the variable it was assigned to, so the stale node matches the export name exactly | **Soundness** — reproduced end-to-end as a false `NOT_AFFECTED` carrying a complete Family C unreachability proof over a function the module does not export | **Fixed for variable bindings (RWF-013)**; the declaration-form half is RWF-013b below |
| RWF-013b | any CommonJS file that reassigns an exported `function`/`class` DECLARATION | RWF-013 classified an identifier's provenance by asking how the name was DECLARED, so a reassigned function/class declaration was reported "unmodeled" — silence — and still fell through to the legacy name search, even though the same fact collector had already recorded the reassignment | **Soundness** — the identical false `NOT_AFFECTED` with a complete Family C proof, surviving RWF-013 | **Fixed (RWF-013b)** |
| RWF-014 | any CommonJS file whose `module.exports = <identifier>` sits in a CONDITIONAL or nested position (real shapes in UMD/feature-detect boilerplate) | `wholeModuleDefaultExport` reads a `localName` off the assignment's right-hand side without asking whether that assignment is unconditional, while every other export-provenance fact in the same relation is gated on `isUnconditionalExportAssignment`. `findLastModuleExportsAssignment` keeps only the LAST assignment in SOURCE order, so a two-branch `module.exports` picks a branch arbitrarily and presents it as certainty | **Soundness** — reproduced end-to-end as a false `NOT_AFFECTED` carrying a complete Family C proof over a function the module may never export | **Fixed (RWF-014)** |
| RWF-015 | `dunder-proto` (real, vendored under the `RWB-05` fixture); any CommonJS file with a top-level `return`/`throw` above a later export write (browser/node feature-detect boilerplate is the common real shape) | RWF-014 made whole-module export authority depend on the last write being an UNCONDITIONAL top-level statement. Node wraps every CommonJS module in a function, so a module-scope `return` is legal and ends module evaluation, and an uncaught module-scope `throw` propagates out of the `require()` — either one leaves a later, syntactically unconditional write unexecuted. Every export-provenance gate asked whether a write was unconditional when the property it needed was whether the write is REACHED | **Soundness** — reproduced end-to-end as a false `NOT_AFFECTED` carrying a complete Family C proof over the value the module exports on every early-exit load; shared verbatim by property exports, object-literal, class, chained-alias and require-re-export attribution | **Fixed (RWF-015)** |
| RWF-012 | `ini` | A chained CommonJS export alias (`exports.parse = exports.decode = decode`) assigns the exported name `parse` to a function whose own declared name is `decode`; export-symbol attribution has no way to bridge the two. The same relation stopped after ONE hop of local-variable indirection, so `const a = require("pkg"); const b = a; module.exports = b` was equally unattributable | Precision only — degrades to UNKNOWN, never a false verdict (VT-301B correctly closed the adjacent soundness gap that let this coincidentally read as `NOT_AFFECTED` before) | **Fixed (RWF-012)** |
| RWF-016 | any CommonJS file with a top-level call to a local, non-reassigned function/arrow whose entire body always throws, above a later export write (real shape: UMD/feature-detect boilerplate that calls a `fail()`/`bail()`-style helper instead of writing a bare `return`/`throw`) | RWF-015 made module-evaluation reachability depend on a literal syntactic `return`/`throw` (`firstModuleEvaluationCutoff`). A CALL to a local function whose own body always throws ends module evaluation exactly as a literal `throw` inlined at the call site would, but RWF-015's model deliberately does not reason about calls at all (and is right not to, for an ARBITRARY call) — so this one narrow, provably-safe exception was still a gap | **Soundness** — reproduced end-to-end as a false `NOT_AFFECTED` carrying a complete Family C proof over the value the module exports whenever the throwing call's branch is taken; a real Node-executed circular-import fixture confirms a cyclic consumer can retain the bypassed dangerous export before the call throws | **Fixed (RWF-016)** |
| RWF-017 | any CommonJS file where the RWF-016 shape's throwing call is written as a variable declaration's initializer (`const x = bail();`) rather than as a bare statement (`bail();`), above a later export write — the same UMD/feature-detect boilerplate family, where the helper's return value is captured instead of discarded | RWF-016 proved the CALLEE (`resolveExactLocalCallable` + `cannotCompleteNormally`) but recognised the CALL in one syntactic position only: `isDefinitelyAbruptCallStatement` opened with `if (!ts.isExpressionStatement(node)) return false`, so a `VariableStatement` whose declarator initializer is that exact call was refused on shape alone. Abrupt module-evaluation behavior is a property of execution semantics — JavaScript evaluates a declarator's initializer as part of executing the declaration — not of whether the `CallExpression` happens to be wrapped in an `ExpressionStatement` | **Soundness** — reproduced end-to-end as a false `NOT_AFFECTED` carrying a complete Family C proof (`confirmedUnreachableTarget`, `reachableSubgraphComplete: true`) over the value the module exports whenever the initializer's branch is taken; a real Node-executed circular-import fixture confirms a cyclic consumer retains the bypassed dangerous export and calls the vulnerable sink through it | **Fixed (RWF-017)** |
| RWF-018 | any CommonJS file where the RWF-016/017 shape's throwing call is written as a class STATIC FIELD initializer (`class C { static x = bail(); }`) rather than as a statement, above a later export write — the same UMD/feature-detect family, where the helper's result is captured on a class instead of in a variable | RWF-016 proved the CALLEE and RWF-017 proved that the call's syntactic POSITION does not change the outcome, but both recognised the call only in STATEMENT positions: `isDefinitelyAbruptCallStatement` dispatched on `ExpressionStatement` or `VariableStatement` and refused everything else on shape alone. A static field initializer is neither — it hangs off a `PropertyDeclaration` — and it is executed by CLASS EVALUATION, which is itself part of module evaluation: evaluating a class definition runs its static elements, blocks and field initializers alike, in declaration order. An INSTANCE field is genuinely different and must stay excluded: it is installed by class evaluation and executed per-instance during construction | **Soundness** — reproduced end-to-end as a false `NOT_AFFECTED` carrying a complete Family C proof (`confirmedUnreachableTarget`, `reachableSubgraphComplete: true`) over the value the module exports whenever the class's branch is taken; a real Node-executed circular-import fixture confirms a cyclic consumer retains the bypassed dangerous export and calls the vulnerable sink through it, and — in the same process — that the INSTANCE-field twin genuinely does complete and publish its later export | **Fixed (RWF-018)** |
| RWF-019 | any CommonJS file where the RWF-016/017/018 shape's throwing call is written as a class element's COMPUTED KEY (`class C { [bail()] = 1; }`, `class C { [bail()]() {} }`) rather than in a value position, above a later export write — the same UMD/feature-detect family, and NOT restricted to `static` elements | RWF-016 proved the CALLEE, RWF-017 proved the call's syntactic POSITION does not change the outcome, and RWF-018 carried it into a class STATIC FIELD initializer. All three read the call out of a VALUE position: `isDefinitelyAbruptCallStatement` dispatched on `ExpressionStatement`/`VariableStatement`, and `isDefinitelyAbruptStaticFieldInitializer` on a `PropertyDeclaration`'s `initializer` gated on the `static` modifier. A computed property name is neither. It is evaluated by ClassDefinitionEvaluation, in declaration order, as each element is defined — the key has to exist before the element can be installed on the class or its prototype — so it runs at class-definition time for an INSTANCE field, a method, a getter and a setter exactly as for a static field, even though those elements' VALUES and BODIES are genuinely deferred. RWF-018 recorded this as the RWF-019 candidate rather than folding a partial version of it in behind a static-field name | **Soundness** — reproduced end-to-end as a false `NOT_AFFECTED` carrying a complete Family C proof (`confirmedUnreachableTarget`, `reachableSubgraphComplete: true`) over the value the module exports whenever the class's branch is taken; a real Node-executed circular-import fixture confirms a cyclic consumer retains the bypassed dangerous export and calls the vulnerable sink through it, that all eight element forms abort the class definition on the same key, and — in the same process — that the same element's instance-field VALUE, a method BODY and a class defined inside an uncalled function genuinely do complete and publish their later export | **Fixed (RWF-019)** |
| RWF-021 | any CommonJS file used as a CONFIGURED ENTRYPOINT that exports a top-level callable and carries any RWF-014/015/016/017/018/019 authority-withdrawing construct above the export write — and, independently of any cutoff, any entrypoint exporting an ANONYMOUS callable | Entrypoint reachability ROOTS were read out of export ATTRIBUTION provenance (`exp.localName ?? exp.exportedName` in verdict.ts's `entrypointSourceNodes`). The two questions fail in opposite directions — attribution must REFUSE when it cannot name the exported value, root selection must WIDEN — so every soundness cutoff that correctly withdrew attribution silently deleted the entrypoint's root as well. The exported function's body was then never traversed, and an anonymous export (RWF-003's shape) had no name to be rooted by at all | **Soundness, cross-family** — reproduced end-to-end on `8d18130` as a false `NOT_AFFECTED` carrying a complete Family C proof (`confirmedUnreachableTarget`, `reachableSubgraphComplete: true`) for **all four merged cutoff families** (RWF-016/017/018/019) plus the property-export and anonymous-export forms, over an entrypoint whose exported `main` really is published and really does reach the vulnerable sink on every run where the branch is not taken (asserted under real `node`) | **Fixed (RWF-021)** |

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

### Status update — VT-307d (module-load absence negative proof)

`RWB-06` now returns the expected `NOT_AFFECTED`. Read the scope of that
carefully, because it is **not** the fix this finding's "proposed direction"
above contemplated, and RWF-002's own tradeoff is deliberately untouched:

- Nothing about "blocking uncertainty" was narrowed. `checkReachability`
  still sets `sawUnknown` for **any** unclassifiable edge anywhere in an
  entrypoint's reachable subgraph, exactly as described above, and every
  reachability-derived `NOT_AFFECTED` still requires `graphTruncated ===
  false`. The dangerous change this finding warned against — scoping
  blocking uncertainty to edges "on some path toward the target" — was
  **not** made, and would still need the careful analysis this entry asks
  for.
- Instead, VT-307d added a **second, independent** route to `NOT_AFFECTED`
  that never consults the call graph at all: a `ModuleLoadClosure` over the
  configured entrypoints. When that closure is **complete** and this
  finding's exact canonical `PackageInstanceId` is **not** in its
  `loadedPackageInstances`, the affected package's code cannot execute from
  those entrypoints at all — so no call-graph search is needed to know that
  no call into it can happen either.
- Why unrelated non-widening uncertainty is safe to ignore **on that route
  specifically**: a construct that could actually load a module the
  traversal never saw is *closure-widening*, and every closure-widening
  construct makes the closure incomplete, which withdraws the proof
  entirely. `token.trim()` — this finding's own trigger — is
  `unsupported_construct`: non-widening, bounded to values already
  discovered, and incapable of loading `node-forge`. It therefore stops
  vetoing a conclusion it has no bearing on, without anything being
  assumed about it.

So the blast radius described above is genuinely reduced, but only for the
UNREACHED_DEPENDENCY shape: a package that is installed and never loaded.
A vulnerable package that IS loaded, with an unattributable target or an
unresolved call path, still returns `UNKNOWN` for precisely the reasons
this finding gives (`RWB-07`, `RWB-08`, `RWB-09a`, `RWB-10` are all
unchanged). The compounding effect this entry predicted for those cases is
real and still stands.

---

## RWF-003 — `module.exports` assigned as an anonymous function expression isn't matched to a function node

**Status: Fixed.** An export binding now carries the exported value's
CONCRETE FUNCTION IDENTITY — the source position of the function-like node
it structurally references — on
`ExportBinding.localFunctionLocation`
(`src/code-intelligence/module-model.ts`), derived by
`directExportedFunctionLocation` and preferred by `mapExportsToFunctions`
over the pre-existing same-file name search. Exactly one AST node begins at
a given position, so the resolution is an identity rather than a text
match, and it works for a function with no name at all — which is the whole
point. `source-index.ts` additionally stops fabricating the name `"exports"`
for such a function: `module.exports = function () {}` assigns to the
CommonJS construct, not to a property named `exports`, and reporting that
text both misled evidence output and left a fake name a name-based match
could latch onto (`exports.foo = function () {}` still names the function
`foo`, which is accurate and is relied on).

Six shapes now attribute (a direct anonymous / named / `async` function
expression, a direct arrow or `async` arrow, TypeScript's
`export = function () {}`, and one hop through a module-scope, provably
single-assignment local binding holding a function expression or arrow —
reusing `commonjs-reexports.ts`'s existing single-assignment proof, not a
new one). Three guards keep the result a fact:

- **unconditional module scope** — the winning assignment must be a direct
  statement of the file. `findLastModuleExportsAssignment` picks the last
  assignment in SOURCE order, which is not execution order, so binding to a
  conditional one would be choosing a branch arbitrarily;
- **CommonJS ambient provenance** — a file declaring its own
  `module`/`exports`/`require` binding is refused outright, preserving
  RWF-004a's protection;
- **exactly one alias hop** — a longer chain resolves to nothing here
  (RWF-012's boundary, deliberately not broadened).

Every refusal leaves the export exactly as unattributed as before, i.e.
UNKNOWN. Nothing in `verdict.ts`, the reachability search, the proof
context or the negative-proof schema changed: attribution improves, so the
real function node is bound and the normal call graph and reachability
search do the rest. An anonymous exported CLASS
(`module.exports = class {}`) is deliberately still unattributed — its
callable target is a constructor and its members are attributed by a
name-keyed relation (`findExportedClassMembers`).

**Result:** `RWB-02` (`minimist`) moved `UNKNOWN` → `AFFECTED`, with a
concrete three-hop evidence path ending at the anonymous function in
`node_modules/minimist/index.js`. No other validation case moved, and no
case moved into `NOT_AFFECTED`. `RWB-05` (`qs`) is still `UNKNOWN` — see
the note under RWF-004 below, which this fix updates.

**One `UNKNOWN` → `NOT_AFFECTED` transition is now reachable in principle,
and it is correct.** Attribution is a precondition for BOTH verdicts, not
just for `AFFECTED`: an application that installs a package whose whole API
is an anonymous `module.exports` function and never calls it previously
came out `UNKNOWN` because the target could not be attributed at all
(`verdict.ts`'s Site A). With the target attributed to a real node, a
complete, untruncated graph containing no path to it now reaches
`NOT_AFFECTED` through exactly the positive-proof route `RWB-06`/`RWB-11b`
already use — nothing new was added to the verdict layer, the proof
context, or the negative-proof schema. Note what does NOT happen: no
`NOT_AFFECTED` is ever inferred from a failure to resolve. Every shape this
relation refuses (conditional assignment, ambient shadowing, a >1-hop alias
chain, a cross-package hop) stays `UNKNOWN`. Both directions are pinned in
`src/cli/scan.anonymous-export.test.ts`, which runs the real scan command
end to end. No validation case and no adversarial scenario moved into
`NOT_AFFECTED`.

**Composition with RWF-004a, verified:** the two relations compose in both
directions. A same-package whole-module re-export chain
(`index.js -> internal/ops.js -> impl.js`) terminating in an anonymous
`module.exports = function () {}` now binds end to end; permanent coverage
is `fixtures/commonjs-anonymous-export` (with
`src/analysis/verdict.anonymous-export.integration.test.ts`) and `ADV2-068`.
The cross-package half stays refused: RWF-004b is unchanged, and both the
fixture and `ADV2-068` carry an identically-shaped anonymous export in a
DIFFERENT installed package that must never be bound.

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

**Status: the SAME-PACKAGE half (RWF-004a) is fixed; the cross-package half
(RWF-004b) remains open.**

`src/code-intelligence/commonjs-reexports.ts` now derives a CommonJS
re-export ORIGIN (`{specifier, importedName?}`) for an export whose value
comes from a literal `require()` — directly, or through exactly one hop of a
module-scope, provably single-assignment local binding — and
`module-model.ts` carries it on `ExportBinding.commonJsReExport`.
`call-graph.ts`'s `resolveReExportChain` chases it, composing across hops
and across syntaxes with the existing ESM chase, and is gated on the target
file belonging to the **same canonical PackageInstance** (`identifyModule`),
so a relative `../` specifier, a same-name/same-version install at a
different path, and a bare cross-package specifier are all refused. Dynamic
specifiers, conditionals, chained aliases (RWF-012) and files that declare
their own `exports`/`module`/`require` binding all produce no origin at all
and keep their previous UNKNOWN.

**Result:** `RWB-09a` moved `UNKNOWN` → `AFFECTED` (the correct answer;
see below and RWF-009). No other validation case moved, and no case moved
into `NOT_AFFECTED`. `RWB-05` (`qs`) and `RWB-08` (`debug`→`ms`) still fail,
each for a *second*, independent reason documented below.

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

**Direction taken (RWF-004a and RWF-004b, both implemented as described):** when an export's local binding resolves to a `require(...)` call expression (directly, or via one level of local-variable indirection), follow that `require()` to the target file and repeat the same-file function lookup there — a bounded, one-or-few-hop chase (matching `VT-214`'s existing alias-tracking precedent), not unbounded points-to analysis. The cross-package (`RWB-08`) variant was scoped as a separate, later step (**RWF-004b**) from the same-package sibling-file case (**RWF-004a**), on the expectation that crossing into a different package's own `node_modules` resolution would be strictly harder. It was not: the hop is resolved by the same authoritative resolver, from the same file, and the extra step turned out to be a *conservatism* one — see "RWF-004b — what changed, and what did not" below.

**Why `RWB-05` (`qs`) still fails after RWF-004a AND RWF-003:** the export
half of this case is now fully resolved. `qs`'s re-export chain reaches
`lib/stringify.js`, whose `module.exports = function (object, opts)` is
anonymous, and RWF-003 attributes it — the `unresolved_target at
src/serialize-filters.js#toQueryString` diagnostic that this entry
originally described is **gone**, and the call graph now walks into `qs`'s
real implementation. `RWB-05` nevertheless remains `UNKNOWN`, for two
independent reasons, neither of which is RWF-003 or RWF-004:

1. **Target attribution does not chase a re-export.** The rule names
   `qs#parse`, and `verdict.ts`'s `findExportNodeInFile` attributes a
   target with a per-file `mapExportsToFunctions` lookup across the
   instance's discovered files. `lib/parse.js` *is* discovered (`lib/index.js`
   does `var parse = require('./parse')` at module level), but its canonical
   export name is `"default"` — it is `module.exports = function (str, opts)`
   — not `"parse"`; and `lib/index.js`'s own `parse` entry is a re-export
   with no local function, which `mapExportsToFunctions` deliberately does
   not chase. Bridging `qs#parse` -> `lib/parse.js#default` needs a
   TARGET-side re-export chase; the existing chase (`resolveReExportChain`)
   lives in the call graph and is driven from real call sites, and nothing
   ever calls `parse`. So the target stays honestly unresolved: `export
   "parse" could not be attributed to any function or class member in the
   resolved module`. That is a separate, deliberate scope boundary, not a
   defect in either relation.
2. **RWF-002's blocking uncertainty, now with a wider surface.** Because
   the call into `qs.stringify` resolves, the reachable subgraph now
   genuinely includes `qs`'s implementation and its transitive dependencies
   (`get-intrinsic`, `side-channel`, `object-inspect`, …), which are dense
   with `unsupported_construct`, `dynamic_member_access` and
   `function_constructor` diagnostics. Any one of those sets `sawUnknown`
   and blocks a reachability-derived `NOT_AFFECTED`. This is RWF-002's
   documented tradeoff, unchanged; resolving more of the graph legitimately
   exposes more of it.

`RWB-05` expects `NOT_AFFECTED`, so it needs both of the above, not more
export attribution.

**`RWB-08` (`debug`→`ms`) — fixed by RWF-004b.** Its first hop
(`node.js`'s `exports = module.exports = require('./debug')`) is
same-package and resolved from RWF-004a; its second hop
(`debug.js:14`'s `exports.humanize = require('ms')`) crosses a package
boundary and was refused by design until RWF-004b. `RWB-08` is now
`AFFECTED`, attributed to `ms@0.6.2` — never to `debug`, whose file merely
spells the re-export — over the evidence path
`src/rate-limit.js:9` → `node_modules/ms/index.js:24`, i.e. `ms`'s own
anonymous `module.exports = function (val, options)` (RWF-003) inside `ms`'s
own canonical PackageInstance.

### RWF-004b — what changed, and what did not

The same-instance test in `call-graph.ts`'s re-export chase was **scoping,
not a soundness guard**, and removing it is the whole of RWF-004b's
resolution change. What kept attribution honest was never that test: it is
**resolver relativity**. Each hop's specifier is resolved *from the file
that physically spells the `require()`*, so `require("vuln-pkg")` inside
`app/node_modules/wrapper/index.js` reaches
`app/node_modules/wrapper/node_modules/vuln-pkg` when that nested install
exists and `app/node_modules/vuln-pkg` only when it does not — Node's own
answer, never a search for an installed package by name or version. Package
identity is then derived downstream from the resolved file's path alone by
`identifyModule`, so two installs sharing a name *and* a version remain
distinct instances end to end. The chase forms no package-identity opinion
of its own; a second opinion at that layer is exactly the parallel source of
truth `SDD-v0.2.md` § 5 forbids.

**A real false `NOT_AFFECTED` was found and closed while implementing
this**, and it is the reason the change is not a one-line deletion. Every
export-provenance fact in `module-model.ts` is read out of a
**last-write-wins** map keyed by source order, which is Node's semantics for
straight-line module-scope code and nothing else. For

```js
if (cond) { exports.parse = require("pkg-a").parse; }
else      { exports.parse = require("pkg-b").parse; }
```

the map keeps only `pkg-b`. `localName`/`localFunctionLocation` were already
gated on an unconditional-module-scope test (RWF-011); `commonJsReExport`
was not. Ungated, the chase forwarded `wrapper.parse` to `pkg-b` alone and
thereby asserted that `pkg-a`'s function is *not* what the export holds:
`pkg-a`'s target then resolved to a real node nothing pointed at, and
Family C proved it unreachable with `reachableSubgraphComplete: true`.
Reproduced end to end before the fix (`UNKNOWN` on the pre-RWF-004b main,
`NOT_AFFECTED` with the gate removed and nothing else changed). Under
RWF-004a the same shape was harmless — both branches sat inside one
instance, so the finding's own package matched either way; crossing a
package boundary is what made it reachable. `commonJsReExport` is now gated
on the same `isUnconditionalExportAssignment` test as its neighbours, which
also refuses `try`/`catch` and single-branch `if` forms while still
accepting the chained `exports = module.exports = require(...)` idiom real
`debug@2.0.0` uses. Permanent coverage:
`src/analysis/verdict.cross-package-reexport.integration.test.ts` and
`src/code-intelligence/call-graph.cross-package-reexport.test.ts`.

**Deliberately still out of scope**, and unchanged by RWF-004b: dynamic
specifiers (`require(name)`), a second local alias hop (`RWF-012`), a
reassigned alias or declaration (`RWF-013`/`RWF-013b`), a coincidental
export-name match (`RWF-011`), and the separate **target-side** re-export
chase `RWB-05` needs — `verdict.ts`'s `findExportNodeInFile` still attributes
a rule target with a per-file lookup and does not chase re-exports, which is
a different direction from the call-side chase RWF-004a/b implement.

**MVP-readiness relevance:** does not violate any adversarial-suite invariant (still 79/79) — no adversarial fixture splits a vulnerable library's implementation across multiple files.

---

## RWF-005 — TypeScript module resolution prefers a package's `.d.ts` over its real `.js` implementation

**Status: Fixed (VT-304).** `src/code-intelligence/module-resolver.ts`'s
`resolveSync` now checks whether `ts.resolveModuleName`'s result is a
declaration file (`.d.ts`/`.d.cts`/`.d.mts`, identified via the compiler's
own `ResolvedModuleFull.extension`) and, if so, attempts to identify the
real runtime implementation before ever returning it as a normal
`"resolved"` result: first by re-resolving the same specifier with
TypeScript's internal `noDtsResolution` option (isolated to one function,
`attemptNoDtsResolution`, with a documented, cast, try/catch-guarded call
site), then by a structurally-scoped same-package sibling probe
(`attemptSiblingRuntimeFile`, respecting `package.json`'s own `main` field
when present) as a fallback. If neither finds a real implementation, the
result is now an explicit, first-class `DeclarationOnlyModule` (`kind:
"declaration"`) — never silently treated as an analyzable module.
Downstream, a declaration-only import now produces an explicit
`declaration_only_resolution` call-edge/`DynamicCallReason`, classified as
closure-widening (the real runtime file was never indexed, so its
behavior — including any further `require`/`import` calls — is exactly as
unknown as an unresolved module), and the declaration file itself is never
indexed as a graph node. `RWB-01` now correctly resolves to `AFFECTED`
(previously `UNKNOWN`) with 0 regressions elsewhere in the suite. See
`src/code-intelligence/module-resolver.ts`'s own doc comments and
`src/code-intelligence/module-resolver.test.ts`'s VT-304 test group for the
full regression coverage, including the `@types/*` case (RWB-09's fixture
never actually exercised the `@types/*` shape — its own real `semver`
installs declare `"main": "index.js"` and ship no `.d.ts` at all, so its
remaining failures are exclusively RWF-004/RWF-009, unrelated to this
finding).

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

---

## RWF-007 — Node builtin specifiers never resolved, producing spurious closure-widening blockers

**Status: Fixed (VT-305).**

**Discovered:** scanning real `handlebars@4.7.6` (`RWB-10`) against real GHSA-f2jv-r9rf-7988 / CVE-2021-23369; also verified directly against `ts.resolveModuleName`.

**Symptom:** `RWB-10`'s `template-engine.js` opens with `const fs = require("fs"); const path = require("path");`, then calls `path.join(...)` and `fs.readFileSync(...)` inside `renderTemplate()`. Both calls produced an `unresolved_module` edge -- a **closure-widening** blocker (`isClosureWideningReason`, `src/domain/graph.ts`) -- entirely unrelated to the case's own intended blocker (the genuinely unresolvable `engines[engineName]` dynamic dispatch). `RWB-10`'s own expected verdict (`UNKNOWN`) never changed, since the intended blocker alone was already sufficient, but the *reason* was polluted, and any application whose reachable subgraph depends on a builtin call one hop earlier than its real target would have been affected for real.

**Root cause, confirmed directly:**

```
resolver.resolve("fs", ...)        -> { kind: "unresolved", ... }
resolver.resolve("path", ...)      -> { kind: "unresolved", ... }
resolver.resolve("node:fs", ...)   -> { kind: "unresolved", ... }
resolver.resolve("crypto", ...)    -> { kind: "unresolved", ... }
resolver.resolve("http", ...)      -> { kind: "unresolved", ... }
```

`ts.resolveModuleName` never resolves Node core specifiers at all -- its knowledge of Node's core API is ambient `@types/node` declarations, not per-specifier module resolution. Every builtin `require`/`import` therefore fell through to `ResolutionFailure` -> `unresolved_module` -> a closure-widening `unknown` edge, exactly as if the specifier named a genuinely missing npm package.

**Why this matters:** essentially every real Node.js application uses at least one builtin (`fs`, `path`, `crypto`, `http`, ...). Combined with `RWF-002` (open; see above), this meant no realistic Node application could ever reach a confident `NOT_AFFECTED` -- far broader blast radius than any single-package finding in this benchmark.

**Fix (VT-305):** `src/code-intelligence/module-resolver.ts`'s `resolveSync` now checks `node:module`'s `isBuiltin(specifier)` *before* attempting any `ts.resolveModuleName`/`node_modules` lookup at all (matching real Node.js semantics, where a builtin always shadows a same-named `node_modules` package) and returns an explicit `BuiltinModule` (`kind: "builtin"`, specifier normalized to its bare unprefixed form so `"fs"`/`"node:fs"` are the same identity). `src/code-intelligence/symbol-binder.ts` and `src/code-intelligence/call-graph.ts` propagate this through as a `SymbolBindingBuiltin`/no graph edge at all -- mirroring `KNOWN_GLOBAL_IDENTIFIERS`'s existing treatment of ambient globals, but checked *after* VT-213's inline-callback fallback has already had its chance, so `fs.readFile(file, callback)`-shaped calls still connect their callback argument correctly. No new `DynamicCallReason` was needed -- builtins produce no edge, so `isClosureWideningReason`'s exhaustive switch is untouched.

**MVP-readiness relevance:** does not violate any adversarial-suite invariant (still 83/83, v1+v2) -- no adversarial fixture imports a Node builtin. `RWB-10`'s own verdict is unchanged (still the correct `UNKNOWN`, via its own intended `unsupported_construct` blocker); the two `unresolved_module` edges attributable to `require("fs")`/`require("path")` are gone from its reachable subgraph.

---

## RWF-009 — npm-aliased package instance identity mismatch between the dependency graph and the call graph

**Status: Fixed (VT-306).**

**Discovered:** scanning real `semver@7.5.1` installed under the npm-aliased dependency name `semver-vulnerable` (`RWB-09a`) against real GHSA-c2qf-rxjj-qqgw / CVE-2022-25883.

**Symptom:** `isLegacyCompatible()` calls `new legacySemver.Range(userRange)`, where `legacySemver` is `require('semver-vulnerable')` -- a real, live, unconditional reachable call into the real, vulnerable `semver@7.5.1`. Expected `AFFECTED` (modulo the separate RWF-004 gap below); actual (pre-fix) `NOT_AFFECTED` -- a **false negative**, not merely an imprecise UNKNOWN.

**Root cause, confirmed directly:**

```
dependency-graph layer  (package-lock.json entry.name, npm always writes this for an alias):
  "semver-vulnerable" -> name: "semver", locations: ["node_modules/semver-vulnerable"]

call-graph layer (identifyModule(), pre-fix):
  .../node_modules/semver-vulnerable/classes/range.js
    -> packageName: "semver-vulnerable"   (derived from the install DIRECTORY name)
    -> packageInstance: .../node_modules/semver-vulnerable
```

The dependency-graph layer already derived identity correctly (`entry.name`, which npm always writes explicitly for an aliased install, since it can't be inferred from the path). But `src/domain/resolved-target.ts`'s `identifyModule()` -- the call-graph/verdict layer's sole identity function -- derived `packageName` purely from the resolved file's `node_modules/<segment>` path, never consulting the installed instance's own `package.json`. `graphPackageInstances(graph, "semver")` (`src/analysis/verdict.ts`) therefore never matched this instance's nodes (their derived identity was `"semver-vulnerable"`, not `"semver"`), so `resolveTargetNodes` treated the aliased instance as `confirmedAbsentInstance` -- VT-212's guard, correctly designed for a genuinely-never-touched instance, incorrectly triggered here because the instance genuinely *was* touched. Since no closure-widening blocker was reachable in this particular fixture, `confirmedAbsentInstance` degraded straight to `NOT_AFFECTED` instead of `UNKNOWN`.

**Why this matters:** an npm alias (`"name": "npm:realpackage@version"`) is a normal, supported npm feature -- used for side-by-side major-version installs, gradual migrations, and forks. Every such install has this exact shape (directory name != package.json name), so this affected every real-world alias, silently converting a genuinely reachable, vulnerable instance into a confident, false `NOT_AFFECTED`.

**Fix (VT-306):** `identifyModule()` now reads the owning installed package instance's own `package.json` `"name"` field (new `readInstalledPackageName` helper, mirroring `analysis/verdict.ts`'s existing `readInstalledVersion` pattern/fallback discipline) and prefers it over the path-derived segment when present and valid -- falling back to the path-derived name only when `package.json` is missing, unreadable, or has no valid `name` (never manufacturing a new UNKNOWN merely because metadata was unavailable). `packageInstance` (the install *location*) is completely unaffected -- an alias never changes *where* a package is installed, only what it should be called. Both `node_modules/semver` and `node_modules/semver-vulnerable` now correctly report `packageName: "semver"` while keeping distinct `packageInstance` values, so `graphPackageInstances` finds both, and VT-212's exact-instance-wins selection logic operates on the correct instance's own nodes -- never borrowing the separate, patched instance's evidence.

**Result:** `RWB-09a` moved from `NOT_AFFECTED` (false negative) to `UNKNOWN` (safe) -- verified directly against the call graph: `isLegacyCompatible()`'s call now resolves to the correct `semver-vulnerable` instance, whose own `Range` export is `require('./classes/range')`, a cross-file re-export never chased (**RWF-004**, open, out of this task's scope) -- an honest `unresolved_target`, not a confident answer either way. `RWF-004` remains the sole, independent, correctly-attributed remaining blocker.

**MVP-readiness relevance:** does not violate any adversarial-suite invariant (still 83/83, v1+v2) -- no adversarial fixture uses an npm alias. VT-212's own regression tests, ADV2-045, and VT-300's multi-instance dynamic-loading cases were all explicitly re-run and remain correct (none of their fixtures alias a package name away from its directory name, so path-derived and package.json-derived identity already agreed for all of them).

---

## RWF-012 — CommonJS chained export alias (`exports.foo = exports.bar = impl`) isn't attributed to its implementing function

**Status: Fixed.**

**Discovered:** scanning real `ini@1.3.5` (`RWB-07`) against real GHSA-qqgx-2p2h-9c37 / CVE-2020-7788 (prototype pollution in `ini.parse`).

**Symptom:** VT-301B's independent architecture review surfaced this while auditing the phantom-target Site A fix (see `docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md`): `RWB-07`'s prior `PASS` (`NOT_AFFECTED`) turned out to be built on an unresolved target, not a genuinely identified one. Before VT-301B, the rule's `ini#parse` target fell through to a phantom node; a reachability search against that phantom happened to conclude `NOT_AFFECTED` only because the configured `{file: src/config.js, symbol: loadModernConfig}` entrypoint's own reachable subgraph is trivially edge-less (`loadModernConfig` calls only `JSON.parse`, a known global with no call-graph edge at all) — the *target itself* was never actually resolved, before or after VT-301B. After VT-301B, the same unresolved-target state correctly reports `unresolvedReason` directly (SDD.md § 23's "vulnerable target known? NO → UNKNOWN"), so `RWB-07` now (correctly) reports `UNKNOWN` instead of an accidental `NOT_AFFECTED`.

**Root cause, confirmed by reading the real installed `node_modules/ini/ini.js`:**

```js
exports.parse = exports.decode = decode
exports.stringify = exports.encode = encode
...
function decode (str) { ... }
```

The rule's target names the **public, canonical export** (`parse`) — but the function implementing it is declared under a **different name** (`decode`), assigned to `exports.parse` only via a **chained assignment expression** (`exports.parse = (exports.decode = decode)`). Confirmed directly: zero functions anywhere in `ini.js` are literally named `"parse"` — the export-symbol attribution path (`mapExportsToFunctions`, `src/code-intelligence/module-model.ts`) can only bridge an `exports.foo = ...` binding back to a real function declaration when the assigned identifier's own name coincides with the export name (or the RHS is a directly-visible function expression); it has no mechanism for tracing through an **aliasing assignment chain** to the ultimate function that chain resolves to. `buildExportBindings`'s `commonjs-exports-property` case (`src/code-intelligence/source-index.ts`) records the export's `exportedName` (`"parse"`) but never captures a `localName` for this shape at all — so the lookup key defaults to the export name itself (`"parse"`), which the real function's own name (`"decode"`) never matches.

**Why this matters:** chained/aliased CommonJS export assignments (`exports.publicName = exports.internalAlias = implementation`) are a real, if less common, authoring idiom — used here specifically so `ini.decode`/`ini.parse` (and `ini.encode`/`ini.stringify`) are both valid, interchangeable public names for the same implementation. This is a **different** mechanism from RWF-004's re-export chasing (which is about a value **imported from another file/package**) and from RWF-003's anonymous-function gap (which is about a **missing** name, not a **mismatched** one) — here the implementing function has a real, resolvable name, just not the one the export uses.

**Relevant files:** `src/code-intelligence/source-index.ts` (`buildIndex`'s `commonjs-exports-property` case never records a `localName` for a chained/aliased RHS), `src/code-intelligence/module-model.ts` (`mapExportsToFunctions`'s `localKey` fallback to `exportedName`, which only coincidentally works when the assigned identifier's own name matches the export name).

### The fix (RWF-012)

Two related indirections were closed, both by extending relations that
already existed rather than adding a value-flow engine.

**1. An alias CHAIN, not one hop.** RWF-004a admitted exactly one hop of
local-variable indirection between an export and the value it publishes,
and RWF-003 did the same for a function identity. `resolveLocalValue`
(`src/code-intelligence/commonjs-reexports.ts`) now walks the whole chain
by ITERATING the existing per-hop `classifyLocalBinding` under a cycle
guard, and `resolveOrigin` threads the same walk through the re-export
relation. The hop count changed; the per-hop obligation did not. Every
identifier on a chain must still be a module-scope binding the file
declares exactly once — in any form, any scope — at its own top level,
with an initializer, and never writes to again. One unproven hop anywhere
stops the whole chase at nothing, which is the same unresolved target,
and therefore the same UNKNOWN, as before.

Building the walker out of `classifyLocalBinding` rather than
re-deriving its facts is deliberate: RWF-013's and RWF-013b's refusal
grounds cannot drift out of sync with the chain walker if there is only
one implementation of them.

Termination is a visited set of names, checked before each hop. A cycle
(`const a = b; const b = a;`) is two individually impeccable bindings —
each `const`, each declared once, neither ever written to — so no per-hop
proof can catch it, and refusing is the only answer that is not an
arbitrary pick from the cycle. The walk is iterative, so there is no
stack to overflow however long the chain, and within one file's facts a
name IS binding identity, because the single-assignment proof admits a
name only when the whole file declares it exactly once.

**2. The chained assignment itself.** `unwrapValue` reads through a chained
plain assignment, so `exports.parse = exports.decode = decode` publishes
`parse` under the local name `decode` — the same name, from the same
expression, that `exports.decode` already resolved through. The value of
`x = v` IS `v`, for every left-hand side, so this is exact language
semantics rather than dataflow; only `=` is unwrapped, never a compound
assignment, whose value is the result of the operation and not its
right-hand side. Every caller is already gated on
`isUnconditionalExportAssignment`, which climbs exactly these links before
requiring an unconditional module-scope statement — so a branch-local
`if (cond) { exports.a = exports.b = impl; }` is refused before this ever
runs, and RWF-004b's conditional-export guard is untouched.

Crucially, the name still comes from the right-hand side's OWN text.
`exports.parse = exports.impl = registry.impl` stays unattributed rather
than binding a same-named local `function parse()`: RWF-011's rule is that
a public export name is not provenance for any local symbol, and reading
through an assignment does not change what the right-hand side says.

**Refusal got strictly wider, never narrower.**
`refusesLocalIdentifierProvenance` now asks about the whole chain, which
closes a real gap RWF-013 left open: a clean first hop onto a reassigned
binding —

```js
let stale = function () {};   // indexed under the name "stale"
stale = somethingElse;
const alias = stale;
exports.stale = alias;        // RWF-013 saw only `alias`, which is clean
```

— left the same-file name search free to bind the stale initializer that
source indexing names after the very variable the file reassigns away
from. The chain, not the first hop, is what touches the mutation.

**No new authoritative terminal.** The chase still ends only at a direct
function/arrow value, a `require()` origin, or a destructured require
property. A chain ending in a `function`/`class` DECLARATION therefore
stays unattributed — that would be a new terminal form, and it would have
to prove the declaration is the file's only one — while the one-hop forms
that resolved through `localName` (`module.exports = fn` over
`function fn() {}`) are untouched. Both boundaries are pinned as tests.

**One blocker was found by independent audit and fixed on the same
branch.** The chained-assignment unwrap has three production consumers.
Two were gated from the start — `propertyExportProvenance` on
`isUnconditionalExportAssignment`, `directExportedFunctionLocation` on
`assignment.isModuleScope`. The third, `wholeModuleDefaultExport`'s
`localName`, was not, so a chained assignment could supply a local name
from a CONDITIONAL or function-body `module.exports` assignment, where the
raw right-hand side previously supplied none:

```js
if (FLAG) { module.exports = alias = dangerousOp; }
else      { module.exports = alias = safeOp; }
```

`findLastModuleExportsAssignment` keeps only the last assignment in source
order, so the export bound to `safeOp` and Family C proved THAT node
unreachable — a complete, internally consistent, false `NOT_AFFECTED` on a
run that may export `dangerousOp`. Reproduced end to end (base: `UNKNOWN`;
pre-fix branch: `NOT_AFFECTED`), and closed by gating that one field the
way its siblings already were. The unconditional top-level form — real
`ini`'s, and RWB-07's — is unaffected, and the guard is pinned in both
directions by tests that fail without it. The adjacent RAW-identifier
conditional form is a separate, pre-existing defect and is filed above as
RWF-014 rather than changed here.

**Result:** `RWB-07` (`ini`) moved `UNKNOWN` → `NOT_AFFECTED`, the oracle's
answer. The rule's `ini#parse` target now binds `ini.js`'s real
`function decode` at line 69 — the identical node `ini#decode` already
resolved to, which is correct at runtime (`ini.parse === ini.decode`, and
`ini.js` contains no function named `parse` at all, so no name coincidence
is available). `RWB-07` is the ONLY validation case that moved: 11 → 12
PASS, 6 → 5 known failures, 0 unexpected, 17 total.

**That `UNKNOWN` → `NOT_AFFECTED` is the one movement into a negative
verdict, and it is correct.** Attribution is a precondition for BOTH
verdicts, exactly as RWF-003 established. The proof is Family C's
positive route, not an inference from failure: the target is a real node;
the configured `{file: src/config.js, symbol: loadModernConfig}`
entrypoint's reachable subgraph is complete (`reachableSubgraphComplete:
true`, `modulesUnresolved: 0`); and no path in it reaches that node,
because `loadModernConfig` calls only `JSON.parse` and nothing in the
file calls `loadLegacyIniConfig`. The many `unsupported_construct`
diagnostics in the output are all inside `ini.js`, which is not in the
reachable subgraph at all — RWF-002's rule, unchanged. Nothing new was
added to the verdict layer, the proof context, the reachability search or
the negative-proof schema. Every shape this relation refuses — a mutated
hop, a cycle, a conditional initialization, a multiply-declared name, a
destructured hop, a dynamic terminal, a conditional export — stays
`UNKNOWN`.

**Permanent coverage:** `ADV2-073` puts all four wrong answers in one
fixture (truncation, name fallback, wrong instance, wrong package): a
four-hop chain over a cross-package `require`, between two installs of the
same name and version, with a private same-named decoy declared ahead of
the chain. Its per-instance half — the unreached twin never inheriting the
AFFECTED, and its evidence containing no node from the reached one — is
asserted in `src/analysis/verdict.cross-package-reexport.integration.test.ts`,
because the adversarial suite addresses a finding by package name and
version alone and cannot itself tell two same-version instances apart.

**MVP-readiness relevance:** no adversarial-suite invariant moved (v1 + v2
both fully green, 107/107 with ADV2-073 added). `RWB-07`'s own oracle
(`expected: NOT_AFFECTED`) was never in question and is unchanged: a human
analyst reading `src/config.js` with the configured entrypoint in mind
concludes `NOT_AFFECTED` with no ambiguity. What changed is that the
analyzer can now reach that conclusion on a target it has actually
identified, rather than declining because it could not.

---

## RWF-014 — A CONDITIONAL `module.exports = <identifier>` is attributed as if it were unconditional

**Status: Fixed.** P0 (soundness). Was pre-existing on `main` — NOT
introduced by RWF-012, and deliberately not fixed by it.

**Discovered:** an independent soundness audit of the RWF-012 branch. The
audit's own blocker (RWF-012 reading THROUGH a chained assignment in a
conditional position) was fixed there; this is the adjacent, older half of
the same relation that the blocker's investigation exposed, and it
reproduced identically on `origin/main` at `71014f0`.

**Symptom, reproduced end to end before the fix** — see
`fixtures/commonjs-conditional-whole-module-export/` and `ADV2-074`:

```js
function dangerousOp(input) { return danger.explode(input); }
function safeOp(input) { return "safe:" + input; }

if (process.env.FIXTURE_LIB_MODE === "fast") {
  module.exports = dangerousOp;
} else {
  module.exports = safeOp;
}
```

with an application that calls the package's whole exported value.

- **Actual, on `main`:** `NOT_AFFECTED`, with `confirmedUnreachableTarget`
  and `reachableSubgraphComplete: true`.
- **Correct, and delivered:** `UNKNOWN`. Under the flag the module's
  exported value IS `dangerousOp`, which calls the sink. The analyzer has
  no control-flow semantics and cannot know which branch runs, so it
  cannot certify either.

**Root cause.** Not one ungated field — the SELECTION feeding all of them.
`findLastModuleExportsAssignment` kept whichever `module.exports` write it
saw LAST in source order, including writes nested in an `if`/`try`/`switch`
/loop or in a function body, and handed that one write to every consumer as
the module's exported value. Node's `module.exports` really is
last-write-wins, but source order IS last-write order only when every write
definitely runs, in that order. The moment one is conditional or deferred,
"last in the file" is a branch picked arbitrarily and then presented as the
module's identity.

The individually-ungated `localName` derivation in
`wholeModuleDefaultExport` was the most visible consequence (it drives
`mapExportsToFunctions`'s same-file name search), but gating that one field
— the direction this entry originally proposed — would have left three
other paths reading the same wrongly-selected assignment: an unconditional
write followed by a CONDITIONAL overwrite, a DEFERRED write in a function
body that an importer can call after module evaluation, and
`unpackObjectLiteralExports` publishing one branch's export table as the
module's.

**The fix.** One centralized authority gate, in
`src/code-intelligence/module-model.ts`:

- `collectModuleExportsAssignments` collects EVERY `module.exports = X` /
  `export = X` write in source order (one pre-order traversal), each
  classified by `classifyWholeModuleExportAuthority` as `"unconditional"`
  (a direct statement of the file, modulo RWF-012's chained-assignment
  climb), `"deferred"` (inside a function, class body or class static
  block — execution time not ordered by source position at all), or
  `"conditional"` (nested, but still in the module's own top-level
  statement list).
- `selectAuthoritativeWholeModuleExport` returns a write only when the LAST
  collected write is `"unconditional"` AND no `"deferred"` write exists
  anywhere in the file. Otherwise it returns nothing, and
  `ambiguousWholeModuleExport` records that the module HAS a whole-module
  export while attributing no identity to it.

**Why this is sound without a CFG.** Module evaluation runs each top-level
statement exactly once, in order. So a final unconditional write definitely
runs, and definitely runs after everything above it — which is why
`if (f) { module.exports = a; } module.exports = b;` still resolves to `b`,
while the mirror image `module.exports = a; if (f) { module.exports = b; }`
must not resolve at all. Requiring the LAST collected write to be
unconditional expresses both directions in one test. Deferred writes are
excluded from that reasoning entirely because position does not order them:
`function configure() { module.exports = a; }` can be called by an importer
after evaluation, so a single deferred write withdraws the whole file's
whole-module identity.

**Measured impact.** Across all 108 adversarial scenarios (v1 + v2) and all
17 benchmark cases, exactly ONE verdict moved: `ADV2-074`
`NOT_AFFECTED` → `UNKNOWN`, the intended correction. Zero
`UNKNOWN` → `NOT_AFFECTED` movements. Benchmark unchanged at 12 PASS / 5
KNOWN_FAIL / 0 UNEXPECTED. RWB-02 (RWF-003) stays `AFFECTED`, RWB-07
(RWF-012) stays `NOT_AFFECTED` with its Family C proof intact.

**Known remaining conservatism** (precision, never soundness): a write
inside a top-level `try`/`switch`/loop/bare block that is genuinely the
file's only write is refused, as is an IIFE's write and a class static
block's, and a single conditional `module.exports = X` with no other write.
Each would need either a real CFG or an immediate-invocation proof to
accept, and both are out of this task's scope.

**Relevant files:** `src/code-intelligence/module-model.ts`
(`classifyWholeModuleExportAuthority`, `collectModuleExportsAssignments`,
`selectAuthoritativeWholeModuleExport`, `ambiguousWholeModuleExport`);
regressions in `module-model.conditional-whole-module-export.test.ts`,
`verdict.conditional-whole-module-export.integration.test.ts`,
`fixtures/commonjs-conditional-whole-module-export/`, and `ADV2-074`.

---

## RWF-015 — A top-level export write is attributed even when an early exit can prevent it running

**Status: Fixed.** P0 (soundness). Was pre-existing on `main` — NOT
introduced by RWF-014, but left standing by it: RWF-014's own authority
rule is what accepted this shape.

**Discovered:** an independent soundness audit of the RWF-014 branch,
which observed that "the last write is unconditional" does not imply "the
last write runs". Reproduced independently on `origin/main` at `4874569`
before any change, in both the `return` and the `throw` form.

**Symptom, reproduced end to end before the fix** — see
`fixtures/commonjs-early-exit-whole-module-export/` and `ADV2-075`:

```js
function dangerousOp(input) { return danger.explode(input); }
function safeOp(input) { return "safe:" + input; }

if (process.env.FIXTURE_LIB_MODE === "fast") {
  module.exports = dangerousOp;
  return;                        // ends module evaluation
}
module.exports = safeOp;         // top-level, unconditional, NOT always run
```

with an application that calls the package's whole exported value. The
`throw` form (`throw new Error("stop")` in place of the `return`) behaves
identically at runtime and reproduced identically.

- **Actual, on `main` at `4874569`:** `NOT_AFFECTED`, with
  `confirmedUnreachableTarget` and `reachableSubgraphComplete: true`, from
  both the `return` and the `throw` entrypoint. The whole-module export
  bound to `safeOp`, the caller's `fixture(input)` got a fully RESOLVED
  edge to it, and `dangerousOp` was left with no incoming edge at all.
- **Correct, and delivered:** `UNKNOWN`. Under the flag the module's
  exported value IS `dangerousOp`, which calls the sink, and the statement
  below never executes.

**Why RWF-014 did not already cover it.** RWF-014's fixture writes
`module.exports` from both arms of an `if`/`else`, so NEITHER write is a
top-level statement and its rule ("the last write in the file must be
`unconditional`") refuses on sight. Here the last write **is** a direct
child of the source file. It is unconditional by every syntactic test the
model had, it is last in the file, and no deferred write exists anywhere —
so all three of RWF-014's conditions are satisfied by a write that does not
always run.

**Root cause.** Node wraps every CommonJS module in a function, which makes
a module-scope `return` legal and module-terminating; an uncaught
module-scope `throw` terminates evaluation too, propagating out of the
`require()` that triggered the load. Either one leaves whatever
`module.exports` already held as the module's exported value. The gate
every export-provenance fact passes through
(`isUnconditionalExportAssignment`) asked only whether the assignment was a
top-level statement — never whether module evaluation could still be
running when that statement was reached. "Unconditional" and "definitely
reached" are different properties, and this is precisely where they come
apart.

**Direction taken.** The gate now asks the second question, and is renamed
`isDefinitelyReachedExportAssignment` to say so.
`firstModuleEvaluationCutoff` computes, in one linear pass over the file's
top-level statements, the start position of the FIRST statement that can
complete abruptly. Module evaluation runs top-level statements in order, so
that one position partitions the file: a top-level write starting before it
runs on every load, and one starting at or after it does not. The
comparison is the whole reachability model — no control-flow graph, no path
enumeration, no dataflow, no evaluation of any flag. Because the cutoff is
monotone in source position, no extra scan is needed: if the last write is
definitely reached, every write above it is too.
`WholeModuleExportAuthority` gains a fourth value, `"bypassable"`, so a
refusal reports "top-level, but an earlier statement can end evaluation
first" rather than being folded into `"conditional"`.

**What is and is not treated as module-terminating.** Only abrupt
completions whose behavior is intrinsic to the syntax, requiring no
knowledge of any value or call target:

- `return` — always, and always a module-scope one, since `return` is a
  syntax error outside a function body and function bodies are not walked
  into;
- `throw` — unless caught by a `try` with a `catch` clause whose own block
  lexically contains it. A `try`/`finally` with no `catch` does not stop
  the exception; a `throw` inside a `catch` or `finally` clause is not
  caught by its own `try`, so a rethrow terminates exactly as the original
  would have; nesting resolves outward, so an inner rethrow caught by an
  outer `try` correctly keeps authority.

Deliberately NOT modeled: `process.exit()` or any other call (whether a
call returns is a property of the callee, not of the call syntax — treating
calls as terminators would withdraw almost every real module's identity and
would still be a guess), and `break`/`continue` (they transfer control
within the enclosing loop, switch or label, which for a top-level `break`
is inside the same top-level statement; execution continues with the next
statement either way).

Function and method bodies, arrow bodies and accessors are skipped, so a
nested, deferred or callback `return`/`throw` never poisons a module's
identity — `function configure() { throw err; }` above a later
`module.exports = b` leaves `b` authoritative, because `configure` has not
run. Class bodies are NOT skipped, for the symmetric reason: a `static { }`
block runs at class-definition time, i.e. during module evaluation, so a
throw inside one really can abort the load.

**This was never only a whole-module defect.** Property exports read the
same last-write-wins map through the same gate and shared it verbatim:

```js
if (flag) { exports.foo = dangerous; return; }
exports.foo = safe;                      // pre-fix: bound to `safe`
```

Because the gate is one function, fixing it centrally closed the
whole-module, object-literal, class, chained-alias (RWF-012),
require-re-export (RWF-004a/RWF-004b) and property-export surfaces in a
single change rather than five. This was classified as *same root cause,
safe to fix centrally* rather than a separate P0 — verified case by case in
`module-model.early-exit-whole-module-export.test.ts`.

**Measured impact.** Across all 109 adversarial scenarios (v1 + v2) and all
17 benchmark cases, exactly ONE verdict moved: `ADV2-075`
`NOT_AFFECTED` → `UNKNOWN`, the intended correction. Zero
`UNKNOWN` → `NOT_AFFECTED` movements, and no new `AFFECTED`. Benchmark
unchanged at 12 PASS / 5 KNOWN_FAIL / 0 UNEXPECTED. `ADV2-074` (RWF-014)
stays `UNKNOWN`, `RWB-07` (RWF-012) stays `NOT_AFFECTED` with its Family C
proof intact, and `RWB-02` (RWF-003) stays `AFFECTED`.

**Real-corpus incidence.** An AST-accurate scan of all 449 vendored
CommonJS files that write `module.exports`/`exports.*` across
`tests/validation/fixtures/`, `fixtures/` and `tests/adversarial/` found
exactly one genuine instance outside this task's own fixtures: real
`dunder-proto`'s `get.js` and `set.js` (vendored under the `RWB-05` `qs`
fixture), whose top-level `try`/`catch` rethrows any error that is not
`ERR_PROTO_ACCESS` and therefore can abort the load before the file's
`module.exports`. That rethrow almost never fires in practice, but proving
so requires reasoning about `e.code`, so the conservative refusal is
correct. Its right-hand side is a conditional expression rather than an
identifier or function node, so it carried no attribution before the change
either and no verdict moved. Correctness here is deliberately not
conditional on this count being small.

**Performance.** The walk descends only through statement-bearing
constructs, since a `return`/`throw` cannot hide inside an expression once
function bodies are excluded; a `\bstatic\b` text test selects the full
expression walk for the one exception (a class static block in expression
position), which is a sound over-approximation because a static block
cannot exist without that token in the file. Walking expressions
unconditionally cost ~190ms per module model on the scan-performance
suite's single-file fixture (9,001 top-level statements), multiplied by
every model a scan builds; with the statement-position walk the suite's
timings are indistinguishable from before. The result stays
O(top-level statements), memoized per `ts.SourceFile` in a `WeakMap`.

**Known remaining limitations.** The second and third below are pure
precision costs — they refuse more than they strictly must, which is always
the safe direction. The first is a real boundary of the model and is
deliberately not claimed as a soundness guarantee:

- a `throw` inside an IIFE is skipped along with every other function
  expression, so an IIFE that throws above a later export write does not
  withdraw authority. This behavior is **unchanged from before this task** —
  the cutoff model neither introduces nor widens it — and no false
  NOT_AFFECTED was reproduced for it: an IIFE is a call whose callee is a
  function expression, which call-graph.ts records as
  `unknown(unsupported_construct)`, so the reachable subgraph is incomplete
  and Family C is withdrawn before any negative proof can be issued. That
  mitigation is incidental rather than designed, which is exactly why this
  is stated as a limitation and not as "precision only": an uncaught
  module-scope throw does not by itself make the pre-throw export
  unobservable, because a CommonJS cycle can capture and retain a
  partially-initialised `module.exports` (verified against real Node
  execution). If the IIFE call ever becomes resolvable, or the surrounding
  uncertainty is otherwise narrowed, this bullet needs re-examining rather
  than reclassifying. Distinguishing the case properly would mean proving a
  function expression is invoked immediately — call-graph work, and the same
  line `classifyWholeModuleExportAuthority` already draws by classifying an
  IIFE-nested write as `"deferred"`;
- *(precision)* a bare conditional `return`/`throw` above a file's only
  export write withdraws that write's identity even though nothing competes
  with it — correct (the module may export the default `exports` object
  instead), but a real precision cost on feature-detect boilerplate;
- *(precision)* `finally`-clause semantics are not modeled beyond refusal: a
  write held in a `finally` block is `"conditional"` under RWF-014's existing
  rule and stays refused, rather than being reasoned about.

**Relevant files:** `src/code-intelligence/module-model.ts`
(`isDefinitelyReachedModuleScopeStatement`, `firstModuleEvaluationCutoff`,
`mayEndModuleEvaluation`, `isCaughtWithin`, `mayContainNestedStatements`,
`isDefinitelyReachedExportAssignment`, `isTopLevelExportAssignment`,
`classifyWholeModuleExportAuthority`); regressions in
`module-model.early-exit-whole-module-export.test.ts`,
`verdict.early-exit-whole-module-export.integration.test.ts`,
`fixtures/commonjs-early-exit-whole-module-export/`, and `ADV2-075`.

---

## RWF-013 — A reassigned local binding's STALE initializer is attributed to the export by name

**Status: Fixed.**

**Discovered:** a focused RWF-003 follow-up audit of the legacy name-based
CommonJS export fallback, then reproduced end-to-end on a purpose-built
fixture (`fixtures/commonjs-stale-alias-export/`) and as `ADV2-069`.

**Symptom:** a false `NOT_AFFECTED` — the highest-severity class of defect
this analyzer can produce — carrying a complete, well-formed Family C
`confirmedUnreachableTarget` proof with `reachableSubgraphComplete: true`.

**Root cause.** RWF-003 gave `module.exports = X` a concrete function
identity (`ExportBinding.localFunctionLocation`) derived through
`commonjs-reexports.ts`'s module-scope single-assignment proof. For an
identifier right-hand side that proof correctly REFUSES a binding it cannot
vouch for — reassigned, declared more than once, declared outside module
scope, declared without an initializer. But the refusal was expressed as
`localFunctionLocation === undefined`, and `mapExportsToFunctions` then fell
straight through to the pre-existing name search:

```ts
const localKey = exp.localName ?? exp.exportedName;
const matchingFn = index.functions.find((fn) => fn.name === localKey);
```

That search re-attributes the export to the very node the stronger relation
just rejected. The two facts compose into a trap:

```js
let parse = function (input) { ... };   // SAFE fallback -- ANONYMOUS, so
                                        // source-index names it "parse"
                                        // after the variable it is
                                        // assigned to
parse = require("./lib/parse");         // ...and immediately stale
exports.parse = parse;                  // binds "parse" -> the STALE node
```

Because `inferAssignedName` names an anonymous function expression after its
assignment target, the discarded initializer is indexed under *exactly* the
export name a rule asks for. The stronger, negative provenance information
was computed and then thrown away.

**Why it produced a false `NOT_AFFECTED` rather than only imprecision.**
The stale node is a real graph node, so the target resolved and a
reachability search ran. Whether that search says AFFECTED or NOT_AFFECTED
depends entirely on whether the *stale* node happens to be reachable — a
question with no relationship to the vulnerability. In the reproducer the
package publishes the same implementation under a second, statically
resolvable name (`exports.parseSync = require("./lib/parse")`), the
application calls that one, and the stale fallback is called by nothing. So
the search correctly proved the stale node unreachable, and the verdict
layer correctly turned a complete unreachability proof into
`NOT_AFFECTED`. Every stage was right about the node it was handed. The node
was wrong.

**Fix.** `commonjs-reexports.ts` now answers a three-way question
(`classifyLocalBinding`) where it previously answered a two-way one:

- `"single-assignment"` — the proof holds; carries the initializer.
- `"refused"` — this file DOES bind the name with `var`/`let`/`const`, and
  the proof rejected it. Backed by a new `CommonJsFacts.variableDeclaredNames`
  set: every `var`/`let`/`const`-bound name in any scope, which is exactly
  the set of names the proof has an opinion about.
- `"unmodeled"` — no variable of that name exists, so the proof was never
  applicable.

`ExportBinding.localIdentifierProvenanceRefused` carries the middle case
(internal only — never serialized, no schema or HTML change), and
`mapExportsToFunctions` skips the name fallback for such an export,
producing an unresolved target and therefore `UNKNOWN`. Applied to all three
identifier-valued export forms: `module.exports = X`, `exports.X = <ident>`,
and `module.exports = { X }` / `{ X: <ident> }`.

**Why `localFunctionLocation === undefined` could not be the signal.** It is
also the answer for every shape RWF-003's identity relation does not model
at all, most of which the name-based path handles perfectly soundly:
`function fn() {} module.exports = fn` (a function declaration, not a
variable binding), `const C = class {}; module.exports = C` (a class,
attributed via its constructor's name — and everything
`findExportedClassMembers` builds on it), and every `exports.foo = ...`
property export. Suppressing on `undefined` alone would silently drop all of
them. The distinction that matters is "analyzed and rejected" versus "never
analyzed", which is why this needed a new fact rather than a reinterpreted
one.

**Deliberately unchanged.** No verdict thresholds, no Family A/B/C
semantics, no `reachableSubgraphComplete`, `ModuleLoadClosure`,
`AnalysisProofContext`, exactly-one proof schema, evidence field or reason
identifier was touched. Family C was never wrong here; it was fed a wrong
target, and the correction belongs entirely in export attribution. Alias
chains longer than one hop (RWF-012) and cross-package re-export (RWF-004b)
remain out of scope and equally conservative.

**Blast radius, measured.** A parser-based sweep of every validation
fixture, vendored package and adversarial fixture (730 files walked, 412
containing a CommonJS export construct) found **3** real vendored files
matching the shape — `fast-xml-parser/lib/fxp.cjs`,
`es-define-property/index.js` and `gopd/index.js`, the last two being the
textbook `var x = ...; if (...) { x = ... } module.exports = x` feature
probe. All three attribute **nothing** both before and after the fix (none
declares a function carrying the exported name), so the benchmark delta is
**zero**, independently confirmed: 10 PASS / 7 KNOWN_FAIL / 0 UNEXPECTED /
17 total, unchanged. `RWB-02` and `RWB-09a` remain `AFFECTED`; `ADV2-067`
and `ADV2-068` remain passing.

**Residual limitation (precision, not soundness).** An export naming a
top-level `function fn() {}` is refused if any *other* scope in the same
file also declares a `var`/`let`/`const` called `fn`, since the
declaration-count proof cannot then vouch for which binding the export sees.
This costs an attribution that used to be made by coincidence and never
manufactures one.

---

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

## RWF-016 — A resolvable local throwing CALL invalidates later CommonJS export authority

**Status: Fixed.** P0 (soundness). Was pre-existing on `main` — NOT
introduced by RWF-015, but left standing by it: RWF-015 fixed the SYNTACTIC
abrupt-completion case (`return`/`throw`) and explicitly declined to
reason about calls at all.

**Discovered:** an independent soundness audit of the RWF-015 branch,
which observed that a CALL to a local function whose own body always
throws ends module evaluation exactly as a literal `throw` inlined at the
call site would — a gap RWF-015's own model, by design, does not close.
Reproduced independently on `origin/main` at `69caeb9` (current merged
main, with RWF-015 fully in place) before any change.

**Symptom, reproduced end to end before the fix** — see
`fixtures/commonjs-local-throwing-call-export-authority/` and `ADV2-076`:

```js
function dangerousOp(input) { return danger.explode(input); }
function safeOp(input) { return "safe:" + input; }
function bail() { throw new Error("fast mode is not supported here"); }

if (process.env.FIXTURE_LIB_MODE === "fast") {
  module.exports = dangerousOp;
  bail();                        // never returns -- ends module evaluation
}
module.exports = safeOp;         // top-level, unconditional, NOT always run
```

with an application that calls the package's whole exported value.

- **Actual, pre-fix:** `NOT_AFFECTED`, with `confirmedUnreachableTarget`
  and `reachableSubgraphComplete: true`. The whole-module export bound to
  `safeOp` (even carrying a `localName`/`localFunctionLocation`
  attribution — verified directly against `buildModuleModel`'s output,
  not just the final verdict), the caller's `fixture(input)` got a fully
  RESOLVED edge to it, and `dangerousOp` was left with no incoming edge at
  all.
- **Correct, and delivered:** `UNKNOWN`. Under the flag the module's
  exported value IS `dangerousOp`, which calls the sink, and `bail()`
  never returns, so the statement below never executes.

**Runtime ground truth.** Because an uncaught `throw` propagating out of a
`require()` might look, at a glance, like it makes the bypassed dangerous
export unobservable in practice (the importer's own `require()` call also
throws), a real, coherent CommonJS circular-import fixture was built and
executed with actual `node` (not VulnTrace) to establish that this is not
so — see `fixtures/commonjs-circular-import-throwing-export-ground-truth/
README.md` for the full transcript. `a.js` publishes the dangerous branch,
then requires `b.js`; `b.js` requires `a.js` right back (a genuine
circular dependency), and Node's own documented circular-require
semantics hand `b.js` `a.js`'s CURRENT `module.exports` — the dangerous
branch, published before the circular `require()` ran. `a.js` then calls
`bail()`, which throws, and `a.js`'s own final (safe) export is never
reached, on this run or on any subsequent `require("./a")` (Node evicts a
module that threw during its first load from `require.cache`, so the
throw is deterministic, not a fluke). `b.js`, already fully loaded before
`a.js`'s own throw, retains and can call the dangerous export — verified
by actually calling it and observing real output. This is the identical
runtime mechanism RWF-015's own remaining-limitations note already
identified for its IIFE boundary case, now independently confirmed against
a coherent, non-vacuous fixture rather than asserted.

**Root cause.** `firstModuleEvaluationCutoff`
(`mayEndModuleEvaluation`) answers "can this top-level statement end
module evaluation" by looking for exactly two syntactic constructs,
`return` and uncaught `throw` — deliberately NOT a call, because whether a
call returns is a property of the CALLEE, not of the call syntax, and
guessing would make almost every real module's exports unattributable.
That refusal is correct for an ARBITRARY call. It is not correct for the
one narrow case where the callee's own body is PROVEN, by this file's own
text, to never return: a bare identifier call whose target resolves,
without any alias chasing, to a local, non-reassigned, non-`async`,
non-generator function/arrow whose every modeled execution path ends in
an uncaught `throw`.

**Direction taken.** `mayEndModuleEvaluation` gains a third, narrowly-gated
condition alongside `return`/uncaught-`throw`:
`isDefinitelyAbruptCallStatement`, which fires only for a bare
`ExpressionStatement` (`bail();`) whose callee is a plain identifier. Two
independent proofs both have to hold before it fires:

- **`resolveExactLocalCallable`** — exact callee identity. A REAL lexical
  scope walk from the call site up to (but not including) the module's
  own top level (`scopeDeclares`), refusing on any intervening `catch`
  parameter, `for` loop variable, or block/case-clause declaration of the
  same name — genuine JS shadowing, not a whole-file name-collision guess,
  and bounded by the call site's own nesting depth (which
  `mayEndModuleEvaluation`'s own reach model already keeps shallow: a call
  inside a function body is never even offered to this relation). Then:
  never reassigned anywhere `mayEndModuleEvaluation` can reach without
  itself calling into a function (`reassignedModuleReachableNames` — the
  same reach model, reused, so a `bail = other;` sibling statement
  disqualifies the call); and a supported module-TOP-LEVEL callable shape
  actually exists — a `function bail() {}` declaration, or a `const
  bail = function () {}` / `const bail = () => {}` (deliberately `const`
  only, mirroring commonjs-reexports.ts's own single-assignment gate,
  since a `const` needs no separate reassignment proof). Deliberately ONE
  hop: `const x = bail; x();` resolves nothing here — chasing that would
  be new alias resolution, which this task is explicitly scoped not to
  introduce.
- **`cannotCompleteNormally`** — the callee's OWN body is proven, not
  guessed, to always throw. A small, three-outcome (`"throws"`/
  `"returns"`/`"normal"`) statement classifier
  (`classifyAbruptOutcome`/`classifyAbruptSequence`) walks only `throw`,
  `return`, a block, an `if`/`else`, and a `try`/`catch` with no
  `finally` — a `return` reachable on ANY path refuses outright (a
  `return` is a NORMAL completion for the caller), an `if` with no
  matching `else` refuses (the false path falls through), a `try`/`catch`
  is abrupt only when the `try` block is itself proven abrupt AND the
  `catch` block is too (so a swallowing `catch` refuses and a rethrowing
  one confirms), and a `finally` refuses outright rather than reasoning
  about it. Everything else this relation does not model — loops,
  `switch`, plain statements — answers `"normal"` by construction, which
  is also why an infinite loop (`while (true) {}`) is never classified
  abrupt: this relation proves abrupt completion from an uncaught `throw`
  reachable on every path, never from non-termination. `async` and
  generator functions are excluded before their body is even inspected: a
  synchronous `throw` inside an `async` function becomes a rejected
  promise, not a synchronous exception, and a generator's body does not
  run at all until `.next()` is called.

Both new relations reuse `mayEndModuleEvaluation`'s own "abrupt-completion
propagates to `try`/`catch`" rule unchanged: `isCaughtWithin`'s parameter
type was widened from `ts.ThrowStatement` to `ts.Node` (the ancestry walk
it performs never depended on the node's kind), so a throwing call wrapped
in a call-site `try { bail(); } catch {}` keeps the later export
authoritative exactly as a literal caught `throw` would.

**Feeds the SAME centralized authority gate RWF-015 built**, not a
parallel one: `mayEndModuleEvaluation` is the sole relation
`firstModuleEvaluationCutoff` — and therefore
`isDefinitelyReachedModuleScopeStatement`,
`isDefinitelyReachedExportAssignment`, and every export-provenance
consumer gated on it (whole-module, property, object-literal, class,
chained-alias and require-re-export attribution alike) — reads. One
change closed all six surfaces, verified case by case in
`module-model.local-throwing-call-export-authority.test.ts`.

**Performance.** The naive first implementation resolved callee identity
by counting every declaration of a name ANYWHERE in the whole file (any
scope, any form) — provably safe, but expensive: measured on the
scan-performance suite's 3,000-call single-file fixture, it cost ~280ms
extra per `buildModuleModel` call (547ms baseline → 829ms), enough to push
the suite's own 4,500ms threshold into occasional failure under load. The
shipped design instead scopes BOTH new relations to exactly the reach
`mayEndModuleEvaluation` already pays for: `resolveExactLocalCallable`'s
shadow check walks only the call site's own ancestor chain (typically
zero to a few nodes, never the whole file), and
`reassignedModuleReachableNames` never descends into a function body or
an expression tree, mirroring `mayContainNestedStatements`'s own
statement-position walk. Re-measured on the same fixture: 581ms (~6% over
the 547ms pre-RWF-016 baseline), and the scan-performance suite's own
single-large-file case is back to its pre-existing 2.0-2.5s range against
the 4,500ms threshold (confirmed identically flaky under full-suite
parallel contention on UNMODIFIED `main`, i.e. pre-existing environmental
noise, not a regression this task introduced).

**Measured impact.** Across all 110 adversarial scenarios (34 v1 + 76 v2,
including the new `ADV2-076`) and all 17 benchmark cases, the new case
(`ADV2-076`) is `UNKNOWN`, correctly, and every one of the other 109
pre-existing scenarios is unchanged — zero regressions, zero other verdict
movements. Benchmark unchanged at 12 PASS / 5 KNOWN_FAIL / 0 UNEXPECTED.
`ADV2-075` (RWF-015) stays `UNKNOWN`, `ADV2-074` (RWF-014) stays
`UNKNOWN`, `RWB-07` (RWF-012) stays `NOT_AFFECTED` with its Family C proof
intact, and `RWB-02` (RWF-003) stays `AFFECTED`.

**Real-corpus incidence.** An AST-shape search (`function NAME(...) {`
containing `throw` within ~200 characters) across every vendored
CommonJS/JS file under `fixtures/`, `tests/validation/fixtures/` and
`tests/adversarial/` found 24 candidate files; 3 are this task's own new
fixtures. Of the remaining 21 real, independently-authored files, **zero**
match the full RWF-016 pattern (a throwing-only local function CALLED at
module top level, with a later export write). Every real hit fell into
one of three shapes RWF-016 correctly does not need to act on:

- the `throw` sits directly inside the EXPORTED function's own body
  (`call-bind-apply-helpers`, `es-object-atoms`, `function-bind`,
  `get-proto`, `qs/lib/stringify.js`, `get-intrinsic`) — never a top-level
  CALL to a separately-named helper, so there is no call site for this
  relation to examine at all;
- real `dunder-proto/set.js` — RWF-015's own exhibit, a literal `throw`
  inside a `catch` clause at module scope, not a call;
- a `throw` nested inside a larger, multi-branch function (`node-forge`'s
  `util.js`/`asn1.js`, `handlebars`'s `compiler.js`/`runtime.js`) that is
  never itself called at module top level — the exact "deferred function"
  shape RWF-015's own doc comment already establishes does not poison a
  later export, for the identical reason.

`lodash.js` (488 top-level function declarations) contains no zero-argument,
throw-only function at all, and its whole-module export identity is
already unattributable for the separate, pre-existing reason RWF-001
tracks (a UMD-style locally-aliased `module.exports` assignment), so no
verdict could move there regardless. Correctness here is deliberately not
conditional on this count being small.

**Known remaining limitations.** All precision costs — they refuse more
than they strictly must, which is always the safe direction:

- *(precision)* no transitive reasoning: `function a() { b(); } function
  b() { throw err; } a();` is not recognized, even though `a` also always
  throws. Direct local body proof only, per this task's own scope; a tiny,
  cycle-safe transitive extension may be worth adding later, but nothing
  here requires it for soundness;
- *(precision)* a method call (`obj.bail()`), a computed/registry call
  (`registry[name]()`), and an aliased call (`const x = bail; x();`) are
  never resolved, even when the underlying target is in fact provably
  exact — extending any of these is new alias/receiver resolution, which
  RWF-016 is deliberately scoped not to introduce;
- *(precision)* a `let`/`var`-bound throwing function expression is never
  treated as definitely abrupt, only `const` — a `let`/`var` binding COULD
  be proven single-assignment-in-fact the way commonjs-reexports.ts does
  for RWF-012/013's different question, but RWF-016 does not extend that
  proof to this relation;
- *(unchanged from RWF-015)* a throwing IIFE still does not withdraw a
  later export's authority, for the same reason RWF-015 documented — an
  IIFE's callee is a function EXPRESSION, and proving it is invoked
  immediately is call-graph work this relation does not do. The runtime
  ground-truth fixture above independently confirms the underlying risk
  this leaves unmitigated (a cyclic `require()` can retain a
  pre-throw export) is real, not merely theoretical — but no false
  NOT_AFFECTED was reproduced for the IIFE shape specifically, because an
  IIFE call is `unknown(unsupported_construct)` in the call graph, which
  already withdraws Family C before this relation's own answer matters.

**Relevant files:** `src/code-intelligence/module-model.ts`
(`isDefinitelyAbruptCallStatement`, `resolveExactLocalCallable`,
`cannotCompleteNormally`, `classifyAbruptOutcome`,
`classifyAbruptSequence`, `mergeAbruptOutcomes`, `scopeDeclares`,
`reassignedModuleReachableNames`, `topLevelCallableCandidates`,
`isAsyncOrGeneratorCallable`, `isCaughtWithin` (widened),
`mayEndModuleEvaluation` (widened)); regressions in
`module-model.local-throwing-call-export-authority.test.ts`,
`verdict.local-throwing-call-export-authority.integration.test.ts`,
`fixtures/commonjs-local-throwing-call-export-authority/`,
`fixtures/commonjs-circular-import-throwing-export-ground-truth/`, and
`ADV2-076`.

---

## RWF-017 — A throwing local call in a VARIABLE DECLARATION'S INITIALIZER invalidates later CommonJS export authority

**Status: Fixed.** P0 (soundness). Was pre-existing on `main` — NOT
introduced by RWF-016, but left standing by it: RWF-016 proved the callee
and then recognised the call in exactly one syntactic position.

**Discovered:** the final RWF-016 audit, which observed that the same
resolvable, always-throwing local call has the same runtime consequence
when its return value is captured (`const result = bail();`) as when it is
discarded (`bail();`). Reproduced independently on `origin/main` at
`1e80f7a` (current merged main, with RWF-016 fully in place) before any
change.

**Symptom, reproduced end to end before the fix** — see
`fixtures/commonjs-initializer-throwing-call-export-authority/` and
`ADV2-077`:

```js
function dangerousOp(input) { return danger.explode(input); }
function safeOp(input) { return "safe:" + input; }
function bail() { throw new Error("fast mode is not supported here"); }

if (process.env.FIXTURE_LIB_MODE === "fast") {
  module.exports = dangerousOp;
  const result = bail();         // never returns -- ends module evaluation
}
module.exports = safeOp;         // top-level, unconditional, NOT always run
```

with an application that calls the package's whole exported value. The
file is RWF-016's fixture with one character-level change, and that is the
point: only the syntactic position of the `CallExpression` differs.

- **Actual, pre-fix** (verified on the commit before this one, and against
  `buildModuleModel`'s own output as well as the final verdict):
  `NOT_AFFECTED`, with `confirmedUnreachableTarget` present and
  `reachableSubgraphComplete: true`. The whole-module export bound to
  `safeOp`, the caller's `fixture(input)` got a fully RESOLVED edge to it,
  and `dangerousOp` was left with no incoming edge at all. Scanning the
  whole-module target instead returned `AFFECTED` over `safeOp` — a
  definitive attribution to the wrong branch.
- **Correct, and delivered:** `UNKNOWN`. Under the flag the module's
  exported value IS `dangerousOp`, which calls the sink, and the
  initializer's call never returns, so the statement below never executes.

**Root cause, exactly.** `isDefinitelyAbruptCallStatement` in
`src/code-intelligence/module-model.ts` opened with:

```ts
if (!ts.isExpressionStatement(node)) {
  return false;
}
```

Everything after that line — `resolveExactLocalCallable`'s lexical-scope
walk, the reassignment check, the `async`/generator exclusion,
`cannotCompleteNormally`'s three-outcome body classifier — was already
correct and already sufficient. The single shape test in front of it was
the whole defect: a `VariableStatement` never reached any of it.
`mayEndModuleEvaluation` already VISITS the `VariableStatement` (it is a
statement, and the walk descends through blocks, `if` arms, `switch`
clauses and `try` blocks to reach it), so no traversal change was needed
either — only the predicate applied at that node.

**Runtime ground truth.** A real, coherent CommonJS circular-import
fixture was built and executed with actual `node` (not VulnTrace) — see
`fixtures/commonjs-circular-import-initializer-throw-ground-truth/README.md`
for the verbatim transcript. It is RWF-016's ground-truth fixture with the
same one change, so the run isolates the question this task asks. It
establishes, non-vacuously:

1. `a.js` assigns `module.exports = dangerousOp` before the initializer
   statement is reached;
2. the declaration `const result = bail();` invokes `bail()` — proven by
   the log line printed immediately before it and the absence of the line
   after it, so the declaration provably did not complete and `result` was
   never bound;
3. `bail()` throws, and the exception propagates out of `a.js`'s own
   `require()`;
4. the later `module.exports = safeOp` is skipped — `require("./a")`
   yields `undefined` to the importer, and re-requiring re-throws
   deterministically, so `safeOp` is never the module's value on this
   path;
5. the cycle retains the dangerous export: `b.js` completed loading and
   holds `retained === dangerousOp`;
6. the vulnerable sink is genuinely CALLED through it, returning real
   output (`"EXPLODED:payload-from-entrypoint"`).

**The fix.** RWF-016's proof is factored out rather than duplicated. The
callee half is untouched: `resolveExactLocalCallable` and
`cannotCompleteNormally` are called exactly as before, with every existing
constraint intact (lexical identity, no same-name guessing, no stale
reassignment, no methods, no computed calls, no aliases, no imported
functions, `async`/generator excluded, `const`-only function-expression
callees). What widened is the CALL SITE:

- `isDefinitelyAbruptCall(expression)` — the shared core, an
  unwrap-parentheses + direct-`CallExpression` + identifier-callee shape
  test in front of RWF-016's two proofs;
- `declarationListCannotCompleteNormally(list)` — scans declarators LEFT
  TO RIGHT, the order the language evaluates them in, and answers `true`
  at the first one whose initializer is a proven-abrupt call;
- `isDefinitelyAbruptCallStatement(node)` — now dispatches on
  `ExpressionStatement` (RWF-016) or `VariableStatement` (RWF-017).

**Why left-to-right scanning needs no expression evaluator.** For
`const a = safe(), b = bail(), c = later();`, every declarator before the
abrupt one either completed normally — in which case `b` is reached and
throws — or was itself abrupt. Both readings agree that the statement
cannot complete normally, so the relation never has to decide which one
holds. `const a = bail(), b = safe();` and `const a = other(), b = bail();`
follow from the same argument.

**Why this cannot introduce a false NOT_AFFECTED, structurally.**
Reachability in this model is one comparison:
`isDefinitelyReachedModuleScopeStatement` returns
`cutoff === undefined || node.getStart(sf) < cutoff`, where `cutoff` is
`firstModuleEvaluationCutoff`'s single number. RWF-017 can only make
`mayEndModuleEvaluation` answer `true` for statements it previously
answered `false` for — it removes no case — so the cutoff can only move
EARLIER or come into existence, never move later or disappear. The set of
definitely-reached statements therefore only shrinks, and no export can
gain authority it did not already have on `main`. Every verdict movement
this change can produce runs `NOT_AFFECTED → UNKNOWN`, never the reverse.

**Verdict movements measured.** `NOT_AFFECTED → UNKNOWN`: 1 (`ADV2-077`,
plus the analyzer fixture's three integration assertions).
`UNKNOWN → NOT_AFFECTED`: 0. New false `AFFECTED`: 0. The real-world
validation baseline is bit-identical (12 PASS / 5 KNOWN_FAIL / 0
UNEXPECTED / 17 total), adversarial v1 is 34/34 and v2 is 77/77.

**Real-corpus incidence.** An AST pass (not a regex) over 3,173
`.js`/`.cjs`/`.mjs` files — the full vendored dependency tree plus every
real-world benchmark package (`lodash`, `qs`, `semver`, `node-forge`,
`handlebars`, `ini`, `ms`, `fast-xml-parser`, ...) — looking for a
module-reachable `VariableDeclaration` whose initializer is a direct
`CallExpression` resolving to a local top-level throw-only function, with
a later export write, found:

- 17,545 module-reachable `VariableStatement`s;
- 7,167 whose initializer is a direct `CallExpression`;
- 1,167 whose callee is a plain identifier bound to a local top-level
  function/arrow;
- **2** where that callee is throw-only above a later export write — and
  both are RWF-017's own fixtures.

Zero real-world matches, hence zero attribution or verdict delta on the
corpus, which is exactly what the unchanged validation baseline shows.
Correctness here is deliberately not conditional on that count being
small: the shape is a genuine, coherent CommonJS idiom, it is the same
UMD/feature-detect family RWF-015 and RWF-016 found in the wild, and the
runtime fixture proves the hazard independently of how often it is
currently vendored here.

**Performance.** The added work is a `ts.isVariableStatement` kind check
on nodes the cutoff walker already visits, plus, only when an initializer
really is a direct identifier call, RWF-016's existing (already memoized)
callable-summary lookups. No new traversal, no expression CFG, no
whole-file scan per initializer, no fixed point, no target execution. The
corpus numbers above bound the extra resolutions at ~1,167 across 3,173
files. `scan-performance`'s large-single-file fixture measured 1,811ms
with the fix against 2,426ms for the same fixture with the fix reverted
(4,500ms threshold) — run-to-run noise, no measurable regression.

**Known remaining limitations.** All precision costs except where marked.
They refuse more than they strictly must, which for a cutoff relation is
the direction that loses precision rather than soundness *only* where
noted — the unmarked entries are shapes where a missed cutoff could in
principle leave a later export over-attributed, and each is UNCHANGED from
`main` rather than introduced here:

- *(precision)* only a DIRECT initializer call is recognised. `const x =
  foo(bail());` and `const x = (bail(), value);` do evaluate `bail()`
  under ordinary JS evaluation order, but recognising them means walking
  arbitrary expression trees with a real evaluation-order model rather
  than a shape test; deliberately unmodeled. `const x = flag && bail();`,
  `const x = flag ? bail() : v;` and `const x = obj?.bail();` are
  correctly refused — the call genuinely may not happen;
- *(precision, sound)* `const x = bail?.()` IS recognised, and needs no
  special case: an exactly-resolved local callee is a hoisted function
  declaration or a never-reassigned `const`-bound function expression, so
  it is never nullish and the optional call always executes;
- *(unchanged from `main`)* a `for` statement's own initializer
  (`for (let x = bail(); ...)`) is a `VariableDeclarationList`, not a
  `VariableStatement`, and is not recognised. Loops keep the conservative
  treatment RWF-015 already gives them; `for (const x of bail())`'s RHS is
  likewise unmodeled;
- *(unchanged from `main`, worth a follow-up)* a class STATIC FIELD
  initializer (`class C { static x = bail(); }`) executes during class
  evaluation, i.e. during module evaluation, and is NOT recognised — the
  initializer sits on a `PropertyDeclaration`, which is neither statement
  kind. A class `static { ... }` BLOCK is recognised, both for `bail();`
  (RWF-016) and now for `const q = bail();` (RWF-017). The static-field
  shape can in principle reproduce a false `NOT_AFFECTED` and is recorded
  here as a **separate P0 candidate**: it turns on class-evaluation
  semantics (field ordering, `this` binding, computed keys) rather than on
  statement-position semantics, needs its own runtime ground truth, and
  fixing it here would have widened this task past the boundary it was
  scoped to;
- *(unchanged from `main`, worth a follow-up)* an object-literal property
  initializer (`const x = { value: bail() };`) is evaluated during object
  construction but is not recognised, for the same
  no-expression-evaluator reason as the argument-position case;
- *(unchanged from `main`)* `const x = new bail();` is a `NewExpression`,
  not a `CallExpression`, and is not recognised;
- *(unchanged from `main`)* the three shapes the RWF-016 audit recorded
  are all still open and all still behave exactly as they do on `main`,
  verified directly rather than assumed: a conditional-throw callee
  (correctly keeps authority), a throwing shadow declared in the call's
  OWN block (`resolveExactLocalCallable` refuses on the shadow and the
  later export keeps authority — the pre-existing fail-open the audit
  named), and a transitive `a() -> b() -> throw` chain (not recognised;
  direct local body proof only). RWF-017 reuses
  `resolveExactLocalCallable` verbatim and changes none of them. The
  shadow case does not block RWF-017: the new path fails closed through
  the same resolver, so it can only decline to act, never resolve to the
  wrong callee;
- *(unchanged from RWF-015/016)* a throwing IIFE still does not withdraw a
  later export's authority, and `scopeDeclares` still does not consider
  function parameters — latent, because no call site offered to it sits in
  a parameter scope; deliberately not broadened here.

**Relevant files:** `src/code-intelligence/module-model.ts`
(`isDefinitelyAbruptCall` (new), `declarationListCannotCompleteNormally`
(new), `isDefinitelyAbruptCallStatement` (widened),
`mayEndModuleEvaluation` (doc only); `resolveExactLocalCallable`,
`cannotCompleteNormally`, `isCaughtWithin`,
`reassignedModuleReachableNames`, `topLevelCallableCandidates`,
`isAsyncOrGeneratorCallable` all reused UNCHANGED); regressions in
`module-model.initializer-throwing-call-export-authority.test.ts`,
`verdict.initializer-throwing-call-export-authority.integration.test.ts`,
`fixtures/commonjs-initializer-throwing-call-export-authority/`,
`fixtures/commonjs-circular-import-initializer-throw-ground-truth/`, and
`ADV2-077`.

## RWF-018 — A throwing local call in a CLASS STATIC FIELD INITIALIZER invalidates later CommonJS export authority

**Status: Fixed.** P0 (soundness). Was pre-existing on `main` — NOT
introduced by RWF-017, but left standing by it, and named there in
advance: RWF-017's own remaining-limitations note recorded the static-field
shape as a **separate P0 candidate**, on the grounds that it turns on
class-evaluation semantics rather than statement-position semantics and
needs its own runtime ground truth. This entry is that follow-up.

**Discovered:** the final RWF-017 audit. Reproduced independently on
`origin/main` at `21940fd` (current merged main, with RWF-017 fully in
place) before any change — both against `buildModuleModel`'s own output
and end-to-end through the scan.

**Symptom, reproduced end to end before the fix** — see
`fixtures/commonjs-static-field-throwing-call-export-authority/` and
`ADV2-078`:

```js
function dangerousOp(input) { return danger.explode(input); }
function safeOp(input) { return "safe:" + input; }
function bail() { throw new Error("fast mode is not supported here"); }

if (process.env.FIXTURE_LIB_MODE === "fast") {
  module.exports = dangerousOp;
  class Mode {
    static probe = "fast";
    static ready = bail();       // never returns -- ends module evaluation
    static trailing = "never initialized";
  }
}
module.exports = safeOp;         // top-level, unconditional, NOT always run
```

with an application that calls the package's whole exported value. The
file is RWF-016/017's fixture with the call moved into a class body, and
that is the point: only the position of the `CallExpression` differs.

- **Actual, pre-fix** (verified on the commit before this one, by
  reverting only `module-model.ts` and re-running this task's own
  integration test): `NOT_AFFECTED`, with `confirmedUnreachableTarget`
  present and `reachableSubgraphComplete: true`, over target
  `fixture-lib/danger#explode`. The whole-module export bound to `safeOp`,
  the caller's `fixture(input)` got a fully RESOLVED edge to it, and
  `dangerousOp` was left with no incoming edge at all. Scanning the
  whole-module target instead returned `AFFECTED` over `safeOp` — a
  definitive attribution to the wrong branch. `ADV2-078` scored
  `NOT_AFFECTED` against an expected `UNKNOWN`.
- **Correct, and delivered:** `UNKNOWN`. Under the flag the module's
  exported value IS `dangerousOp`, which calls the sink, and the class's
  static field initializer never returns, so the statement below never
  executes.

**Root cause, exactly.** `mayEndModuleEvaluation` in
`src/code-intelligence/module-model.ts` already WALKS into class bodies —
it must, because a `static { ... }` block has run at class-definition time
since RWF-015 — and `mayContainClassStaticBlock`'s `/\bstatic\b/` text gate
already turns the full expression walk on for any file containing the
token, so the `PropertyDeclaration` for `static ready = bail();` was
already being visited. The only predicate applied at that node was
`isDefinitelyAbruptCallStatement`, which opens with:

```ts
if (ts.isExpressionStatement(node)) { ... }
if (ts.isVariableStatement(node)) { ... }
return false;
```

A `PropertyDeclaration` is neither statement kind, so it fell straight
through to `return false`. Everything after that — `resolveExactLocalCallable`'s
lexical-scope walk, the reassignment check, the `async`/generator
exclusion, `cannotCompleteNormally`'s three-outcome body classifier,
`isCaughtWithin`'s try/catch rule — was already correct and already
sufficient. No traversal change was needed; only the predicate applied at
a node the walker already reached.

**Why a static field is module-evaluation time.** Evaluating a class
DEFINITION — declaration or expression alike — runs each static element in
declaration order as part of that evaluation: `static { ... }` blocks and
`static x = ...` field initializers together. A class at module scope
therefore executes its static field initializers during module evaluation,
exactly as a static block does, and a throw out of one propagates out of
the class definition and out of the `require()` that started the load.

**Why an INSTANCE field is not, and why that distinction is the whole
argument.** An instance field initializer is INSTALLED by class evaluation
and evaluated per-instance, during construction. Evaluating
`class C { x = bail(); }` defines `C` and runs nothing; `bail()` executes
only if someone later writes `new C()`, which is a caller's decision made
after this module finished loading — the same reason
`mayEndModuleEvaluation` skips function bodies. Conflating the two would
withdraw authority from exports that really are reached, which is a false
refusal rather than conservatism, so it is refused explicitly and pinned by
tests at every level (unit, integration fixture, `ADV2-078`'s own
`class Installed { ready = bail(); }` decoy, and the runtime fixture's
`c.js`).

**Why ordering inside the class needs no model.**
`firstModuleEvaluationCutoff` records the enclosing top-level STATEMENT's
start position, so which static field throws — first, middle or last —
cannot change the answer: static elements run in declaration order, every
one of them during this same class definition, and any abrupt one means the
class definition does not complete. `static a = safe(); static b = bail();
static c = later();` and `static a = bail(); static b = safe();` therefore
agree, with no intra-class control-flow graph and no class evaluator.

**Runtime ground truth.** A real, coherent CommonJS circular-import fixture
was built and executed with actual `node` v26.7.0 (not VulnTrace) — see
`fixtures/commonjs-circular-import-static-field-throw-ground-truth/README.md`
for the verbatim transcript. It is RWF-017's ground-truth fixture with the
call moved into a static field, so the run isolates the question this task
asks, and it carries the instance-field control in the same process. It
establishes, non-vacuously:

1. `a.js` assigns `module.exports = dangerousOp` before the class is
   reached;
2. class evaluation invokes `bail()` — proven by the log line printed
   immediately before the class and the absence of the line after it, so
   the class definition provably did not complete and `C` was never bound;
   `static before` had already initialized and `static after` never did,
   which is the declaration-order execution this depends on;
3. `bail()` throws, and the exception propagates out of the class
   definition and out of `a.js`'s own `require()`;
4. the later `module.exports = safeOp` is skipped — `require("./a")`
   yields `undefined` to the importer, and re-requiring re-throws
   deterministically, so `safeOp` is never the module's value on this
   path;
5. the cycle retains the dangerous export: `b.js` completed loading and
   holds `retained === dangerousOp`;
6. the vulnerable sink is genuinely CALLED through it, returning real
   output (`"EXPLODED:payload-from-entrypoint"`);
7. the INSTANCE-field twin `c.js`, identical but for the `static` token,
   completes its class definition, prints that it did NOT call `bail()`,
   publishes `safeOp`, and throws only when `new C()` is later evaluated.

**The fix.** One new predicate, and it reuses RWF-016/017's proof rather
than duplicating any part of it. The callee half is untouched:
`resolveExactLocalCallable` and `cannotCompleteNormally` are called exactly
as before, through the shared `isDefinitelyAbruptCall`, with every existing
constraint intact (lexical identity, no same-name guessing, no stale
reassignment, no methods, no computed calls, no aliases, no imported
functions, `async`/generator excluded, `const`-only function-expression
callees, parentheses normalization). What widened is the CALL SITE:

- `isDefinitelyAbruptStaticFieldInitializer(node)` (new) — a
  `PropertyDeclaration` + `static` modifier + present initializer shape
  test in front of the shared `isDefinitelyAbruptCall`;
- `mayEndModuleEvaluation` — now applies that predicate alongside
  `isDefinitelyAbruptCallStatement` at the nodes it already visits, under
  the SAME `isCaughtWithin` guard, so a caught class-evaluation throw keeps
  a later export's authority and a rethrowing `catch` withdraws it, with no
  separate try/catch rule;
- `mayContainClassStaticBlock` → `mayContainClassStaticEvaluation`
  (renamed, same `/\bstatic\b/` test) — the gate now honestly names both
  constructs it admits, static blocks and static field initializers.

No parallel static-block model was created: static blocks continue to be
handled exactly as RWF-015/016/017 handle them, through the same walk and
the same statement predicates, and a class mixing a static block with an
abrupt static field is answered by whichever the walk reaches first.

**Why this cannot introduce a false NOT_AFFECTED, structurally.**
Reachability in this model is one comparison:
`isDefinitelyReachedModuleScopeStatement` returns
`cutoff === undefined || node.getStart(sf) < cutoff`, where `cutoff` is
`firstModuleEvaluationCutoff`'s single number. RWF-018 can only make
`mayEndModuleEvaluation` answer `true` for nodes it previously answered
`false` for — it removes no case — so the cutoff can only move EARLIER or
come into existence, never move later or disappear. The set of
definitely-reached statements therefore only shrinks, and no export can
gain authority it did not already have on `main`. Every verdict movement
this change can produce runs `NOT_AFFECTED → UNKNOWN`, never the reverse.

**Verdict movements measured.** `NOT_AFFECTED → UNKNOWN`: 1 (`ADV2-078`,
plus the analyzer fixture's three integration assertions).
`UNKNOWN → NOT_AFFECTED`: 0. New false `AFFECTED`: 0. The real-world
validation baseline is bit-identical (12 PASS / 5 KNOWN_FAIL / 0
UNEXPECTED / 17 total), adversarial v1 is 34/34 and v2 is 78/78, and the
full unit/integration suite is 2,300/2,300 across 103 files.

**Real-corpus incidence.** An AST pass (not a regex) over 3,198
`.js`/`.cjs`/`.mjs` files — the full vendored dependency tree plus every
fixture and real-world benchmark package — looking for a class
declaration/expression with a `static` `PropertyDeclaration` whose
initializer is a direct identifier `CallExpression` resolving to a local
top-level throw-only function, with a later export write, found:

- 237 files containing the token `static` at all;
- 1,557 class declarations/expressions;
- 481 STATIC fields with an initializer (and 791 INSTANCE fields with one
  — the shape that must NOT be acted on, and by a wide margin the more
  common of the two in real code);
- 4 whose static-field initializer is a direct identifier call;
- **4** where that callee is throw-only above a later export write — and
  all four are RWF-018's own fixtures (one of them, `ADV2-078`'s
  `class Deferred` inside `configure`, is a deliberately DEFERRED decoy the
  analyzer correctly does not act on; this probe is a superset and does not
  model deferral).

Zero real-world matches, hence zero attribution or verdict delta on the
corpus, which is exactly what the unchanged validation baseline shows.
Correctness here is deliberately not conditional on that count being small:
the shape is a genuine, coherent CommonJS idiom, it is the same
UMD/feature-detect family RWF-015, RWF-016 and RWF-017 found in the wild,
and the runtime fixture proves the hazard independently of how often it is
currently vendored here.

**Performance.** The added work is a `ts.isPropertyDeclaration` kind check
plus a modifier scan on nodes the cutoff walker already visits, and only in
files whose text contains `static` at all (237 of 3,198 here — the gate was
already there for static blocks and is unchanged). When a static field's
initializer really is a direct identifier call, it reuses RWF-016's
existing, already-memoized callable-summary lookups. No new traversal, no
class CFG, no expression interpreter, no whole-file rescan per field, no
fixed point. `scan-performance`'s large-single-file fixture — whose text
contains no `static` at all, so this code path is provably unreachable for
it — measured 1,764ms / 1,846ms / 2,454ms with the fix against 2,019ms for
the same fixture with the fix reverted (4,500ms threshold): run-to-run
noise, no measurable regression. (One 6,392ms reading was observed for that
test inside the fully parallel 103-file suite run and did not reproduce in
isolation on either branch or base; it is scheduling contention, not this
change.)

**Newly characterised, all still open, all UNCHANGED from `main`.** Each
was probed directly against `main` rather than assumed, using the same
reproducer shape. None is introduced or worsened here; they are recorded so
the next task can pick them up rather than rediscover them:

- *(soundness, separate P0 follow-up — **since fixed by RWF-019**; see its
  entry below)* a COMPUTED static field key,
  `class C { static [bail()] = 1; }`, reproduced a false `NOT_AFFECTED` on
  `main` and still did on the RWF-018 branch. It was deliberately NOT fixed
  there: computed keys
  are evaluated at class-definition time for INSTANCE members, METHODS and
  ACCESSORS too — `static [bail()] = 1`, `[bail()] = 1`, `[bail()]() {}`,
  `static [bail()]() {}` and `get [bail()]() {}` were each probed directly
  and all five behave identically, on `main` and on this branch — so a
  correct fix is a key-position rule covering every class element, not a
  static-field rule; folding a partial version of it in behind
  `isDefinitelyAbruptStaticFieldInitializer` would have shipped
  inconsistent coverage under a name that does not describe it. Recorded as
  the RWF-019 candidate;
- *(soundness, same expression-boundary family RWF-017 already recorded)*
  `static x = bail() || 1;` and `static x = (bail(), value);` both evaluate
  the call unconditionally at runtime and both keep authority on `main` and
  on this branch. These are the LHS/first-operand positions, which are
  genuinely always evaluated, unlike `flag && bail()` and
  `flag ? bail() : v` (correctly refused — the call genuinely may not
  happen). They belong to the one arbitrary-expression-evaluation gap
  RWF-017 named, and closing it properly means an evaluation-order model
  over expression trees rather than a shape test;
- *(precision)* `static x = foo(bail());`, `static x = [bail()];`,
  `static x = { v: bail() };` and ``static x = `v${bail()}` `` are all
  evaluated at runtime and all keep authority — the same boundary, listed
  separately because argument, element, property and template-hole
  positions are the shapes most likely to appear first in real code;
- *(precision)* `static x = new bail();` is a `NewExpression`, not a
  `CallExpression`, and is not recognised — unchanged from RWF-017;
- *(precision, the one shape this branch makes MORE conservative)* a
  nested class carrying an abrupt static field, written inside an INSTANCE
  field's initializer — `class C { x = class { static y = bail(); }; }` —
  now reports a cutoff where `main` did not. At runtime the outer instance
  field never evaluates at class-definition time, so the inner class is
  never evaluated either and the later export really is reached; the cutoff
  is therefore an over-approximation. It is accepted deliberately: the
  walker does not model which expressions are evaluated, only which
  constructs execute at class-definition time, and `main` already behaves
  exactly this way for the static-BLOCK spelling of the same shape
  (`class C { x = class { static { throw ...; } }; }` reports a cutoff on
  `main` today). Making the static-field case match it keeps one model
  rather than two, and errs toward UNKNOWN, never toward a negative proof.
  Confirmed by direct differential probe: base `second`, branch refused,
  static-block spelling refused on both;
- *(precision)* a throwing IIFE in a static field initializer
  (`static x = (() => { throw ...; })();`) does not withdraw authority, for
  exactly the reason RWF-015 documented for IIFEs generally and RWF-016/017
  left unchanged;
- *(unchanged from `main`)* a CLASS NAME shadow (`class bail { static x =
  bail(); }`) is not modeled by `scopeDeclares`, which does not treat a
  class's own name binding as shadowing inside its body. This branch
  deliberately does NOT change it: `scopeDeclares` is part of the lexical
  resolution RWF-018 is scoped to reuse verbatim, and adding the shadow
  would make the analyzer KEEP authority for a later export that a real
  Node run never reaches (calling a class without `new` throws a
  TypeError), i.e. it would introduce the very false `NOT_AFFECTED` this
  task exists to remove. The pre-existing "calling a class throws" gap is
  its own separate question and is untouched either way; on this branch the
  shape happens to be refused, which is the sound direction;
- *(unchanged from `main`)* a transitive `a() -> b() -> throw` chain is
  still not recognised (direct local body proof only), a conditional-throw
  callee is still correctly kept, a throwing shadow declared in the call's
  OWN block still fails closed through `resolveExactLocalCallable`, and a
  `for` statement's own initializer is still unmodeled. RWF-018 reuses
  `resolveExactLocalCallable` verbatim and changes none of them.

**Relevant files:** `src/code-intelligence/module-model.ts`
(`isDefinitelyAbruptStaticFieldInitializer` (new), `mayEndModuleEvaluation`
(one predicate added at an already-visited node),
`mayContainClassStaticBlock` → `mayContainClassStaticEvaluation` (renamed,
same test), `isDefinitelyAbruptCallStatement` (doc only);
`isDefinitelyAbruptCall`, `declarationListCannotCompleteNormally`,
`resolveExactLocalCallable`, `cannotCompleteNormally`, `isCaughtWithin`,
`reassignedModuleReachableNames`, `topLevelCallableCandidates`,
`isAsyncOrGeneratorCallable` all reused UNCHANGED); regressions in
`module-model.static-field-throwing-call-export-authority.test.ts`,
`verdict.static-field-throwing-call-export-authority.integration.test.ts`,
`fixtures/commonjs-static-field-throwing-call-export-authority/`,
`fixtures/commonjs-circular-import-static-field-throw-ground-truth/`, and
`ADV2-078`.

---

## RWF-019 — A throwing local call in a class element's COMPUTED KEY invalidates later CommonJS export authority

**Severity:** P0 / CRITICAL SOUNDNESS — a false `NOT_AFFECTED`.

**Family:** the same one RWF-015, RWF-016, RWF-017 and RWF-018 belong to, and
named in advance by RWF-018 as "the RWF-019 candidate": RWF-016 proved the
CALLEE, RWF-017 proved that the call's syntactic POSITION does not change the
outcome, and RWF-018 carried it into a class STATIC FIELD's initializer. All
three read the call out of a VALUE position, and a computed property name is
not one.

**Discovered:** the final independent RWF-018 audit, which observed that
`class C { static [bail()] = 1; }`, `class C { [bail()] = 1; }`,
`class C { [bail()]() {} }`, `class C { static [bail()]() {} }` and
`class C { get [bail()]() {} }` all behaved identically on `main` — all five
kept the later export attributable — and that a correct fix must therefore be
a key-POSITION rule covering every class element rather than a static-field
one. Reproduced independently on `origin/main` at `21b1466` (current merged
main, with RWF-018 fully in place) before any change on this branch.

### The defect

```js
function dangerousOp() { /* reaches the vulnerable sink */ }
function safeOp() {}
function bail() { throw new Error("boom"); }

if (FLAG) {
  module.exports = dangerousOp;
  class C {
    [bail()] = 1;          // <- no `static`, no call in any VALUE position
  }
}

module.exports = safeOp;   // <- syntactically unconditional; NOT always run
```

A **computed property name is evaluated by ClassDefinitionEvaluation**, in
declaration order, as each element is defined — the key has to exist before
the element can be installed on the class or its prototype. That is true of
**every** element form, because installing any of them needs a property key:
static field, instance field, method, getter, setter, `async` method,
generator method. So reaching this class necessarily invokes `bail()`, the
class definition never completes, `C` is never bound, and nothing below the
class runs — including `module.exports = safeOp`, which a cyclic importer
therefore never sees.

**Why this is a different rule from RWF-018, not a widening of it.**
RWF-018's static/instance distinction is real, and it survives untouched —
but it is about when the element's **VALUE** runs. The **KEY** of that very
same element runs immediately either way:

```js
class C { x = bail(); }      // completes -- an instance field VALUE is per-instance
class C { [bail()] = 1; }    // throws    -- the same element's KEY is definition-time
```

A rule that required `static` would therefore miss the majority of this
family. Folding a partial version of it in behind
`isDefinitelyAbruptStaticFieldInitializer` would have shipped inconsistent
coverage under a name that does not describe it, which is exactly why RWF-018
deferred it rather than half-doing it.

### Pre-fix reproduction on `main`

`fixtures/commonjs-computed-class-key-throwing-call-export-authority/` is
RWF-018's fixture with the call moved from the static field's initializer to
a non-static element's computed key, and — for `method-key.js` — onto a
METHOD, the form where both the value and the body are deferred and only the
key runs. Scanned on `main` at `21b1466`,
`src/analysis/verdict.computed-class-key-throwing-call-export-authority.integration.test.ts`
fails four of its seven cases:

| case | `main` | this branch |
| --- | --- | --- |
| `fixture-lib/danger#explode` reachability | **`NOT_AFFECTED`** | `UNKNOWN` |
| Family C proof for it | `confirmedUnreachableTarget` present, `reachableSubgraphComplete: true` | absent |
| `fixture-lib#default` (whole-module) | **`AFFECTED`** (bound to `safeOp`) | `UNKNOWN` |
| `fixture-lib/method-key#default` | **`NOT_AFFECTED`** | `UNKNOWN` |
| deferred-position control | `NOT_AFFECTED` | `NOT_AFFECTED` (unchanged) |
| Family C control (`stable`) | `NOT_AFFECTED` | `NOT_AFFECTED` (unchanged) |
| PackageInstance substitution | never `AFFECTED` | never `AFFECTED` (unchanged) |

So `main` issued a **complete Family C negative proof over `dangerousOp`** —
a confident clean bill of health for a package that reaches the sink on every
load taking the early branch. Both controls already passed on `main`, so they
are real controls rather than artifacts of the fix.

At the module-model level the same reproduction is one line: on `main`,
every one of the ten computed-key forms below attributed the later SAFE
export (`second`), while RWF-018's static-field control correctly refused it.

### Runtime ground truth

`fixtures/commonjs-circular-import-computed-class-key-throw-ground-truth/`
is a plain Node program (`node entry.js`, Node.js v26.7.0, built-in CommonJS
loader, no mocking); see its README for the verbatim transcript. It is
RWF-018's ground-truth fixture with the call moved into a non-static computed
key, and it proves, in one process:

1. the dangerous export is assigned first, and the circular `require("./b")`
   happens while it is still the module's value;
2. class evaluation runs the computed keys — the key BEFORE the abrupt one
   printed, the key AFTER it never did;
3. `bail()` throws out of the class definition and out of `require("./a")`;
4. the later `safeOp` assignment is skipped, and re-requiring `./a` re-throws
   deterministically, so `safeOp` is never the module's value on this path;
5. the cycle retains the dangerous export;
6. the vulnerable sink is genuinely called through it
   (`EXPLODED:payload-from-entrypoint`);
7. **all eight element forms** — `static [bail()] = 1`, `[bail()] = 1`,
   `[bail()]() {}`, `static [bail()]() {}`, `get [bail()]() {}`,
   `set [bail()](v) {}`, `async [bail()]() {}`, `*[bail()]() {}` — plus the
   parenthesized key, the optional call `[bail?.()]`, and the class
   declaration and class expression spellings, all threw at class-definition
   time;
8. the deferred controls — an instance field's VALUE, a method BODY, and a
   class defined inside an uncalled function — all **completed** and
   published their later export;
9. `class Outer { field = class Inner { [bail()] = 1; }; }` also **completed**
   (see the over-approximation note below).

`forms.js` also measures key ordering directly:
`[safe()] = 1; [bail()] = 2; [later()] = 3;` evaluated `safe` and `bail` and
never `later`.

### The fix

One new predicate, and it reuses RWF-016/017/018's proof rather than
duplicating any of it. In `src/code-intelligence/module-model.ts`:

- **`isDefinitelyAbruptComputedClassElementKey(node)`** (new) — true when
  `node` is a class element (`ts.isClassElement`) whose `name` is a genuine
  `ts.ComputedPropertyName`, whose parent is a `ClassDeclaration` or
  `ClassExpression` (`ts.isClassLike`), and whose key expression satisfies the
  existing `isDefinitelyAbruptCall`. Detection is an AST node-kind check, never
  a text test.
- **`mayEndModuleEvaluation`** — the new predicate is asked at an already
  visited node, but **before** the walk's `ts.isFunctionLike` stop rather than
  after it. That ordering is the substance of the fix for methods and
  accessors: a `MethodDeclaration`, `GetAccessorDeclaration` and
  `SetAccessorDeclaration` are all function-like, so a test placed after the
  stop would never see their keys. The stop still applies to the element's
  BODY, which is what it is for.
- **`mayContainClassDefinitionTimeEvaluation`** (new) — the cheap text gate
  that decides whether a file needs the full expression walk widens from
  `/\bstatic\b/` to `/\bclass\b/`. RWF-015/018's `static` test was complete
  for the two constructs known then, because neither a static block nor a
  static field can be written without that token; a computed key has no
  `static` in it at all. All three do share the `class` keyword — there is no
  other way to write a class — so one token still gates all of them, and it is
  the token that names the construct doing the executing.

Deliberately **not** shared with `reassignedModuleReachableNames`, which keeps
the narrower `static` gate. Widening a walk that looks for ABRUPT COMPLETIONS
can only find more cutoffs, i.e. refuse more exports — the safe direction.
Widening the walk that looks for REASSIGNMENTS runs the other way: a name it
newly marks as reassigned makes `resolveExactLocalCallable` refuse a callee
and REMOVES a cutoff, turning a refused export into an attributed one. RWF-019
is a soundness fix and takes no movement in that direction, so the two gates
are separate on purpose.

`isDefinitelyAbruptCall`, `declarationListCannotCompleteNormally`,
`isDefinitelyAbruptStaticFieldInitializer`, `resolveExactLocalCallable`,
`cannotCompleteNormally`, `isCaughtWithin`, `reassignedModuleReachableNames`,
`topLevelCallableCandidates`, `isAsyncOrGeneratorCallable`,
`mayContainClassStaticEvaluation` and `mayContainNestedStatements` are all
reused **unchanged**. There is no class CFG, no expression evaluator, no
method-body execution model and no target execution.

### Monotonicity

Everything RWF-019 changes moves `firstModuleEvaluationCutoff`'s single number
EARLIER or leaves it alone; it can never move it later. Concretely: the walk's
descent strictly grows (the gate widens, nothing narrows), and one more
predicate can report `found`, so every cutoff `main` finds this branch finds
too. Withdrawing authority can only remove an attributed target, and no
fallback exists that could substitute another one — verified by direct probe
over the localName, exportedName, anonymous-location, earlier-export,
re-export, different-PackageInstance and Family A/B/C substitution paths:

- **module-model differential, 34 probe shapes** (base vs. branch, same
  process): 7 changed, and every one of them `second` → `undefined`
  (attributed → refused). Zero changed in the other direction.
- **corpus differential, 3,207 vendored/fixture `.js`/`.cjs`/`.mjs` files**
  (see below): 3 files changed, all three RWF-019's own new fixtures, all
  three `default=safeOp` → no attribution. Zero real third-party files
  changed; zero movements toward attribution anywhere.
- **suite-wide**: `NOT_AFFECTED → UNKNOWN` movements: 4 (the fixture's own
  cases). `UNKNOWN → NOT_AFFECTED` movements: **0**. New false `AFFECTED`: 0.
  New false `NOT_AFFECTED`: 0.

Family C itself is untouched. The correction is upstream of it: the later safe
export's attribution is withdrawn → no authoritative target is available → the
Family C proof is unavailable → `UNKNOWN`. Valid Family C controls
(`fixture-lib/stable`, RWB-06, RWB-06A, RWB-07, RWB-11b) all still produce
`NOT_AFFECTED`. `ModuleLoadClosure` semantics are unchanged, and nothing infers
absence from computed-key abruptness.

### Corpus

AST-searched every vendored/fixture `.js`, `.cjs` and `.mjs` under
`node_modules/`, `fixtures/` and `tests/` — 3,207 files, 0 parse failures:

| measure | count |
| --- | --- |
| files scanned | 3,207 |
| files containing a class | 470 |
| classes (declarations + expressions) | 2,284 |
| class elements with a `ComputedPropertyName` | 196 |
| …whose key is a direct identifier `CallExpression` | 25 |
| …resolving to an exact local, non-reassigned callable whose body is definitely abrupt | 25, **all in RWF-019's own fixtures** |
| files whose modelled exports changed | **3**, all RWF-019's own fixtures |

So the shape is real but rare in vendored code: the 196 computed class
elements in third-party JavaScript are overwhelmingly `[Symbol.iterator]`,
`[Symbol.asyncIterator]` and constant-keyed members, none of which is a call.
No vendored file's export attribution moves. That is the expected profile for
a soundness fix in this family — the same as RWF-016/017/018 — and it is why
the adversarial and fixture evidence carries the argument rather than corpus
volume.

### Performance

The predicate is a node-kind check plus a `ComputedPropertyName` check plus
the already-memoized `isDefinitelyAbruptCall`, asked at a node the walk
already visits — no per-key file scans, no expression CFG, no class
evaluator. The one real cost is the widened gate: a file containing the token
`class` now pays for the expression walk where only a file containing
`static` did before. The scan-performance suite's single-file fixture
contains neither token, so it is unaffected by construction, and measured
2,879ms in isolation against a 4,500ms threshold.

That test does fail inside the fully parallel 105-file suite run — but it
fails on `main` too, and by more: `main` 6,620ms, this branch 6,414ms /
5,445ms across runs, against 2,879ms in isolation on this branch and 2,211ms
in a small parallel group. It is scheduling contention on this machine, not
this change; the same phenomenon was recorded for RWF-018.

### Newly characterised, all UNCHANGED from `main`

Each was probed directly against `main` rather than assumed, and each was
checked against real `node` so the runtime truth is measured rather than
argued. None is introduced or worsened here:

- *(soundness, separate P0 follow-up — **not** absorbed here)* a HERITAGE
  CLAUSE, `class C extends bail() {}`, throws at class-definition time under
  real `node` and still keeps the later export attributable on `main` and on
  this branch. It is a genuinely different expression position — evaluated
  before any element, and the natural next member of this family — and RWF-019
  neither fixes nor worsens it. Recorded as the RWF-020 candidate. RWF-019
  does not break existing extends handling: `class C extends base() { [bail()]
  = 1; }` is refused on this branch for the key's sake, exactly as it should
  be;
- *(soundness, separate P0 follow-up)* an OBJECT LITERAL's computed key,
  `const o = { [bail()]: 1 };`, likewise throws under real `node` and keeps
  authority on both. It is deliberately excluded here — the predicate requires
  the element's parent to be a class, which is what tells a class's
  `MethodDeclaration` apart from an object literal's identically-kinded one —
  because an object literal is an ordinary expression and belongs to the
  arbitrary-expression-evaluation boundary RWF-017 recorded, not to class
  evaluation;
- *(soundness, unchanged from `main`, and NOT computed-key specific)* a CLASS
  NAME shadow, `class bail { [bail()] = 1; }`, throws a `ReferenceError` under
  real `node` (the class's own binding shadows the outer function and is in
  TDZ) and keeps authority on both. `scopeDeclares` sees the enclosing block
  declare `bail` and `resolveExactLocalCallable` fails closed on identity,
  which withdraws the cutoff. RWF-018's own shape behaves identically —
  `class bail { static x = bail(); }` also keeps authority on `main` and on
  this branch — so this is the pre-existing lexical-model gap, not something
  the key rule introduces. Fixing it means changing `scopeDeclares`, which
  RWF-019 is scoped to reuse verbatim;
- *(soundness, same expression-boundary family RWF-017 and RWF-018 already
  recorded)* `[bail() || "x"]`, `[(bail(), "x")]`, `[foo(bail())]`,
  `[[bail()]]`, `` [`v${bail()}`] `` and `[{ v: bail() }]` are all evaluated
  unconditionally at runtime (confirmed under real `node`) and all keep
  authority on `main` and on this branch. Closing them properly means an
  evaluation-order model over expression trees rather than a shape test;
- *(correctly refused, not a gap)* `[FLAG && bail()]` and
  `[FLAG ? bail() : "x"]` genuinely may not call `bail` at all — confirmed by
  running both under real `node` with a falsy flag, where the class definition
  completed. Refusing them is right, and it is why guessing past the shape
  test is not available;
- *(precision)* `[new bail()]` is a `NewExpression`, not a `CallExpression`,
  and is not recognised — unchanged from RWF-017/018. A throwing IIFE in a
  computed key is likewise not recognised, for exactly the reason RWF-015
  documented for IIFEs generally;
- *(precision, the one shape this branch makes MORE conservative)* a nested
  class carrying an abrupt COMPUTED KEY, written inside an INSTANCE field's
  initializer — `class C { x = class { [bail()] = 1; }; }` — now reports a
  cutoff where `main` did not. At runtime the outer instance field never
  evaluates at class-definition time (measured: it completed), so this is an
  over-approximation. It is accepted deliberately and is **not new behaviour
  in kind**: `main` already answers both the static-BLOCK and the
  static-FIELD spellings of this exact shape the same way
  (`class C { x = class { static y = bail(); }; }` reports a cutoff on `main`
  today, confirmed by direct differential probe). Giving computed keys a
  second, different traversal model to avoid it would mean two models rather
  than one; the movement is strictly toward UNKNOWN, never toward a negative
  proof, and RWF-019 does not broaden it further in any other direction;
- *(unchanged from `main`)* a transitive `a() -> b() -> throw` chain is still
  not recognised (direct local body proof only), a conditional-throw callee is
  still correctly kept, a returning callee is still kept, an `async` or
  generator CALLEE is still correctly excluded (note that an `async` or
  generator ELEMENT is not — `async [bail()]() {}` with a synchronously
  throwing `bail` really does abort the class definition, and is refused),
  a throwing shadow declared in the call's OWN block still fails closed
  through `resolveExactLocalCallable`, an ALIASED callee (`[alias()]`) and a
  MEMBER callee (`[obj.bail()]`) are still both refused as one-hop boundaries,
  a REASSIGNED callee is still correctly kept, and a `for` statement's own
  initializer is still unmodeled. RWF-019 reuses `resolveExactLocalCallable`
  verbatim and changes none of them.

**Relevant files:** `src/code-intelligence/module-model.ts`
(`isDefinitelyAbruptComputedClassElementKey` (new),
`mayContainClassDefinitionTimeEvaluation` (new),
`mayEndModuleEvaluation` (one predicate added, asked before the function-like
stop), `firstModuleEvaluationCutoff` (gate swap only),
`isDefinitelyAbruptStaticFieldInitializer` (doc only);
`isDefinitelyAbruptCall`, `declarationListCannotCompleteNormally`,
`isDefinitelyAbruptCallStatement`, `resolveExactLocalCallable`,
`cannotCompleteNormally`, `isCaughtWithin`, `reassignedModuleReachableNames`,
`mayContainClassStaticEvaluation`, `topLevelCallableCandidates`,
`isAsyncOrGeneratorCallable` all reused UNCHANGED); regressions in
`module-model.computed-class-key-throwing-call-export-authority.test.ts` (91
cases), `verdict.computed-class-key-throwing-call-export-authority.integration.test.ts`,
`fixtures/commonjs-computed-class-key-throwing-call-export-authority/`,
`fixtures/commonjs-circular-import-computed-class-key-throw-ground-truth/`,
and `ADV2-079`. The two computed-key shapes RWF-018 pinned as unmodeled in
`module-model.static-field-throwing-call-export-authority.test.ts` moved out
of that file's boundary list, since they are now correctly refused.

---

## RWF-021 — Withdrawing export attribution deleted the entrypoint's reachability ROOT

**Severity:** P0 / CRITICAL SOUNDNESS — a false `NOT_AFFECTED`. **Cross-family:**
this is not a defect in any one cutoff rule; it is a defect in what every
cutoff rule's output was wired into.

**Discovered:** the independent RWF-020 audit, which built a
configured-entrypoint attack against the (then unmerged) heritage-clause
branch, found a false `NOT_AFFECTED`, and then established that the same
attack already succeeded on **current main** through all four merged
families. RWF-020 was blocked on that basis; the defect it exposed is this
one, and it is older than RWF-020.

### The defect

```js
// src/index.cjs -- the CONFIGURED ENTRYPOINT
const dep = require("vuln-lib");

function main(userInput) {          // the only path to the sink
  return dep.dangerousOp(userInput);
}
function bail() { throw new Error("boom"); }

if (process.env.FLAG === "1") { bail(); }   // RWF-016 cutoff

module.exports = main;              // bypassable -> attribution withdrawn
```

Runtime, with `FLAG` unset (asserted, not argued — see
`fixtures/commonjs-entrypoint-root-widening/verify.cjs`): the abrupt branch
never executes, `module.exports` **is** `main`, and calling it returns
`danger:payload`. The sink is genuinely reachable.

The analyzer said otherwise:

```text
precise export     localName = "main"      -> root "main" -> path found -> AFFECTED
authority withdrawn localName = undefined  -> NO root      -> `main` never traversed
                                           -> target unreachable
                                           -> reachableSubgraphComplete: true
                                           -> NOT_AFFECTED   (FALSE)
```

Measured on `8d18130` for every merged cutoff family, all four identical:

| Entrypoint cutoff | base `8d18130` | RWF-021 |
| --- | --- | --- |
| RWF-016 `bail();` | **NOT_AFFECTED**, Family C complete | AFFECTED |
| RWF-017 `const x = bail();` | **NOT_AFFECTED**, Family C complete | AFFECTED |
| RWF-018 `static x = bail();` | **NOT_AFFECTED**, Family C complete | AFFECTED |
| RWF-019 `[bail()] = 1` | **NOT_AFFECTED**, Family C complete | AFFECTED |
| `exports.run = main` + cutoff | **NOT_AFFECTED**, Family C complete | AFFECTED |
| anonymous `module.exports = function (u) {…}` | **NOT_AFFECTED**, Family C complete | AFFECTED |

### Root cause: two different questions answered by one expression

`entrypointSourceNodes` derived its roots with
`const name = exp.localName ?? exp.exportedName`. That expression is export
**attribution** provenance, and attribution and root selection are not the
same question — they fail in opposite directions:

- **Export attribution** asks *"which function IS this module's exported
  value?"*. Its correct failure mode is to **refuse**: naming a function the
  module might not export manufactures a target out of nothing. RWF-011,
  RWF-013 and RWF-014 are all fixes for having answered it too eagerly.
- **Root selection** asks *"which of this file's functions might an outside
  caller invoke?"*. Its correct failure mode is to **widen**: an
  entrypoint's exports are by definition invocable from outside the analyzed
  codebase, so a root this file cannot pin down is a root that might be any
  of its top-level callables — not none of them.

Reading the second off the first made every refusal a deletion. Worse, the
deletion is **invisible in the evidence**: the resulting subgraph is
smaller, so it is *more* likely to be judged complete, and the false
negative arrives wearing a complete Family C proof.

The anonymous case is the same asymmetry without any cutoff at all:
`module.exports = function (u) {…}` has an exact function IDENTITY
(RWF-003's `localFunctionLocation`) and no name, so a name-only root lookup
lost it even when attribution was fully precise.

### The fix

Root selection becomes its own named relation,
`entrypointRootCandidates` in module-model.ts, and `entrypointSourceNodes`
consumes it instead of reading provenance inline:

- every export that still carries a name contributes it — **the precise
  case is byte-for-byte unchanged**, so a file whose authority is intact
  widens nothing and costs nothing;
- an export whose attribution was WITHDRAWN additionally contributes every
  **top-level** callable the file declares
  (`topLevelCallableCandidates`, reused rather than re-derived);
- an anonymous exported callable contributes its **position**, matched
  against the graph node's own location.

Withdrawal is marked explicitly (`ExportBinding.exportAttributionWithdrawn`)
rather than inferred from a missing `localName`, because those are not the
same fact: `module.exports = 42` also has no `localName`, genuinely exports
no callable, and must NOT widen. Both `ambiguousWholeModuleExport`
(whole-module) and `propertyExportProvenance` (`exports.foo = …`) set it.

**Monotonicity is the property, and it is asserted directly**
(`module-model.entrypoint-root-candidates.test.ts`): for each of the four
cutoff families, the ambiguous root set is a strict superset of the precise
one, and it is never empty when the precise one was not.

### What widening deliberately does NOT do

- **No attribution is resurrected.** `mapExportsToFunctions` is untouched;
  a widened root is a traversal start point, never an identity claim. No
  target resolves through one, and no evidence names one as the export.
- **`exportedName` is not turned into a local symbol.** The pre-existing
  `?? exp.exportedName` fallback is kept as-is for roots (where landing on
  a same-name local merely adds a start point) and remains correctly
  removed from attribution by RWF-011 (where it manufactures a false
  target). That asymmetry is the whole point of the split.
- **No fallback to an earlier write, a stale binding, a re-export's origin,
  or another PackageInstance.** The fix is widening, not fabricated export
  identity.
- **Nested/deferred functions are not rooted.**
  `topLevelCallableCandidates` walks `sourceFile.statements` only, so
  `function outer() { function hidden() {…} }` contributes `outer` and never
  `hidden` — export ambiguity is no evidence at all that a nested helper is
  exported.
- **Nothing is manufactured.** An ambiguous export in a file with no
  top-level callables contributes no names, leaving the module node as the
  only root and the honest UNKNOWN/NOT_AFFECTED intact.

### Family C is defended, not disabled

The `unreachable.cjs` control has its authority withdrawn, so its roots DO
widen — and none of the widened callables reaches the target, so it still
returns `NOT_AFFECTED` with `reachableSubgraphComplete: true`. Widening
costs no genuine negative proof; it removes only the ones whose
completeness was manufactured by declining to look.

### Verdict differential

- Adversarial v1/v2, all 114 cases: **one** movement, `ADV2-080`
  NOT_AFFECTED → AFFECTED. Nothing else moved.
- Validation: **identical**, 12 PASS / 5 KNOWN_FAIL / 0 UNEXPECTED / 17
  total; `RWB-07` still certified NOT_AFFECTED on a valid proof.
- `UNKNOWN → NOT_AFFECTED`: **0**. `AFFECTED → UNKNOWN`: **0**. No new
  false AFFECTED: every movement is onto a call path that exists in the
  source and executes under real `node`.

### Corpus

AST search (not text matching) for all four facts coinciding in one file —
a top-level CommonJS export of a locally-declared callable, a preceding
module-evaluation cutoff, and that callable reaching a `require()`-bound
dependency: **3,156 files scanned**, 2,044 exports of a local top-level
callable, 22 of those with a preceding cutoff, **7** also reaching a
dependency — all 7 this task's own fixtures, **0 elsewhere**. That is the
expected shape of the result rather than a reassuring one: the defect bites
APPLICATION entrypoints, and `node_modules` contains libraries, which are
almost never the configured entrypoint. Its real-world reach is in
first-party application code, which this repository's corpus does not
contain.

### Performance

Widening is scoped to configured-entrypoint modules whose export provenance
was actually withdrawn; every other file takes the identical path it did
before. Root counts on the fixtures: 1 → 2 for the canonical shape, 1 → 3
where a decoy and a sibling exist. `scan-performance`, median of three:
1,922 ms base vs 2,223 ms branch on the large-file baseline (threshold
4,500 ms).

### RWF-020 interaction

RWF-020 (class heritage `extends bail()`) is blocked on this finding: its
branch added a fifth trigger for this same root-loss, which turned an input
that was correctly AFFECTED on main into a false NOT_AFFECTED. Verified
externally by stacking RWF-020's implementation commit on top of this
branch — see the RWF-021 completion report. RWF-021 must merge first.

**Documentation correction owed by RWF-020** (recorded here because the
RWF-020 audit required it and the text lives on that branch, which this
task must not modify): RWF-020's FINDINGS entry and its
`isDefinitelyAbruptClassHeritage` doc comment describe
`class C extends (bail() || Base) {}` as a shape that "genuinely may not
call `bail` at all". That is wrong — the **left operand of `||` is always
evaluated**, so `bail()` always runs and, when it is throw-only, the class
definition always aborts and a later export write really is bypassed
(measured: `ran=true, threw=true`). It belongs with `foo(bail())` and
`(bail(), Base)` as a shape that ALWAYS evaluates the call and is a
remaining soundness gap, not with `(flag && bail())` and
`(flag ? bail() : Base)`, which genuinely may not. RWF-020 must adopt this
classification on rebase. RWF-021 does not implement nested-expression
heritage support.

**Relevant files:** `src/analysis/verdict.ts` (`entrypointSourceNodes` — now
consumes the new relation and matches by position as well as name);
`src/code-intelligence/module-model.ts`
(`entrypointRootCandidates` + `EntrypointRootCandidates` (new),
`ExportBinding.exportAttributionWithdrawn` (new),
`ambiguousWholeModuleExport` and `propertyExportProvenance` (marker only);
`topLevelCallableCandidates`, `mapExportsToFunctions`,
`selectAuthoritativeWholeModuleExport`, `isDefinitelyReachedExportAssignment`
all reused UNCHANGED); regressions in
`module-model.entrypoint-root-candidates.test.ts` (26 cases),
`verdict.entrypoint-root-widening.integration.test.ts` (12 cases),
`fixtures/commonjs-entrypoint-root-widening/`, and `ADV2-080`.
