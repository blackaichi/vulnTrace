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
| RWF-020 | any CommonJS file where the RWF-016/017/018/019 shape's throwing call is written as a class's `extends` HERITAGE expression (`class C extends bail() {}`) rather than on any class element, above a later export write — the same UMD/feature-detect family, and it fires even when the class body is completely EMPTY | RWF-016 proved the CALLEE, RWF-017 proved the call's syntactic POSITION does not change the outcome, RWF-018 carried it into a class STATIC FIELD's initializer and RWF-019 into any class element's COMPUTED KEY. All four read the call off a STATEMENT or off a class ELEMENT: `isDefinitelyAbruptCallStatement` dispatched on `ExpressionStatement`/`VariableStatement`, `isDefinitelyAbruptStaticFieldInitializer` on a `PropertyDeclaration`'s `initializer`, and `isDefinitelyAbruptComputedClassElementKey` on a `ClassElement`'s `ComputedPropertyName`. A heritage expression is on no element at all — it hangs off the class's `heritageClauses` — and ClassDefinitionEvaluation evaluates it FIRST, before any element exists, because the superclass value is what the new class's prototype chain is built from. So it is the only class-definition-time expression that still runs when the class body is EMPTY, which is exactly the shape (`class C extends bail() {}`) none of the four predecessors could see | **Soundness** — reproduced end-to-end as a false `NOT_AFFECTED` carrying a complete Family C proof (`confirmedUnreachableTarget`, `reachableSubgraphComplete: true`) over the value the module exports whenever the class's branch is taken; a real Node-executed circular-import fixture confirms a cyclic consumer retains the bypassed dangerous export and calls the vulnerable sink through it, measures that a throwing heritage leaves the class's element list entirely unevaluated while a harmless one lets every element run, and — in the same process — that a heritage call which RETURNS, an `extends null`, an `async` callee, a generator callee, a conditional-throw callee, a class defined inside an uncalled function and a class nested in an instance field genuinely do NOT abort module evaluation | **Fixed (RWF-020)** |
| RWF-021 | any CommonJS file used as a CONFIGURED ENTRYPOINT that exports a top-level callable and carries any RWF-014/015/016/017/018/019 authority-withdrawing construct above the export write — and, independently of any cutoff, any entrypoint exporting an ANONYMOUS callable | Entrypoint reachability ROOTS were read out of export ATTRIBUTION provenance (`exp.localName ?? exp.exportedName` in verdict.ts's `entrypointSourceNodes`). The two questions fail in opposite directions — attribution must REFUSE when it cannot name the exported value, root selection must WIDEN — so every soundness cutoff that correctly withdrew attribution silently deleted the entrypoint's root as well. The exported function's body was then never traversed, and an anonymous export (RWF-003's shape) had no name to be rooted by at all | **Soundness, cross-family** — reproduced end-to-end on `8d18130` as a false `NOT_AFFECTED` carrying a complete Family C proof (`confirmedUnreachableTarget`, `reachableSubgraphComplete: true`) for **all four merged cutoff families** (RWF-016/017/018/019) plus the property-export and anonymous-export forms, over an entrypoint whose exported `main` really is published and really does reach the vulnerable sink on every run where the branch is not taken (asserted under real `node`) | **Fixed (RWF-021)** |
| RWF-029 | `qs` (`RWB-05`); any package whose advisory-named export is FORWARDED from another file rather than declared in the file that exports it — the dominant shape for any CommonJS package past trivial size | TARGET-side attribution (`verdict.ts`'s `findExportNodeInFile`, at Site A) is a PER-FILE relation: it attributes an advisory's `{module, export}` against one file's own export table and nothing else. Real `qs/lib/index.js` forwards `parse` to `lib/parse.js`, which publishes the implementation as an ANONYMOUS whole-module default (canonical export name `"default"`), so the advisory-facing name and the implementation-facing name genuinely differ and **no file in `qs` exports anything called `parse`** — the target could not be attributed at any depth. Not the RWF-004a/b CONSUMER-side chase (whose fixture resolves only because some file there happens to export the advisory's literal name), and not P0-Z's entrypoint ROOT derivation (which must widen where this must refuse) | Precision/coverage only — degrades to UNKNOWN in both directions, never a false AFFECTED or NOT_AFFECTED | **Fixed (P1-A1)** — see below. `RWB-05` itself stays KNOWN_FAIL on the independent, pre-existing RWF-002 the unresolved target was masking |
| RWF-030 | any installed package with MORE THAN ONE file exporting the advisory's literal name — i.e. any package whose public entry re-publishes an internal callable under a different public name, or that has an internal module sharing a name with a public one. Measured on the real vendored corpus (RUNTIME files only; a `.d.ts` rival can never contribute a target node): **3** genuine npm instances in `tests/validation/fixtures` — `has-symbols`, `call-bind-apply-helpers`, `yallist` — where authoritative resolution selects a different file than the per-file scan would offer. Counting declaration files too gives 6, but the extra three (`call-bound`, `side-channel`, `side-channel-list`) have only an `index.d.ts` rival and are measurement artifacts, not runtime defects | TARGET attribution asked EVERY graph-discovered file of the `PackageInstance`, independently, whether it exported the advisory's name (`resolveTargetNodes`'s per-file loop over `findExportNodeInFile`). Nothing in that loop asked which file the package actually PUBLISHES, so package MEMBERSHIP became sufficient for target identity when it is only ever necessary. `pkg/other.js` exporting `vulnerable` is not evidence about what `require("pkg").vulnerable` is. Distinct from RWF-011/VT-301B, which closed the bare-NAME fallback: here the sibling genuinely does export the name, so no name-search guard applied. Distinct from RWF-029/P1-A1, which fixed the forwarding RELATION but left it as a fallback that ran only AFTER this loop had already found something — so a sibling shadowed it entirely | **Soundness, BOTH directions** — reproduced byte-identically on the P0 closure base `d36a83c` and on the P1-A1 merge base `4a969b2`. False `AFFECTED`: a dangerous, reachable sibling answers for a package whose public `vulnerable` is safe and never called (`publicsafe-lib`; evidence path ended at `node_modules/publicsafe-lib/other.js:5`, while real `node` proves `pkg.vulnerable === impl.safeImpl`). False `NOT_AFFECTED`: because a found sibling returned before P1-A1's forwarding chase could run, an UNREACHABLE sibling shadowed the genuinely-reached public implementation and the finding received a complete negative proof about a callable the advisory never named (`twinpub-lib`, both twins — real `node` confirms `pkg.vulnerable` IS called) | **Fixed (P1-A2)** — see below |
| RWF-031 | any installed package that declares BOTH `main` and `exports` where the two name different files (14 of the 49 vendored corpus instances declare both), and any advisory whose `module` names a SUBPATH (`qs/lib/parse`, `@scope/pkg/api`) rather than a package root — `schemas/symbol-rule.schema.json` has always permitted the latter | TWO defects in P1-A2's authoritative-public-entry probe set. (1) That set probed the instance's ABSOLUTE INSTALL PATH (the RWF-009 alias handle), and a path request never consults `exports` in real Node — so for `{"main":"./legacy.js","exports":{".":"./modern.js"}}` it admitted `legacy.js`, a file no importer can reach through the package name, as an authoritative public entry. That is RWF-030's own defect restored through a different door. (2) Installed instances were selected by comparing the advisory's whole module specifier against each instance's package NAME, so `"pkg/parse"` matched nothing, `instances.size` was 0, and resolution fell through to Site B — an instance-blind re-resolution that feeds a PHANTOM into the reachability search | **Soundness, BOTH directions** — reproduced on the P1-A2 merge base `eb128b6` by swapping that commit's `verdict.ts` into the branch; 4 of `fixtures/package-entry`'s 30 cases fail there. False `AFFECTED`: a superseded, reachable, dangerous `main` answered for a package whose public `vulnerable` is safe and uncalled (`expmainsafe-lib`), and an invalid `exports` target fell back to a same-named sibling (`badexports-lib`). False `NOT_AFFECTED`, RUNTIME-REACHABLE: a subpath advisory received a complete family-C negative proof about a phantom while real `node` proves the callable IS executed (`subpathfwd-lib/api`, `twin-lib/api`) | **Fixed (P1-A3)** — see below |
| RWF-022 | any CommonJS file where a class's `extends` HERITAGE call RETURNS NORMALLY but hands back a value that is not a constructor (`function notAConstructor() { return 1; }` + `class C extends notAConstructor() {}`), above a later export write — the same UMD/feature-detect family as RWF-016/017/018/019/020, and the half of the heritage family RWF-020 explicitly deferred | RWF-020 asks only whether evaluating the heritage CALL completes, and here it does: `notAConstructor()` is not abrupt under `cannotCompleteNormally`, so `isDefinitelyAbruptCall` refuses it and RWF-020's rule never fires. What ends module evaluation is the VALUE: ClassDefinitionEvaluation validates the superclass before it does anything else with the class, and `1` is neither `null` nor a constructor, so the definition throws `TypeError: Class extends value 1 is not a constructor or null`. The same applies, through a second and deliberately separate mechanism, to an `async` or generator CALLEE — whose call provably returns a `Promise` or a generator object, neither of which is a constructor — which RWF-016 must refuse for the opposite reason (calling one cannot throw synchronously) | **Soundness** — reproduced end-to-end as a false `NOT_AFFECTED` carrying a complete Family C proof (`confirmedUnreachableTarget`, `reachableSubgraphComplete: true`) over the value the module exports whenever the class's branch is taken, on all three of the classifier's routes (numeric-literal return, concise-arrow object return, `async` callee); a real Node-executed circular-import fixture ASSERTS that a cyclic consumer retains the bypassed dangerous export by identity and calls the vulnerable sink through it, that the factory returns normally with `1`, that the later safe write never runs, and that re-requiring re-throws — and, in the same process across a 31-row measured table, that returning a class, an ordinary function or `null` genuinely does NOT abort module evaluation | **Fixed (RWF-022)** |
| RWF-042 | `qs` (`RWB-05`), and any file that shadows a name or calls above its own initializer | The call graph's named-binding paths resolved a name by SPELLING — `resolveSingleAssignmentValue` is whole-file, name-only and first-match-wins — so an inner `const fn = safe` was answered with an outer `const fn = danger`'s value, and a call written above its initializer was answered with that initializer. Separately, a name bound to a NAMED function expression (`var parseValues = function parseQueryStringValues(){}`) was indexed under the expression's own name and so matched nothing | **Soundness, fabricating direction** — both shadowing and order produce a call edge to a function the program does not reach through that name (a false `AFFECTED` risk, never a false `NOT_AFFECTED` — **this parenthesis is WRONG and is corrected by RWF-043 § 1: a fabricated edge DISPLACES the honest `unknown` blocker, and can therefore produce a false `NOT_AFFECTED`**); the missed function expressions are precision only | **Fixed (P1-B3)** — see below |
| RWF-043 | `lodash` (found via the P1-B3 corpus differential); any file with two same-named functions in unrelated scopes | `findLocalFunctionNodeId` attributes a bare-name call to the FIRST same-named function anywhere in the file, at any nesting depth, with no scope check — so `lodash`'s module-scope `var freeParseInt = parseInt` (the ambient global) could be paired with its own `parseInt` declared inside `runInContext` | **Soundness, fabricating direction** — invents a call edge to a function never reached through that name; can produce a false `AFFECTED` and a misleading evidence path, ~~never a false `NOT_AFFECTED`~~. **The struck clause is WRONG**: the matcher ran BEFORE every authoritative path, so its edge REPLACED the honest `unknown` one, displacing the blocker that withholds `reachableSubgraphComplete` and yielding a false Family-C `NOT_AFFECTED`. Reproduced end-to-end in P1-B3b — see RWF-043 § 1 | **Fixed (P1-B3b)** — the named-binding paths were closed by P1-B3; the direct-call and construct paths are closed by P1-B3b, which removes the matcher entirely — see below |
| RWF-044 | `fast-xml-parser`, `lru-cache`, `semver` — any module whose function bodies reference a `const`/`let` callable declared later in the file | B3's evaluation-order rule (P1-B3 § 9) refuses a reference written textually above its initializer. That is right about STATEMENT order and wrong about EXECUTION order for a deferred body: `function f() { later(); }` above `const later = ...` only runs `later()` once something calls `f`, which cannot precede module initialization | **Precision only, never soundness** — every refusal costs an edge that is correct in fact; the failure direction is UNKNOWN. 85 call-graph edges in the corpus. These resolved on `779e219` only because the same-name matcher overrode B3's refusal | Open, deliberately not scoped into P1-B3b — precision only; needs deferred-execution modeling, not a heuristic — see below |
| RWF-045 | any file with two `const { name } = source` patterns binding the SAME name in different scopes | `findDestructuredBindingSource` is reached only once `resolveNamedBinding` has proved the reference binds to a destructuring, but it then locates WHICH pattern by a whole-file, first-match search on the bound name — the same flat-index mistake RWF-043 removed from the direct-call paths, surviving on the destructuring bridge | **Soundness, BOTH directions** — reproduced: `main` destructures `run` from `safeMod` and calls it, and the edge resolves to `danger.js#run`. Identical on the P1-B3 base `779e219`, so pre-existing rather than a P1-B3b regression. The record's original "fabricating direction" framing was INCOMPLETE and is corrected below: an end-to-end oracle now reproduces a false `NOT_AFFECTED` carrying a complete Family C proof over a call the program really makes into the vulnerable export, AND a false `AFFECTED` against a program that never calls it | **Fixed (RWF-045)** — see below |
| RWF-046 | `gopd` (found via the RWF-046 corpus differential), the repo's own `fixtures/target-side-reexport` and `fixtures/commonjs-entrypoint-root-widening`; any file that binds a require to a name bound more than once in the file, or that reassigns a require-bound name | `bindCallee` resolved a callee's module with `moduleModel.imports.find((imp) => imp.localName === calleeText)` — a FILE-WIDE, NAME-KEYED table carrying no declaration identity at all, so the first row spelled the same won every reference in the file. The same flat-index mistake RWF-042 removed from the value-binding paths and RWF-043 removed from the direct-call paths, surviving one layer down: both of those made the call graph ask which DECLARATION a name binds to, and the answer was then discarded and the module question re-asked by spelling | **Soundness, BOTH directions** — reproduced on the base `b9bb81b`. False `AFFECTED`: a file-scope `require("vulnerable-mod")` answers for an inner `const source = require("safe-mod"); source.run()`. False `NOT_AFFECTED`: reversing the two resolves the inner vulnerable call onto the outer safe module, and by RWF-043 § 1's corrected reasoning a fabricated edge also DISPLACES the honest `unknown` blocker. Reproduced in the repo's OWN corpus: 7 edges in `fixtures/target-side-reexport/verify.cjs` all collapsed onto `direct-lib#vulnerable`, and a resolved edge was FABRICATED at `verify.cjs:306` out of a dynamic template specifier by borrowing a `main` require six lines away in a different block. Real npm code reproduces the reassignment shape: `gopd/index.js`'s `var $gOPD = require('./gOPD'); ... $gOPD = null;` kept its pre-reassignment provenance | **Fixed (RWF-046)**; the first implementation of this fix introduced a separate fabrication of its own, recorded and closed as RWF-046a — see below |
| RWF-046a | any file binding a require with an ARRAY pattern, a rest element, or (on the base commit too) a defaulted element — zero occurrences in the current corpus, which is why nothing caught it | RWF-046's first implementation accepted any `BindingElement` under a require-initialized `VariableDeclaration` and let `symbol-binder.ts` take `element.propertyName ?? element.name` as the exported name. Sound for an object shorthand, where the property and local names are the same token; unsound otherwise. An ARRAY element has no property name, so the LOCAL IDENTIFIER'S TEXT became the export name — the `identifier text → module source` substitution RWF-046 exists to remove, reintroduced inside the function that replaced the old table | **Soundness, fabricating direction. INTRODUCED, not pre-existing** — found by independent audit of branch head `e29a713` before it merged. `const [, run] = require("pkg"); run()` binds array index 1 and resolved to `pkg#run`; the base `b9bb81b` returns UNKNOWN. A false-AFFECTED vector whose fabricated key is whatever the local is spelled. The defaulted form (`const { run = fallback } = require("pkg")`) resolved on the BASE too, and is closed here as well. A scoped re-audit then measured FIVE further pre-existing base defects sharing the same root cause — see RWF-046b | **Fixed (RWF-046a)** — see below |
| RWF-046b | any file destructuring a require with a COMPUTED, NUMERIC or STRING-LITERAL property key, or with a default, or reassigning a destructured require binding. Zero occurrences in the current corpus | `source-index.ts`'s `extractRequireBindings` derives the imported name as `ts.isIdentifier(propertyName) ? propertyName.text : element.name.text` — so any key that is not an `Identifier` falls through to the binding's LOCAL name and publishes it as the export name. Separately it never checked `element.initializer`, so a defaulted element resolved to one target despite two possible runtime values. The same local-text-as-export-name class as RWF-046a, reached by a different route, and the FOURTH site of that class after RWF-043, RWF-045 and RWF-046 | **Soundness, fabricating direction. PRE-EXISTING on `main`** — measured on `b9bb81b` by the scoped re-audit of RWF-046a, not by the corpus differential. `const { [k]: run }`, `const { ["run"]: run }` and `const { 0: run }` all resolve to `pkg#run` by local text; `const { "run": execute }` resolves to `pkg#execute`, a DIFFERENT REAL EXPORT of the same package, which nothing downstream could detect as wrong; `let { run } = require("pkg"); run = null` keeps stale provenance | **Fixed (RWF-046a)** — closed by the same shape boundary; recorded separately because it was on `main` and RWF-046a's introduced array case was not |
| RWF-047 | any file that writes a member of a require-bound module object and then calls it — `const mod = require("pkg"); mod.run = patched; mod.run()` | `isMemberAssignedWithin` invalidates a member read on an OBJECT LITERAL binding, but no equivalent check governs a require-bound module object, so the attribution survives a write to the member it names | **OPEN QUESTION, deliberately not yet classified** — identical on `b9bb81b` and on this branch, so neither introduced nor expanded by RWF-046/046a. A missing invalidation yields a WRONG attribution rather than an absent one, so this may be a fabricated-edge class rather than a precision gap; that is the thing to decide, and it is not decided here | Open — unclassified pending the reproduction below |

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
  over expression trees rather than a shape test - **since fixed by
  RWF-026**, which built exactly that model over REQUIRED operand
  positions only;
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
- *(soundness, separate P0 follow-up — **since fixed by RWF-024**)* an
  OBJECT LITERAL's computed key, `const o = { [bail()]: 1 };`, likewise
  throws under real `node` and kept authority on `main` at the time of this
  entry. It was deliberately excluded here — the predicate requires the
  element's parent to be a class, which is what tells a class's
  `MethodDeclaration` apart from an object literal's identically-kinded one
  — because an object literal is evaluated by a different ECMAScript
  abstract operation than ClassDefinitionEvaluation, and closing it needed
  its own, separately-scoped predicate rather than a widening of this one;
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

## RWF-020 — A throwing local call in a class's `extends` HERITAGE expression invalidates later CommonJS export authority

**Severity:** P0 / CRITICAL SOUNDNESS — a false `NOT_AFFECTED`.

**Family:** the same one RWF-015, RWF-016, RWF-017, RWF-018 and RWF-019
belong to, and named in advance by RWF-019 as a separate open P0 rather than
folded into it: RWF-016 proved the CALLEE, RWF-017 proved that the call's
syntactic POSITION does not change the outcome, RWF-018 carried it into a
class STATIC FIELD's initializer and RWF-019 into any class element's
COMPUTED KEY. All four read the call off a STATEMENT or off a class ELEMENT.
A heritage expression is on neither.

**Discovered:** the final independent RWF-019 audit, which reproduced
`class C extends bail() {}` as behaving identically on `main` and on the
RWF-019 branch — both kept the later export attributable — and recorded it
as a separate family rather than a gap in RWF-019's rule. RWF-019 pinned it
as an explicit test case asserting the (then-correct) `main` behaviour, and
that case's assertion is flipped by this task. Reproduced independently on
`origin/main` at `8d18130` (the then-current merged main, with RWF-019
fully in place) before any change on this branch, and re-verified after
rebasing onto the RWF-021 main described below.

### The defect

```js
function dangerousOp() { /* reaches the vulnerable sink */ }
function safeOp() {}
function bail() { throw new Error("boom"); }

if (FLAG) {
  module.exports = dangerousOp;
  class C extends bail() {}   // <- EMPTY body: no element to read a call off
}

module.exports = safeOp;      // syntactically unconditional; NOT always run
```

JavaScript evaluates the heritage expression `bail()` while evaluating the
class definition. When `FLAG` is true: `dangerousOp` is exported, the class
definition begins, `bail()` runs, `bail()` throws, the class definition
aborts, `C` is never bound, and `module.exports = safeOp` is never reached.

Pre-fix, VulnTrace still bound `safeOp` as the module's whole exported value,
gave the consumer's call a fully RESOLVED edge to it, left `dangerousOp` with
no incoming edge at all, and returned the reachability search over the
vulnerable sink as unreachable **with a complete subgraph** — a Family C
proof, and a false `NOT_AFFECTED`, for a package that reaches the sink on
every load that takes the early branch. Measured on `8d18130` against
`fixtures/commonjs-class-heritage-throwing-call-export-authority/`:

```json
{"target":{"module":"fixture-lib/danger","export":"explode"},
 "entrypointRoots":["…/src/index.cjs"],
 "reachableSubgraphComplete":true}
```

### Why the heritage expression executes during class definition

ClassDefinitionEvaluation evaluates the `extends` expression **before it does
anything else with the class**: the superclass value has to be in hand before
the new class's prototype chain can be built, before any element can be
installed on it, and therefore strictly before every computed key (RWF-019),
every static field initializer (RWF-018) and every static block (RWF-015).
Class evaluation is itself part of module evaluation, so a throw out of the
heritage expression propagates out of the class definition and out of the
`require()` that started the load.

That ordering is measured rather than asserted, in one real `node` v26
process in
`fixtures/commonjs-circular-import-class-heritage-throw-ground-truth/`:

```text
class definition threw: throwingBase() always throws
evaluated, in order: ["heritage"]
-> heritage ran first and NOTHING else ran: true
with a harmless heritage: ["computed key","static field"] on D
```

The same fixture proves the whole runtime claim end to end: the dangerous
export is published first, a cyclic `require()` retains that exact value,
the heritage throws, the later safe export never executes, the retained
dangerous export invokes the vulnerable sink
(`EXPLODED:payload-from-entrypoint`), and re-requiring the module re-throws
deterministically — `safeOp` is never this module's exported value on this
code path, on any load.

### Why this is a THIRD class rule rather than a widening of RWF-018/019

RWF-018's predicate is handed a `PropertyDeclaration` and reads its
`initializer`; RWF-019's is handed a `ClassElement` and reads its
`ComputedPropertyName`. An empty-bodied `class C extends bail() {}` has
neither — there is no element of any kind, no `static` token, and no computed
key. The heritage clause is the only class-definition-time expression that
still runs when the class body is completely empty, which is precisely why
neither predecessor could see it, and why folding a partial version of it
behind either name would have been the wrong shape.

### The fix

A new predicate, `isDefinitelyAbruptClassHeritage`, asked alongside the
existing three in `mayEndModuleEvaluation`:

```ts
function isDefinitelyAbruptClassHeritage(node: ts.Node): boolean {
  return (
    ts.isHeritageClause(node) &&
    node.token === ts.SyntaxKind.ExtendsKeyword &&
    node.parent !== undefined &&
    ts.isClassLike(node.parent) &&
    node.types.some((type) => isDefinitelyAbruptCall(type.expression))
  );
}
```

Everything about the CALL is RWF-016/017's, reused verbatim through
`isDefinitelyAbruptCall`: the exact non-reassigned local callee
(`resolveExactLocalCallable`), the always-throws body proof
(`cannotCompleteNormally`), the `async`/generator exclusions, and the
parentheses normalization that makes `extends (bail())` work. Caught-throw
handling is the existing `isCaughtWithin` at the call site, unchanged. The
`mayContainClassDefinitionTimeEvaluation` gate needed no widening — a
heritage clause cannot be written without the `class` keyword, which that
test already keys on.

### What is deliberately NOT inferred: the heritage VALUE

RWF-020 asks only whether evaluating the heritage CALL completes. Whether
the resulting value is a valid superclass is a separate semantic question
this model does not answer, and three real cases turn on it — all three
measured in the same ground-truth fixture, all three throwing a `TypeError`
for a reason RWF-020 does not and must not claim:

| Form | Measured outcome |
| --- | --- |
| `class C extends asyncBail() {}` | `TypeError: Class extends value #<Promise> is not a constructor or null` |
| `class C extends generatorBail() {}` | `TypeError: Class extends value [object Generator] is not a constructor or null` |
| `class C extends notAConstructor() {}` | `TypeError: Class extends value 1 is not a constructor or null` |

In each, the CALL itself completes normally — an `async` function's `throw`
becomes a rejected promise, a generator's body does not run on call at all,
and `notAConstructor()` simply returns `1`. Each genuinely bypasses a later
export at runtime, so each was a real false `NOT_AFFECTED`; but proving it
needs reasoning about the returned VALUE, which RWF-020 declined to
introduce. Recorded as a **separate open finding** rather than smuggled into
RWF-020.

**Closed by RWF-022** (below), which answers all three — through a separate,
disjoint predicate (`isDefinitelyInvalidClassHeritageValue`), never by
widening `isDefinitelyAbruptCall`. RWF-020's own mechanism still refuses all
three, and a regression block in
`module-model.class-heritage-throwing-call-export-authority.test.ts` asserts
that it does, in a non-heritage call position where the two can be told
apart.

### Newly confirmed separate P0s (NOT fixed here)

- **Invalid heritage RESULT.** `class C extends notAConstructor() {}` where
  the callee returns a non-constructor. Runtime: `TypeError`, later export
  bypassed. Base: `second` attributed. Branch: unchanged, `second`
  attributed. A real false `NOT_AFFECTED`, outside RWF-020's call-completion
  scope by design.
- **Nested heritage expressions that ALWAYS evaluate the call.**
  `class C extends foo(bail()) {}`, `class C extends (bail(), Base) {}` and
  `class C extends (bail() || Base) {}` all necessarily invoke `bail` under
  ordinary evaluation order — an argument is evaluated before the call, a
  comma sequence evaluates its left operand, and so does `||`, whose
  short-circuit decides only whether the RIGHT operand runs. All three are
  refused on shape and are therefore remaining soundness gaps. Same
  arbitrary-expression boundary RWF-017 recorded; unchanged in either
  direction. (`(FLAG && bail())` and `(FLAG ? bail() : Base)` are correctly
  kept — those genuinely may not call `bail` at all, and were measured as
  `ran=false`.)
- **Throwing IIFE heritage** — `class C extends (() => { throw e })() {}` —
  unchanged, and the same limitation RWF-015 documented for IIFEs generally.
- **`new`-expression heritage** — `class C extends new Bail() {}` — a
  `NewExpression`, not a `CallExpression`; constructor semantics are not
  modeled. Unchanged from RWF-017/018/019.
- **Object-literal computed key** — `const x = { [bail()]: 1 };` — the
  pre-existing P0 RWF-019 excluded by design. Regression-pinned here,
  unchanged.

### RWF-021 interaction — why this branch was blocked, and what changed

RWF-020's own independent audit BLOCKED it, and the reason was not this
rule. A configured-entrypoint attack —

```js
// src/index.cjs -- the configured entrypoint
const dep = require("vuln-lib");
function main(u) { return dep.dangerousOp(u); }   // the only path to the sink
function bail() { throw new Error("boom"); }
if (flag) { class C extends bail() {} }
module.exports = main;
```

— answered **AFFECTED** on that branch's base and **NOT_AFFECTED with a
complete Family C proof** on the branch itself. The mechanism was entirely
downstream of this predicate: withdrawing export attribution also deleted
the entrypoint's reachability ROOT, so `main`'s body stopped being
traversed. That defect was already live on main for RWF-016/017/018/019's
cutoffs; this rule merely added a fifth trigger for it.

It was fixed separately, as **RWF-021**, which now sits in this branch's
base. Root selection is derived independently of export attribution and
bounded by what the file's own export writes can publish, so withdrawal
widens the root set instead of emptying it. Re-verified after the rebase:
the attack above answers **AFFECTED**, with no Family C, while this rule's
own canonical defect still moves to UNKNOWN. RWF-020 neither reintroduces
the root loss nor perturbs RWF-021's monotonicity or publishability
invariants.

### Verdict movement

The primary fixture moves `NOT_AFFECTED` → `UNKNOWN`. Every export surface
moves the same way and for the same reason — whole-module, property,
object-literal, class target and `require()` re-export all share the one
`firstModuleEvaluationCutoff` relation:

| Shape | Base | Branch |
| --- | --- | --- |
| `module.exports = safe` after abrupt heritage | `second` | refused |
| `exports.foo = safe` after abrupt heritage | `second` | refused |
| `module.exports = { foo: safe }` after abrupt heritage | `second` | refused |
| `module.exports = SafeClass` after abrupt heritage | `SafeClass` | refused |
| `module.exports = require("safe-twin")` after abrupt heritage | `safe-twin` | refused |
| `try { class C extends bail() {} } finally {}` | `second` | refused |
| ADV2-081 (end to end) | `NOT_AFFECTED` | `UNKNOWN` |

`UNKNOWN → NOT_AFFECTED` movements: **0**. No new `AFFECTED`. Validation
baseline unchanged at 12 PASS / 5 KNOWN_FAIL / 0 UNEXPECTED / 17 total, with
`RWB-07` still certified `NOT_AFFECTED` on a valid proof.

### Corpus scan

AST search over every vendored `.js`/`.cjs`/`.mjs` under `fixtures/`,
`tests/` and `node_modules/`: **3,229 files scanned**, 1,988 classes, 1,287
with an `extends` heritage clause, 28 with a heritage expression that is a
direct `CallExpression` with an identifier callee, 28 of those resolving to
an exact non-reassigned local callable, and **10 whose callee body is
throw-only**. Every one of the 10 is a fixture authored by this task or its
ground truth; **zero** matches in real vendored third-party code. The change
is inert on the existing corpus and fires only on the shapes it was written
for.

### Remaining limitations

- *(precision, the one shape this branch makes MORE conservative)* a nested
  class carrying an abrupt HERITAGE, written inside an INSTANCE field's
  initializer — `class Outer { field = class Inner extends bail() {}; }` —
  now reports a cutoff where `main` did not. At runtime the outer instance
  field never evaluates at class-definition time (measured: it `COMPLETED`),
  so this is an over-approximation. It is accepted deliberately and is **not
  new behaviour in kind**: `main` already answers both the computed-KEY and
  the static-FIELD spellings of this exact shape the same way (confirmed by
  direct differential probe — both report a cutoff on `8d18130` today). The
  movement is strictly toward UNKNOWN, never toward a negative proof;
- *(unchanged from `main`)* a transitive `a() -> b() -> throw` chain is still
  not recognised (direct local body proof only); a conditional-throw callee
  is still correctly kept; a returning callee is still kept; an `async` or
  generator CALLEE is still correctly excluded; a throwing shadow declared in
  the call's OWN block still fails closed through `resolveExactLocalCallable`,
  while a harmless own-block shadow is correctly resolved to; an ALIASED
  callee (`extends alias()`) and a MEMBER callee (`extends obj.bail()`) are
  still both refused as one-hop boundaries; a REASSIGNED callee is still
  correctly kept; and a class-name shadow (`class bail extends bail()`) is
  refused rather than reasoned about, since its class-binding/TDZ semantics
  are their own question. RWF-020 reuses `resolveExactLocalCallable` verbatim
  and changes none of them;
- *(scope)* a TypeScript `implements` clause and an INTERFACE's `extends`
  clause evaluate nothing and are excluded by the `ExtendsKeyword` token test
  and the `ts.isClassLike` parent test respectively; both are regression-pinned.

**Relevant files:** `src/code-intelligence/module-model.ts`
(`isDefinitelyAbruptClassHeritage` (new), `mayEndModuleEvaluation` (one
predicate added to the existing disjunction),
`mayContainClassDefinitionTimeEvaluation` (doc only),
`isDefinitelyAbruptComputedClassElementKey` (untouched);
`isDefinitelyAbruptCall`, `declarationListCannotCompleteNormally`,
`isDefinitelyAbruptCallStatement`, `isDefinitelyAbruptStaticFieldInitializer`,
`resolveExactLocalCallable`, `cannotCompleteNormally`, `isCaughtWithin`,
`firstModuleEvaluationCutoff`, `reassignedModuleReachableNames`,
`mayContainClassStaticEvaluation`, `topLevelCallableCandidates`,
`isAsyncOrGeneratorCallable` all reused UNCHANGED); regressions in
`module-model.class-heritage-throwing-call-export-authority.test.ts` (51
cases),
`verdict.class-heritage-throwing-call-export-authority.integration.test.ts`,
`fixtures/commonjs-class-heritage-throwing-call-export-authority/`,
`fixtures/commonjs-circular-import-class-heritage-throw-ground-truth/`, and
`ADV2-081`. The heritage case RWF-019 pinned as a separate open P0 in
`module-model.computed-class-key-throwing-call-export-authority.test.ts` has
its assertion flipped, since it is now correctly refused.

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
  callable this file's own **export writes** could publish
  (`collectExportWriteCandidates` over the already-collected
  `module.exports` writes and property right-hand sides — see "The
  narrowing" below for why this bound, and not every top-level callable);
- an anonymous exported callable contributes its **position**, matched
  against the graph node's own location.

Withdrawal is marked explicitly (`ExportBinding.exportAttributionWithdrawn`)
rather than inferred from a missing `localName`, because those are not the
same fact: `module.exports = 42` also has no `localName`, genuinely exports
no callable, and must NOT widen. Both `ambiguousWholeModuleExport`
(whole-module) and `propertyExportProvenance` (`exports.foo = …`) set it.

**Monotonicity is the property, and it is asserted directly**
(`module-model.entrypoint-root-candidates.test.ts`): for each of the four
cutoff families, the ambiguous root set is a superset of the precise one,
and it is never empty when the precise one was not.

### The narrowing — why monotonicity alone was not enough

RWF-021's first cut widened to every TOP-LEVEL CALLABLE in the file
(`topLevelCallableCandidates`). That satisfies monotonicity and is still
too broad: it roots callables that no export write mentions, which no run
of the module can hand an importer. Its independent audit reproduced three
**branch-introduced false AFFECTED** findings on that basis, each verified
against real `node`:

| Shape | What is actually published | First cut | Now |
| --- | --- | --- | --- |
| `neverExported` reaches the sink, is the RHS of nothing | `main` (safe) | **AFFECTED** | NOT_AFFECTED |
| `dangerous` is a sibling; only `module.exports = safe` exists | `safe` | **AFFECTED** | NOT_AFFECTED |
| `main = safe` before `module.exports = main` | `safe` | **AFFECTED** | NOT_AFFECTED |

So RWF-021 carries **two** invariants, not one:

1. **Monotonicity** — losing export precision may only ADD roots. Violating
   it deletes the entrypoint's root and yields a false NOT_AFFECTED.
2. **Publishability** — a widened root must be a value some real export
   write in this file could hand an importer. Violating it roots dead code
   and yields a false AFFECTED.

The eligible set is therefore the values of the file's own
`module.exports = X` / `exports.Y = X` writes, resolved by
`collectExportWriteCandidates`: a directly written function contributes its
POSITION, an identifier contributes its NAME unless `resolveLocalValue`
REFUSES it (RWF-013/013b's reassignment proof, which is what stops the
stale declaration in row 3 from being rooted), an object literal
contributes its property values recursively, and a `require(...)` re-export
contributes nothing at all. A nested helper is excluded by the same rule
rather than a separate one: nothing assigns it to an export.

The distinction is sharp and is pinned by a matched pair of fixtures —
`sibling-only-safe.cjs` (a sibling callable, NOT rooted) versus
`both-writes.cjs` (the same callable as a real export write's value, rooted
legitimately).

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
- **Nested/deferred functions are not rooted.** Nothing assigns
  `hidden` in `function outer() { function hidden() {…} }` to an export, so
  it is not a publishable value — export ambiguity is no evidence at all
  that a nested helper is exported. It falls out of the publishability
  bound rather than needing a rule of its own.
- **Stale bindings are not rooted.** A reassigned identifier is REFUSED by
  `resolveLocalValue`, so `main = safe; module.exports = main` contributes
  no candidate for the original `main` — the same refusal attribution
  already honours (RWF-013/013b).
- **Nothing is manufactured.** An ambiguous export whose writes publish no
  callable contributes no names, leaving the module node as the only root
  and the honest UNKNOWN/NOT_AFFECTED intact.

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
- `UNKNOWN → NOT_AFFECTED`: **0**. `AFFECTED → UNKNOWN`: **0**.
- No new false AFFECTED. That claim is load-bearing and was **not** true of
  RWF-021's first cut — see "The narrowing" below, which records the three
  false AFFECTED findings its audit reproduced and the constraint added to
  remove them. Every remaining AFFECTED movement is onto a call path that
  exists in the source AND is publishable by one of the file's own export
  writes, verified under real `node`.

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
(`entrypointRootCandidates` + `EntrypointRootCandidates` +
`collectExportWriteCandidates` (new),
`ExportBinding.exportAttributionWithdrawn` (new),
`ambiguousWholeModuleExport` and `propertyExportProvenance` (marker only);
`collectModuleExportsAssignments`, `commonJsPropertyExportRhs`,
`resolveLocalValue`, `directValueFunctionLocation`, `unwrapValue`,
`mapExportsToFunctions`, `selectAuthoritativeWholeModuleExport`,
`isDefinitelyReachedExportAssignment` all reused UNCHANGED); regressions in
`module-model.entrypoint-root-candidates.test.ts` (29 cases),
`verdict.entrypoint-root-widening.integration.test.ts` (16 cases),
`fixtures/commonjs-entrypoint-root-widening/` (including the three
false-AFFECTED controls and the `both-writes.cjs` counterpart), and
`ADV2-080`.

---

## RWF-022 — A class heritage call that RETURNS an invalid superclass invalidates later CommonJS export authority

**Severity:** P0 / CRITICAL SOUNDNESS (false `NOT_AFFECTED`)
**Status:** Fixed (RWF-022)
**Base:** `9a1370d` (current main, RWF-020 and RWF-021 merged)

### The defect

RWF-020 taught the model that a class's `extends` HERITAGE expression runs at
class-definition time, and withdrew a later export write's authority when
evaluating that expression could only ever THROW. It deliberately stopped
there, and said so in its own doc comment and in this file: whether the
resulting VALUE is a usable superclass is a different semantic question, and
RWF-020 recorded three real cases turning on it as an open finding rather
than guessing at them.

This is that finding.

```js
function dangerousOp(input) { return danger.explode(input); }
function safeOp(input) { return "safe:" + input; }

function notAConstructor() { return 1; }   // returns NORMALLY, every time

if (FLAG) {
  module.exports = dangerousOp;
  class C extends notAConstructor() {}
}

module.exports = safeOp;   // syntactically unconditional; NOT always run
```

`notAConstructor()` is not abrupt. `cannotCompleteNormally` refuses it —
correctly, its body is a single `return` — so `isDefinitelyAbruptCall` says
no and RWF-020's rule never fires. But ClassDefinitionEvaluation validates
the superclass before it does anything else with the class, and `1` is
neither `null` nor a constructor, so the definition throws
`TypeError: Class extends value 1 is not a constructor or null`. `C` is never
bound and `module.exports = safeOp` never runs.

Before this fix the analyzer kept `safeOp` authoritative, the entrypoint's
call got a fully RESOLVED edge to it, `dangerousOp` was left with no incoming
edge at all, and the reachability search came back unreachable with a
COMPLETE subgraph — a Family C proof, and a false `NOT_AFFECTED`, for a
package that reaches the sink on every load taking the early branch.

Measured on `9a1370d` against
`fixtures/commonjs-invalid-class-heritage-value-export-authority/`:

| target | base `9a1370d` | RWF-022 |
| --- | --- | --- |
| `fixture-lib/danger#explode` | **NOT_AFFECTED**, Family C complete | UNKNOWN |
| `fixture-lib/class-expression` (concise arrow → object) | **NOT_AFFECTED**, Family C complete | UNKNOWN |
| `fixture-lib/async-callee` (`async` callee → Promise) | **NOT_AFFECTED**, Family C complete | UNKNOWN |
| `ADV2-082` | **NOT_AFFECTED** | UNKNOWN |

### Why this is a second mechanism, not a widening of RWF-020

The two are disjoint by construction and must stay that way. RWF-020 needs a
callee body that always THROWS; RWF-022 needs one that always RETURNS. No
function is both, so neither rule can ever compete for the other's cases.

The point is sharpest on `async` and generator callees, where the SAME
syntactic fact is read for OPPOSITE purposes:

```js
async function bail() { throw x; }
class C extends bail() {}   // the CALL returns a Promise -> TypeError
function* bail() { throw x; }
class C extends bail() {}   // the CALL returns a generator object -> TypeError
```

RWF-016's `isAsyncOrGeneratorCallable` exists to make `cannotCompleteNormally`
REFUSE both: an `async` function's `throw` becomes a rejected promise, and a
generator's body does not run on call, so neither call is abrupt. RWF-022
reads the same fact as a positive: the call provably returns a `Promise` or a
generator object, and neither is a constructor — decidable from syntax alone,
with no body analysis at all.

So the exclusion had to stop being part of callee IDENTITY.
`resolveExactLocalCallable` was split: `resolveExactLocalCallableIdentity`
holds the three identity proofs (no lexical shadow, never reassigned, a
supported top-level callable shape) and `resolveExactLocalCallable` keeps the
`async`/generator filter in the wrapper. Every RWF-016/017/018/019/020 answer
is bit-for-bit unchanged, and a regression block in
`module-model.class-heritage-throwing-call-export-authority.test.ts` asserts
it where the two can actually be told apart — a NON-heritage call position,
which RWF-022's classifier never sees.

### The classification domain

`HeritageValueClass` mirrors the language's own three-way check rather than
trying to describe the value in general:

```text
"valid-null"        -- `extends null` is LEGAL. Its own state, on purpose:
                       folding it in with "not a constructor" is the single
                       most dangerous mistake available here
"constructable"     -- has [[Construct]]; the class definition completes
"non-constructable" -- neither null nor a constructor; TypeError
"unknown"           -- declines to say. The conservative default
```

Only `"non-constructable"` is actionable, and only as an input to
`isDefinitelyAbruptClassHeritage`. Nothing downstream reads a VERDICT off it:
it answers "does the class definition complete?", never "is the package
affected?".

`classifyHeritageValueExpression` is a flat table over node KINDS. It
performs no name resolution, reads no binding, and evaluates no
subexpression, which is what keeps it from being the general value
interpreter this task was scoped not to build.

| classified `non-constructable` | classified VALID | left `unknown` |
| --- | --- | --- |
| `1` `0` `1n` `"x"` `` `x` `` `` `a${1}b` `` `true` `false` | `null` (→ `valid-null`) | `Base` (an identifier) |
| `{}` `{ a: 1 }` `[]` | `class B {}` | `obj.Base` |
| `() => {}` `async () => {}` | `function B() {}` | `f()` `new Base()` |
| `async function B() {}` `function* B() {}` `async function* B() {}` | | `-1` `void 0` `FLAG ? 1 : Base` |

Every row was executed under real `node` v26.7.0 in
`fixtures/commonjs-circular-import-invalid-class-heritage-ground-truth/forms.js`,
whose 31-row table asserts `completed` or `threw:TypeError` per row.

Two decisions in that table are worth stating, because both look like they
might go the other way:

- **`{ __proto__: Function.prototype }` is still non-constructable.**
  `__proto__` in an object literal sets the object's PROTOTYPE, and
  `[[Construct]]` is an internal method, not an inherited property. Measured.
  `{ constructor: function () {} }` likewise: a `constructor` PROPERTY has
  nothing to do with constructability.
- **The identifier `undefined` is deliberately NOT a row.** It is an ordinary
  global reference and can be shadowed by a parameter, a `catch` binding or a
  local declaration, and this classifier resolves no bindings. The undefined
  VALUE is still reachable, but only through shapes that need no name at all
  — an empty body and a bare `return;`.

An object or array literal can contain arbitrary subexpressions
(`{ a: foo() }`), which might throw while the literal is built. If they do,
the enclosing CALL completes abruptly, so the class definition does not
complete either — the same conclusion. Both readings agree, so the classifier
does not have to know which holds. This is the argument
`declarationListCannotCompleteNormally` already makes for its left-to-right
declarator scan, reused; it is also what admits a `TemplateExpression`.

### The static return summary

`classifyExactCallReturnValue` decides by callee IDENTITY first
(`async`/generator, no body analysis), and otherwise matches a narrow pattern
exactly or declines:

```text
function f() { return 1; }   -- one statement, a `return` with a value
function f() { return; }     -- one statement, a bare `return` -> undefined
function f() {}              -- EMPTY body -> undefined
const f = () => 1;           -- concise arrow body IS the returned value

function f(flag) { if (flag) return 1; return Base; }   -- unknown
function f(flag) { if (flag) return 1; return 2; }      -- unknown
function f() { "use strict"; return 1; }                -- unknown
function f() { doSomething(); }                         -- unknown
function f() { try { return 1; } finally {} }           -- unknown
```

The refusals are the mechanism, not a limitation of it. Any body with a
conditional, a loop, a `try`, or any second statement is `"unknown"`, full
stop — so no function with more than one reachable ending is ever classified,
and the multiple-returns family stays off this rule entirely.

Callee identity is RWF-016's, shared verbatim: an own-block shadow resolves
to the inner binding, and `notAConstructor = () => Base;` anywhere in the
modeled reach refuses via RWF-013/013b's reassignment proof. A `let`-bound
factory is not a candidate shape at all (only `const`), and aliases
(`const alias = f; class C extends alias() {}`) and member callees
(`obj.make()`) are not resolved — deliberately, and unchanged.

### Direct (non-call) heritage values

The same classifier applies to a heritage expression written directly, since
it is the same question with the call removed:

```js
class C extends 1 {}            // withdraws
class C extends (() => {}) {}   // withdraws
class C extends null {}         // KEEPS -- legal
class C extends Base {}         // KEEPS -- unknown
```

This is not a scope expansion: it is one semantic boundary — *is the heritage
value definitely not a constructor* — applied wherever the heritage value is
statically written.

### A measured asymmetry with RWF-020, recorded rather than smoothed over

The two families do NOT behave identically inside the class, and the
ground-truth fixture asserts the difference:

| heritage failure | computed KEY | static field init | static block | class bound |
| --- | --- | --- | --- | --- |
| RWF-020 — the call throws | not evaluated | not evaluated | not evaluated | no |
| RWF-022 — the value is invalid | **evaluated** | not evaluated | not evaluated | no |

When the call itself throws, the exception escapes from inside the heritage
expression and nothing else in the class is reached. When the call returns,
evaluation proceeds far enough for V8 to evaluate the class body's computed
property KEYS before performing the `IsConstructor` check — so a computed key
runs, then the `TypeError` is thrown.

RWF-020's own README says a throwing heritage "leaves the element list
entirely unevaluated". That is correct FOR RWF-020 and does not carry over.

**This does not weaken the cutoff.** It rests on exactly one fact — the class
definition does not complete, so no later top-level statement runs — and that
holds identically in both rows. The computed-key difference is about what
happens INSIDE the class statement, which the cutoff never claimed anything
about, and it can only ever cause the model to refuse MORE.

### RWF-021 interaction

A new cutoff family is exactly the shape that could reintroduce the
entrypoint-root loss RWF-021 fixed, so `rwf022.cjs` was added to
`fixtures/commonjs-entrypoint-root-widening/` alongside RWF-016/017/018/019's:
a configured entrypoint whose `main` is the only path to the sink, with
`class Mode extends notAConstructor() {}` above the export write. Authority is
withdrawn, roots widen instead of emptying, the real path is found, and the
answer is **AFFECTED** with no Family C proof. Never NOT_AFFECTED.

### Corpus

AST search over vendored real-world JS/CJS/MJS (the repository's own
`node_modules`, 2,527 `.js`/`.cjs`/`.mjs` files, 596 containing `class`):

| | count |
| --- | --- |
| class `extends` heritage clauses | 1,269 |
| ...whose expression is a direct `CallExpression` | 3 |
| ...with a plain identifier callee | 3 |
| ...resolving to an exact module-top-level local callable | 3 |
| ...classified `non-constructable` (would cut off) | **0** |
| ...classified VALID | 3 |
| direct non-call heritage values classified `non-constructable` | 0 |
| **verdict deltas** | **0** |

All three resolved cases are the same real shape, and it is the one this
design most needed to find in the wild: `argparse`'s `_AttributeHolder(...)`
**mixin factory**, whose single unconditional return is a class expression.
RWF-022 classifies it `constructable` and keeps the export — which is the
correct answer, and the reason `classifyHeritageValueExpression` treats a
returned `ClassExpression` as a first-class VALID row rather than falling
through to `unknown`.

A separate scan of this repository's own fixtures (743 files) finds 12
`non-constructable` heritage calls, all of them deliberate RWF-022 task
fixtures. Task fixtures and real vendored files were counted separately on
purpose.

### Remaining limitations (deliberately not fixed here)

Each of these is a real shape that ends module evaluation and is NOT modeled,
so each is a residual soundness gap in the same family. None is a regression;
all are recorded so a future fix is a deliberate decision:

- **Multi-path abruptness.** `function f(flag) { if (flag) throw e; return 1; }`
  — the class definition cannot complete EITHER way (a throw, or a `TypeError`
  on `1`), so this is definitely abrupt at class level. Proving it needs
  reasoning that spans both mechanisms; refused today.
- **Bound functions and Proxies.** `return Base.bind(null)` throws
  `TypeError: Class extends value does not have valid prototype property
  undefined`, and `new Proxy({}, {})` is not constructable either. Both are
  measured in `forms.js` and explicitly left unmodeled; general
  constructability of exotic callables is its own boundary.
- **Aliases and member callees.** `const alias = f; class C extends alias() {}`
  and `class C extends obj.make() {}` — the standing alias/member boundary
  RWF-016 drew.
- **Nested heritage expressions.** `class C extends (f(), Base) {}` and
  `class C extends (f() || Base) {}` DO always evaluate `f`, and remain at
  RWF-017's arbitrary-expression boundary along with `foo(bail())`. Inherited
  from RWF-020, unchanged.
- **`return undefined;`** — the identifier form, refused because `undefined`
  is shadowable and this classifier resolves no bindings.
- **Instance-field-nested classes are over-approximated.**
  `class Outer { field = class Inner extends notAConstructor() {}; }` defers to
  construction at runtime, but `mayEndModuleEvaluation` descends into class
  element initializers and cuts off, so authority is withdrawn even though the
  later export really is reached.

  The over-approximation is inherited from **RWF-019/020's nested-CLASS
  walk** — `main` already answers the computed-key and throwing-heritage
  spellings of this exact shape the same way today (confirmed by direct
  differential probe on `9a1370d`). It is **not** inherited from RWF-018's
  instance-field rule, and the distinction matters: a bare
  `class Outer { f = bail(); }` is deliberately **KEPT** on both `main` and
  this branch, because an instance-field VALUE is not module-time execution.
  RWF-022 reaches the pre-existing nested-class walk with one more predicate;
  it does not widen the walk.

  **What the movement actually costs, stated precisely.** Withdrawing
  authority here can leave the module's export ambiguous (**UNKNOWN**) or,
  once RWF-021's root widening roots the values the export writes publish, can
  surface a real path and report **AFFECTED**. The independent RWF-022 audit
  measured the AFFECTED outcome on a configured-entrypoint spelling of this
  shape, and measured the RWF-020 spelling of the same shape reaching
  AFFECTED on `9a1370d` already. So this is a precision cost in **two**
  directions, not a uniform move "toward UNKNOWN" — earlier drafts of this
  entry said that, and it was wrong.

  The invariant that does hold, and the one that matters: this creates **no
  branch-attributable false `NOT_AFFECTED`**. It never manufactures a negative
  proof. See the separate P0 candidate below for the neighbouring
  computed-key reachability gap, which is a different defect and is
  pre-existing.

### Verification

Full unit + integration (2,606 tests), adversarial v1/v2 (**82/82**, 0
classification errors), validation (**12/17**, 5 KNOWN_FAIL, **0
unexpected** — the documented baseline, unchanged), hermeticity, typecheck,
lint, build, prettier, history-validator. `scan-performance` in isolation:
1,962 ms against a 4,500 ms threshold (main measured 2,067 / 2,915 /
2,102 ms — no regression; the failure seen under a full parallel run
reproduces identically on clean main and is contention, not this branch).

**Relevant files:** `src/code-intelligence/module-model.ts`
(`HeritageValueClass`, `classifyHeritageValueExpression`,
`classifyExactCallReturnValue`, `isDefinitelyInvalidClassHeritageValue` (all
new), `resolveExactLocalCallableIdentity` (split out of
`resolveExactLocalCallable`, whose behavior is unchanged),
`isDefinitelyAbruptClassHeritage` (second disjunct);
`isDefinitelyAbruptCall`, `cannotCompleteNormally`,
`isAsyncOrGeneratorCallable`, `topLevelCallableCandidates`,
`reassignedModuleReachableNames`, `scopeDeclares`, `isCaughtWithin`,
`mayEndModuleEvaluation` all reused UNCHANGED); regressions in
`module-model.invalid-class-heritage-value-export-authority.test.ts` (103
cases), `verdict.invalid-class-heritage-value-export-authority.integration.test.ts`
(8 cases), `module-model.class-heritage-throwing-call-export-authority.test.ts`
(3 superseded pins updated, 3 mechanism-isolation cases added),
`verdict.entrypoint-root-widening.integration.test.ts` (`rwf022.cjs`),
`fixtures/commonjs-circular-import-invalid-class-heritage-ground-truth/`
(real-node, asserted), `fixtures/commonjs-invalid-class-heritage-value-export-authority/`,
and `ADV2-082`.

---
## RWF-023 — A vulnerable target invoked from a COMPUTED CLASS-ELEMENT KEY was omitted from module-load reachability

**Severity:** P0 / CRITICAL SOUNDNESS (false `NOT_AFFECTED`, with a complete
Family C proof)
**Status:** **Fixed.** Recorded as an open P0 candidate by the independent
RWF-022 soundness audit, which reproduced it on `9a1370d` and on the RWF-022
branch with identical results; the ID was deliberately left unassigned until
the remediation task opened. Reproduced again, unchanged, on `86c8669` before
any edit here.

### The defect

A computed property KEY on a class element is evaluated during
ClassDefinitionEvaluation — that is, during module evaluation for a class at
module scope. RWF-019 already relies on exactly this fact in the *abrupt*
direction: a computed key whose call always throws ends module evaluation.
The *reachability* direction was not modeled. A call written inside a
computed key runs at load time, but the analyzer did not treat the callee as
reachable, and would then issue a **complete** negative proof over a target
that really is invoked.

```js
const dep = require("vuln-lib");

function key() {
  dep.dangerousOp("from-computed-key");   // RUNS at class-definition time
  return "x";
}

class C {
  [key()]() {}
}

module.exports = C;
```

There is no conditional export here, no branch, and no second candidate for
the module's value. That matters: every finding from RWF-014 through RWF-022
asks *which export write is authoritative*, and this one asks a prior
question — *which code does the analyzer believe runs at load time at all?*
The two are orthogonal, and the reproducer is written to make that
impossible to attribute to an export-authority cutoff.

### Pre-fix reproduction on `86c8669`

Measured with `fixtures/commonjs-computed-class-key-module-load-reachability/`,
one entrypoint per module, target `fixture-lib/danger#explode`:

| entrypoint | base `86c8669` | branch | truth |
| --- | --- | --- | --- |
| `src/index.cjs` — the canonical shape | **NOT_AFFECTED**, Family C complete | AFFECTED | sink runs — **false negative** |
| `src/top-level.cjs` — the same call as `key();` | AFFECTED | AFFECTED | sink runs — correct on both |
| `src/forms.cjs` — all eight element forms | AFFECTED | AFFECTED | see below |
| `src/expressions.cjs` — key expression shapes | **NOT_AFFECTED**, Family C complete | AFFECTED | sink runs — **false negative** |
| `src/conditional.cjs` — class in a top-level `if` | **NOT_AFFECTED**, Family C complete | AFFECTED | sink runs — **false negative** |
| `src/direct-call.cjs` — imported member call as the key | **NOT_AFFECTED**, Family C complete | AFFECTED | sink runs — **false negative** |
| `src/heritage.cjs` — valid + invalid heritage | **NOT_AFFECTED**, Family C complete | AFFECTED | sink runs — **false negative** |
| `src/class-definition-time.cjs` — static field / static block host | **NOT_AFFECTED**, Family C complete | AFFECTED | sink runs — **false negative** |
| `src/deferred.cjs` — eleven deferred positions | NOT_AFFECTED, Family C complete | NOT_AFFECTED, Family C complete | sink does NOT run — correct on both |
| `src/duplicate-instance.cjs` — nested PackageInstance | **NOT_AFFECTED**, Family C complete | AFFECTED | sink runs — **false negative** |

The second row is the control that names the defect. `top-level.js` holds
byte-for-byte the same call, the same wrapper and the same sink as
`index.js`, moved out of the computed key into a plain ExpressionStatement.
It was already AFFECTED. **The only semantic difference between the two
modules is the POSITION of the call.**

`src/forms.cjs` is AFFECTED on base for an instructive reason, and it is why
the element-level claim is pinned in the call-graph unit suite rather than by
a verdict: that module carries all eight forms, four of which already worked,
so a module-level verdict masks the four that did not. See the split below.

### Root cause — exact, and not where the task brief guessed

`call-graph.ts`'s `walkFile` keeps a stack of owner nodes. It pushes a node
for every function-like construct **before** descending into its children,
and attributes each call it meets to the top of that stack. A class element's
computed name is one of those children.

`isFunctionLike` (source-index.ts) covers `FunctionDeclaration`,
`MethodDeclaration`, `ConstructorDeclaration`, `FunctionExpression` and
`ArrowFunction`. So the four class-element kinds split into two groups for a
reason that has nothing to do with the language:

| element kind | pushed as owner? | who owned the key's calls | correct? |
| --- | --- | --- | --- |
| field (`[key()] = 1`) | no | the module | yes, by accident |
| static field | no | the module | yes, by accident |
| getter / setter | no | the module | yes, by accident |
| **method** (`[key()]() {}`) | **yes** | **the method itself** | **no** |

A `MethodDeclaration` covers the instance, `static`, `async` and generator
spellings, which is why all four were lost together and why the accessor and
field spellings never showed the defect. The key's calls landed in a region
that runs only if something calls the method, `key`'s body never entered the
reachable subgraph, `danger.explode` was left with no incoming edge at all,
and the search returned unreachable **with a complete subgraph** — a Family C
proof over a sink that runs on every single load.

This is worth stating plainly because the task brief anticipated a missing
*source node* or *root*: it is not. Every node and every root already
existed. One edge was attributed to the wrong owner.

### The fix

`walkFile`'s `visit` now visits a function-like member's computed name under
the **enclosing** owner, before the member's own node is pushed:

```ts
const computedName = classDefinitionTimeComputedName(node);
if (computedName) {
  await visit(computedName.expression);
}
```

Three properties of this shape are deliberate.

**It reuses `visit`, not a bespoke key walker.** A computed key is an
arbitrary expression, so every construct the graph already understands — a
local wrapper call, a member call straight onto an import, a nested call, a
template substitution, a short-circuit operand, even a class expression
written inside the key — is classified by exactly the same machinery. There
is no second notion of what a call is, and no shape-specific rule for any of
the forms in the matrix below.

**It adds an edge; it never moves one.** The normal child walk still visits
the key a second time under the member's own node, so the pre-existing
method→key edge survives. Moving it would have been tidier and is wrong:
shrinking a reachable subgraph is how a false `NOT_AFFECTED` is born, and a
caller that reaches the method by a route the module node does not dominate
would have lost the edge entirely. See *Monotonicity*.

**It refuses deferred positions by walking ancestors, not by testing scope.**
`runsWhenEnclosingOwnerRuns` walks from the element up to the nearest
function-like ancestor (the node the walk pushed, and therefore the current
stack top) or to the source file, and refuses as soon as it crosses a
position the language defers. `defersEvaluationOf` names exactly two:

- a **non-static field**: its computed NAME is evaluated when the element is
  defined, but its INITIALIZER is deferred to construction — RWF-018's line,
  reproduced rather than moved;
- an **accessor**: its computed NAME is evaluated at definition; its BODY and
  its PARAMETER list run only on get/set.

A static field initializer and a static block are not listed, because both
run during class definition. Nothing else defers.

`hasStaticModifier`, `defersEvaluationOf`, `runsWhenEnclosingOwnerRuns` and
`classDefinitionTimeComputedName` are the whole of the new code. No existing
function changed behavior.

### Why the deferral gate is the load-bearing half

`class Outer { field = class Inner { [key()]() {} }; }` is the shape that
separates a fix from an over-approximation. The **enclosing** class really is
being defined at module load, so a rule that stopped at "the class is at
module scope" — or that simply took the walk's current stack top — would root
`Inner`'s key and manufacture a false AFFECTED for a definition that never
happens.

The corpus scan below makes this concrete rather than hypothetical: of the 31
call-carrying computed keys found in real vendored code, **26 are in deferred
contexts**. A naive implementation would have been wrong about five sixths of
the real population it touched.

### Why this is distinct from RWF-019, and not a widening of it

RWF-019 asks whether a computed key's call is **definitely abrupt**, so that
a later CommonJS export is provably NOT reached. It needs a call that ALWAYS
runs and always throws. RWF-023 asks whether a computed key's call is
**executed at all**, so that its callee is reachable. It needs only that
there EXISTS a load on which the call runs.

Those are opposite quantifiers over the same syntax, and the difference is
not cosmetic:

```js
class C { [flag ? key() : "x"]() {} }        // RWF-023: reachable
                                             // RWF-019: NOT definitely abrupt
if (flag) { class C { [key()]() {} } }       // RWF-023: reachable
                                             // RWF-019: NOT definitely reached
```

Reusing RWF-019's definite-execution predicates here would have thrown away
every conditional shape and re-introduced the false negative for the majority
of the family. RWF-023 uses none of them: `isDefinitelyAbruptCall`,
`cannotCompleteNormally`, `mayEndModuleEvaluation` and every other cutoff
predicate in module-model.ts are untouched, and RWF-019's own regression
suite passes unchanged.

### Runtime ground truth (real node, asserted, v26.7.0)

`fixtures/computed-class-key-module-load-reachability-ground-truth/` is a
plain Node program run with `node entry.js`. Every claim is `assert`ed, not
printed — a wrong answer fails the process. It settles, in a real engine:

- **all eight element forms evaluate their key** — instance field, static
  field, instance method, static method, getter, setter, `async` method,
  generator method;
- every key EXPRESSION shape runs — parenthesized, nested, sequence,
  template, `||`, `?:`, a class expression, a class expression inside an
  object literal, an object literal's own method key, a class inside a
  top-level `if`;
- **evaluation ORDER**, measured rather than assumed:
  `heritage -> key1 -> key2 -> staticblock`;
- a computed key runs **before** the `TypeError` from an invalid heritage
  value (the RWF-022 interaction, below);
- a static field initializer and a static block are class-definition time, so
  a class nested in either really is defined at load;
- **none** of thirteen deferred controls reaches the sink;
- the KEY runs and the BODY does not — not at definition, not on
  construction, only when the method is actually called;
- and, end to end, that `require()`ing the canonical module — with no call
  into it, no entrypoint and no export ambiguity — reaches the sink, completes
  module evaluation, and installs the key's return value as the property name.

### The required matrix

Every row measured on both `86c8669` and the branch. "runtime" is the
ground-truth fixture's asserted answer.

| # | shape | runtime | base | branch |
| --- | --- | --- | --- | --- |
| 1 | computed instance field key | runs | reachable | reachable |
| 2 | computed static field key | runs | reachable | reachable |
| 3 | computed instance method key | runs | **missed** | reachable |
| 4 | computed static method key | runs | **missed** | reachable |
| 5 | computed getter key | runs | reachable | reachable |
| 6 | computed setter key | runs | reachable | reachable |
| 7 | computed `async` method key | runs | **missed** | reachable |
| 8 | computed generator method key | runs | **missed** | reachable |
| 9 | class expression method key | runs | **missed** | reachable |
| 10 | parenthesized key | runs | **missed** | reachable |
| 11 | direct imported member call as the key | runs | **missed** | reachable |
| 12 | local wrapper call | runs | **missed** | reachable |
| 13 | nested call `[String(key())]` | runs | **missed** | reachable |
| 14 | sequence `[(key(), "x")]` | runs | **missed** | reachable |
| 15 | template `` [`x${key()}`] `` | runs | **missed** | reachable |
| 16 | `[key() \|\| "x"]` | runs | **missed** | reachable |
| 17 | `[flag && key()]`, `[flag ? key() : "x"]` | may run | **missed** | reachable |
| 18 | class in a top-level `if` | may run | **missed** | reachable |
| 19 | class expression in an object literal | runs | **missed** | reachable |
| 20 | object literal's own method key | runs | **missed** | reachable |
| 21 | valid heritage + key | runs | **missed** | reachable |
| 22 | invalid heritage + key, before the failure | runs | **missed** | reachable |
| 23 | nested class in a STATIC field initializer | runs | **missed** | reachable |
| 24 | nested class in a STATIC block | runs | **missed** | reachable |
| 25 | class in an uncalled function | no | not rooted | not rooted |
| 26 | class in an uncalled arrow | no | not rooted | not rooted |
| 27 | class in an uninvoked callback | no | not rooted | not rooted |
| 28 | class in a method body | no | not rooted | not rooted |
| 29 | class in a getter / setter body | no | not rooted | not rooted |
| 30 | class in a constructor body | no | not rooted | not rooted |
| 31 | nested class in an INSTANCE field | no | not rooted | not rooted |
| 32 | object literal in an INSTANCE field | no | not rooted | not rooted |
| 33 | class in a method / setter PARAMETER default | no | not rooted | not rooted |
| 34 | class two deferral levels deep | no | not rooted | not rooted |
| 35 | dangerous call in a method BODY | no | not rooted | not rooted |
| 36 | key runs, method body does not | key only | — | key only |

Rows 1–24 and 25–34 are pinned individually in
`call-graph.computed-class-key-module-load-reachability.test.ts` (39 cases,
asserting the OWNER of the key's edge, which is the actual claim); the
end-to-end verdicts are in
`verdict.computed-class-key-module-load-reachability.integration.test.ts`
(17 cases).

### Object-literal computed method keys, absorbed deliberately

`const o = { [key()]() {} };` is the same defect with the same cause: a
`MethodDeclaration` is pushed as the owner before its own name is visited,
and the object literal's evaluation — not the method's — is what runs the
key. Excluding it would have meant leaving a known false `NOT_AFFECTED` that
the identical predicate already covers, so it is included and the deferral
gate covers its deferred spelling (`class O { literal = { [key()]() {} }; }`)
for free. Recorded here rather than left implicit.

Note this is **not** the separately-recorded object-literal gap in the
*abrupt* direction (`const o = { [bail()]: 1 }` and whether it ends module
evaluation) — that is RWF-024, below, fixed by a completely separate
mechanism (`module-model.ts`'s `firstModuleEvaluationCutoff`, not
`call-graph.ts`'s reachability walk this task touches).

### The RWF-022 interaction, retested as required

The audit that recorded this P0 established that with an INVALID heritage
VALUE the computed keys can already have run before the final
`IsConstructor` failure. Asserted again here in real node:

```js
function makeInvalid() { return 1; }
function key() { dep.dangerousOp(); return "x"; }
class C extends makeInvalid() { [key()]() {} }
// sink calls: ["..."]   then: TypeError
```

RWF-022 correctly withdraws the authority of any export written below that
statement. That is a statement about later EXPORTS and says nothing about the
sink the key has already reached, and the fixture's `heritage.js` pins both
halves: the target is reachable, and no Family C proof is issued. **No
simplistic "heritage validation always precedes keys" rule is encoded**, in
either direction.

### Scope decisions, made explicitly rather than by omission

The brief asked whether static field initializers, static blocks and heritage
expressions belong in RWF-023. They were probed independently, on base,
before any edit:

| probe on `86c8669` | verdict | conclusion |
| --- | --- | --- |
| `class C { static x = dep.dangerousOp(); }` | AFFECTED | already reachable — **no gap** |
| `class C { static { dep.dangerousOp(); } }` | AFFECTED | already reachable — **no gap** |
| `class C extends makeBase() {}` | AFFECTED | already reachable — **no gap** |
| `class C { static x = key(); }` | AFFECTED | already reachable — **no gap** |
| `class C { static { key(); } }` | AFFECTED | already reachable — **no gap** |

All three already work, for the same structural reason the field and accessor
keys did: none of `PropertyDeclaration`, `ClassStaticBlockDeclaration` or a
heritage clause is function-like, so none is pushed as an owner and their
calls were already attributed to the module. **There is no broader
class-definition reachability family to open, and RWF-023 stays narrow.** No
follow-up P0 is recorded for them, because there is nothing to record.

What RWF-023 *does* add for those positions is one step further in: a class
NESTED inside a static field initializer or a static block now has its own
computed method key reached (rows 23–24). That falls out of the same ancestor
walk and is not a separate rule.

### Newly confirmed, pre-existing, NOT introduced here

Two false-AFFECTED over-approximations were measured on base and are
**unchanged** on the branch. Both are precision defects, not soundness ones,
and both predate this task:

| shape | base | branch | truth |
| --- | --- | --- | --- |
| `class O { field = dep.dangerousOp(); }` | AFFECTED | AFFECTED | value is per-instance — over-approximate |
| `class O { get g() { return dep.dangerousOp(); } }` | AFFECTED | AFFECTED | body is deferred — over-approximate |
| `class O { field = class I { [key()] = 1; }; }` | AFFECTED | AFFECTED | deferred — over-approximate |
| `class O { get g() { class C { [key()] = 1; } } }` | AFFECTED | AFFECTED | deferred — over-approximate |

They share one cause: a non-static `PropertyDeclaration`'s initializer and an
accessor's body are not pushed as owners, so calls inside them are attributed
to the module. RWF-023 could have corrected them with the predicate it
already has — `defersEvaluationOf` names exactly these positions — and
deliberately did **not**, because doing so would move verdicts from AFFECTED
to NOT_AFFECTED, which this task's monotonicity contract forbids and which no
reachability task should smuggle in. Recorded as an open precision candidate,
not a P0: the direction is over-approximation, and no false `NOT_AFFECTED` is
reachable through it.

### Monotonicity

Measured per fixture entrypoint, base vs. branch:

| entrypoint | nodes base → branch | edges base → branch |
| --- | --- | --- |
| `src/index.cjs` | 8 → 8 | 4 → 5 |
| `src/top-level.cjs` | 8 → 8 | 4 → 4 |
| `src/forms.cjs` | 18 → 18 | 18 → 22 |
| `src/expressions.cjs` | 24 → 24 | 12 → 21 |
| `src/conditional.cjs` | 8 → 8 | 4 → 5 |
| `src/direct-call.cjs` | 7 → 7 | 3 → 4 |
| `src/heritage.cjs` | 13 → 13 | 7 → 9 |
| `src/class-definition-time.cjs` | 12 → 12 | 5 → 7 |
| `src/deferred.cjs` | 33 → 33 | 14 → 20 |
| `src/duplicate-instance.cjs` | 8 → 8 | 4 → 5 |

**Node counts are identical in every row.** No root was added, removed or
renamed; no new entrypoint identity exists; no synthetic node was invented.
Edge counts strictly increase or stay equal, never fall.

`src/deferred.cjs` is the row worth reading twice. It gains six edges — the
deferred keys are still attributed, to their own deferred owners, exactly as
before — and its verdict stays `NOT_AFFECTED` with
`reachableSubgraphComplete: true`. Edges added, reachable set unchanged,
negative proof preserved and still correct.

### Corpus

Two corpora, AST-scanned with the same ancestor-walk classifier the fix uses.

**`tests/validation/fixtures/` (the real vendored benchmark corpus):** 422
files scanned, 422 parsed, 12 class declarations, 0 class expressions, **0
computed class keys**. No verdict delta is possible, and none occurred.

**The repository's own vendored `node_modules` (typescript, prettier, eslint,
vitest, ajv, zod, semver, yaml and their transitive installs):**

| measure | count |
| --- | --- |
| files scanned / parsed | 4,372 / 4,372 |
| classes (1,904 declarations + 1,086 expressions) | 2,990 |
| computed class-element keys | 285 |
| computed keys containing a call | 31 |
| — direct identifier calls | 9 |
| — member calls | 22 |
| — module-evaluation context | 5 |
| — **deferred context** | **26** |
| on a method / field / accessor | 17 / 0 / 0 |
| **exact defect population** (module-time key on a function-like member) | **5** |

All five of the module-time cases are
`[Symbol.for('nodejs.util.inspect.custom')]` (minimatch ×4, prettier ×1) — a
member call rooted in the `Symbol` builtin, which the graph correctly leaves
edgeless (`KNOWN_GLOBAL_IDENTIFIERS`), so no real verdict moved in either
corpus. The distribution is the useful result: the shape occurs at real
frequency, and **26 of 31 sit in deferred positions**, which is the empirical
case for the deferral gate.

### Performance

No whole-file rescan, no CFG, no interpreter, no second AST pass. The fix is
one predicate evaluated at nodes `walkFile` already visits, plus an ancestor
walk bounded by the distance to the nearest enclosing function — for a class
element that is a handful of parent links. `scan-performance` in isolation: the medium
(~300 file) synthetic project completes in **510 ms** against a 5,000 ms
threshold, and the single-large-file guard in **5,224 ms** against a 20,000 ms
threshold.

### Verdict differential

Base `86c8669` → branch, in two disjoint groups. They are separated because
they mean different things, and only the first is sound.

**Group 1 — the primary RWF-023 differential**, across the fixture suites,
adversarial v1/v2 and validation:

| movement | count |
| --- | --- |
| NOT_AFFECTED → AFFECTED | 8 fixture entrypoints + ADV2-083 |
| NOT_AFFECTED → UNKNOWN | 0 |
| **UNKNOWN → NOT_AFFECTED** | **0** |
| **AFFECTED → NOT_AFFECTED** | **0** |
| any other movement in this group | 0 |

**Group 2 — abrupt-completion precision movements**, pinned in
`verdict.abrupt-completion-precision-limit.integration.test.ts` and recorded
in full under "Precision limit — reachability does not prune paths after
definitely-abrupt evaluation" below:

| movement | shapes | count |
| --- | --- | --- |
| UNKNOWN → AFFECTED | throwing-heritage METHOD key; throwing-heritage STATIC METHOD key; `throw …;` then a class with a METHOD key | 3 |
| NOT_AFFECTED → AFFECTED | `[false && key()]` METHOD key | 1 |
| **any movement toward NOT_AFFECTED** | — | **0** |

Every movement in BOTH groups is toward AFFECTED; neither group contains a
movement toward NOT_AFFECTED. What separates them is what the new AFFECTED
means:

- **Group 1 is sound.** Every one of those movements is a shape whose runtime
  execution is independently asserted in real node, so AFFECTED is the
  correct answer.
- **Group 2 is FALSE AFFECTED.** Real node asserts those shapes do NOT
  execute the key — a throwing heritage expression aborts before any element
  is defined, and `false && key()` cannot evaluate its right operand. These
  are accepted precision costs under the explicit waiver recorded with the
  precision-limit finding. They are **not** sound reachability and must never
  be read as evidence that the key runs.

Neither group licenses a Family C proof, so no false `NOT_AFFECTED` follows
from any of it.

### Verification

Full unit + integration (**2,682 tests**, 113 files — base `86c8669` measured
2,614 in 110 files; this branch adds exactly three test files and 68 cases),
adversarial v1/v2 (**117/117**; v1 34/34, v2 **83/83**, 0 classification
errors, with ADV2-083 measured **FAIL on base** — expected AFFECTED, got
NOT_AFFECTED, 82/83 — and **PASS on the branch**), validation (**12/17**,
5 KNOWN_FAIL, **0 unexpected** — the documented baseline, unchanged, with
RWB-07 PASS), hermeticity (6/6), typecheck, lint, build, prettier,
history-validator.

**Relevant files:** `src/code-intelligence/call-graph.ts`
(`hasStaticModifier`, `defersEvaluationOf`, `runsWhenEnclosingOwnerRuns`,
`classDefinitionTimeComputedName` — all new; one four-line addition to
`walkFile`'s `visit`. `classifyCall`, `classifyNew`, `emitModuleLoadEdges`,
`prepareFile`, `isFunctionLike` and every module-model.ts predicate reused
UNCHANGED); new regressions in
`call-graph.computed-class-key-module-load-reachability.test.ts` (39 cases)
and `verdict.computed-class-key-module-load-reachability.integration.test.ts`
(17 cases); new fixtures
`fixtures/commonjs-computed-class-key-module-load-reachability/` and
`fixtures/computed-class-key-module-load-reachability-ground-truth/`
(real-node, asserted); and `ADV2-083`.

### Remaining limitations (deliberately not fixed here)

- **The two pre-existing over-approximations above.** An instance field's
  VALUE and an accessor's BODY are attributed to the module. Recorded as a
  precision candidate; correcting them moves verdicts toward NOT_AFFECTED and
  belongs to a task that can carry that risk explicitly.
- **The object-literal computed key in the ABRUPT direction** remains open
  here, unchanged and unrelated to this task (`const o = { [bail()]: 1 }`)
  — **since fixed by RWF-024**, below.
- **A computed key reached only through an unresolved construct** stays
  UNKNOWN, as it should — the fix adds an edge, it does not resolve callees
  the binder cannot already resolve. `(() => { class C { [key()]() {} } })()`
  is UNKNOWN on both base and branch, because the IIFE's callee is not
  resolved; that is RWF-017's arbitrary-expression boundary, inherited
  unchanged.
- **`class C { [dep.dangerousOp()]() {} }` where the member call cannot be
  resolved** produces an honest `unknown` edge rather than a fabricated
  target. Nothing here fabricates a target that resolution does not support.
- **Definitely-abrupt evaluation is still not pruned from reachability.**
  `class C extends bail() { [key()]() {} }` reports AFFECTED although the
  throwing heritage means the key never runs. This is the cross-family
  limitation recorded below under "Reachability does not prune paths after
  definitely-abrupt evaluation": the FIELD, GETTER, SETTER and
  plain-statement spellings of it already answered AFFECTED on base, and
  correcting method-key ownership brought that spelling into line with them.
  False `AFFECTED` only — it cannot license a Family C proof — and pinned in
  `verdict.abrupt-completion-precision-limit.integration.test.ts`.

---

## RWF-024 — A throwing local call in an OBJECT LITERAL's COMPUTED KEY invalidates later CommonJS export authority

**Severity:** P0 / CRITICAL SOUNDNESS (false `NOT_AFFECTED`, with a complete
Family C proof)
**Status:** **Fixed.** Recorded as a separate, open P0 follow-up by RWF-019's
own audit (this file's RWF-019 entry, "Newly characterised, all UNCHANGED
from `main`") and reconfirmed untouched by every intervening task through
RWF-023, whose own entry explicitly distinguishes it from the REACHABILITY
gap RWF-023 closed ("Note this is **not** the separately-recorded
object-literal gap in the *abrupt* direction... That remains open"— now
this entry). Reproduced again, unchanged, on `e170f06` (current merged
main, RWF-023 included) before any edit here.

### The defect

Computed property names in object literals execute while the object
literal is evaluated — the same fact RWF-019 established for a class
element's computed key, but for a DIFFERENT ECMAScript evaluation
entirely. For every property in an `ObjectLiteral`'s
`PropertyDefinitionList`, in source order, the computed key expression is
evaluated and converted to a property key **before** that property's value
(or the method/getter/setter it names) is defined on the new object. There
is no class anywhere in this construct — it needs none.

```js
function dangerousOp() {
  vulnerableSink();
}

function safeOp() {}

function bail() {
  throw new Error("boom");
}

if (FLAG) {
  module.exports = dangerousOp;

  const obj = {
    [bail()]: 1,
  };
}

module.exports = safeOp;
```

At runtime: the earlier dangerous export is assigned; object-literal
evaluation starts; `bail()` executes; `bail()` throws; object construction
does not complete; the later safe export is skipped. Before this fix,
VulnTrace continued treating `safeOp` as authoritative and emitted a
complete Family C false `NOT_AFFECTED`.

### Why this is a different rule from RWF-019, not a widening of it

RWF-019's `isDefinitelyAbruptComputedClassElementKey` reads a
`ClassElement`'s computed name, evaluated by `ClassDefinitionEvaluation` —
an abstract operation that exists only for a `class`. Its own docs record,
and its own test suite pinned as a "documented boundary", that an object
literal's identically-shaped element (`PropertyAssignment`/
`MethodDeclaration`/`GetAccessorDeclaration`/`SetAccessorDeclaration` are
the same AST node KINDS whether they sit in a class body or an object
literal) was deliberately excluded by checking the element's PARENT is
class-like. That check is correct and stays unchanged; what RWF-019 left
undone is the SEPARATE rule for the excluded side, which this task adds:
`isDefinitelyAbruptComputedObjectLiteralKey`, checking the identical shape
with the opposite parent test (`ts.isObjectLiteralExpression(node.parent)`).
The two rules are structurally disjoint — one node can only ever satisfy
one of them — and neither widens the other.

**This is also not a mechanical copy of RWF-018's static/instance line.**
RWF-018 turns on a real class distinction: an INSTANCE field's VALUE is
deferred to construction, while a STATIC field's VALUE runs immediately at
class-definition time. An object literal has **no** comparable per-instance
deferral for an ordinary property's VALUE at all — every property of an
object literal, key and value alike, evaluates immediately when the
literal itself is evaluated. Measured directly under real `node`
(`fixtures/commonjs-circular-import-object-literal-computed-key-throw-ground-truth/forms.js`):
`{ x: bail() }` **throws**, unlike a class's `{ x = bail(); }`, which
completes. What genuinely defers in an object literal is a method/getter/
setter's **BODY** (runs only when invoked) and a computed key inside an
object literal that is never built at all (inside an uncalled function,
or — the one accepted over-approximation, mirroring RWF-019's identical
class-nested-in-instance-field case exactly — nested inside a class's own
INSTANCE field initializer).

### Runtime ground truth (real node, asserted, v22.11.0)

`fixtures/commonjs-circular-import-object-literal-computed-key-throw-ground-truth/`
is a plain Node program run with `node entry.js`. It settles, in a real
engine:

- a cyclic `require()` (`a.js` ⇄ `b.js`) retains the dangerous export by
  identity, published before the object literal is evaluated, and calls
  the vulnerable sink through it;
- the object literal's computed key runs, throws, and the object literal
  never finishes constructing — the later safe export is never published,
  and re-requiring the module re-throws deterministically;
- **every element form throws at construction time**: `PropertyAssignment`,
  `MethodDeclaration`, `GetAccessorDeclaration`, `SetAccessorDeclaration`,
  an `async` method, a generator method, a parenthesized call
  (`[(bail())]`) and an optional call on an exact non-nullish callee
  (`[bail?.()]`);
- **an ordinary property's VALUE also throws** (`{ x: bail() }`) —
  confirming there is no instance-field-style deferral to mirror, and
  pinning why this task's rule deliberately does not claim that position
  (see "Remaining limitations" below);
- a method BODY, a getter BODY, and a computed key inside a never-called
  function all genuinely complete — the deferred-position negative controls
  that make this a sound rule rather than a merely conservative one;
- a computed key nested inside a class's INSTANCE field initializer also
  completes at runtime (the class is never defined at module-evaluation
  time) — VulnTrace's own answer over-approximates this one case, on
  purpose, matching RWF-019's identical documented limitation;
- computed keys and property VALUES evaluate strictly in **source order**,
  and an abrupt key stops everything after it: `[safe()]: 1, [bail()]: 2,
  [later()]: 3` measured `safe-key, bail` — `later`'s key and the abrupt
  property's own value never ran.

### The fix

`module-model.ts` gains one new predicate,
`isDefinitelyAbruptComputedObjectLiteralKey`, structurally parallel to
RWF-019's `isDefinitelyAbruptComputedClassElementKey`: it matches an
`ObjectLiteralElementLike` node whose `name` is a `ts.ComputedPropertyName`,
whose parent is a genuine `ts.ObjectLiteralExpression`, and whose key
expression `isDefinitelyAbruptCall` already proves is a definitely-abrupt
call — reusing RWF-016's exact-local-callee proof
(`resolveExactLocalCallable`), always-throws body proof
(`cannotCompleteNormally`), `async`/generator exclusions and parentheses
normalization verbatim. It is wired into `mayEndModuleEvaluation`'s walk
exactly where RWF-019's predicate is: BEFORE the function-like stop, since
a `MethodDeclaration`/`GetAccessorDeclaration`/`SetAccessorDeclaration` IS
function-like and the stop must still apply to its BODY, not its KEY.

The one genuinely new piece is the file-level pre-filter. RWF-019 (and
RWF-020) widened `firstModuleEvaluationCutoff`'s `scanExpressions` gate
from a `\bstatic\b` text test to a `\bclass\b` one, because every
class-definition-time construct needs the literal token `class` to exist
at all. An object literal's computed key has no comparable keyword —
`{ [bail()]: 1 }` is written with nothing but a `[`, the same token an
array literal or an ordinary index expression uses — so the new gate,
`mayContainObjectLiteralComputedKeyEvaluation`, is necessarily a coarser
sound over-approximation: it fires on any file containing `[` at all. That
costs an unrelated file the full expression walk and changes no answer,
never the reverse — `isDefinitelyAbruptComputedObjectLiteralKey` still
re-checks the exact AST shape on every node the walk reaches, so
correctness never depends on the text gate alone.

### Pre-fix reproduction on `e170f06`

Measured with `fixtures/commonjs-object-literal-computed-key-throwing-call-export-authority/`,
target `fixture-lib/danger#explode`, entrypoint `src/index.cjs`:

| shape | base `e170f06` | branch |
| --- | --- | --- |
| `fixture-lib` (PropertyAssignment computed key) | **NOT_AFFECTED**, Family C complete | UNKNOWN |
| `fixture-lib/method-key` (MethodDeclaration computed key) | **NOT_AFFECTED**, Family C complete | UNKNOWN |
| `fixture-lib/deferred-key` (deferred controls) | NOT_AFFECTED, Family C complete | NOT_AFFECTED, Family C complete (unchanged) |
| `fixture-lib/stable` (Family C positive control) | NOT_AFFECTED, Family C complete | NOT_AFFECTED, Family C complete (unchanged) |

### Newly characterised

- *(soundness, an adjacent, deliberately open gap — recorded as the next
  candidate rather than absorbed)* an object literal PROPERTY's ordinary
  VALUE, `{ [safeKey()]: bail() }`, also runs unconditionally at
  object-construction time and is not modeled by any existing predicate:
  `isDefinitelyAbruptCallStatement` recognises a call only as an
  `ExpressionStatement` or a `VariableStatement`'s own initializer, neither
  of which an object literal's property value is. Absorbing it would mean
  either widening that predicate to a new expression position (the same
  "arbitrary-expression-evaluation boundary" RWF-017 already drew and
  RWF-019/020/022 all respected) or building a second, parallel value-
  position rule — and the task governing this fix explicitly scoped it to
  the KEY alone ("Do NOT absorb unless it is the same narrow mechanism and
  architecture makes it trivial"). Confirmed live under real `node`
  (`forms.js`'s `{ x: bail() }` row) that this position genuinely does
  throw, so it is a real, tracked gap and not a hypothetical one -
  **since fixed by RWF-026**, which models a property VALUE as a required
  evaluation through a separate relation, leaving RWF-024's KEY rule
  untouched;
- *(precision, the one shape this task makes MORE conservative, identical
  in kind to RWF-019's own accepted over-approximation)* a computed key
  nested inside a class's INSTANCE field initializer —
  `class C { x = { [bail()]: 1 }; }` — now reports a cutoff where `main`
  did not. At runtime the instance field never evaluates at class-
  definition time, so this is an over-approximation, and it exists for the
  identical reason RWF-019 accepted the same shape for a nested CLASS:
  `mayEndModuleEvaluation`'s walk stops at every function-like node but not
  at a non-static `PropertyDeclaration`, so once the walk is inside a class
  body it can reach an object literal sitting in an instance field's
  initializer too. Giving object literals a second, different traversal
  model to avoid it would mean two models rather than one; the movement is
  strictly toward UNKNOWN, never toward a negative proof;
- *(correctly refused, not a gap)* `[flag && bail()]` and
  `[flag ? bail() : "x"]` genuinely may not call `bail` at all, and
  `[foo(bail())]`, `` [`${bail()}`] `` stay unrecognised for the same
  arbitrary-expression-evaluation reason RWF-017/019 already documented -
  the two nested-call forms **since fixed by RWF-026**, while the logical
  and ternary forms stay correctly refused there too;
- *(correctly refused, not a gap)* scope, shadowing, reassignment, alias and
  member callees are refused by the same `resolveExactLocalCallable`
  machinery RWF-013/013b established, reused verbatim and unmodified;
- *(precision)* `[new bail()]` is a `NewExpression`, not recognised, and a
  throwing IIFE returning the object literal is not recognised either, for
  the same documented IIFE boundary RWF-015 established.

### Verification

Unit (`module-model.computed-object-literal-key-throwing-call-export-authority.test.ts`,
67 cases covering every element form, key-before-value ordering,
earlier/later property order, multiple computed keys, parenthesized/
optional calls, conditional/logical/nested keys, scope/shadow/reassignment/
alias/member boundaries, try/catch/finally, every deferred position, the
one accepted over-approximation, every export surface, and RWF-015/016/
017/018/019/020/022 regressions); the two pre-existing "documented
boundary" tests in `module-model.computed-class-key-throwing-call-export-authority.test.ts`
and the "still-open P0" regression pin in
`module-model.class-heritage-throwing-call-export-authority.test.ts` are
flipped to their now-correct `toBeUndefined()` expectation, with updated
commentary rather than silently deleted; integration
(`verdict.object-literal-computed-key-throwing-call-export-authority.integration.test.ts`,
7 cases: UNKNOWN for both the field and method-key shapes, no Family C
proof, no PackageInstance substitution, the deferred-key control still
NOT_AFFECTED with a complete Family C proof, and the Family C positive
control unaffected); adversarial v2 (`ADV2-084`, expected UNKNOWN,
84/84 — see below); full RWF-015 through RWF-023 regression suites (all
pass unchanged); validation (12/17, 5 KNOWN_FAIL, 0 unexpected — the
documented baseline, unchanged); adversarial v1 (34/34, unchanged);
hermeticity (6/6); typecheck, lint, build, prettier, history-validator.

**Relevant files:** `src/code-intelligence/module-model.ts`
(`isDefinitelyAbruptComputedObjectLiteralKey`,
`mayContainObjectLiteralComputedKeyEvaluation` — both new; a four-line
addition to `mayEndModuleEvaluation`'s `visit` and a two-line widening of
`firstModuleEvaluationCutoff`'s `scanExpressions`; every other predicate —
`isDefinitelyAbruptCall`, `resolveExactLocalCallable`,
`cannotCompleteNormally`, `isCaughtWithin`,
`isDefinitelyAbruptComputedClassElementKey`,
`isDefinitelyAbruptClassHeritage` — reused UNCHANGED); new regressions in
`module-model.computed-object-literal-key-throwing-call-export-authority.test.ts`
(67 cases) and
`verdict.object-literal-computed-key-throwing-call-export-authority.integration.test.ts`
(7 cases); new fixtures
`fixtures/commonjs-object-literal-computed-key-throwing-call-export-authority/`
and
`fixtures/commonjs-circular-import-object-literal-computed-key-throw-ground-truth/`
(real-node, asserted); and `ADV2-084`.

### Remaining limitations (deliberately not fixed here)

- **The object-literal PROPERTY-VALUE abrupt call** (`{ [safeKey()]: bail() }`)
  remains open — see "Newly characterised" above. Recorded as the next
  candidate in this family.
- **A computed key reached only through an unresolved construct** stays
  UNKNOWN, as it should. Nothing here fabricates a cutoff resolution does
  not support.
- **The instance-field over-approximation** described above is accepted
  deliberately, identically to RWF-019's own, and moves only toward
  UNKNOWN.
- **`{ [dep.dangerousOp()]: 1 }` where the member call cannot be resolved**
  is refused, correctly — this predicate never guesses a callee identity
  RWF-016's model does not already support.

---

## Precision limit — reachability does not prune paths after definitely-abrupt evaluation

**Severity:** PRECISION / false `AFFECTED` — **not** P0, and **not** a
soundness finding. No false `NOT_AFFECTED` and no Family C consequence
follows from it.
**Status:** **Open, pinned.** Cross-family and pre-existing; surfaced through
one additional spelling by RWF-023 and deliberately not fixed there.
**Discovered:** the independent RWF-023 soundness audit, which reproduced
every row below on base `86c8669` and on the RWF-023 branch.
**Pinned by:** `src/analysis/verdict.abrupt-completion-precision-limit.integration.test.ts`
(12 cases).

### The limitation

`analyzeReachability` walks the call graph, and the call graph is a purely
structural MAY-reachability over-approximation: **it does not model abrupt
completion at all.** Nothing prunes the statements that follow a `throw`, a
call that can only throw, or a class definition that cannot finish.

Abrupt-completion reasoning exists in this repository only in
module-model.ts, where RWF-016/017/018/019/020/022 use it to decide which
CommonJS export WRITE is authoritative. That is a different question, on a
different graph, with the opposite quantifier — MUST-execute rather than
MAY-execute. The two have never been connected, and the limitation is
visible with no class involved at all:

```js
bail();   // throws
key();    // never runs -- reported reachable
```

### Runtime truth (real node v26.7.0, asserted)

In every row below, `key()` **does not execute**. Any `AFFECTED` is a false
`AFFECTED`.

A class's heritage expression is evaluated FIRST, before any element and
therefore before any computed key — the superclass has to exist before the
prototype chain can be built — so a heritage call that throws leaves the
element list entirely unevaluated. (RWF-020's fixture README documents the
same ordering from the abrupt side. Note the deliberate contrast with
RWF-022's case, where the heritage call RETURNS an invalid value: there the
keys DO run before the `TypeError`, and RWF-023 correctly reports that one
`AFFECTED`.)

### Measured, base vs. now

| shape | runtime | base `86c8669` | now |
| --- | --- | --- | --- |
| `bail(); key();` | key does not run | AFFECTED | AFFECTED |
| `throw new Error("x"); key();` | key does not run | AFFECTED | AFFECTED |
| throwing heritage + **FIELD** key | key does not run | AFFECTED | AFFECTED |
| throwing heritage + **GETTER** key | key does not run | AFFECTED | AFFECTED |
| throwing heritage + **SETTER** key | key does not run | AFFECTED | AFFECTED |
| throwing heritage + **METHOD** key | key does not run | UNKNOWN | **AFFECTED** |
| throwing heritage + **STATIC METHOD** key | key does not run | UNKNOWN | **AFFECTED** |
| `throw ...;` then class + METHOD key | key does not run | UNKNOWN | **AFFECTED** |
| `[false && key()]` **FIELD** | key does not run | AFFECTED | AFFECTED |
| `[false && key()]` **GETTER** | key does not run | AFFECTED | AFFECTED |
| `[false && key()]` **METHOD** | key does not run | NOT_AFFECTED | **AFFECTED** |

### What RWF-023 did and did not do here

RWF-023 did **not** introduce an abrupt-completion model, and did not widen
one. Before it, a computed key on a METHOD was mis-attributed to the method's
own deferred node — so these shapes answered UNKNOWN or NOT_AFFECTED
*accidentally*, for a reason unrelated to abrupt completion. Correcting that
ownership made the method spelling answer the way its FIELD, GETTER and
SETTER siblings already did on base.

The bold rows are therefore the pre-existing limitation becoming visible
through one more spelling, not a new defect. Every movement is toward
`AFFECTED`; an over-approximation can only add findings, never license a
negative proof.

Where the analyzer *does* hold a real proof, RWF-023's new edge respects it:
`if (false) { class C { [key()]() {} } }` stays `NOT_AFFECTED` with a
complete Family C proof, because `evaluateConstantBoolean` keeps the walk out
of the untaken branch and the new edge is only emitted for nodes the walk
actually visits. The fix participates in the existing traversal rather than
blanket-rooting every computed key, and that boundary is pinned too.

### Why it was not fixed inside RWF-023

Gating the new computed-key edge on RWF-020's
`isDefinitelyAbruptClassHeritage` was considered and rejected:

- it would introduce a **call-graph → module-model dependency**, importing
  MUST-execute cutoff logic into a MAY-execute reachability walk;
- it would leave the FIELD, GETTER, SETTER and plain-statement spellings
  untouched, creating a semantic asymmetry between spellings of one shape;
- made consistent across those spellings, it would move existing findings
  from `AFFECTED` to `NOT_AFFECTED` — the one direction a reachability change
  must never take as a side effect of an unrelated task;
- and it would address only *throwing heritage*, not `throw`, not a throwing
  call in statement position, and not any other definitely-abrupt form.

### The proper fix

A unified, abrupt-completion-aware reachability model applied across all of
these forms at once: sequential top-level statements, throwing heritage,
throwing calls in any evaluated position, and every computed-key spelling.
That is an architectural change to the call-graph walk, it must be sound in
the `NOT_AFFECTED` direction before it is precise in the `AFFECTED`
direction, and it deserves its own task. Constant folding inside arbitrary
expressions (`false && key()`) is a separate, smaller sub-question and was
deliberately not added — inventing new positive proofs is how a false
`NOT_AFFECTED` gets built.

### Scope

- **False `AFFECTED` only.** Over-approximation cannot produce a false
  `NOT_AFFECTED` and cannot license a Family C proof.
- **Family A/B, ModuleLoadClosure, PackageInstance identity, entrypoint-root
  derivation:** unaffected.
- **RWF-014 … RWF-022 export-authority semantics:** unaffected; those live in
  module-model.ts and are untouched by this limitation and by its pin.

## RWF-025 — A destructuring computed KEY must not poison module-wide reassignment provenance

**Severity:** P0 / CRITICAL SOUNDNESS (false `NOT_AFFECTED`, with a complete
Family C proof)
**Status:** **Fixed.** Found by the P0 closure inventory and independently
reproduced on `9c0ca73` (current merged main, RWF-024 included) before any
edit here. Prioritised ahead of RWF-026 (P0-A) because the defect could
silently disable already-merged abruptness fixes for an entire source file.

### The defect

RWF-016 through RWF-024 all rest on one callee-identity question: is the
name `bail` at a call site still the module-top-level `function bail` this
file can read a body out of, or was it reassigned somewhere module
evaluation can reach? `reassignedModuleReachableNames` answers it with a
set of names, cached per `ts.SourceFile`. `markLocallyReassigned` filled
that set, and its last line was:

```ts
ts.forEachChild(target, (child) => markLocallyReassigned(child, into));
```

An assignment target's syntax tree contains two independent kinds of thing:
the **destinations** the assignment writes to, and the **expressions the
language merely evaluates** to work out what those destinations are. The
blind child walk could not tell them apart, so:

```js
({ [bail()]: x } = HOLDER);
```

recorded `bail` as locally reassigned. It is not. `x` is the destination;
`bail()` is evaluated to produce the property key that says WHICH property
of `HOLDER` to read.

Because the set is cached per source file, one such statement — anywhere in
the file, in either order relative to the vulnerable path, and arbitrarily
far from it — made `bail`'s identity unresolvable **file-wide**. Every
merged cutoff for that name was withdrawn, and a later `module.exports =
safeOp` regained an authority it does not have:

```js
function dangerousOp() { vulnerableSink(); }
function safeOp() {}
function bail() { throw new Error("boom"); }

if (FLAG) {
  module.exports = dangerousOp;
  const obj = { [bail()]: 1 };   // RWF-024's cutoff -- silently withdrawn
}

module.exports = safeOp;

({ [bail()]: x } = HOLDER);      // <- the only thing that changed
```

The same blind walk also recorded every identifier under an
`ElementAccessExpression` target — `obj` **and** `key` in `obj[key()] = v`
— even though that statement mutates a property and rebinds no local
binding at all. `PropertyAccessExpression` was already excluded; its
element-access sibling was not.

### Why it is worse than an ordinary false negative

The syntax that triggers it is unremarkable, need not be near the vulnerable
path, and changes no runtime behaviour of the module. A package could
therefore regress from a sound verdict to a confident clean bill of health
through an edit that changes nothing about what it does.

### Runtime ground truth (real node v22.11.0, asserted)

`fixtures/destructuring-computed-key-assignment-target-ground-truth/` is a
plain Node program (`node entry.js`) whose every claim is `assert`ed, not
printed. Seven measured rows:

| shape | key expression evaluated? | key's own binding rebound? | target rebound? |
| --- | --- | --- | --- |
| `({ [key()]: target } = source)` | yes | **no** | yes |
| `({ [bail()]: target } = source)` where `bail` throws | yes (it throws) | — | no |
| `({ [bail()]: bail } = source)` | yes, with the OLD value | — | **yes** |
| `({ target = fallback() } = source)` | yes | **no** | yes |
| `[holder[key()]] = values` | yes | **no** | nothing local; `holder.slot` written |
| `holder[key()] = value` | yes | **no** | nothing local; `holder.slot` written |
| shorthand / aliased / nested / rest / array / array-rest / defaulted | — | — | all seven rebind |

Row 3 rules out the lazy fix: suppressing every identifier under a computed
property name would be wrong, because in `({ [bail()]: bail } = source)` the
key occurrence rebinds nothing while the value occurrence genuinely does.
The roles must be distinguished, not the name.

The same fixture also proves, through a circular `require()`, that a cyclic
consumer of the poisoned module captures `fastPath` **by identity** before
the throw and reaches the sink through it (`danger.reachedCount()` goes
`0 → 1`), and that re-requiring the failed module re-throws.

### The fix

`markLocallyReassigned` now recurses through ASSIGNMENT-TARGET STRUCTURE
only, never through arbitrary children:

- `Identifier` → recorded.
- `ObjectLiteralExpression` → `PropertyAssignment`: recurse into the
  INITIALIZER only, never the name (a `ComputedPropertyName` is evaluated,
  not assigned); `ShorthandPropertyAssignment`: record the name, ignore
  `objectAssignmentInitializer` (a default VALUE); `SpreadAssignment`:
  recurse into its expression.
- `ArrayLiteralExpression` → each element; `OmittedExpression` skipped,
  `SpreadElement` unwrapped.
- `BinaryExpression` with `=` (a destructuring DEFAULT, `[x = d]`) →
  recurse into the LEFT side only.
- `PropertyAccessExpression`, `ElementAccessExpression`, and anything that
  is not an assignment target → contribute nothing.

A small `unwrapAssignmentTarget` strips parentheses and TypeScript's
type-only wrappers (`(x) = 1`, `x! = 1`, `(x as T) = 1`) by taking one
node's `.expression` — deliberately never a child walk, since that is the
defect.

The per-source-file cache is unchanged, and so is the module-evaluation
reach model (a reassignment inside a function body is still out of scope,
for RWF-016's own reason). One bounded traversal per assignment target,
strictly smaller than the old one.

### Deliberately NOT changed

`resolveExactLocalCallable`, `cannotCompleteNormally`, every cutoff's own
position rule (RWF-016/017/018/019/020/022/024), negative-proof semantics,
Family C, `PackageInstance` identity, `ModuleLoadClosure`, the call graph,
entrypoint roots. No alias, member-callee or transitive resolution was
added. P0-A was not implemented.

### Pre-fix reproduction on `9c0ca73`

Six C1 cases, at module-model level. `second` means the later export kept
authority (the false negative); `undefined` means it was soundly withdrawn.

| case | shape | poison | base `9c0ca73` | branch |
| --- | --- | --- | --- | --- |
| C01 | RWF-016 bare call, poison BEFORE the scenario | `({ [bail()]: x } = HOLDER)` | `second` | `undefined` |
| C02 | RWF-024 object-literal computed key | poison after final write | `second` | `undefined` |
| C03 | RWF-016 bare call | poison after final write | `second` | `undefined` |
| C04 | RWF-017 variable initializer | poison after final write | `second` | `undefined` |
| C05 | RWF-016 bare call | `[HOLDER[bail()]] = [1]` | `second` | `undefined` |
| C06 | RWF-016 bare call | none (control) | `undefined` | `undefined` |

C06 and the poison-free RWF-017/RWF-024 controls answer `undefined` on BOTH
sides. The poisoned rows are the only movement, and they move only in the
sound direction.

### Newly characterised

Every row measured on both sides. "reassigned" means the cutoff was
withdrawn.

| target | base | branch | correct? |
| --- | --- | --- | --- |
| `({ [bail()]: x } = HOLDER)` | reassigned | **not** | branch |
| `({ [otherKey()]: bail } = HOLDER)` | reassigned | reassigned | both |
| `({ [bail()]: bail } = HOLDER)` | reassigned | reassigned | both |
| `({ x = bail() } = HOLDER)` | reassigned | **not** | branch |
| `({ bail = fallback() } = HOLDER)` | reassigned | reassigned | both |
| `({ k: x = bail() } = HOLDER)` | reassigned | **not** | branch |
| `({ k: bail = fallback() } = HOLDER)` | reassigned | reassigned | both |
| `[HOLDER[bail()]] = [1]` | reassigned | **not** | branch |
| `HOLDER[bail()] = 1` | reassigned | **not** | branch |
| `bail[0] = 1` | reassigned | **not** | branch |
| `bail.prop = 1` | not | not | both |
| `[x = bail()] = [1]` | reassigned | **not** | branch |
| `({ k: { [bail()]: x } } = HOLDER)` | reassigned | **not** | branch |
| `[{ [bail()]: x }] = [HOLDER]` | reassigned | **not** | branch |
| `for ({ [bail()]: x } of [])` | reassigned | **not** | branch |
| `bail = () => "safe"` | reassigned | reassigned | both |
| `({ bail } = HOLDER)` | reassigned | reassigned | both |
| `({ k: bail } = HOLDER)` | reassigned | reassigned | both |
| `({ outer: { bail } } = HOLDER)` | reassigned | reassigned | both |
| `({ a: { b: [{ c: bail }] } } = HOLDER)` | reassigned | reassigned | both |
| `({ ...bail } = HOLDER)` | reassigned | reassigned | both |
| `[bail] = [1]` | reassigned | reassigned | both |
| `[, bail] = [1, 2]` | reassigned | reassigned | both |
| `[...bail] = [1]` | reassigned | reassigned | both |
| `[{ k: bail }] = [HOLDER]` | reassigned | reassigned | both |
| `bail += 1` / `bail \|\|=` / `bail &&=` / `bail ??=` | reassigned | reassigned | both |
| `bail++` / `--bail` | reassigned | reassigned | both |
| `for (bail of [])` / `for (bail in HOLDER)` | reassigned | reassigned | both |
| `for ({ bail } of [])` / `for ([bail] of [])` | reassigned | reassigned | both |
| `(bail) = "safe"` | reassigned | reassigned | both |
| `({ k: (bail) } = HOLDER)` | reassigned | reassigned | both |
| `({ bail } = HOLDER)` inside a function body | not | not | both (RWF-016's reach model, unchanged) |

**Not one genuine assignment destination stopped being recorded.** The
branch's marks are a strict subset of the base's, and the corpus scan below
confirms it empirically: across 152,236 assignment targets in real vendored
code, the new collector never once recorded a name the old one did not.

### Corpus

Structural scan with the TypeScript parser (never textual) over real
vendored JS/CJS/MJS.

Real installed dependency tree (2,527 files):

| measure | count |
| --- | --- |
| assignment targets | 152,236 |
| destructuring-assignment targets | 181 |
| targets containing a computed property NAME | 0 |
| targets with a CallExpression in a computed name | 0 |
| **targets with a CallExpression in an ElementAccess INDEX** | **121** |
| names the new collector adds that the old did not | **0** |

**Measured effect on the production cache.** Two quantities are easy to
confuse here, and an earlier revision of this entry reported the wrong one.
A *per-target syntactic occurrence count* — how many times, anywhere in a
file, the old walk would have recorded a name the new one does not — comes
to 19,680 across 671 files. That number overstates the real effect, because
it counts assignment targets inside FUNCTION BODIES, which
{@link reassignedModuleReachableNames}'s own reach model never visits.

The quantity that actually determines behaviour is the difference between
the two per-file CACHED name sets. Measured by running the shipped relation
itself over the same 2,527 files:

| measure | count |
| --- | --- |
| names dropped from the cached set | **80** (28 files) |
| of those, module-top-level callables | **2** (`chai`'s `assert`, twice) |
| of those, names genuinely written elsewhere in the file | **12** (all loop counters: `i`, `c`, `i$1`) |
| **dropped AND a callable AND genuinely written** | **0** |
| names added to the cached set | **0** |

The last two rows are the ones that matter. There is no file in this corpus
where the fix drops a name that is both a resolvable local callable and
genuinely reassigned — so there is no file where it could cause a stale
callable to be trusted. Both `chai` drops are correct: `assert[as] = ...`
mutates a property and never rebinds `assert`, so refusing `assert`
file-wide was the defect, not the protection.

Repository fixtures (791 files): 14,678 targets, 6 destructuring targets, 7
element-access-index call targets, 0 dropped callables, 0 additions.

The primary spelling (`({ [f()]: x } = src)`) is rare in this corpus; the
element-access spelling of the SAME defect is not. Concrete instances:
`rollup`'s `importedBindingsPerDependency[resolveFileName(dependency)]`,
`vite`'s `resolvedCache[getResolveCacheKey(key, options)]` and
`attributes[getAttrKey(attr)]`, `chai`'s `assert[as]`, and `esquery`'s
minified bundle. **Low frequency is not low severity:** the poisoning is
file-wide, so a single occurrence disables a name's identity for an entire
module — `chai`'s `assert` is a real installed package where it did.

### Newly discovered, NOT fixed here — the twin walker in commonjs-reexports.ts

`collectFacts`'s local `markAssigned` (src/code-intelligence/commonjs-reexports.ts)
has the **identical** defect, ending in the same `ts.forEachChild(target,
markAssigned)` fallback, feeding `CommonJsFacts.reassignedNames`, cached in
the same per-source-file way. It was left untouched here under this task's
"one defect only" scope.

Its failure mode is the **opposite, safe direction** and cannot produce a
false `NOT_AFFECTED`: over-marking there makes RWF-013b refuse to bind an
export, so the module's exported value becomes unattributed and the verdict
degrades to `UNKNOWN`. Measured: a file containing
`({ [keyFor(neverCalled)]: seen } = REGISTRY)` loses the binding for
`neverCalled` entirely, even after RWF-025's fix. It cost precision in this
task's own fixture authoring — `fixtures/.../stable.js` and ADV2-085's
`index.js` both had to avoid naming an EXPORTED function inside an
assignment target to keep the two defects from confounding each other.

**Recommendation:** its own follow-up task (RWF-025b), applying the same
semantic rule locally in `markAssigned`. It is a precision defect, not a
soundness one, so it does not block P0-Z.

### Remediation — real assignments inside evaluated target sub-expressions

**Found by:** independent audit of this task's own first implementation,
which returned `RWF025_BLOCKED`. Fixed on the same branch, in one further
commit, before any review.

**What the first implementation got right.** Stopping the arbitrary
`ts.forEachChild` walk was correct and is unchanged: a computed key, a
default initializer and an element-access index are EVALUATED while the
target is resolved, and the names they merely READ are not rebound.

**What it then got wrong.** It stopped looking at those sub-expressions
altogether — and an assignment written INSIDE one of them really does run:

```js
({ x = (bail = safe) } = HOLDER);    // `x` AND `bail` are rebound
({ [(bail = safe)]: x } = HOLDER);   // `x` AND `bail` are rebound
HOLDER[(bail = safe)] = 1;           // `bail` is rebound
```

The base implementation recorded `bail` in all three (accidentally, via the
child walk — and it also wrongly recorded `safe`). The first RWF-025
implementation recorded neither. That is a **missed genuine reassignment**,
and it let `resolveExactLocalCallable` trust a stale throwing declaration.

Measured end-to-end on a fixture where real `node` proves the module always
reaches its final export, so `NOT_AFFECTED` is the CORRECT answer:

| | base `9c0ca73` | first implementation | after remediation |
| --- | --- | --- | --- |
| sink target | `NOT_AFFECTED`, Family C complete | `UNKNOWN`, no Family C | `NOT_AFFECTED`, Family C complete |
| whole-module target | `AFFECTED` | `UNKNOWN` | `AFFECTED` |

**Direction.** The regression was strictly over-conservative: it *lost* a
correct `NOT_AFFECTED` and could never manufacture one, because a withdrawn
export attribution yields an UNRESOLVED edge, which forbids a Family C
proof. It was therefore a precision defect rather than a soundness one —
but it was a regression the branch introduced, it trusted a stale callable
after a genuine reassignment, and it is fixed rather than documented.

**The fix: two traversals, deliberately separate.**
`markAssignmentsInsideEvaluatedExpression` is handed every evaluated-only
position — a `ComputedPropertyName`'s expression, a shorthand's
`objectAssignmentInitializer`, a destructuring default's right-hand side,
and both halves of a property/element-access target. It descends through
children only to FIND assignment and update OPERATIONS, and collects names
only from their targets, through `markLocallyReassigned`:

- `BinaryExpression` with any assignment operator (by `SyntaxKind`, via the
  existing `isAssignmentOperatorToken`, never by text) — its LEFT side is a
  real assignment target; its RIGHT side is re-entered only to find further
  nested assignments;
- `PrefixUnaryExpression`/`PostfixUnaryExpression` `++`/`--` — its operand;
- everything else — descend, collecting nothing.

A bare identifier is never collected. `bail = safe` records `bail` and not
`safe`; `bail()` records nothing at all. Function bodies are not entered,
so the RWF-016 reach model is unwidened. No P0-A expression semantics were
imported: this relation still answers only "which local bindings does this
statement rebind".

**Characterised, all measured on the shipped relation.** `safe` — the
right-hand-side name the old child walk wrongly recorded — appears in none
of these sets.

| shape | reassigned set |
| --- | --- |
| `({ x = (bail = safe) } = HOLDER)` | `bail, x` |
| `({ [(bail = safe)]: x } = HOLDER)` | `bail, x` |
| `holder[(bail = safe)] = 1` | `bail` |
| `({ [(a = (b = safe))]: x } = HOLDER)` | `a, b, x` |
| `obj[(a = 1, b = 2)] = 1` | `a, b` |
| `({ [bail++]: x } = HOLDER)` / `holder[bail++] = 1` / `({ [++bail]: x } = ...)` | `bail` (+ `x`) |
| `({ [(bail \|\|= safe)]: x } = HOLDER)`, `+=`, `&&=`, `??=` | `bail, x` |
| `({ [key()]: x = (bail = safe) } = HOLDER)` | `bail, x` — not `key`, not `safe` |
| `({ [(key = "k")]: x } = HOLDER)` | `key, x` |
| `((obj = holder)).x = 1` | `obj` |
| `safe().x = 1` | *(none)* |
| `({ [(() => (bail = safe))()]: x } = HOLDER)` | `x` — deferred, reach model unchanged |

**Every original poison control is unchanged** — `({ [bail()]: x } = src)`,
`[holder[bail()]] = values`, `holder[bail()] = 1`, `({ x = bail() } = src)`,
`bail.prop = 1`, `bail[0] = 1`, and their nested/array/`for..of` spellings
all still contribute only the real target. Every genuine assignment-target
control is unchanged. The reassigned sets differ from the first
implementation only by ADDING names that are genuinely assigned.

**Differential after remediation.** Across the 37-case behavioural matrix:
all twelve poison recoveries preserved, all eleven genuine-reassignment
controls unchanged, the three regression cases restored to base's answer,
P0-A and P0-E unchanged with and without poison, and **zero** movements
toward kept export authority. `UNKNOWN → NOT_AFFECTED = 0` and
`AFFECTED → NOT_AFFECTED = 0` across all 119 adversarial scenarios and the
whole validation suite.

### Verdict differential (base `9c0ca73` vs. branch)

| suite | base | branch | movement |
| --- | --- | --- | --- |
| unit + integration | 2,756 pass | 2,823 pass | +67 new tests, 0 regressions |
| adversarial v1 | 34/34 | 34/34 | none |
| adversarial v2 | 84/85 (ADV2-085 FAIL) | 85/85 | **ADV2-085 `NOT_AFFECTED` → `UNKNOWN`** |
| validation + hermeticity | 17 pass / 6 fail | 17 pass / 6 fail | none (identical set) |
| scan-performance | pass | pass | none |

- `UNKNOWN` → `NOT_AFFECTED`: **0**
- `AFFECTED` → `NOT_AFFECTED`: **0**
- `NOT_AFFECTED` → `UNKNOWN`: **1** (ADV2-085 — the defect)
- Any other movement: **0**

The six validation failures (VAL-002, VAL-003, RWB-03, RWB-05, RWB-09b, and
one hermeticity assertion) are byte-identical on both sides and are the
suite's pre-existing, deliberately-kept disagreements.

### ADV2-085

`tests/adversarial/v2/fixtures/adv2-085-destructuring-computed-key-reassignment-cache-poisoning/`
is ADV2-084's fixture with one statement added, between duplicate
same-name, same-version `PackageInstance`s.

| run | verdict |
| --- | --- |
| base `9c0ca73`, poison present | **`NOT_AFFECTED`** (FAIL — the false negative) |
| base `9c0ca73`, poison statement DELETED, nothing else changed | `UNKNOWN` (PASS) |
| branch, poison present | `UNKNOWN` (PASS) |

The middle row is the control that matters: on unmodified base main,
removing only `({ [keyFor(bail)]: seen } = REGISTRY);` restores the sound
answer. That identifies the cache poisoning as the cause, rather than the
abrupt position itself.

The fixture is non-vacuous in the other direction too: it carries
`({ retired } = REPLACEMENTS)`, a module-scope destructuring statement that
GENUINELY rebinds a local callable, so an analyzer that passed it by no
longer recording destructuring targets at all would be caught.

### Verification

`npm test` (117 files, 2,823 tests, all pass) · `npm run test:adversarial`
(v1 34/34, v2 85/85) · `npm run test:validation` (unchanged from base) ·
`npm run test:performance` (2/2, 2.35s and 8.54s against 5s/20s thresholds)
· `npm run typecheck` · `npm run lint` · `npm run build` · `npm run format`
· `npm run validate:history`. New focused suite:
`src/code-intelligence/module-model.destructuring-assignment-target-reassignment.test.ts`
(59 tests) — 22 of them fail on base `9c0ca73` with only the production file
reverted, and the 37 genuine-reassignment controls pass on both sides. New
end-to-end regression:
`src/analysis/verdict.destructuring-computed-key-reassignment-cache-poisoning.integration.test.ts`
(8 tests), including the Family C positive control and the
false-`AFFECTED` control where `bail` really is rebound.

### Remaining limitations (deliberately not fixed here)

- **The twin walker in commonjs-reexports.ts** — above. Precision only.
- **P0-A (RWF-026)** — a throwing call in an ARGUMENT or operand position
  (`foo(bail())`, `1 + bail()`) is still not proved definitely abrupt.
  Verified invariant: those shapes answer identically with and without the
  poison, on the branch. — **since fixed by RWF-026**, below, which also
  re-verified the invariant: a genuine reassignment of `bail` still refuses
  in every newly supported position.
- **P0-E (RWF-028)** — alias (`const alias = bail; alias()`) and member
  (`holder.bail()`) callees are still unresolved. Same invariant verified.
- **An assignment buried inside a larger expression that is not part of an
  assignment target** (`foo(bail = other)`, `x = bail = 1`) is still not
  chased, unchanged from before and unchanged by the remediation below:
  `checkAssignmentLike` inspects an expression statement's own top-level
  shape only. Missing one of these only makes the relation more
  conservative. **This bullet previously claimed the same was true of an
  assignment written inside an assignment TARGET; it was not — see the
  remediation entry below.**
- **A reassignment inside a function body** is still outside the
  module-evaluation reach model, unchanged and by design (RWF-016) — and
  that includes one written inside an immediately-invoked function in a
  computed key, `({ [(() => (bail = safe))()]: x } = source)`.


## RWF-026 — A definitely-abrupt call in a NECESSARILY EVALUATED EXPRESSION POSITION invalidates later CommonJS export authority

**Severity:** P0 / CRITICAL SOUNDNESS (false `NOT_AFFECTED`, with a complete
Family C proof)
**Status:** **Fixed.** Found by the P0 closure inventory (P0-A) and
independently reproduced on `13c82e4` (current merged main, RWF-025
included) before any edit here. This is the umbrella family: one semantic
rule, not one task per syntax spelling.

### The defect

RWF-016 through RWF-024 each recognise a definitely-abrupt call in one
NAMED syntactic slot — a bare expression statement, a declarator's whole
initializer, a class static field's initializer, any class element's
computed key, a class's `extends` heritage, an invalid heritage value, an
object literal's computed key. Every one of them is a SHAPE TEST on the
node that directly holds the call, and each previous task closed its gap by
adding one more shape.

The inventory found 25 spellings where no shape is available, because the
call occupies no privileged slot at all — it is an ordinary OPERAND:

```js
function dangerousOp() { vulnerableSink(); }
function safeOp() {}
function bail() { throw new Error("boom"); }

if (FLAG) {
  module.exports = dangerousOp;
  foo(bail());               // no slot -- and Node never gets past it
}

module.exports = safeOp;     // syntactically unconditional; never reached
```

`bail` is already proven definitely abrupt by RWF-016's unchanged
exact-local-callee proof. JavaScript evaluation necessarily reaches the
call: `EvaluateCall` builds the argument list, left to right, BEFORE the
callee is entered. Real Node therefore cannot reach the later export write
— but the analyzer kept it authoritative, attributed `safeOp` as the whole
module value, found `dangerousOp` unreachable, and issued a **complete
Family C negative proof** for a package that reaches the sink on every load
taking the early branch.

The problem was never that VulnTrace lacks a JavaScript interpreter. It is
that an already-proven abruptness FACT was not propagated through the
expression positions whose evaluation necessarily reaches the call.

### The fix — one bounded relation

`necessarilyEvaluatesAbruptly(expression)` in
`src/code-intelligence/module-model.ts` answers exactly one question: does
NORMAL COMPLETION of this expression REQUIRE evaluating a call
`isDefinitelyAbruptCall` has already proven can only ever throw?

It widens **where** a proven-abrupt call is necessarily evaluated. It does
**not** widen **which** calls can be proven abrupt — that stays RWF-016's
proof, consumed verbatim and never re-derived. The two axes are deliberately
kept apart: RWF-027 (P0-B) owns multi-path callee completion, RWF-028 (P0-E)
owns invocation/provenance, and both reproducers are verified unchanged.

**The soundness rule, and why it needs no evaluation-ORDER model.** An
expression completes normally only if every operand position the language
REQUIRES it to evaluate completes normally first. So if any required
operand cannot complete normally, neither can the enclosing expression:

```js
safe() + bail()
```

Either `safe()` completed (so `bail()` is reached and throws) or it did not
(so the `+` never completes either way). Both readings agree — the same
argument RWF-017's `declarationListCannotCompleteNormally` already makes for
a declarator list, generalised to operands. Source order is still MEASURED
under real Node, because pinning it keeps each form's documented reading
honest, but no proof rests on it.

**It is an explicit switch over SyntaxKinds, never `ts.forEachChild`.** A
generic child traversal would descend into a `&&`'s right operand or an
arrow body — precisely the class of unsoundness this family exists to fix,
and precisely the mistake RWF-025 had just finished repairing in the
neighbouring reassignment collector. Every supported kind is listed with
which of its children are required; an unlisted kind is refused by a closing
`return false`.

**Supported required positions.** Parenthesized and TS type-only wrappers
(`as`, `satisfies`, `!`, `<T>e`); object literal computed keys, property
VALUES and spread operands; array elements and spread operands (holes
evaluate nothing); a call's CALLEE then every ARGUMENT; a `new`'s
constructor expression then every ARGUMENT; template substitutions; a
tagged template's TAG then its substitutions; a property access RECEIVER; an
element access receiver then index; unary/`typeof`/`void`/`delete`/`await`
operands; a conditional's CONDITION; both operands of every
non-short-circuiting binary operator, comma included; a short-circuiting
operator's LEFT operand only; an assignment's target-reference
sub-expressions then its RHS. Statement HEADERS are anchored at the same
time: `if`, `switch`, `while`, a `for` initializer and test, and a
`for-of`/`for-in` right-hand side.

**Explicitly refused, each for a stated reason.** A logical operator's RIGHT
operand and a logical assignment's RHS (short-circuit); both arms of a
conditional expression (neither is required, and joining two abrupt arms is
multi-path reasoning left out of scope); a `for` INCREMENTOR and a
`do`/`while` condition (neither is reached until an iteration has
completed); anything inside a function — function/arrow bodies, method and
accessor bodies, DEFAULT PARAMETERS; a class INSTANCE field initializer
(per-construction, not module time); positions guarded by an OPTIONAL CHAIN
(`a?.m(bail())`, `a?.[bail()]`); a destructuring assignment TARGET, which
also keeps RWF-025's different question about the same syntax untouched; and
an IIFE, whose invocation semantics remain unmodelled.

`bail?.()` stays on the required side, unchanged and for RWF-017's recorded
reason: an optional call short-circuits only on a nullish CALLEE, and
`resolveExactLocalCallable` only ever resolves a hoisted function
declaration or a never-reassigned `const`-bound function expression.

### Performance

A per-file gate, `fileHasDefinitelyAbruptCallable`, opens the relation. Since
`isDefinitelyAbruptCall` can only ever succeed for a callee resolving to a
`topLevelCallableCandidates` entry, a file declaring no always-throwing
top-level callable provably has no definitely-abrupt call anywhere in it —
so the gate is exactly complete, not merely close, and the recursion is
never entered for such a file. `scan-performance` is unchanged: 2,311 ms and
7,938 ms on the branch against 2,398 ms and 8,266 ms on base `13c82e4`
(thresholds 5 s / 20 s).

### Runtime ground truth (real node v22.11.0)

`fixtures/commonjs-circular-import-expression-position-throw-ground-truth/`
is a plain Node program, not an assertion. It measures, in one process:

- **45 REQUIRED positions — every one throws**, across A1 (object value,
  computed key, safe-key + abrupt value, nested object, array element,
  middle element, element after a hole, object spread), A2 (call argument,
  multi-argument, `new` argument, template, tagged template, property-access
  receiver, element-access index and receiver, array spread, call spread,
  optional-chain receiver, optional call), A3 (sequence left and middle,
  logical `||`/`&&`/`??` LEFT, binary left and right, comparison right,
  assignment RHS, compound-assignment RHS, assignment-target index and
  receiver, unary operand, `typeof` operand, parenthesized), A4 (`if`
  condition, `switch` discriminant, `for` initializer as declaration and as
  expression, `for` test, `for-of` RHS, `for-in` RHS, `while` condition) and
  class-definition time (static field, static block).
- **20 CONDITIONAL/DEFERRED positions — every one completes**: logical
  `&&`/`||`/`??` RIGHT, both conditional arms, `||=`/`&&=`/`??=`, `for`
  update, `do`/`while` condition, function body, arrow body, callback,
  method body, class instance field, default parameter, returned object in
  an uncalled function, optional-chain-guarded argument and index, and a
  call caught by `try`/`catch`.
- **13 measured evaluation ORDERS**: call arguments left to right; object
  literal key-then-value in source order; array elements; template
  substitutions; tagged template tag-then-substitutions; member receiver
  before access; element access receiver-then-index; sequence; logical LEFT;
  assignment target-reference-then-RHS; `if` condition before either arm;
  `for` initializer-then-test-never-body; `for-of` RHS before iteration.

`a.js` additionally proves the whole point end to end: a cyclic `require()`
retains the dangerous export by identity, calls the vulnerable sink through
it, `before()` runs while `after()` and the callee never do, and re-requiring
re-throws deterministically. `c.js` is the conditional/deferred control that
completes and publishes its safe export.

### Base reproduction (independently recreated on `13c82e4`)

Of a 75-case matrix run against unmodified main:

- **47 required spellings** — **42 reproduced the false negative** (later
  export kept authoritative). Five already withdrew for a pre-existing
  reason and are kept as unregression pins: RWF-024's computed key, a bare
  `bail?.()` statement, a parenthesized initializer, a class static field
  and a static block.
- **28 negative controls** — all 28 already correct on base, and all 28
  unchanged on the branch.

End to end, three fixture modules carrying the defect in three unrelated
required positions each returned, on base:

```
NOT_AFFECTED
confirmedUnreachableTarget: { target: fixture-lib/danger#explode,
                              reachableSubgraphComplete: true }
```

On the branch all three are `UNKNOWN` with `confirmedUnreachableTarget`
absent.

### Verdict differential (base `13c82e4` → branch)

| suite | base | branch | movement |
| --- | --- | --- | --- |
| unit + integration | 117 files / 2,846 tests | 119 files / 3,062 tests | +216 tests, 0 regressions |
| adversarial v1 | 34/34 | 34/34 | none |
| adversarial v2 | 85/85 | 86/86 | **ADV2-086 added; `NOT_AFFECTED` → `UNKNOWN` on base code** |
| validation (canonical: `tests/validation/validation.test.ts`) | 12/17 pass, 5 known fail, 0 unexpected | 12/17 pass, 5 known fail, 0 unexpected | none (identical set and verdicts) |
| hermeticity (`tests/validation/hermeticity.test.ts`) | 6/6 | 6/6 | none |
| scan-performance | 2/2 | 2/2 | none |

- `UNKNOWN` → `NOT_AFFECTED`: **0**
- `AFFECTED` → `NOT_AFFECTED`: **0**
- `NOT_AFFECTED` → `UNKNOWN`: **45** (42 unit spellings + 3 fixture modules)
- Any movement toward `NOT_AFFECTED`: **0**

Twenty-three tests across RWF-016/017/018/019/020/024 pinned these positions
as documented limitations. Each was updated to the sound expectation with its
CONDITIONAL counterpart kept adjacent in the same block, so the
required/refused line stays visible in the suite rather than erased from it.

The canonical validation baseline is unchanged in both scope and content:
`12/17 passed (70.6%)` with `Unexpected failures (not in FINDINGS.md): 0`.
The five failures (VAL-002, VAL-003, RWB-03, RWB-05, RWB-09b) are
byte-identical on both sides and are the suite's pre-existing, deliberately
kept disagreements. Note that `npm run test:validation` runs
`vitest.validation.config.ts`, whose `include` glob covers ALL of
`tests/validation/`, so its aggregate line reads `18 passed / 5 failed (23)`
— the canonical 17 CVE cases PLUS the 6 hermeticity tests. Those are two
counting scopes for the same unchanged result, not a moved baseline; the
canonical 12/17 figure is the one to compare against. RWF-026 touched no
validation runner, oracle case, fixture or config — only this document. Separately, VT-208, VT-301A and VT-307d time out under
parallel load on base and branch alike and pass on both with a raised
timeout; they are environmental, not semantic.

### ADV2-086

`tests/adversarial/v2/fixtures/adv2-086-definitely-abrupt-expression-evaluation/`
places the defect in a call ARGUMENT, between duplicate same-name,
same-version `PackageInstance`s, and surrounds it with eleven conditional or
deferred decoys that all name `bail` at module scope and none of which ends
module evaluation — plus `install(before(), maybe(FLAG), after())`, a
genuinely REQUIRED position at module scope whose callee returns on one path,
which is the sharpest control in the fixture: an analyzer that widened the
CALLEE proof to reach it would be answering RWF-027's question instead of
this one.

| run | verdict |
| --- | --- |
| base `13c82e4` | **`NOT_AFFECTED`** (the false negative) |
| branch | `UNKNOWN` (PASS) |

Runtime coherence is checked directly: with `VT2_MODE` unset or `slow` the
module publishes `slowPath` and returns normally; with `VT2_MODE=fast` it
throws before publishing anything, so a cyclic consumer keeps `fastPath`.

### Corpus scan (vendored real JS/CJS/MJS/TS)

Counted separately, and deliberately not conflated:

| | |
| --- | --- |
| 1. files scanned | 976 |
| 2. candidate expression-position occurrences | 2,421 |
| 3. files declaring an exact local definitely-abrupt callable | 47 |
| 4. exact local definitely-abrupt callee matches in NEW positions | 12 |
| 5. of those, module-reachable | 12 |
| 6. of those, followed by a later export write | 12 |
| 7. actual verdict movement in vendored third-party code | **0** |

All 12 semantic matches are in VulnTrace's own fixtures and adversarial
corpus; **none is in vendored third-party code**. The 2,421 figure is a
SYNTACTIC candidate count and must not be read as impact. Absence from this
corpus does not reduce the severity: the defect is a false `NOT_AFFECTED`
with a complete negative proof, and the shapes are ordinary JavaScript.

### Verification

`npx vitest run` (119 files, 3,062 tests, all pass) · `npm run
test:adversarial` (v1 34/34, v2 86/86) · `npm run test:validation`
(unchanged from base) · hermeticity 6/6 · `npm run test:performance` (2/2)
· `npm run typecheck` · `npm run lint` · `npm run build` · `npm run format`
· `npm run validate:history`. New focused suite:
`src/code-intelligence/module-model.definitely-abrupt-expression-evaluation.test.ts`
(206 tests) — a table-driven required/refused matrix, adjacent boundary
pairs, source-order cases, the RWF-024/025/027/028 interaction blocks, and
the 43-row SELF-REVIEW attack matrix (conditional branch treated as
mandatory, function body crossed, instance field or default parameter
crossed, optional-chain guard ignored, stale binding trusted after
reassignment, P0-B or P0-E absorbed), which reports 0 mismatches.
New end-to-end regression:
`src/analysis/verdict.expression-position-throwing-call-export-authority.integration.test.ts`
(9 tests), including the Family C positive control, the conditional/deferred
control and the same-name same-version twin-instance identity control.

### Remaining limitations (deliberately not fixed here)

- **P0-B (RWF-027)** — a callee that throws on one path and RETURNS on
  another (`function maybe(f) { if (f) throw e; return 1; }`) is still not
  definitely abrupt, so no expression containing it is a cutoff however
  necessarily evaluated that expression is. Verified unchanged, in required
  positions, on both sides. — **This statement still holds exactly as
  written.** RWF-027, below, does NOT make such a callee definitely abrupt;
  it proves the different and narrower claim that a CLASS DEFINITION whose
  heritage calls it cannot complete. `foo(maybe())` and `maybe();` remain
  unproven on both sides, and RWF-027 pins them as controls.
- **P0-E (RWF-028)** — alias (`const alias = bail; alias()`), member
  (`obj.bail()`), transitive and `new bail()` callees remain unresolved.
  `foo(alias())` is therefore still not a cutoff, and must not become one
  from this task's side. Verified unchanged.
- **Both arms of a conditional expression abrupt** (`FLAG ? bail() :
  bail()`) is refused. Real Node throws either way; proving it needs the
  multi-path join RWF-027 owns. Conservative, recorded, not closed.
- **One composite interaction reaches a conditional arm anyway, and it is
  not this relation doing it.** `expressionCannotCompleteNormally` refuses
  both arms, as above. But an object literal's COMPUTED KEY is reached by
  the pre-existing `mayEndModuleEvaluation` walk (RWF-024's rule), which is
  a MAY relation and already withdrew for `FLAG ? { [bail()]: 1 } : 0` on
  base. Because RWF-026 widened the predicate that path consults,
  the nested form `FLAG ? { [foo(bail())]: 1 } : 0` now withdraws too. The
  movement is toward UNKNOWN — never a false `NOT_AFFECTED`, and never an
  `AFFECTED` — and it makes the nested form agree with the direct one. No
  generic conditional-arm reasoning was added.
- **`do`/`while` conditions and `for` INCREMENTORS** are refused for want of
  body-completion reasoning. A `while` condition and a `for` test, which
  need none, are supported.
- **IIFE** (`(() => bail())()`) is unchanged: its invocation is not modelled
  as an exact local definitely-abrupt call, and RWF-026 consumes only that
  fact. Pinned as a control in both the unit matrix and ADV2-086.
- **A class INSTANCE field** is untouched, including RWF-024's known
  structural over-approximation for an object literal nested inside one. The
  boundary is pinned, not widened.
- **Optional-chain-guarded positions** are refused wholesale rather than
  resolved. `a?.m(bail())` really does skip the argument for nullish `a`;
  proving the base non-nullish would need flow analysis this task does not
  invent.
- **`try`/`finally` without a `catch`** still ends module evaluation, and
  `try`/`catch` still stops it, both through the pre-existing
  `isCaughtWithin`; RWF-026 adds no exception-flow semantics of its own.
- **MAY-execute abrupt operands are a separate, INHERITED family, stated
  here explicitly rather than left implicit.** `mayEndModuleEvaluation` is
  a MAY relation elsewhere — a cutoff inside an `if` body or a loop body
  withdraws authority, because it *may* run — but a conditional OPERAND
  (`flag && bail()`, `flag ? bail() : v`, `z ||= bail()`) does not, on base
  `13c82e4` and on this branch alike. On a truthy `flag` the later export
  really is unreached, so this is the same defect family one step further
  out, and it is the reason the governing task listed those shapes as
  BLOCK-if-withdrawn controls: closing them means deciding whether the
  operand model should become MAY like the statement model, which is a
  design question this task was explicitly scoped away from. RWF-026
  neither introduces nor widens it — the branch answers every one of these
  identically to base — but it is a real, tracked gap, not a settled one,
  and it is the natural candidate for whichever task takes the
  conditional-operand axis next.

## RWF-027 — A class `extends` HERITAGE whose EVERY analyzable ending prevents the class definition from completing invalidates later CommonJS export authority

**Severity:** P0 / CRITICAL SOUNDNESS (false `NOT_AFFECTED`, with a complete
Family C proof)
**Status:** **Fixed.** Found by the P0 closure inventory (P0-B), recorded as
an explicit open follow-up by RWF-022 and again by RWF-026, and
independently reproduced on `6b5ad53` (current merged main, RWF-026
included) before any edit here.

### The defect

RWF-020 recognises a class heritage expression that can only ever THROW.
RWF-022 recognises a class heritage expression that definitely produces a
value which is neither `null` nor a constructor. Each asks about **one**
ending. A callable can have several:

```js
function maybe(flag) {
  if (flag) { throw new Error("boom"); }   // ending 1
  return 1;                                // ending 2
}

if (FLAG) {
  module.exports = dangerousOp;
  class C extends maybe(FLAG) {}
}

module.exports = safeOp;     // syntactically unconditional; never reached
```

- `cannotCompleteNormally(maybe)` is **false** — one path returns. RWF-020
  declines, correctly.
- `classifyExactCallReturnValue(maybe)` is **`"unknown"`** — the body is not
  a single unconditional return. RWF-022 declines, correctly.

Yet **every** path prevents the class definition from completing, for two
*different* reasons. Measured under real `node` v22.11.0 in
`fixtures/commonjs-circular-import-multipath-class-heritage-ground-truth/`,
each ending in its own circular-require module graph:

| `FLAG` | the call | the class definition | `module.exports = safeOp` |
| --- | --- | --- | --- |
| truthy | `throw Error: boom` | never entered | **never runs** |
| falsy | returns `1`, **normally** | `TypeError: Class extends value 1 is not a constructor or null` | **never runs** |

So neither rule fires, the analyzer keeps the later write authoritative,
attributes `safeOp` as the whole module value, finds `dangerousOp`
unreachable, and issues a **complete Family C negative proof** for a package
that reaches the sink on every load taking the early branch. `B02` —
`function twoBad(f) { if (f) return 1; return 2; }` — is the same defect
with no throwing path at all.

The class-definition failure is a property of the path **set**, and of
nothing smaller. No rule that inspects one ending can reach it.

### The semantic distinction the whole task rests on

RWF-027 does **not** prove "this call cannot complete normally". With a
falsy `FLAG` the call completes perfectly normally and returns `1`; the
ground-truth fixture asserts `maybe(false) === 1` outside any heritage
position specifically to pin this. What is proven is narrower and different:

> evaluating **this class heritage** cannot lead to a normally completed
> class definition.

Consequently `maybe(FLAG);` as a plain statement, `const v = maybe(FLAG);`
as an initializer, and `foo(maybe(FLAG))` as an operand are all **untouched**
and stay exactly as unproven as RWF-016 and RWF-026 leave them. That is not
a limitation awaiting a later task — it is the correct answer, and both the
unit matrix and ADV2-087 pin it.

### The fix — one bounded path-outcome summary

`summarizeExactCallHeritageOutcomes(fn)` in
`src/code-intelligence/module-model.ts` computes, for an exact local
callable, the finite set of endings a call to it can have. Outcomes are
RWF-022's `HeritageValueClass` widened with one member, `"abrupt-throw"`.

`isDefinitelyNonCompletingClassHeritageCall(expression)` then proves
non-completion **only** when the summary is known, non-empty, and EVERY
outcome is in `{"abrupt-throw", "non-constructable"}` — the only two
outcomes that stop a class definition, and precisely RWF-020's and RWF-022's
two fatality reasons, composed across the set.

The refusals are the mechanism, not edge cases:

- one `"unknown"` refuses the whole summary;
- one `"valid-null"` refuses — `class C extends null {}` is **legal**;
- one `"constructable"` refuses.

The asymmetry is the point. A single surviving good ending means the class
definition CAN complete, the later export CAN run, and withdrawing its
authority would be an overreach reporting a demonstrably-completable class
definition as fatal.

It is a third, SEPARATE disjunct of `isDefinitelyAbruptClassHeritage`.
RWF-020 and RWF-022 are unchanged, still consulted first, and still own what
they owned; RWF-027 duplicates neither and weakens neither.

### Path enumeration, and why it refuses rather than approximates

`collectHeritageExitOutcomes` walks a statement list with an **allow-list**:
`return`, `throw`, `if`/`else`, nested blocks, and statements that cannot
leave the callable (expression statements, declarations, nested function and
class declarations, `;`, `debugger`). Everything else — every loop, `switch`,
`try`/`catch`/`finally`, labeled statement, `break`, `continue`, `with` —
returns UNKNOWN and poisons the entire summary.

A dropped path is the primary risk in both directions, and it is
unrecoverable: a lost `return Base;` withdraws a CORRECT export, a lost
fatal path claims a proof that does not hold. Sound refusal is always
available, so the collector never skips a construct it does not model.

Three properties are load-bearing:

- **The implicit ending is a PATH, never an absent one.** A body that can run
  off its end ends by returning `undefined`, and that is APPENDED
  EXPLICITLY. This is the only reason
  `function f(flag) { if (flag) return 1; }` can be answered at all — its two
  endings are `1` and `undefined`, both non-constructable. A model recording
  only the written `return` would see one path where there are two.
- **The function-scope boundary is structural, not a filter.** The collector
  walks statements only and enters no expression, so a `return` inside a
  nested function, method, accessor, class static block or IIFE is unable to
  be counted as an exit of the outer callable.
- **Statements that cannot exit are passed over, not analyzed.** They may
  only fall through or THROW, and a throw is already a class-definition-fatal
  outcome — so ignoring them can only ever omit a fatal ending from a set the
  caller requires to be entirely fatal. The same argument covers the `if`
  condition and the `return`/`throw` operands, none of which are examined.
  This is `declarationListCannotCompleteNormally`'s argument, reused.

Bounded by construction: a fixed nesting depth of 4 and a fixed exit ceiling
of 32, both refusing past the limit. No CFG, no interprocedural fixpoint, no
whole-program summaries. `scan-performance` is unchanged.

### Callee identity is unchanged

`resolveExactLocalCallableIdentity` is shared verbatim with RWF-022, so the
lexical-shadow walk and RWF-013/013b/025's reassignment refusal apply here
exactly as they do there. A genuinely reassigned heritage callee
(`f = () => Base;`) refuses, and alias, member, transitive and `new` callees
stay RWF-028's — pinned as controls in the unit matrix, the fixture and
ADV2-087.

### Verification

Reproduced on base `6b5ad53` first: B01 and B02 both keep the later export
authoritative, both yield `NOT_AFFECTED` with
`confirmedUnreachableTarget` and `reachableSubgraphComplete: true`.

Family C differential on
`fixtures/commonjs-multipath-class-definition-completion/`:

| target | base `6b5ad53` | this branch |
| --- | --- | --- |
| `fixture-lib/danger#explode` | `NOT_AFFECTED` + complete Family C | `UNKNOWN`, no negative proof |
| `fixture-lib#default` | `AFFECTED` | `UNKNOWN` |
| `fixture-lib/two-bad#default` | `NOT_AFFECTED` + complete Family C | `UNKNOWN`, no negative proof |
| `fixture-lib/fallthrough#default` | `NOT_AFFECTED` + complete Family C | `UNKNOWN`, no negative proof |
| `fixture-lib/valid-multipath#default` | `NOT_AFFECTED` + complete | **unchanged** |
| `fixture-lib/stable#default` | `NOT_AFFECTED` + complete | **unchanged** |

`UNKNOWN → NOT_AFFECTED`: **0**. `AFFECTED → NOT_AFFECTED`: **0**. No
movement toward `NOT_AFFECTED` anywhere. Both Family C controls untouched —
this narrows negative proofs rather than disabling them.

New permanent matrix:
`src/code-intelligence/module-model.multipath-class-definition-completion.test.ts`
(43 tests) covering throw+invalid, invalid+invalid, throw+throw,
invalid+null, invalid+constructor, throw+null, throw+constructor,
unknown+invalid, unknown+throw, nested-if all-bad and nested-if with a valid
leaf, early return, implicit fallthrough, bare `return`, the empty body, the
nested-function and nested-method boundaries, the loop/switch/try refusals,
the plain-call and initializer non-overreach, class expressions, deferred
class definitions, reassignment and alias/member controls, and the RWF-020 /
RWF-022 regressions.

New end-to-end regression:
`src/analysis/verdict.multipath-class-definition-completion.integration.test.ts`
(8 tests), including the Family C positive control, the seven-factory
multi-path negative control and the same-name same-version twin-instance
identity control.

`ADV2-087` is `NOT_AFFECTED` (**FAIL**) on base `6b5ad53` and `UNKNOWN`
(**PASS**) on this branch. That movement is what ADV2-087 proves, and it
proves it non-vacuously: the runtime aborts the class definition on both
flag values, the later safe export runs on neither, and base issues a
complete Family C negative proof for a package that reaches the sink.

**Where the valid-path controls are actually enforced — a correction.** An
earlier revision of this entry, of ADV2-087's oracle description and of the
fixture's own comment claimed that ADV2-087's seven valid-path negative
controls "sit BETWEEN the branch and the final export deliberately, so an
overreach on any of them flips the case's own verdict to `AFFECTED`". **That
claim is false**, and the independent audit disproved it by mutation:
changing one control (`throwOrBase`) to be all-fatal leaves ADV2-087
`UNKNOWN` and **passing**. The reason is structural — the canonical heritage
cutoff, `class Mode extends heritage(FLAG)` inside the `fast` branch, has
already made the module's exported value ambiguous by the time those
factories are reached, and a second cutoff cannot move an already-ambiguous
export. ADV2-087's end-to-end verdict is a detector for the POSITIVE defect,
not an individual detector for overreach in each control.

The controls themselves are real and were never the problem. They are
enforced at the SEMANTIC (module-model) layer, by
`module-model.multipath-class-definition-completion.test.ts`, where every
shape — throw+constructable, invalid+constructable, throw+`null`,
invalid+`null`, unknown+invalid, unknown+throw, and the nested valid leaf —
is asserted to refuse a cutoff on its own, in isolation, with no earlier
cutoff in the file to mask it. The same audit re-derived all of them
independently and found zero overreach. **No coverage was lost or added by
this correction; only the description of where that coverage is enforced was
wrong.**

The same distinction applies to the end-to-end fixture's
`valid-multipath` control. It is scanned from `src/valid-only.cjs`, which
`require`s the module and never CALLS its export, so its `NOT_AFFECTED` +
complete Family C result is a genuine statement about verdict and
negative-proof behavior, but it is not sensitive to whether any single
factory's authority was withdrawn. Read the division of labour this way:
**end-to-end fixtures prove overall verdict and proof behavior; the focused
module-model matrix proves the path-summary overreach controls.**

Validation baseline unchanged at 12 PASS / 5 KNOWN_FAIL / 0 UNEXPECTED / 17
total. Adversarial v1 34/34, v2 87/87.

### Self-review — the attack matrix, and what each attack found

Every row below was executed against real `node` before being pinned, and
all of them now live in the `self-review attack matrix` block of
`module-model.multipath-class-definition-completion.test.ts`.

| # | attack | result |
| --- | --- | --- |
| A | a constructable path silently dropped | **clean** — a valid leaf three `if`s deep still refuses; the same shape with every leaf fatal still withdraws |
| B | `null` treated as invalid | **clean** — `valid-null` is its own outcome and refuses, including buried in a deep leaf |
| C | an unknown path ignored | **clean** — one `"unknown"` refuses the whole summary; labeled statements and `break` poison it outright |
| D | implicit fallthrough ignored | **clean** — appended explicitly as `return undefined`, never absent |
| E | a nested function's `return` counted as an outer exit | **clean** — structurally impossible; pinned for nested declarations, methods, object-literal methods, class static blocks and IIFEs, in BOTH directions |
| F | a one-branch throw promoted to all paths | **clean** — an `else if` chain with a constructable tail refuses; the same chain all-fatal withdraws |
| G | a plain call gaining class-specific semantics | **clean** — `maybe(FLAG);` and `const v = maybe(FLAG);` answer identically to base |
| H | a reassigned callee using a stale summary | **clean** — `resolveExactLocalCallableIdentity` refuses (RWF-025), pinned in the unit matrix and ADV2-087 |
| I | P0-E alias/member absorbed | **clean** — both refuse; verified unchanged |
| J | RWF-020 regression | **clean** — single always-throwing callee and throw+throw both withdraw, same answers |
| K | RWF-022 regression | **clean** — single invalid return, direct invalid value, `extends null`, `async` and generator callees all unchanged |
| L | Family C globally suppressed | **clean** — both Family C controls still `NOT_AFFECTED` with `reachableSubgraphComplete: true` |
| M | false AFFECTED from partial enumeration | **clean** — the one shape that looked risky, a `return Base;` after two exiting arms, is genuinely UNREACHABLE at runtime; node returns 1 or 2 and aborts on both |
| N | a false `NOT_AFFECTED` remaining in a supported all-fatal set | **clean** — every supported combination withdraws; the unsupported ones refuse and are listed under Remaining limitations |

Two rows are worth stating rather than merely ticking.

**M was the only attack that could have gone either way.** Counting the
unreachable trailing `return Base;` as a path would be the exact mirror of
losing a real one: it would refuse a heritage that is genuinely fatal on
every path. The collector stops when neither arm of an `if` falls through,
which is what makes the answer right rather than lucky, and node confirms
`f` returns 1 or 2 and never `Base`.

**The depth bound refuses in the safe direction.** A six-deep nested `if`
whose every leaf is fatal is left UNKNOWN. That is a precision loss, is
recorded as one, and is the correct trade: a fixed, checkable ceiling is
what keeps "bounded" a property rather than a claim.

### Corpus

Scanned with a standalone syntactic scanner implementing RWF-027's own
allow-list, over every `.js`/`.cjs`/`.mjs`/`.ts` file (excluding `.d.ts`):

| | vendored third-party (`node_modules`) | repo `fixtures/` + `tests/` |
| --- | --- | --- |
| 1. files scanned | 3,071 | 948 |
| 2. class heritage clauses (any form) | 1,391 | 124 |
| 3. of those, a CallExpression heritage | 3 | 109 |
| 4. of those, an exact local callee | 3 | 75 |
| 5. of those, MULTI-exit callees | **0** | 31 |
| 6. of those, every ending fatal | **0** | 9 |

**Actual verdict movement in vendored real third-party code: zero.** All
1,391 heritage clauses there are `extends SomeBinding`; only three call
anything, and none of those three callees has more than one exit. The family
is real and runtime-confirmed, but — as with RWF-020 and RWF-022 before it —
it does not appear in the third-party code vendored here, so the syntactic
counts above must not be read as semantic impact.

All nine repo hits are RWF-027's own new fixtures. Two of them are
deliberate REFUSALS that this crude scanner cannot see, and they are listed
here rather than quietly filtered: `valid-multipath.js`'s `extends allBad()`
is inside a never-called `configure()`, so the real analyzer creates no
module-time cutoff, and `adv2-087`'s `extends reassigned()` follows
`reassigned = () => Base`, which `resolveExactLocalCallableIdentity` refuses
outright (RWF-025). The scanner models neither deferral nor reassignment;
the analyzer models both, and the integration tests assert it.

### Performance

`npm run test:performance` — both budgets met, no measurable change:
the ~300-file synthetic project completes in 2.36s against a 5,000ms
threshold, and the single-large-file case in 8.00s against a 20,000ms
threshold.

The summary is bounded by construction: a fixed nesting depth of 4 and a
fixed exit ceiling of 32, walking statements only and entering no expression
and no nested body. It is reached only from the class-heritage disjunct, so
a file with no `extends <call>` never runs it at all — which is why 1,391
heritage clauses across 3,071 vendored files cost nothing measurable. No
CFG, no interprocedural fixpoint, no whole-program call summaries, and no
new caching was required.

### Remaining limitations (deliberately not fixed here)

- **The plain-call axis is NOT closed, and must not be.** `maybe(FLAG);`,
  `const v = maybe(FLAG);` and `foo(maybe(FLAG))` stay unproven, because the
  call really does complete normally on one path. RWF-026's recorded P0-B
  limitation is closed **only** where the CLASS DEFINITION is the thing
  failing; everywhere else it stands exactly as written, and the branch
  answers all three identically to base.
- **Concise-bodied arrows and conditional expressions.** `flag => flag ? 1 :
  2` is refused: RWF-027 adds no conditional-EXPRESSION path model. A
  BLOCK-bodied arrow is fully supported. The `FLAG ? bail() : bail()` join
  RWF-026 recorded is likewise still open — this task's join is over a
  CALLEE's endings, not over an expression's arms.
- **`switch`, loops and `try`/`catch`/`finally` in a heritage callee** are
  refused wholesale. A `switch` whose cases all `return` an invalid value is
  fatal at runtime and recorded here as unproven; supporting it means
  modeling fallthrough and `break`, and exception flow is explicitly out of
  scope for this task.
- **Nested `if` deeper than 4 levels** refuses. The bound is fixed and
  checkable rather than heuristic; no real heritage factory observed needs
  more.
- **A call in a `return` operand** (`return helper();`) is `"unknown"`, so
  one such ending refuses the summary. Resolving it is interprocedural and
  belongs to RWF-028's provenance work, not here.
- **Value classification was not widened.** `return Symbol()`,
  `return someBinding` and any operator expression stay `"unknown"`, exactly
  as RWF-022 left them. RWF-027 composes that classifier across paths; it
  does not extend it.
- **P0-E (RWF-028)** — alias (`const alias = f; class C extends alias() {}`),
  member (`obj.f()`), transitive and `new` callees remain unresolved and must
  not become resolvable from this task's side. Verified unchanged.
  **Closed by RWF-028**, and deliberately not from this side: RWF-027's own
  heritage machinery (`summarizeExactCallHeritageOutcomes`,
  `isDefinitelyNonCompletingClassHeritageCall`,
  `resolveExactLocalCallableIdentity`) is bit-for-bit unchanged. The aliased
  heritage case now fires through RWF-026's shared EXPRESSION rule, because
  `class C extends alias() {}`'s heritage expression is itself a
  definitely-abrupt CALL once the callee resolves — a statement about the
  call, not about the class definition. See RWF-028's entry below.

## RWF-028 — An invocation whose CALLEE is already proven fatal but whose PROVENANCE was unresolved invalidates later CommonJS export authority

**Severity:** P0 / CRITICAL SOUNDNESS (false `NOT_AFFECTED`, with a complete
Family C proof)
**Status:** **Fixed.** Found by the P0 closure inventory (P0-E), recorded as
an explicit open follow-up by RWF-016, RWF-017, RWF-018, RWF-019, RWF-020,
RWF-024, RWF-026 and RWF-027, and independently reproduced on `e956acc`
(current merged main, RWF-027 included) before any edit here.

### The defect

Every earlier task in this family asked a question about a **callee**: can
this call complete normally (RWF-016), what value does it return (RWF-022),
does every ending of it prevent a class definition from completing
(RWF-027). This one asks nothing about the callee at all.

```js
function bail() { throw new Error("boom"); }   // already proven fatal
const alias = bail;

if (FLAG) {
  module.exports = dangerousOp;
  alias();                       // <- the analyzer could not name this
}

module.exports = safeOp;         // syntactically unconditional; never reached
```

`bail` is a local, never-reassigned function declaration whose body throws
on every path — the exact shape RWF-016 has proven fatal since the
beginning. The proof was already in hand and was **discarded**, because the
call site was not a bare identifier. Five confirmed cases, each
independently reproduced at base:

| | invocation | base verdict |
| --- | --- | --- |
| C07 | `const alias = bail; alias();` | NOT_AFFECTED + complete Family C |
| C08 | `function viaHelper() { bail(); } viaHelper();` | NOT_AFFECTED + complete Family C |
| C09 | `const h = { bail }; h.bail();` | NOT_AFFECTED + complete Family C |
| C10 | `{ const bail = () => { throw ... }; bail(); }` | NOT_AFFECTED + complete Family C |
| E01 | `new bail();` | NOT_AFFECTED + complete Family C |

All five were measured under real `node` v22.11.0: module evaluation ends at
the invocation, and `module.exports = safeOp` never runs. VulnTrace
nevertheless attributed `safeOp` as the whole module value, found
`dangerousOp` unreachable, and issued a **complete Family C negative proof**
for a package that reaches the sink on every load taking the early branch.

### The architectural inversion, and why it was NOT fixed at the gate

The closure inventory observed that `resolveExactLocalCallable` refusing a
callee is locally conservative but **globally unsound**: the refusal leaves
a later export's authority standing, and that authority is what produces the
false `NOT_AFFECTED`. It suggested fixing this at the authority gate rather
than by widening the resolver.

That suggestion was tested against the implementation and **rejected**. A
gate rule of the shape "an unresolved call plus a throwing callable
somewhere in this file withdraws authority" would withdraw authority from
calls it knows nothing about — `safeFn()`, `unknownFn()`, `obj.unknown()`,
`registry[name]()` — in any file that happens to declare one throwing
helper. That is not a soundness fix with a precision cost; it is a different
unsoundness, reporting demonstrably-completing modules as non-completing.
The `CRITICAL FALSE-AFFECTED CONTROL` block in
`module-model.invocation-provenance-soundness.test.ts` pins that this
analyzer does not do it.

What RWF-028 does instead is make the resolver able to **name the exact
function node** an invocation enters, for four bounded shapes — each with an
invalidation story it can actually discharge. Where provenance cannot be
named, the answer stays exactly what it was.

### The fix — bounded provenance resolution

`resolveInvocationTargetIdentity(callee)` in
`src/code-intelligence/module-model.ts` is the single new entry point, and
`isDefinitelyAbruptInvocation` is the single place a proof is established.
Both are reached from the one function RWF-017/018/019/020/024/026/027
already share (`isDefinitelyAbruptCall`), so every consumer inherits the
widened identity without any of them changing.

| shape | resolved by | invalidated by |
| --- | --- | --- |
| direct | `topLevelCallableCandidates`, unchanged | reassignment of the name |
| alias | `callableFromStatements`, one hop | reassignment of the ALIAS or the SOURCE name |
| wrapper | `callableAlwaysThrows`, depth-bounded | any surviving normal path; reassignment; recursion |
| member | `resolveObjectMemberCallable` | rebinding, ANY non-read use of the binding, a spread, a computed key, a duplicate key, a non-data property |
| shadow | `resolveIdentifierCallable`, nearest scope wins | ordinary lexical scoping |
| `new` | the same resolver + `isConstructableCallable` | reassignment of the constructor binding |

Three of these deserve their reasoning stated, because they are where a
"bounded" rule usually goes wrong.

**Lexical resolution replaced lexical refusal.** RWF-016 refused any
shadowed name outright. RWF-028 resolves the shadow properly, nearest
binding first, and an unsupported nearest binding refuses rather than
looking further out. That last clause is what makes the mirrored case safe:
`function bail() { throw } { const bail = () => "safe"; bail(); }` must
resolve to the INNER, safe binding. Resolving it to the outer one would be a
verdict invented out of a name collision, and it is pinned as a control in
the matrix, in `fixture-lib/valid.js` and in the ADV2-088 fixture.

**Object members required an escape test, not just a literal read.**
Reading the literal is not enough: `const h = { bail }; mutate(h);
h.bail();` genuinely completes, because `mutate` is free to install a safe
function. `confinedObjectBindings` therefore disqualifies a binding the
moment it is used in any way other than its own declaration and a plain
`h.x` read — passed as an argument, returned, exported, assigned from,
indexed, or written through. The walk covers the whole file, function
bodies included, because a closure that mutates the object is exactly what a
module-reachable-only walk would miss.

**The wrapper bound counts BODIES, not calls.**
`MAX_CALLABLE_ABRUPT_SUMMARY_DEPTH = 3` admits a direct call, one wrapper
hop and two wrapper hops, and refuses the third. There is no worklist, no
iteration to convergence and no cross-file propagation — just a counter that
runs out, plus a `callablesInProgress` set so a self- or mutually-recursive
body is refused on its own merits rather than accidentally proven by running
out of depth somewhere down the chain. `function helper() { helper(); }`
never completes, but it never throws either, and nontermination reasoning
stays out of scope exactly as RWF-016 documents.

### The semantic distinction this task rests on

RWF-028 proves nothing new about any callee. Every fatality answer is
RWF-016's `cannotCompleteNormally`, unchanged in meaning. What moved is the
answer to _"which function does this syntax enter?"_ — so a callee that was
never fatal does not become fatal through an alias, an object property or a
`new`, and the `async`/generator exclusions carry through every new shape
unchanged (`const alias = asyncBail; alias()` stays unproven, because
calling an `async` function returns a rejected promise rather than throwing
synchronously).

### `new` is a construct, not a call — and the line is drawn at the body

`new bail()` on an ordinary function declaration enters the body, which
throws: proven. `new` on an **arrow**, an `async` function or a generator
also ends module evaluation — with `TypeError: X is not a constructor` —
but it throws on constructability _before the body runs_. That is a
different proof, this rule does not perform it, and claiming it would
quietly assert that the arrow's body executed when the ground-truth fixture
measures (with a body-entry flag) that it did not. All three are refused and
recorded below as precision gaps.

### Ground truth

`fixtures/commonjs-circular-import-invocation-provenance-ground-truth/`,
run with real `node` v22.11.0, asserts (never merely prints) that the
aliased call enters `bail`'s **own** body, that `const alias = f` binds the
same function object as `f`, that a cyclic consumer retains the dangerous
export **by identity** before the throw, that the later safe assignment
never runs, that the retained export genuinely reaches the vulnerable sink,
and that a failed load re-throws coherently.

Its `forms.js` writes **47 real modules**, loads each, and measures whether
evaluation reached the later export write:

- **15 proven cutoffs**, every one of which genuinely aborts;
- **23 refused rows**, every one of which genuinely completes;
- **9 rows that abort but are not proven** — the precision gaps below,
  asserted as such so the gap list cannot silently drift.

### Differential (base `e956acc` → branch)

| | base | branch |
| --- | --- | --- |
| C07 / C08 / C09 / C10 / E01 (`fixture-lib/danger#explode`) | **NOT_AFFECTED**, `confirmedUnreachableTarget` with `reachableSubgraphComplete: true` | **UNKNOWN**, no negative proof |
| ADV2-088 | **NOT_AFFECTED** (false) | **UNKNOWN** |
| `fixture-lib/valid` (negative controls) | NOT_AFFECTED + complete Family C | **unchanged** |
| `fixture-lib/stable` (Family C positive control) | NOT_AFFECTED + complete Family C | **unchanged** |

`UNKNOWN → NOT_AFFECTED`: **0**. `AFFECTED → NOT_AFFECTED`: **0**. No
verdict anywhere moved toward `NOT_AFFECTED`.

Nineteen existing tests changed expectation, and all nineteen are the
boundary pins that recorded P0-E as OPEN — RWF-016's "keeps authority for an
ALIASED call", RWF-018/019's "keeps authority for a MEMBER callee",
RWF-026's "does not absorb P0-E", and so on. Each was rewritten to assert
the new, sound answer with its reproducer text verbatim, and each file kept
a refusal row for the shapes RWF-028 still declines.

### Corpus

Measured with the REAL module model (not a re-implementation): every file
was run through `indexSourceFile` → `buildModuleModel` →
`mapExportsToFunctions` on base and on branch, and the whole-module
attribution answers were diffed.

| | vendored third-party (`node_modules`) | repo `fixtures/` | repo `tests/` |
| --- | --- | --- | --- |
| 1. files scanned | 1,766 | 247 | 724 |
| 2a. `const <id> = <id>` declarations | 2,350 | 6 | 2 |
| 2b. `const <id> = { ... }` declarations | 3,123 | 13 | 5 |
| 2c. `<id>.<prop>(...)` calls | 52,044 | 561 | 356 |
| 2d. calls to a top-level local name | 25,315 | 301 | 63 |
| 2e. block bindings shadowing a top-level name | 9 | 0 | 0 |
| 2f. `new <top-level local>()` | 1,384 | 4 | 1 |
| 7. **actual verdict movement** | **0** | 6 | 1 |

**Actual verdict movement in vendored real third-party code: zero**, across
1,766 files carrying 2,350 alias declarations, 3,123 object literals, 52,044
member calls and 1,384 local `new` expressions. The syntactic counts are a
deliberate over-count of _candidate shapes_ and must not be read as semantic
impact: a shape only moves a verdict when its callee is definitely abrupt,
the invocation is module-reachable and uncaught, and a later export write
follows it. All seven repo movements are RWF-028's own new fixtures.

### Performance

`npm run test:performance` — both budgets met, no measurable change: the
~300-file synthetic project completes in 2.30s against a 5,000ms threshold,
and the single-large-file case in 8.20s against a 20,000ms threshold.

Nothing global was added. There is no points-to set, no heap model, no
recursive fixpoint and no whole-program summary. Resolution is bounded by a
one-hop provenance budget and a three-body depth counter; the scope walk is
bounded by the call site's own nesting depth; and the two new per-file facts
(`moduleReachableCallableCandidates`, `confinedObjectBindings`) are cached
per `ts.SourceFile` like every other module-model fact, with the latter
computed only when an object-member invocation is actually being decided —
which `fileHasDefinitelyAbruptCallable` has already gated.

That gate had to be widened, and the reason is worth recording: it is what
keeps the analysis COHERENT rather than merely fast. It now sees
block-scoped and object-literal-held callables too, because otherwise
whether `h.run()` was provable would have depended on some UNRELATED
throwing callable existing elsewhere in the file — precisely the file-level
inference this task exists to avoid.

### Self-review — one real defect found and fixed

The attack pass ran 36 shapes against the branch, and **four landed** —
all the same defect, and a false AFFECTED introduced by this task:

```js
const h = { bail };
({ x: h.bail } = { x: safeFn });   // writes h.bail
[h.bail] = [safeFn];               // writes h.bail
for (h.bail of list) {}            // writes h.bail
h.bail();                          // ...and this COMPLETES
```

`confinedObjectBindings` disqualified a binding written through `h.x = v`,
`h.x++` and `delete h.x`, because it inspected the property access's
IMMEDIATE parent. A destructuring write target can be nested arbitrarily
deep inside a pattern that is syntactically an object or array LITERAL, and
a `for..of`/`for..in` write target hangs off the loop rather than off an
assignment — so none of those four was seen, and all four were proven
non-completing for programs that complete perfectly well.

`isWriteTargetPosition` replaces the immediate-parent test with a climb
through the pattern's own structure (parentheses and TS type-only wrappers,
array and object literals, property assignments, spreads), answering `true`
only when the climb lands on something that really is an assignment. Climbing
a literal proves nothing on its own, which is what keeps `foo({ a: h.x })`
and `const y = [h.x]` correctly READ positions — pinned in both directions in
the matrix.

The other 32 attacks held as written, including: a stale alias after
reassignment, an alias resolved in the wrong scope, an overwritten and a
safe-last duplicate property, a reassigned object binding, a wrapper whose
conditional/returning/catching/deferring path survives, recursion, an
`async` and a generator throw in every provenance form, `new` on an
arrow, an optional-chain receiver, RWF-025 reassignment facts in each new
shape, RWF-026 propagation through conditional and deferred positions,
Family C global suppression, and PackageInstance substitution by
name-and-version.

### Independent audit — one blocker found and fixed

An independent soundness audit of the four-commit branch returned
`RWF028_BLOCKED` on a defect the implementation's own self-review missed.

`scopeDeclares` modelled a `catch` clause's parameter, `for`-loop bindings
and a scope's own statement list — but **not a function's parameters, nor a
named function expression's own name**. Until RWF-028 that omission was
unreachable: this walk only ever started at a MODULE-SCOPE call site, so a
function-like node was never one of the ancestors it visited. RWF-028's
wrapper analysis is the first consumer that resolves an identifier from
INSIDE a function body, and the walk stepped straight over the function
boundary out to module scope:

```js
function bail() { throw new Error("boom"); }
function w(bail) { bail(); }   // the PARAMETER, not the outer callable
w(safeFn);                     // ...so this COMPLETES
module.exports = second;       // and this RUNS
```

The branch resolved that body's `bail()` to the outer, throwing `bail` and
withdrew the later export's authority — a **false AFFECTED** for a module
that runs to completion. Base kept authority; the branch withdrew it, so it
was branch-attributable. Seven shapes reproduced it (plain parameter, second
parameter, default parameter, destructured parameter, arrow wrapper,
function-expression wrapper, depth-2 nested wrapper), each confirmed to
complete under real `node` with a later-export flag.

The fix is at the shared lexical-declaration boundary rather than in the
wrapper resolver: `scopeDeclares` now treats a function-like scope as
declaring every binding introduced by its parameters (through the existing
`bindingNameIncludes`, so every pattern form — default, object, renamed
object, nested, array, rest — is covered by machinery that already handled
them) and a named `FunctionExpression` as declaring its own name inside its
own body.

Two properties of that fix are pinned rather than assumed:

- a parameter is a **shadowing barrier, never positive provenance**.
  `function w(bail) { bail(); } w(realThrower);` aborts at runtime and is
  still REFUSED, because proving it needs call-site arguments mapped onto
  parameters. That is base's answer too — precision, not soundness.
- a function expression's self-name **does not leak**.
  `const x = function f() {}; f();` resolves nothing, exactly as before:
  the walk only ever visits ancestors of the call site, so the expression
  is never consulted from outside its own body.

The audit separately classified two shapes as **pre-existing and not
branch-attributable**, verified by measuring both sides: a nested `var`
redeclaring a callable name, and an Annex B block function declaration
overwriting an outer binding. Both withdraw on base and on branch alike.
They are unchanged here and recorded below.

Corpus after remediation: across 3,875 files, exactly **one** attribution
changed — the new `param-shadow.js` control, withdrawn before and
attributed after. **Zero** files newly withdrawn, and no third-party
movement in either direction.

### Remaining limitations (deliberately not fixed here)

- **Source rebinding after alias capture.** `const alias = bail; bail =
safeFn; alias();` really does throw — `alias` captured the original
  function value. VulnTrace refuses, because distinguishing "the value this
  alias captured" from "whatever this name holds now" needs an ordering
  model over rebinding that this task does not build. Between an unsound
  proof and a refusal the refusal is the only available answer; measured in
  `forms.js` so the gap is documented by execution.
- **`new` on a non-constructable callable** (arrow, `async`, generator) is
  refused, for the reason set out above: the module does end, but on
  constructability rather than on the body this rule read.
- **Object METHOD shorthand** (`{ bail() { throw } }`) is refused. A
  `MethodDeclaration` is a node shape the rest of this file's callable
  machinery does not take, and widening that union across the file is not
  the "trivial" extension the shape suggests. An accessor of the target name
  refuses too, and must: reading the property RUNS code.
- **Class constructor bodies.** `class C { constructor() { throw } } new C();`
  is outside the callable-summary model entirely. Probed, refused, recorded.
- **Beyond the documented bounds**: a second alias hop, a third wrapper hop,
  and `h["bail"]()` — a computed member whose key is a literal this relation
  could resolve but deliberately does not, because doing so is the first
  step of the dynamic-property analysis this task is scoped not to build.
- **Optional RECEIVERS** (`h?.bail()`) are refused, since deciding them
  means proving the receiver non-nullish. An optional CALL on an
  already-proven callee (`h.bail?.()`, `alias?.()`) IS decided, for exactly
  the reason RWF-016 documents for `bail?.()`: the callee is an
  exactly-resolved function declaration and cannot be nullish, so the
  optional token changes nothing about whether the call happens.
- **A nested `var` redeclaring a top-level callable name** (`{ var bail =
safeFn; }`) is not collected as a reassignment —
  `reassignedModuleReachableNames` inspects assignment EXPRESSIONS, not
  hoisted `var` declarations. This predates RWF-028 and is unchanged by it
  (the branch answers such files identically to base); it is recorded here
  because the corpus scan is the first thing to have looked for it. It costs
  precision, never soundness.
- **Parameter VALUES are not propagated.** A wrapper parameter shadows the
  outer binding, and the invocation through it stays unresolved — including
  when the argument really is the throwing callable. Mapping call-site
  arguments onto parameters is interprocedural value flow this task does not
  build; refusing matches base and costs precision only.
- **The class-heritage axis was not widened from this side.** RWF-027's
  `summarizeExactCallHeritageOutcomes` and its own resolver are bit-for-bit
  unchanged. `class C extends alias() {}` does now lose authority, but
  through RWF-026's shared EXPRESSION rule — the heritage expression is
  itself a definitely-abrupt call once the callee resolves — which is a
  statement about the call, not about the class definition.

## RWF-025b — The same broad assignment-target traversal, in CommonJS re-export provenance

**Severity:** P2 / PRECISION ONLY (lost CommonJS re-export attribution;
`UNKNOWN`, never a false `NOT_AFFECTED`)
**Status:** **Fixed.** Reported by an independent audit as an analogous
traversal to RWF-025's, and independently reproduced here on `ebecc57`
(current merged main, RWF-028 included) before any edit. The audit's
precision-only classification was NOT taken on trust — it was re-derived
from the consumers and then measured end to end; see *Direction* below.

### The defect

`commonjs-reexports.ts`'s `collectFacts` records every name a file WRITES
TO in `CommonJsFacts.reassignedNames`. That set is this file's
authoritative NEGATIVE provenance (RWF-013b): `classifyLocalBinding`
consults it FIRST, before any question about declaration form, and refuses
every name in it. A refused name can carry no CommonJS re-export origin,
no alias chain, and no function attribution anywhere in the file.

It was filled by a `markAssigned` whose last line was:

```ts
ts.forEachChild(target, markAssigned);
```

— the exact shape RWF-025 removed from `module-model.ts`, answering the
same question for a different relation. An assignment target's syntax tree
holds two independent kinds of thing: the **destinations** written to, and
the **expressions merely evaluated** to work out which destinations those
are. The blind child walk could not tell them apart, so a bare reference in
an evaluated-only position was recorded as a write:

```js
({ [keyFor(alias)]: seen } = REGISTRY);   // rebinds `seen`; READS `alias`
REGISTRY[keyFor(alias)] = true;           // rebinds NOTHING; READS `alias`
({ seen = keyFor(alias) } = REGISTRY);    // rebinds `seen`; READS `alias`
```

`CommonJsFacts` is cached per `ts.SourceFile`, so ONE such statement —
anywhere in the file, semantically unrelated to any export — withdrew a
real re-export origin **file-wide**:

```js
var vulnerable = require("./lib").vulnerable;
REGISTRY[keyFor(vulnerable)] = true;       // <- the only thing that changed
exports.vulnerable = vulnerable;           // origin lost: no `./lib` hop
```

Reproduced on merged main through the real pipeline in
`fixtures/commonjs-reexport-computed-key-reassignment-provenance/` (whose
README carries the `node`-measured ground truth): the facade's `vulnerable`
IS `lib.js`'s `vulnerable`, `src/index.cjs` calls it, and the scan came
back `UNKNOWN`.

### Direction — precision-only, independently verified

The audit's classification holds, and for a structural reason rather than
an incidental one:

1. The defect only ever ADDS a name to `reassignedNames`, and every
   consumer of that set REFUSES on membership. It can withdraw attribution;
   it can never manufacture any.
2. An export nothing can attribute is an unresolved target.
   `mapExportsToFunctions` skips it, `resolveCommonJsReExport` returns no
   node, and `call-graph.ts` records the failed hop as an explicit
   `unknown(unresolved_target)` edge.
3. A Family C `confirmedUnreachableTarget` proof requires a COMPLETE
   subgraph. An unknown edge on the path FORECLOSES `NOT_AFFECTED` rather
   than enabling it — which is precisely RWF-013's and RWF-011's design.
4. RWF-021's root behavior cannot convert the loss into a negative proof
   either: withdrawn export attribution subtracts a reachability ROOT, and
   RWF-021 exists to keep that from being read as unreachability. Its
   controls are re-run unchanged.

The correction therefore restores resolution the file always justified; it
withdraws no edge, so it cannot complete a subgraph by subtraction. The
measured verdict differential across the fixture suite and the canonical
validation baseline is **one row**, `UNKNOWN → AFFECTED`, with
`UNKNOWN → NOT_AFFECTED = 0` and `AFFECTED → NOT_AFFECTED = 0`.

No ADV2 case was added: per the adversarial policy those record
soundness-critical defects, and this is not one. The evidence here is the
focused matrix, the end-to-end fixture, and the corpus measurement.

### The fix

`markAssigned` now descends through ASSIGNMENT-TARGET STRUCTURE only —
identifier, object/array destructuring pattern, spread, default, and the
property/element-access forms that mutate an object rather than rebind a
name — and hands every evaluated-only position (a computed key, an
element-access index and object expression, a destructuring default) to a
second traversal, `markAssignmentsInsideEvaluatedExpression`, which
descends only to FIND assignment and update OPERATIONS and collects names
only from their targets. A bare identifier is never collected there;
`alias = other` records `alias` and not `other`, and `keyFor(alias)`
records nothing.

Collapsing the two in EITHER direction is a defect, and both directions are
pinned: the read-only rows fail on base, and the real-write rows fail
against a naive fix that simply ignores evaluated subexpressions. The
fixture's third entrypoint exists for the second direction — the facade
writes `REGISTRY[(rebound = require("./lib").reboundReplacement)] = true`,
a genuine reassignment spelled inside exactly the element-access index the
fix stops walking blindly. Losing it would re-open RWF-013 by attributing
`fixture-lib#rebound` to a function the package does not export.

This is deliberately the same semantic split as RWF-025's
`markLocallyReassigned` / `markAssignmentsInsideEvaluatedExpression` in
`module-model.ts`. The two are NOT shared code: they collect into different
models over different reach rules (see the limitation below), and neither
owns the other's scope. They are kept semantically identical about what a
target rebinds, and `commonjs-reexports.reassignment-target-provenance.test.ts`
carries a twin-comparison block asserting they do not diverge on the
observable they share.

### Corpus

Two scans (`scripts/rwf-025b-corpus.mjs`), each recomputing
`reassignedNames` twice over the same visit driver — once with the old
broad traversal, once with the new split — and diffing:

| | fixtures | vendored `node_modules` |
| --- | --- | --- |
| files scanned / parsed | 254 / 254 | 4,550 / 4,550 |
| syntactic assignment targets | 432 | 153,646 |
| non-identifier targets | 353 | 78,044 |
| targets containing identifier references | 353 | 77,296 |
| files with ≥1 poison candidate under the old traversal | 9 | 643 |
| poison names under the old traversal | 26 | 2,808 |
| files containing CommonJS export/`require` logic | 240 | 2,073 |
| poison files that also contain CommonJS export logic | 9 | 488 |
| names NEWLY recorded by the new traversal | **0** | **0** |

The last row holds for every shape, not just the ones these corpora happen
to contain. An earlier draft of this entry claimed one exception — that
`getHolder((alias = other)).x = 1` was newly recorded, since `markAssigned`
used to return early on a `PropertyAccessExpression` target without
inspecting its receiver. That claim was wrong, and the independent audit
measured it on both sides: `alias` is recorded as a write on BASE and on
BRANCH alike.

The two arrive at it by different routes, which is why reading
`markAssigned` alone was misleading. On base the write is reached by
`collectFacts`'s own whole-file `visit` driver, which recurses through
every node — the left-hand side of the assignment included — and handles
the nested `alias = other` as an assignment in its own right, whichever
enclosing traversal declined to look at it. On the branch it is reached
BOTH that way and explicitly, through
`markAssignmentsInsideEvaluatedExpression` on the receiver. The new
traversal therefore introduces no widening for this shape, and none for
any other: every name it records, base records too.

What changes is only the other direction. Bare references in evaluated
positions — a computed key, an element-access index, a property-access
receiver, a destructuring default — stop being counted as writes, while
every real nested assignment and update in those same positions keeps
being counted. Observed reassignment tracking on the branch is thus a
strict subset of base's, and the names it drops are exactly the false ones.

One asymmetry is resolved in passing: base recorded `alias[k] = 1` as a
write to `alias` while already treating `alias.x = 1` as a read. The
branch makes property MUTATION consistently not a rebinding of the object
binding, whichever way the property is spelled.

The remaining counts are SYNTACTIC poison candidates — names the old traversal
would have recorded and the new one does not. They are not a claim that 643
third-party files changed verdict; verdict movement is measured by the
fixture suite and the validation baseline, and was one row.

### Remaining limitations (deliberately not fixed here)

- **Reassignment is keyed by identifier TEXT, whole-file.**
  `CommonJsFacts` does not resolve symbols, so a write to a same-named
  INNER binding still marks the outer name, and any re-declaration of a
  name refuses it on `declarationCounts` independently of reassignment.
  RWF-025b neither widens nor narrows that: it is conservative in the safe
  direction (it only ever REFUSES attribution) and fixing it means a
  symbol-resolved binding model this task is scoped not to build. Pinned in
  the matrix's scope block so the inherited behavior is documented by
  execution rather than assumed.
- **No reach restriction.** Unlike RWF-025's twin, this model counts a
  write inside a function body as a write, because `CommonJsFacts` is
  whole-file by design. That is the one axis on which the two traversals
  intentionally differ, and it is preserved rather than harmonised — the
  evaluated-subexpression walk here does not stop at a function boundary.
- **The evaluated walk is redundant with `collectFacts`'s own recursion.**
  `visit` already reaches every node it reaches, so no currently-observable
  behavior depends on it. It is kept so that the target walk is complete ON
  ITS OWN, rather than relying on a second, independently-evolving walk to
  compensate for the names it deliberately declines to collect.

## P0-Z remediation — A configured entrypoint's reachability ROOT vanishes when its exported callable is not local, and Family C still certifies completeness

**This is a SOUNDNESS fix, not a precision one.** It removes eight
reproduced false `NOT_AFFECTED` verdicts, each carrying a complete
`confirmedUnreachableTarget` proof for a target real Node executes.

### The defect

The P0-Z transversal audit reproduced six false `NOT_AFFECTED` verdicts
sharing one root cause; this remediation's own mutation matrix found a
seventh shape and an eighth (the two-hop chain), all the same mechanism.

```js
// src/index.js -- the CONFIGURED ENTRYPOINT
module.exports = require("./sibling.js");

// src/sibling.js
module.exports = { run: () => require("vlib").vulnerable() };
```

Real Node: `RUN_EXPORTED`, `VULN_EXECUTED`. VulnTrace on `047b68d`:
`NOT_AFFECTED` + `confirmedUnreachableTarget.reachableSubgraphComplete: true`.

`entrypointSourceNodes` roots reachability at the entrypoint's `<module>`
node plus the callables `entrypointRootCandidates` names, and it matches
those names only against nodes **in the entrypoint's own file**. A
re-exported callable is defined elsewhere, so it contributes no local root.
`entrypointRootCandidates` returned `{names, locations}` with no
completeness channel, so that outcome was **indistinguishable** from a file
that genuinely exports nothing:

```js
const x = 1;                              // no exported callable: COMPLETE
module.exports = require("./sibling.js"); // a callable I cannot root: INCOMPLETE
```

Both produced zero names. `analyzeReachability` then searched from the
`<module>` node alone, drained its queue, met no unresolved edge, and
returned `unreachable` — which family C serialized as
`reachableSubgraphComplete: true`. The subgraph really was exhausted. It
was simply never **rooted**, and nothing in the pipeline could say so.

This is the same class of defect RWF-021 fixed for export-attribution
withdrawal, reached through a different route: RWF-021 stopped a *withdrawn
attribution* from deleting the root, but a *foreign-origin* export never had
a local root to withdraw.

### Direction — pre-existing, not a regression

Reproduced identically at `9c0ca73` (pre-RWF-025) and at the audited
`047b68d`. None of RWF-025/025b/026/027/028 introduced or widened it. It is
recorded here as a soundness defect rather than deferred, because P0 closure
criterion 1 is branch-current: a reproduced false `NOT_AFFECTED` in
supported semantics blocks regardless of age.

### The fix — root derivation reports its own completeness

`EntrypointRootCandidates` gains `complete: boolean` and a structured
`incompleteness: readonly EntrypointRootIncompleteness[]`, with three
reasons:

| reason | shape |
| ------ | ----- |
| `unresolved_entrypoint_reexport` | `module.exports = require("./x")`, `module.exports.run = require("./x").run`, `export { run } from "./x"`, `export * from "./x"`, `module.exports = require("pkg")` |
| `unresolved_export_forwarding` | `Object.assign(module.exports, ...)`, `Object.defineProperty(module.exports, ...)` — the export object in a call's mutation-target (first-argument) position |
| `unresolved_computed_export_name` | `module.exports[k] = run` — a LOCAL callable published under a name only the runtime knows |

Both module syntaxes are covered, each read off the field that already
carries the fact: ESM arrives as `kind: "re-export"`, CommonJS as
`commonJsReExport`. A NAME on the binding does not make it rootable —
`export { run } from "./x"` and `module.exports.run = require("./x").run`
both carry `run` and both publish a callable defined elsewhere.

`checkReachability` computes this once for the whole entrypoint set and
withholds `unreachableTarget` — family C's witness — when it is non-empty.
`buildFinding`'s existing `if (!unreachableTarget)` guard then returns
`UNKNOWN`, reporting the root gap rather than the misleading "nothing was
searched to exhaustion".

### Why the gate is at the family C witness and nowhere else

Setting `sawUnknown` instead would have been simpler and wrong: that flag is
checked **before** family B, so an unrootable entrypoint would also have
withdrawn family B's proof. Family B reasons from call-graph traversal
corroborated by the module-load closure, neither of which depends on
entrypoint roots. Families A and B are therefore untouched, by construction
rather than by assertion — A returns before `sawUnknown` is even consulted,
and B's branch is never reached differently than before.

Root incompleteness is also kept **separate from
`ModuleLoadClosure.complete`**. They are independent assumptions about
different traversals. An entrypoint that cannot be PARSED is deliberately
not a reason in this enumeration: that file is also a closure root, so
`parse_failure` is already recorded there and
`invalidatesCallGraphNegativeProof` already blocks families B and C on it.
Duplicating it would blur which condition actually mattered.

The uncertainty is represented at its own layer. No phantom unresolved call
EDGE is fabricated to force the verdict: the real uncertainty is "we do not
know the root", and the diagnostic says exactly that.

### Ground truth

`fixtures/entrypoint-reexport-root-completeness/verify.cjs` runs under plain
`node` and asserts, for every blocker form, that the entrypoint really does
publish a callable and that calling it really does reach the vulnerable
sink. The analyzer's obligation is measured against that, not against a
committed expectation.

### Differential (base `047b68d` → branch)

| | base | branch |
| --- | --- | --- |
| the 8 blocker forms (2 assertions each) | **16 failed** | **28 passed** |
| direct-export control | AFFECTED | AFFECTED |
| valid Family C control | NOT_AFFECTED + complete proof | NOT_AFFECTED + complete proof |
| no-callable-export control | NOT_AFFECTED + complete proof | NOT_AFFECTED + complete proof |
| export-object READ control | NOT_AFFECTED + complete proof | NOT_AFFECTED + complete proof |

All four controls pass on **both** sides. That is what makes this a targeted
fix rather than a blanket disabling of family C.

Global verdict movement: `UNKNOWN → NOT_AFFECTED` = **0**,
`AFFECTED → NOT_AFFECTED` = **0**. Full suite 3328/3328; canonical
validation unchanged at 12 PASS / 5 KNOWN_FAIL / 17; adversarial 122/122.
Every `NOT_AFFECTED` in the real-world corpus (RWB-06, RWB-06A, RWB-07,
RWB-11b) is preserved.

### Corpus

`scripts/p0z-entrypoint-root-corpus.mjs` over `fixtures/` + `tests/`:

| | count |
| --- | --- |
| files scanned | 1048 |
| files that failed to index | 0 |
| files with any export | 972 |
| COMPLETE root derivation | 985 |
| INCOMPLETE root derivation | 63 |

Of the 63, eleven are this task's own fixture and the remainder are
`node_modules` library internals and circular-import ground-truth helpers —
none of them a configured entrypoint. Only a file that is BOTH a configured
entrypoint AND derives roots incompletely can lose a family C proof, which
is why the corpus moved no verdict.

### Performance

Local to entrypoint root derivation: two extra linear AST walks over the
entrypoint file only (entrypoints are few, and the file was already being
indexed). No whole-program fixpoint, no new global CFG, no recursive export
graph. `scan-performance` unchanged: 2.3s / 8.3s against the 5s / 20s
thresholds.

### Remaining limitations (deliberately not fixed here)

- **A re-export is reported, never resolved.** The fix makes the
  uncertainty visible; it does not chase a re-export to its origin module
  and root the callable there. Doing so would need cross-module roots in
  `entrypointSourceNodes`, which matches only same-file nodes today. The
  cost is precision: a re-exporting entrypoint yields `UNKNOWN` where a
  cross-module root could have yielded `AFFECTED` or a genuine family C.
  This is the "either is acceptable, false NOT_AFFECTED is not" trade the
  task allows, taken in the sound direction.
- **`unresolved_export_forwarding` over-reports a first-argument READ.**
  `JSON.stringify(module.exports)` is reported, because distinguishing a
  reading callee from a mutating one is the whole-program question this fix
  is scoped not to open. The costs are asymmetric — over-reporting turns a
  `NOT_AFFECTED` into an `UNKNOWN`; under-reporting turns a reachable
  target into a false `NOT_AFFECTED` — so the imprecise direction is taken
  knowingly rather than narrowed to a fragile allowlist of known-mutating
  callees. A mention outside first-argument position is NOT reported, and
  that control is pinned by execution.
- **A configured `{file, symbol}` entrypoint derives no export surface and
  is never incomplete.** That narrowing is explicit user instruction
  (SDD-v0.2.md § 6 / VT-205), so there is no derived root to be uncertain
  about. A symbol that does not resolve to a node still leaves only the
  `<module>` root, exactly as before; unchanged by this task.
- **Root incompleteness is internal analysis state.** It is not serialized
  into the finding schema — it reaches the output only as the `UNKNOWN`
  reason string. No user-facing schema expansion was made.

### P0-Z final remediation — literal-bracket CommonJS exports were never modeled at all

The focused re-audit of the remediation above found **one surviving false
`NOT_AFFECTED`**, and it was not a re-export:

```js
const dep = require("vlib");
function run(u) { return dep.vulnerable(u); }
module.exports["run"] = run;          // LOCAL callable, statically exact key
```

Real Node: `LOADED → EXPORT_OBTAINED → SINK_EXECUTED`. The analyzer:
`NOT_AFFECTED` + `confirmedUnreachableTarget.reachableSubgraphComplete: true`.

**Chronology, stated plainly.** The original P0-Z audit found one root-loss
family and reproduced six forms of it. The first remediation introduced
root-derivation completeness and closed those six plus two more it found
itself (a two-hop chain and a dynamic computed export name). The focused
re-audit then found that *element-access* CommonJS exports bypassed export
description entirely — a third route into the same root loss. This entry
records the fix for that.

**Why it survived the first remediation.** `describeCommonJsExportTarget`
(source-index.ts) returned `undefined` for anything that was not a
`PropertyAccessExpression`, so `module.exports["run"]` produced **no export
binding at all** — not a withdrawn one, not an imprecise one, none. No
binding means no root candidate. The first remediation then *excluded*
literal keys from `computedExportNameWrites` on the stated grounds that they
were "statically named and already modeled". The first half was true and the
second was false: nothing modeled them. The result was the exact state the
whole P0-Z effort exists to eliminate — an export write that no layer models,
reported as a COMPLETE derivation with zero roots.

**The fix.** `exactCommonJsExportPropertyName` is now the single place that
decides whether an element-access key can be named, and all three sites that
must agree read it:

| site | consequence of disagreement |
| ---- | --------------------------- |
| `describeCommonJsExportTarget` (source-index.ts) | no export binding → no root |
| `commonJsExportPropertyName` (commonjs-reexports.ts) | a bracket RE-export loses `commonJsReExport`, so `isForeignOriginExport` misses it and the derivation reports COMPLETE again |
| `computedExportNameWrites` (module-model.ts) | a key refused by the other two must surface as incompleteness, or it is modeled nowhere |

The middle row is not hypothetical: `module.exports["run"] =
require("./x").run` reproduced the original defect in a new shape when only
the first site was fixed, and is pinned as a test.

Exact keys are a string literal, a no-substitution template literal (both
already `ts.isStringLiteralLike` across this codebase), and a numeric literal
whose text round-trips (`String(Number(text)) === text`). The round-trip
guard is what keeps this from inventing a normalization scheme:
TypeScript already normalizes `1e3` to `"1000"` and `0x10` to `"16"`, which
are the property names JavaScript actually produces, and anything that does
not round-trip is refused rather than mis-named. Identifiers, calls,
templates WITH substitutions, bigints and computed symbols stay refused and
therefore stay incomplete.

**Equivalence, not a parallel path.** `module.exports["run"] = run` now
produces the same binding, the same root candidate and the same completeness
as `module.exports.run = run`, asserted directly rather than by inspection —
including for the `exports` alias and for re-export provenance. Parity was
verified on the awkward forms too (nested `module.exports.a["b"]`,
reassigned `exports`, shadowed `module`): bracket inherits whatever the dot
form already does rather than acquiring new rules of its own.

**Differential (pre-fix `2528feb` → fixed).**

| case | pre-fix | fixed |
| ---- | ------- | ----- |
| `module.exports["run"]` | NOT_AFFECTED + Family C | **AFFECTED** |
| `exports["run"]` | NOT_AFFECTED + Family C | **AFFECTED** |
| escaped `["run"]` | NOT_AFFECTED + Family C | **AFFECTED** |
| no-substitution `` [`run`] `` | NOT_AFFECTED + Family C | **AFFECTED** |
| numeric `[0]` | NOT_AFFECTED + Family C | **AFFECTED** |
| `["run"] = require("./x").run` | NOT_AFFECTED + Family C | **UNKNOWN**, no Family C |

Five of the six reach AFFECTED rather than UNKNOWN because the root is
genuinely derivable and a real path exists — the preferred outcome, and the
reason this was fixed by MODELING the form rather than by declaring it
incomplete. The safe counterpart (`module.exports["run"] = safeRun`) keeps a
genuine complete Family C, so bracket support invents no reachability.

Whole-module export, whole-module re-export, dot property export, dynamic
computed keys, the eight earlier blocker forms, the no-callable-export
control, Family A and Family B are all unchanged. Full suite 3359/3359;
canonical validation unchanged at 12 PASS / 5 KNOWN_FAIL / 17.
`UNKNOWN → NOT_AFFECTED` = 0, `AFFECTED → NOT_AFFECTED` = 0.

**Corpus.** Bracket export syntax occurs in exactly four files across
`fixtures/` + `tests/`, all of them this task's own fixtures. No
pre-existing corpus file uses the form, so the fix moved no corpus verdict —
stated as measured, not as an impact claim.

### Remaining limitations (deliberately not fixed here)

- **Nested export properties are still unmodeled**, in both spellings:
  `module.exports.a.b = run` and `module.exports.a["b"] = run` alike produce
  no binding. Bracket now matches dot exactly, so this fix introduces no new
  asymmetry, but the underlying gap predates P0-Z and is untouched.
- **Refused keys lose precision, not soundness.** A dynamic key degrades the
  whole entrypoint to UNKNOWN even when a sibling export is perfectly
  rootable; incompleteness is per-entrypoint, not per-export.

### P0-Z root-loss remediation, round 3 — an exported local ALIAS is a candidate, not a root

The final focused re-audit of the bracket fix found **one more false
`NOT_AFFECTED`**, and it was neither a re-export nor a bracket key:

```js
const dep = require("vlib");
function bad(u) { return dep.vulnerable(u); }
const alias = bad;
module.exports.run = alias;     // also ["run"] = alias, and { run: alias }
```

Real Node: the export is obtained, `alias` invokes `bad`, and the sink
executes. The analyzer: `NOT_AFFECTED` +
`confirmedUnreachableTarget.reachableSubgraphComplete: true`.

**Chronology.** Round 1 found one root-loss family and six forms of it, and
introduced root-derivation completeness. Round 2 found that element-access
CommonJS exports bypassed export description entirely. Round 3 — this entry
— found that *modeling the export was never the last missing piece*. Here
the binding was modeled, the completeness abstraction saw it, and a
candidate was contributed. The candidate was simply `alias`.

**The distinction this round adds.** Rounds 1 and 2 were about exports the
analyzer could not SEE. This one is about a candidate the analyzer could
not MATERIALIZE:

```text
exported name   run
local name      alias      <- what was contributed as the root
callable node   bad        <- the only thing a root can actually be
```

`entrypointRootCandidates` contributed `exp.localName ?? exp.exportedName`
and reported COMPLETE. `alias` matched no node, the entrypoint was rooted at
`<module>` alone, the search exhausted a subgraph that was never correctly
rooted, and family C certified it. Reproduced identically on `047b68d`,
`2528feb` and `04a839a`, and in the dot, bracket AND object-literal
spellings alike — so it was never bracket-specific, and the bracket work
neither caused nor widened it.

**The fix, in two halves.**

*Resolution.* An exported local name is now walked through RWF-012/013's
existing bounded alias chain (`resolveLocalValue`, entered by name). That
walk already knew the terminal identifier and discarded it; it now carries
it, which is the one fact a root needs. `const alias = bad` contributes
`bad`; a function/arrow expression contributes its exact POSITION. The walk
adds hops, never permissiveness — reassignment, cycles, destructuring and
non-module-scope bindings refuse exactly as they refuse for attribution.
The original name is still contributed, so RWF-021's monotonicity holds:
resolution only ever widens the root set.

*Materialization.* `EntrypointRootCandidates` now carries
`rootRequirements`: one entry per binding that could publish a callable,
listing every alternative that would materialize it.
`entrypointSourceNodes` checks them against the graph and raises
`unresolved_entrypoint_root_candidate` when none matches. That check lives
in `verdict.ts` because it is the only layer holding both the candidates
and the call graph — `entrypointRootCandidates` cannot answer "did this
materialize" without it.

A requirement is satisfied by ANY alternative, because the same binding
materializes differently by form: `const alias = function inner(){}` by
POSITION, `const alias = (u) => ...` by NAME (arrows are indexed under
their variable). Requiring both would manufacture false incompleteness.
Bindings that provably publish no callable (`module.exports.x = 42`) emit
no requirement at all, so "there is no root here" stays a complete answer —
which is what keeps valid family C proofs alive.

**Behavior.**

| form | before | after |
| ---- | ------ | ----- |
| `const alias = bad` (dot / bracket / object-literal / `exports.`) | NOT_AFFECTED + Family C | **AFFECTED**, concrete path |
| two-hop `const a = bad; const b = a` | NOT_AFFECTED + Family C | **AFFECTED**, concrete path |
| function-expression / arrow alias | NOT_AFFECTED + Family C | **AFFECTED**, concrete path |
| reassigned alias (live value dangerous) | NOT_AFFECTED + Family C | **UNKNOWN** |
| conditional / member / destructured / call-initializer alias | NOT_AFFECTED + Family C | **UNKNOWN** |
| safe alias, target unreachable | NOT_AFFECTED + Family C | NOT_AFFECTED + Family C (unchanged) |
| non-callable export, no callable export | NOT_AFFECTED + Family C | NOT_AFFECTED + Family C (unchanged) |

The last two rows are the point: alias support does not globally force
UNKNOWN. A resolved alias root keeps family C fully available.

No stale declaration is ever rooted — `let alias = bad; alias = safe`
refuses rather than reporting the original, so the fix adds no false
AFFECTED in the direction RWF-013/013b guards.

Full suite 3412/3412; canonical validation unchanged at 12 PASS /
5 KNOWN_FAIL / 17; adversarial 122/122. `UNKNOWN → NOT_AFFECTED` = 0,
`AFFECTED → NOT_AFFECTED` = 0.

**Corpus.** 1051 files scanned, 988 complete, 63 incomplete — unchanged from
round 2, because `scripts/p0z-entrypoint-root-corpus.mjs` measures only the
file-level incompleteness `entrypointRootCandidates` can compute alone. The
materialization requirement is deliberately graph-dependent and therefore
invisible to that script; its effect is measured by the focused suites and
the validation baseline, both of which moved no corpus verdict. Stated this
way rather than as "zero impact", which the script cannot establish.

### Remaining limitations (deliberately not fixed here)

- **Only exact one-name-per-hop chains resolve.** A member alias
  (`obj.bad`), a destructured alias, a conditional, and a call-expression
  initializer all fail closed to UNKNOWN. Resolving them means member and
  heap points-to analysis, which this task is scoped not to build.
- **Source rebinding after capture is refused, not modeled.** In
  `const alias = bad; bad = safe;` the runtime value of `alias` is the
  ORIGINAL `bad`, but `classifyLocalBinding` sees `bad` reassigned and
  refuses the chain, so the result is UNKNOWN rather than a root on the
  captured function. That is the sound direction, and modeling capture
  semantics properly is a separate piece of work.
- **Requirements are per-entrypoint, not per-export.** One unmaterializable
  export withdraws family C for the whole entrypoint even when every
  sibling export rooted cleanly.

---

## RWF-029 — A package's advisory-named export that is FORWARDED rather than declared could not be attributed at all (P1-A1)

**Classification: P1 coverage / target-resolution improvement.** Not a
soundness defect.

The claim is scoped deliberately, and the scope is load-bearing: it is
about **the forwarding relation and the Site A forwarding fallback this
task introduces**, not about every target-attribution path in the
analyzer. Within that scope, every affected case previously degraded to
UNKNOWN in both directions; no false `AFFECTED` and no false
`NOT_AFFECTED` existed in the forwarding relation before, and none is
introduced. Implementation review found no P0-style defect in it.

It is explicitly **not** a clean bill of health for the pre-existing
per-file attribution loop the fallback sits behind. The final independent
audit of this branch found a false `AFFECTED` in that older path,
reproduced byte-identically on the P0 closure base `d36a83c`. It is
untouched by this task, in the over-reporting direction, and recorded
below as **the RWF-030 candidate** — named as a candidate, not opened as a
finding, exactly as RWF-018 recorded the RWF-019 candidate rather than
folding a partial version of it into the task that found it.

**Discovered:** reproducing `RWB-05` (real `qs@6.10.1` against real
GHSA-hrpp-h998-j3pp / CVE-2022-24999) on the P0 closure main
`d36a83cfc2dcc6be30b9a358992e91e55354f70c`.

### The canonical failure mechanism

`RWB-05`'s finding carried exactly one reason:

```text
could not resolve module "qs": export "parse" could not be attributed to
any function or class member in the resolved module
```

That is `verdict.ts`'s Site A (VT-301B) — the package instance genuinely
IS in the graph, but the advisory's symbol could not be attributed to any
node in it. Reading the real installed package says why:

```js
// qs/lib/index.js -- declares nothing
var stringify = require('./stringify');
var parse = require('./parse');
module.exports = { formats: formats, parse: parse, stringify: stringify };

// qs/lib/parse.js -- the implementation
module.exports = function (str, opts) { ... };
```

`resolveTargetNodes` asks `findExportNodeInFile` for `"parse"` against each
file of the instance, and that relation is **per-file**: it attributes an
export against the file's own export table and nothing else. Neither file
can answer:

- `lib/index.js` advertises the name `parse` but declares no function, and
  the value it publishes lives in another file;
- `lib/parse.js` holds the implementation but publishes it as a CommonJS
  whole-module default — an **anonymous** function expression, whose
  canonical export name is `"default"`, not `"parse"`.

So the advisory-facing name (`parse`) and the implementation-facing name
(`default`) are genuinely different names, and **no file in `qs` exports
anything called `parse`**. Per-file attribution could not answer the
advisory at any depth.

This is precisely why the case survived RWF-004a/b, which are frequently
mistaken for it. Those fixed the **consumer-side** chase — a call site
following a value through a package's re-exports — and their fixture
(`fixtures/commonjs-reexport-same-package`) resolves only because
`fixture-lib/lib.js` happens to contain `exports.vulnerable = vulnerable`,
which per-file attribution finds directly. Change that one spelling to
`qs`'s and the same fixture would have failed too.

It is also **not** the P0-Z problem it superficially resembles. P0-Z
derived reachability ROOTS from a configured APPLICATION entrypoint's
forwarded exports. This derives the advisory's TARGET IDENTITY inside the
vulnerable PACKAGE. Root selection must WIDEN when uncertain; target
identity must REFUSE — opposite failure directions, so the two deliberately
do not share a relation, and nothing in P1-A1 touches root derivation.

### The fix

One new pure module, `src/code-intelligence/export-forwarding.ts`, holds
the **hop rule** and nothing else: given a module model and a requested
name, which literal specifier does that value come from, and under which
name over there. It is a function of export facts the model already
derived, never a resolver and never a second source of export facts.

It has exactly two consumers, and the rule was **extracted verbatim** from
the first rather than written afresh, so the two can never drift on the one
question they must answer identically:

- `call-graph.ts`'s `resolveEsmReExport` / `resolveCommonJsReExport` — the
  consumer-side chase, behaviorally unchanged (316/316 call-graph tests
  pass);
- `verdict.ts`'s new `findExportNodeThroughForwarding` — the target-side
  chase, added at Site A **strictly as a fallback** after direct
  attribution across every file of the instance has already failed. A
  package that exports its target directly resolves exactly as before.

Supported hops, each an authoritative binding and never a name search:

| shape | forwards to |
| ----- | ----------- |
| `exports.v = require("./impl").v` | `impl#v` |
| `exports.v = require("./impl").internalName` (**rename**) | `impl#internalName` |
| `module.exports = { v: require("./impl") }` / `var impl = require("./impl"); module.exports = { v: impl }` (**the `qs` shape**) | `impl#default` |
| `module.exports = require("./impl")` (whole module) | `impl#<same name>` |
| `module.exports = require("./impl").v` | only `default` → `impl#v` |
| `const a = impl.internalName; exports.v = a` (single-assignment alias) | `impl#internalName` |
| `export { internalName as v } from "./impl.js"` | `impl#internalName` |
| `export { default as v } from "./impl.js"` | `impl#default` |

Chains of any length resolve by recursion through the same relation, so a
two-hop barrel (`index → api → impl`) differs from a one-hop only in how
many times it runs.

### What it refuses, and why that is the point

Every negative outcome is a refusal, never a fallback — the target stays
unresolved and the finding stays UNKNOWN:

- a **reassigned** alias (RWF-013/RWF-025 semantics — the stale initializer
  is not what Node publishes);
- the stale **first** of duplicate export writes (last-write-wins is Node's
  real semantics, and the last write is what resolves);
- a **dynamic/computed** specifier, a **conditional** export write;
- `export * from` — a star export is never resolved by guessing;
- an unresolved, builtin or **declaration-only** resolution (the same
  VT-304 discipline as both halves of the call graph's chase);
- a forwarding **cycle** (`a → b → a`), which terminates on the repeated
  `file#exportName` hop and yields no nodes rather than picking an
  arbitrary member. As in `call-graph.ts` there is deliberately no extra
  depth cap: the visited set already bounds traversal, while a cap would
  return "no target" indistinguishably from "no forwarding" on a legitimate
  deep chain.

### PackageInstance and package ownership

Every hop's resolved file must belong to **exactly** the advisory's own
`packageInstance`, compared as a whole install path by the single identity
authority (`identifyModule`). This is the one place the target-side chase
deliberately differs from the consumer-side one, which RWF-004b correctly
un-gated.

The asymmetry is not an oversight. Following a **value** across a package
boundary is sound — that is what the runtime does. Re-pointing an
**advisory** across one is a different claim: an advisory naming `pkg-a`
answered with an implementation inside `pkg-b` silently re-interprets whose
vulnerability it is. P1-A1 does not broaden package ownership semantics, so
a bare-specifier cross-package hop and a relative hop that escapes the
package root (`pkg/index.js → ../../other/file.js`) are both refused. The
same comparison excludes a same-name/same-version twin install, since two
installs at different paths are different instances.

### Target identity

The node returned is the real implementation's own graph node — its file,
its source position, its own declared name (or none, for `qs`'s anonymous
default). The advisory-facing name and the implementation-facing name stay
separate values throughout the chase, so the public → implementation
mapping (`pkg.vulnerable` → `pkg/path/to/impl.js:internalName`) remains
recoverable from the returned identity rather than being collapsed into the
advisory's name. Nothing is collapsed to package name, version, or
`name@version`. No external schema changed in this task; existing AFFECTED
evidence already names the implementation's real file and line.

### Permanent coverage

`fixtures/target-side-reexport` (see its README) isolates fifteen
forwarding shapes as fifteen installed packages, with per-shape consumer
entrypoints, asserted by
`src/analysis/verdict.target-side-reexport.integration.test.ts` (23 tests)
and `src/code-intelligence/export-forwarding.test.ts` (17 tests).

Two of the fifteen are explicit **false-verdict probes** rather than
shapes. `twoname-lib` publishes ONE implementation under TWO export names
and the application calls the *other* one: Node really does execute the
advisory's target, so anything but AFFECTED is a false negative — exactly
the shape a subtly-wrong target identity would get wrong while still
looking like a confident answer. `bracket-lib` carries the P0
literal-bracket export form (`module.exports["vulnerable"] =
require("./impl").internalName`) onto the target side. Both resolve
correctly.

**Runtime oracle.** `fixtures/target-side-reexport/verify.cjs` asserts,
under real `node` and out-of-process, which instance and forwarding files
load, which concrete callable each package really publishes under
`vulnerable` — **by identity**, not by name — that the reassigned and
duplicated cases publish the current rather than the stale value, that the
cycle publishes nothing at all, that the two twins are name- and
version-identical yet publish different callables, and that every reachable
consumer really does enter its implementation. VulnTrace itself never
executes target code; the oracle is test-only.

The suite was confirmed to **discriminate**: with the new Site A fallback
disabled, 9 of its then-21 tests fail — every positive-resolution case —
while all fail-closed controls pass in both states, which is exactly the
required asymmetry.

**Behavior.**

| case | before | after |
| ---- | ------ | ----- |
| direct export, reached | AFFECTED | AFFECTED (unchanged) |
| one-hop forward (`qs` shape), reached | UNKNOWN | **AFFECTED**, concrete path into `impl.js` |
| one-hop forward, never called | UNKNOWN | **NOT_AFFECTED** (family C, unchanged proof) |
| two-hop forward, reached | UNKNOWN | **AFFECTED**, concrete path |
| renamed export, reached | UNKNOWN | **AFFECTED**, bound to `internalName` |
| local alias forward, reached | UNKNOWN | **AFFECTED**, concrete path |
| duplicate writes, reached | UNKNOWN | **AFFECTED**, bound to the LAST write |
| same-name decoy in the impl file | UNKNOWN | **AFFECTED** on the real target, never the decoy |
| reassigned alias | UNKNOWN | UNKNOWN (unchanged — refused) |
| cycle / dynamic / conditional | UNKNOWN | UNKNOWN (unchanged — refused) |
| cross-package / package-root escape | UNKNOWN | UNKNOWN (unchanged — refused) |
| wrong PackageInstance twin | not AFFECTED | not AFFECTED (unchanged) |

The unreachable row is the one that proves exact resolution does not force
a positive: the same target resolves exactly and then receives a genuine
negative proof. The refusal rows are the ones that prove it cannot
manufacture one either.

**Corpus.** `scripts/p1a1-target-forwarding-corpus.mjs` over
`fixtures/` + `tests/validation/fixtures/`: 750 files scanned, 0
unparsable, 678 with at least one export, 944 export names examined — 473
locally attributable, **471 not** (the population no per-file attribution
could ever answer). Of those, **160 across 59 distinct files carry an exact
forwarding hop** (159 CommonJS, 1 ESM; 130 whole-module → `default` — the
`qs` shape — 22 same-name, 8 renamed), and **311 carry no hop at all and
stay UNKNOWN by design**.

A hop EXISTING is not a target RESOLVED, and the two must not be reported
as one number. Following all 160 chains with the production module
resolver, under the same-PackageInstance gate and cycle guard the
target-side chase itself uses:

| chain outcome | count |
| ------------- | ----- |
| terminates at an attributable implementation in the same PackageInstance | **114** |
| refused — the hop leaves the PackageInstance | 7 |
| refused — the specifier did not resolve | 1 |
| dead end — no further hop, or a cycle | 38 |

So **114**, not 160, is the population this relation can actually resolve
in these corpora; the other 46 carry an exact hop whose chain then refuses
or dead-ends, which is the fail-closed outcome working as intended. Even
114 is a static CEILING rather than a count of resolved targets:
`verdict.ts` additionally requires the implementation to have a node in the
call graph of the scan actually being run, which a corpus walk has no way
to know.

All of these are **resolution measurements, not verdict improvements** — no
count here implies any finding changed verdict. They size the shape's
prevalence in this repository's corpora only; this is not a claim about
ecosystem-wide coverage. Verdicts are measured by the focused suites and
the canonical validation baseline, and nowhere else.

### `RWB-05` itself: resolved target, second blocker

`RWB-05` is **still a KNOWN_FAIL, and its expected verdict is deliberately
unchanged.** What changed is the reason, and the change is real progress
that is worth stating precisely rather than rounding to "fixed" or "not
fixed".

The target now resolves exactly: `qs#parse` binds to `qs/lib/parse.js`'s
anonymous whole-module default callable, in `qs`'s own PackageInstance. The
`could not be attributed` reason is gone.

What blocks the `NOT_AFFECTED` is a **second, independent, pre-existing
cause that the unresolved target was masking** — `RWF-002`, still open in
the table above. The reachability search from this entrypoint traverses
`qs`'s own real transitive dependencies (`get-intrinsic`, `object-inspect`,
`qs/lib/utils.js`), whose genuinely dynamic constructs place
`unresolved_target` / `dynamic_member_access` / `unsupported_construct`
edges inside the reachable subgraph. Family C requires an exhaustive search
with no unresolved edge anywhere in that subgraph, so it cannot complete,
and UNKNOWN is the **sound** answer under the current negative-proof
contract. (Those edges were always there; before P1-A1 the unresolved
target short-circuited ahead of the search, so they never appeared in the
evidence.)

Closing `RWB-05` therefore needs the RWF-002 reachability-scoping work, not
more target resolution. Weakening family C's completeness requirement to
make the case green would be exactly the manufactured `NOT_AFFECTED` the
contract forbids, so it was not done, and the oracle was not adjusted to
the tool. Canonical validation is therefore unchanged at **12 PASS /
5 KNOWN_FAIL / 0 UNEXPECTED / 17**, with the same five known failures
(`RWB-03`, `RWB-05`, `RWB-09b`, `VAL-002`, `VAL-003`). The case's `reason`
field was updated to record the true current mechanism; its `expected`
value and `knownFailure` flag were not touched.

### The RWF-030 candidate — a same-named SIBLING export can win over the package's public one

> **Opened and fixed as RWF-030 (P1-A2).** See the RWF-030 section at the
> end of this file. Note that the classification below — "never a false
> `NOT_AFFECTED`, so it does not touch the negative-proof contract" — was
> **wrong**: reproducing it independently found the under-reporting
> direction as well, from the identical cause. The text is left unedited
> as the historical record of what the P1-A1 audit saw.

Found by this branch's final independent audit, **not** introduced by it,
and deliberately **not** remediated here.

Target attribution asks each file of the instance, independently, whether
it exports the advisory's name (`resolveTargetNodes`'s per-file loop over
`findExportNodeInFile`). Nothing in that loop asks which file is the
package's authoritative PUBLIC entry, so an unrelated sibling that happens
to export the same name can answer for the package:

```js
// pkg/index.js -- the public entry; what the package really publishes
var impl = require("./impl");
module.exports = { vulnerable: impl.safeImpl, runOther: require("./other").vulnerable };

// pkg/other.js -- a sibling that genuinely exports the SAME name
exports.vulnerable = function dangerous(input) { ... };
```

With a consumer that calls only `runOther`, a rule targeting
`pkg#vulnerable` binds to `other.js`'s function and reports **AFFECTED**,
even though what the package publishes as `vulnerable` is `safeImpl` and is
never called. Under real `node`, `pkg.vulnerable` is `safeImpl`.

Classification:

- **Pre-existing.** Reproduced byte-identically on the P0 closure base
  `d36a83c`, with the same verdict and the same evidence path.
- **False `AFFECTED`** — the over-reporting direction, never a false
  `NOT_AFFECTED`, so it does not touch the negative-proof contract.
- **Not introduced, and not widened, by P1-A1.** The forwarding fallback
  runs only when this loop has already found nothing, so it cannot reach
  this shape at all. It is distinct from RWF-011/VT-301B, which closed the
  bare-NAME fallback: here the sibling genuinely does export the name, so
  no name-search guard applies.
- **Adjacent target-resolution work, for its own cycle.** The direction is
  to anchor advisory resolution at the package's authoritative public
  entry/export surface and then follow explicit forwarding from there —
  which is the same anchor P1-A1 already uses for the forwarding chase —
  rather than treating every file's export table as equally authoritative.

Recorded as a candidate rather than opened as a finding, and left entirely
unremediated, so the fix is scoped and proved on its own evidence instead
of being folded into a task that merely discovered it.

### Remaining limitations (deliberately not fixed here)

- **`RWB-05` stays open on RWF-002.** Target resolution is necessary but
  not sufficient for that case.
- **The RWF-030 candidate above is open.** A same-named sibling export can
  still out-answer the package's public entry, in the false-`AFFECTED`
  direction. *(Since fixed in P1-A2; and it was not only the
  false-`AFFECTED` direction — see RWF-030.)*
- **Cross-package advisory ownership is refused, not modeled.** A façade
  package whose advisory-named export really is another package's callable
  stays UNKNOWN. Deciding when an advisory may follow a value across a
  package boundary is a domain-contract question, not a resolution one.
- **`export * from` stays unresolved** as a forwarding hop. Matching one
  requested name against an unenumerated set is P1-B ESM work.
- **No `package.json` `exports`/subpath resolution** was added; the
  canonical fixture needed none. *(P1-A2 did not add it either — it anchors
  target resolution at the package's default public entry using the
  existing resolver semantics. Subpath advisories remain a later P1-A
  task.)*
- **No multi-instance target expansion.** Instance exactness is preserved
  for the instance under analysis; advisory → many-instance expansion is
  P1-A4.
- **Member/destructured/call-initializer aliases fail closed**, exactly as
  in RWF-004a — resolving them needs member and heap points-to analysis,
  which this task is scoped not to build.

---

## RWF-030 — A same-named SIBLING export could out-answer the package's own PUBLIC one (P1-A2)

**Classification: soundness / target-identity correction, in BOTH
directions.** Not a coverage improvement.

This was recorded as *the RWF-030 candidate* at the end of the RWF-029
section above, by P1-A1's own final independent audit, and deliberately
left unremediated there so it could be scoped and proved on its own
evidence. This is that task.

The candidate note characterised it as a false `AFFECTED` only. That was
the half the audit saw. Reproducing it independently here found the
**other direction as well**, from the identical cause — see "Both
directions" below.

**Discovered:** P1-A1's final audit, on the P0 closure main `d36a83c`.
**Reproduced for this task:** on the P1-A1 merge base
`4a969b28a6e54b365774773828fb54d9a660cb21`, byte-identically.

### The defect

Target attribution asked **every** graph-discovered file of the advisory's
`PackageInstance`, independently, whether it exported the advisory's
literal name — `resolveTargetNodes`'s per-file loop over
`findExportNodeInFile`:

```ts
for (const [, files] of selected) {
  for (const file of files) {
    nodes.push(...findExportNodeInFile(graph, file, target.export, ...));
  }
}
```

Nothing in that loop asked which file the package actually **publishes**.
So package MEMBERSHIP became sufficient for target identity, when it is
only ever *necessary*:

```js
// pkg/index.js -- the public entry; what the package really publishes
var impl = require("./impl");
var other = require("./other");
module.exports = { vulnerable: impl.safeImpl, runOther: other.vulnerable };

// pkg/other.js -- an unrelated sibling that genuinely exports the SAME name
exports.vulnerable = function dangerous(input) { ... };
```

Under real `node`, `pkg.vulnerable` **is** `impl.safeImpl`.
`pkg/other.js`'s `vulnerable` is reachable only as `pkg.runOther`, which
is a different public name and therefore a different symbol. An advisory
naming `pkg#vulnerable` bound to `other.js` anyway.

### Canonical reproduction on the merge base

`fixtures/authoritative-public-entry/node_modules/publicsafe-lib` is that
shape exactly; `src/publicsafe-consumer.cjs` calls only `pkg.runOther`. On
`4a969b2`:

```json
{ "verdict": "AFFECTED",
  "path": ["src/publicsafe-consumer.cjs:6",
           "node_modules/publicsafe-lib/other.js:5"] }
```

and the fixture's own runtime oracle, under real `node`:

```text
pkg.vulnerable === impl.safeImpl:    true
pkg.vulnerable === other.vulnerable: false
pkg.vulnerable(1):                   publicsafe-safe:1
```

The advisory's symbol is never executed. The verdict is a false
`AFFECTED`, and its evidence path names the wrong implementation.

Reproducible on any checkout without a test harness:

```sh
npm run build
node scripts/rwf030-repro.mjs fixtures/authoritative-public-entry \
  src/publicsafe-consumer.cjs publicsafe-lib vulnerable publicsafe-lib
node fixtures/authoritative-public-entry/verify.cjs
```

`scripts/rwf030-matrix.mjs` runs the whole matrix the same way, and is
what the verdict differential below was measured with.

### Both directions, one cause

The candidate note called this "the over-reporting direction, never a
false `NOT_AFFECTED`, so it does not touch the negative-proof contract."
That is **not correct**, and the correction matters.

P1-A1's forwarding fallback ran *only when the per-file loop had already
found nothing*. So whenever a sibling did export the name, the sibling
**short-circuited the forwarding chase entirely** — and if that sibling
happened to be unreachable, the finding received a complete Family C
negative proof about a callable the advisory never named.

`twinpub-lib` (both twins) is that shape. The public entry forwards
`vulnerable` to `impl.js`, `other.js` exports a same-named sibling nobody
calls, and the consumer **does** call `pkg.vulnerable`. On `4a969b2` both
instances report `NOT_AFFECTED`; real `node` confirms the public target
really is executed in both. That is a false `NOT_AFFECTED` carrying a
valid-looking negative proof.

So the sibling scan is a soundness defect in **both** directions, and the
negative-proof contract was in fact touched. It is fixed here in both.

### The fix

`resolveTargetNodes`'s Site A no longer scans files. It now:

1. resolves the instance's **authoritative public entry** —
   `resolveAuthoritativePublicEntries`, a new pure function in
   `verdict.ts`;
2. attributes the advisory's name against **that file's** export table, by
   the same structural `findExportNodeInFile` relation a directly exported
   target has always used;
3. failing that, follows **P1-A1's forwarding relation, unchanged**
   (`findExportNodeThroughForwarding`), anchored at the public entry;
4. failing that, **refuses** — `unresolvedReason`, UNKNOWN.

There is deliberately no remaining path from "some file in this package
exports this name" to "this is the advisory's target". P1-A2 invents no
second forwarding resolver and adds no package-resolution semantics of its
own; it changes only **where** resolution starts.

### Identifying the public entry

Never guessed from a filename. `index.js` is a convention, not a rule —
`mainfield-lib` declares `"main": "lib/entry.js"` and carries a *loaded,
reachable* root `index.js` exporting a same-named decoy, and resolves to
`lib/impl.js`.

The entry is whatever the **existing module resolver** — the same one the
call graph itself used — answers, so `main`, `exports`, the `index`
fallback, conditional branches and file/package `type` scope are all
handled by semantics already in the codebase.

A fixed, fully-enumerated probe set is used, and every probe is gated on
exact `packageInstance` identity via `identifyModule`:

| | |
|---|---|
| **contexts** | each entrypoint file (sorted), then the project root's `package.json`, then the instance's own `package.json` |
| **specifiers** | the advisory's own module specifier, and the instance's absolute install DIRECTORY |

Both non-obvious members are load-bearing, and each is pinned by an
existing regression that failed without it:

- **entrypoint contexts** — VT-204: a package with
  `{"import": "./esm/index.js", "require": "./cjs/index.js"}` resolves
  through `require` from a project-root `package.json` context, which is
  *not* the branch an ESM application actually loads. Resolving from the
  application's own entrypoint gets the branch the graph really traversed.
- **the instance directory as a specifier** — VT-306/RWF-009: an npm alias
  (`"foo-alias": "npm:foo@1.2.3"`) installs package `foo` at
  `node_modules/foo-alias`, so *no* context resolves the advisory's name
  `foo` into that instance. The directory names the same public surface
  without going through any name at all.

The **union** of everything landing inside the instance is returned, not
one winner. Every member is a genuine public entry under some real
resolution context, so the union cannot admit a sibling — and it means no
answer depends on which probe ran first, on graph traversal order, or on
file enumeration order. `checkReachability`'s existing OR-across-nodes
contract then does its usual job.

A declaration-only or builtin resolution is skipped, never accepted — the
same VT-304 discipline as everywhere else.

### The legacy-fallback audit

Every remaining caller of `findExportNodeInFile` was classified. None
performs a sibling scan for advisory target identity:

| site | role | disposition |
|---|---|---|
| its own definition | the per-file structural relation itself | unchanged — still correct for a file that is *known* to be the right one |
| inside `findExportNodeThroughForwarding` | per-hop attribution, under a name the hop itself proved | authoritative, kept |
| Site A (new) | the public-entry anchor | authoritative |
| Site B | the package was never discovered by the graph; already anchored at `resolver.resolve(target.module, referenceFile)` — i.e. the public entry, by construction | unchanged |

The relation was **constrained, not deleted**: it remains exactly the
right tool once the caller has established *which* file may answer.

### Behavior

Every row is derived from the fixture's real-`node` oracle, never from
what the analyzer says. Legacy = merged main `4a969b2`.

| case | legacy | P1-A2 | why |
|---|---|---|---|
| public safe, sibling vulnerable, sibling reached | **AFFECTED** → `other.js` | **NOT_AFFECTED** | the false AFFECTED; public target is `impl.safeImpl`, never called |
| public vulnerable, safe same-named sibling | AFFECTED → `safe.js` | AFFECTED → `impl.js` | verdict was right, **target was wrong** |
| direct public export | AFFECTED → `index.js` | unchanged | no precision regression |
| public renamed safe, dangerous sibling | **AFFECTED** → `other.js` | **NOT_AFFECTED** | false AFFECTED |
| missing public symbol, sibling has it | NOT_AFFECTED | **UNKNOWN** | an unproven negative about a symbol the advisory never named |
| 3 same-named siblings | AFFECTED → `sibling-a.js` | AFFECTED → `impl.js` | **traversal-order dependent** before |
| duplicate public writes (safe last) | AFFECTED → `other.js` | AFFECTED → `safe.js` | last write wins |
| duplicate public writes (dangerous last) | AFFECTED → `other.js` | AFFECTED → `dangerous.js` | source order, not preference |
| conditional public export | **AFFECTED** → sibling | **UNKNOWN** | fails closed |
| dynamic/computed public export name | **AFFECTED** → sibling | **UNKNOWN** | fails closed |
| `"main": "lib/entry.js"` + root `index.js` decoy | AFFECTED → `index.js` | AFFECTED → `lib/impl.js` | entry identity is metadata, not filename |
| deep import, public entry has no such symbol | **AFFECTED** → `deep.js` | **UNKNOWN** | boundary, see below |
| cross-package public forward | **AFFECTED** → sibling | **UNKNOWN** | P1-A1's ownership rule, preserved |
| PackageInstance twins, public target reached | **NOT_AFFECTED** (both) | **AFFECTED** (each to its own `impl.js`) | the false NOT_AFFECTED |
| public target exact but never called | NOT_AFFECTED | unchanged | exact resolution does not force a positive |
| ESM `export { internal as vulnerable } from` | AFFECTED → `other.js` | AFFECTED → `impl.js` | target was wrong |

**Zero false AFFECTED and zero false NOT_AFFECTED in the focused matrix**,
each checked against the oracle individually.

### Permanent coverage

`fixtures/authoritative-public-entry` (see its README) isolates sixteen
shapes as sixteen installed packages, almost all carrying a same-named
sibling on purpose — the sibling is the attack. Asserted by
`src/analysis/verdict.authoritative-public-entry.integration.test.ts`
(26 tests).

**Runtime oracle.** `fixtures/authoritative-public-entry/verify.cjs`
asserts under real `node`, out of process, what each package publishes
from its public entry **by callable identity, not by name**; that the
canonical case's public target is never executed while its dangerous
sibling is; that both duplicate-write directions publish the current
rather than the stale value; and that the two name- and version-identical
twins publish different callables. 16 checks. VulnTrace never executes
target code; the oracle is test-only.

The suite was confirmed to **discriminate**: run against merged main's
`verdict.ts`, **21 of its 26 tests fail**; on the branch all 26 pass. The
5 that pass in both states are the unchanged controls (direct export,
unreachable-but-exact, the sibling-under-its-real-public-name complement,
and the oracle itself) — exactly the required asymmetry.

**Order independence** is asserted directly, not assumed: the same scans
re-run with `graph.nodes` reversed, and with `graph.nodes` sorted by
module, must produce an identical verdict *and* an identical resolved
target.

### Corpus

`scripts/p1a2-authoritative-entry-corpus.mjs`. These are **resolution
measurements, not verdict improvements** — nothing here runs a
reachability search, so no count implies any finding changed verdict. They
size the shape in *these* corpora only; this is not an ecosystem claim.

**Runtime files vs declaration files — the two numbers are not
interchangeable.** A `.d.ts` sibling can never contribute advisory target
authority: attribution only materializes a node when the call graph holds
one whose `module` is that exact file, the graph never traverses
declaration files, and VT-304 refuses declaration-only resolutions
outright. So a "collision" whose only rival is a `.d.ts` is an artifact of
walking the tree, not a case the legacy scan could ever have got wrong.
The script therefore reports both passes, and **`runtimeOnly` is the
figure that describes real target-authority disagreement**. (An earlier
revision of this section quoted only the all-files pass; the corrected
runtime-only figures are the ones below.)

Over `fixtures/` + `tests/validation/fixtures/`, 125 installed
PackageInstances, 0 unparsable:

| | all files | **runtime only** |
|---|---|---|
| files walked | 820 | **763** |
| instances with a resolvable authoritative public entry | 123 | **123** |
| instances with **no default public entry** (subpath-only — see below) | 2 | **2** |
| export-name candidates the legacy per-file scan drew from | 240 | **234** |
| of those, same-name sibling collisions | 172 | **163** |
| authoritative entry selects a **different** target than the legacy scan offered | 18 | **15** |
| legacy had a target, the public entry has **none** (→ UNKNOWN) | 139 | **133** |
| public entry attributes the name directly | 76 | **76** |
| public entry resolves it through explicit forwarding | 25 | **25** |

A collision is an **upper bound** on the legacy defect's reach, never a
count of real findings: whether the legacy scan actually *would* have
bound a sibling depends on which files the call graph discovered in a
given scan, which a corpus walk cannot know.

Restricted to the **real vendored npm packages only**
(`tests/validation/fixtures`; 372 runtime files, 47 instances, this task's
own new fixture excluded), the shape is present in genuine third-party
code: **3** runtime cases where authoritative resolution selects a
different file than the per-file scan would offer, all on the canonical
CommonJS `default` name —

```text
has-symbols             default  [index.js, shams.js, test/tests.js] -> index.js
call-bind-apply-helpers default  [applyBind.js, index.js]            -> index.js
yallist                 default  [iterator.js, yallist.js]           -> yallist.js
```

`has-symbols` is the clearest: an advisory naming `has-symbols#default`
was bindable to `shams.js` — or to `test/tests.js`.

The all-files pass reports 6 rather than 3 here. The extra three —
`call-bound`, `side-channel`, `side-channel-list` — each have **only an
`index.d.ts` rival** beside the real `index.js`, so they are declaration
artifacts and are **not** runtime authority mismatches. They are recorded
here as artifacts precisely so they are not mistaken for defects.

### Packages with no default public entry (not a resolver failure)

The two instances the table counts are `dunder-proto` and
`math-intrinsics`, both vendored under `rwb-05-qs-unused-api`. Neither is
an ordinary resolution failure:

```json
{ "main": false, "exports": { "./get": "./get.js", "./set": "./set.js" } }
```

They are **subpath-only packages**: `"main": false`, and an `exports` map
that declares only subpaths with no `"."` entry. There is genuinely no
default public entry to anchor at, so under the P1-A2 contract advisory
resolution **fails closed** to UNKNOWN. That is the correct answer for a
task that deliberately does not implement subpath semantics; supporting an
advisory that explicitly targets a subpath is later P1-A
package-resolution work, not a gap in this relation.

### Why the multiple-public-entry union is safe (invariant)

A package can resolve to more than one public entry file — conditional
`exports` legitimately yield one under `import` and another under
`require`, and the probe set accepts every candidate that lands inside the
exact `PackageInstance`. Those candidates can attribute the advisory's
name to *different* implementations, so "each member is a genuine public
entry" is **not** on its own a sufficient safety argument.

The property the union actually rests on is:

> **A candidate public entry can contribute an advisory target only if
> `findExportNodeInFile` can materialize a real graph node whose `module`
> equals that resolved entry file.**

Every return path of that relation ends in a
`graph.nodes.find(n => n.module === resolvedFile && …)` lookup. A file the
analyzed scan never traversed therefore yields no node, and an entry
resolved under an **inapplicable condition is inert**: the analysis
context itself disambiguates, rather than the union arbitrarily choosing.
When two conditional entries genuinely *are* both loaded, both really can
execute, and OR-across-nodes is the correct answer rather than a guess.

The union is also monotone in the safe direction. `checkReachability`
returns AFFECTED on the first reachable node and requires *no* node
reachable **and** no unresolved blocker before NOT_AFFECTED. Adding a
candidate can therefore only move NOT_AFFECTED → AFFECTED or
NOT_AFFECTED → UNKNOWN; it can never manufacture a negative proof. Going
UNKNOWN on any multi-entry package would instead have discarded genuine
AFFECTED results for ordinary dual-condition packages, which is a worse
trade in both directions.

**Future-refactor warning.** This argument depends on target
materialization requiring a real graph node. `findExportNodeInFile`'s
`allowSyntheticNameOnlyTargetBinding` escape hatch still satisfies it
today — its bare-name fallback is also `n.module === resolvedFile`-gated,
and no production caller enables it. If a future change ever permits
synthetic or name-only target materialization **without** requiring a node
for that exact file, the union's safety argument must be revisited before
that change lands.

### Verdict differential (base `4a969b2` → branch)

Canonical validation is **unchanged at 12 PASS / 5 KNOWN_FAIL / 0
UNEXPECTED / 17**, with the same five known failures (`RWB-03`, `RWB-05`,
`RWB-09b`, `VAL-002`, `VAL-003`). No established case moved.

Movements occur only in the new P1-A2 matrix, and every one is
individually explained by the table above and proved against the runtime
oracle:

| class | count | disposition |
|---|---|---|
| AFFECTED → NOT_AFFECTED | 2 | `publicsafe-lib`, `renamesafe-lib` — false AFFECTED removed; oracle proves the public target is never executed |
| AFFECTED → UNKNOWN | 4 | `condpublic`, `dynpublic`, `deep`, `crosspub` — fail-closed refusals replacing a sibling binding |
| NOT_AFFECTED → UNKNOWN | 1 | `missing-lib` — an unproven negative withdrawn |
| NOT_AFFECTED → AFFECTED | 2 | `twinpub-lib` both twins — **false NOT_AFFECTED removed**; each carries an exact authoritative path into its own instance's `impl.js` |
| AFFECTED → AFFECTED, target corrected | 6 | `publicvuln`, `multisibling`, `dupwrite`, `dupreverse`, `mainfield`, `esmpub` — verdict already right, evidence now names the real implementation |
| unchanged | 2 | `directpub`, `unreachvuln` — the no-regression controls |

The direction that would need the most scrutiny — `UNKNOWN →
NOT_AFFECTED`, a newly *manufactured* negative — **does not occur
anywhere in this task**. Every new `AFFECTED` carries a concrete path into
the authoritative public entry's own implementation.

### `RWB-05` and RWF-002 — unchanged, deliberately

`RWB-05` remains a KNOWN_FAIL with its expected verdict untouched, and
P1-A1's target resolution for it is **not regressed**: `qs#parse` still
resolves exactly, through `qs/lib/index.js` — which *is* `qs`'s
authoritative public entry, so anchoring there is if anything more direct
than the old file sweep — onto `qs/lib/parse.js`'s anonymous whole-module
default. The `could not be attributed` reason stays gone.

`RWF-002` is untouched. `RWB-05`'s residual reachability incompleteness is
exactly as it was; nothing here weakens Family C's completeness
requirement to make the case green.

### Remaining limitations (deliberately not fixed here)

- **Deep imports stay UNKNOWN.** A consumer may bypass the public entry
  (`require("pkg/sibling")`) while the advisory names the public
  `pkg#vulnerable`. Those are different claims, and deciding when they
  coincide is subpath-resolution semantics. It fails closed (`deep-lib`).
  Where the legacy scan answered such a case, it answered it by name
  coincidence, not by proof.
- **No `package.json` `exports`/subpath advisory support was added.** The
  existing resolver's semantics are used as-is for the default entry; an
  advisory that explicitly targets a subpath is out of scope here. That
  remains a later P1-A task. *(Done in P1-A3 — see RWF-031 below, which
  also found that the install-PATH probe described above could admit a
  `main` that `exports` supersedes.)*
- **Cross-package advisory ownership is still refused, not modelled** —
  unchanged from P1-A1.
- **No multi-instance target expansion** — unchanged; instance exactness
  is preserved, advisory → many-instance expansion is P1-A4.
- **A package with no default public entry is UNKNOWN**, not widened. 2 of
  the 125 corpus instances are in that state, and both are SUBPATH-ONLY
  packages (`"main": false` plus an `exports` map with no `"."`) rather
  than resolution failures — see "Packages with no default public entry"
  above. Failing closed is the correct answer while subpath advisory
  semantics are unimplemented; it is still a coverage boundary, and is
  recorded as one rather than rounded away. *(P1-A3/RWF-031 keeps the
  package-ROOT refusal exactly as it is and adds the missing half: an
  advisory that explicitly names one of those packages' declared subpaths
  now resolves authoritatively.)*
- **`export * from` stays unresolved** as a forwarding hop — unchanged
  from P1-A1; P1-B ESM work.

## RWF-031 — Package-entry semantics: a superseded `main` could answer for an `exports` package, and a SUBPATH advisory was never anchored at its instance (P1-A3)

**Classification: soundness / target-identity correction, in BOTH
directions.** Not a coverage improvement.

Two defects in the same relation —
`verdict.ts`'s authoritative-public-entry probe set, introduced by P1-A2 —
recorded together because they are one family (which public surface of
which installed instance may answer for an advisory) and are fixed by one
extraction.

**Discovered:** P1-A3's own resolver inventory, by differentially probing
real `node` against `ts.resolveModuleName` across every package-entry form
before writing any code.
**Reproduced for this task:** on the P1-A2 merge base
`eb128b67384cee0652dddb963fc214bde4097773`, by swapping that commit's
`verdict.ts` into this branch and running `fixtures/package-entry`'s own
suite. 4 of its 30 cases fail there, in both directions.

### Defect 1 — a PATH probe never consults `exports`

P1-A2 resolved a package's authoritative public entry by probing the real
module resolver with a fixed specifier set:

```ts
const specifiers = [moduleSpecifier, packageInstance];
```

The second member — the instance's **absolute install directory** — exists
so that an npm-ALIASED install stays resolvable (RWF-009: `"foo-alias":
"npm:foo@1.2.3"` installs package `foo` at `node_modules/foo-alias`, so the
advisory's own name `foo` resolves into it from no context at all).

But an absolute path is a *path* request, and real Node resolves a path
request through `main`, never consulting `exports`. Measured directly:

```json
{ "main": "./legacy.js", "exports": { ".": "./modern.js" } }
```

```
require("expmain-lib")                       -> modern.js
require("/abs/.../node_modules/expmain-lib")  -> legacy.js
```

`ts.resolveModuleName` reproduces Node exactly here, in both directions —
so the probe faithfully returned a file that **no importer can reach
through the package name**, and P1-A2's union admitted it as an
authoritative public entry.

That is the RWF-030 defect restored through a different door. RWF-030's own
statement of principle — *package MEMBERSHIP is necessary for target
identity, never sufficient*; `pkg/other.js` exporting `vulnerable` is not
evidence about what `require("pkg").vulnerable` is — applies verbatim to a
`main` that `exports` supersedes.

Three concrete consequences, each a **false AFFECTED**:

- a superseded `main` file that exports the advisory's literal name, is
  dangerous, and is genuinely reachable (the public entry re-publishes it
  under a *different* public name) answered for a package whose public
  `vulnerable` is safe and never called — `expmainsafe-lib`;
- an `exports` target pointing at a file that is **not there** fell back to
  a sibling that does export the name — `badexports-lib`;
- an `exports`-encapsulated internal file became an authoritative public
  target — reproducible by removing only the new gate (`encap-lib`), though
  on merged main this particular case was masked by Defect 2, which
  degraded every subpath advisory to UNKNOWN before it could be reached.

### Defect 2 — a SUBPATH advisory was never anchored at its instance

`resolveTargetNodes` selected installed instances by comparing the
advisory's module specifier against each instance's package **name**:

```ts
const instances = graphPackageInstances(graph, target.module, knownPackageRoots);
```

`target.module` is a free string in `schemas/symbol-rule.schema.json`, so an
advisory may legitimately name a subpath — `qs/lib/parse`, `pkg/parse`,
`@scope/pkg/api`. `"pkg/parse"` is never any instance's package name, so the
comparison matched **nothing**, `instances.size` was 0, and resolution fell
through to Site B — a fresh, independent, **instance-blind** re-resolution
that feeds a *phantom* node into the reachability search.

Site B is correct where it was designed to be used (the package was never
discovered by the graph at all, so "unreachable" is positively established).
It is not correct here: the package instance genuinely *is* in the graph,
and a phantom then received a complete family-C negative proof about a
target whose identity was never established.

Two concrete consequences, each a **runtime-reachable false NOT_AFFECTED** —
the worst class:

- `subpathfwd-lib/api#vulnerable` — real `node` proves
  `require("subpathfwd-lib/api").vulnerable` **is** `impl.js`'s callable and
  **is** executed; merged main reports NOT_AFFECTED;
- `twin-lib/api#vulnerable` on the alias instance — same cause, additionally
  losing the PackageInstance distinction the twin fixture exists to pin.

### The remediation

The relation is extracted from `analysis/verdict.ts` into
`code-intelligence/package-entry.ts` as
`resolveAuthoritativePackageEntries`, beside the module resolver it
delegates to, and gains three things:

1. **Specifier splitting.** `parseBarePackageSpecifier` splits a bare
   specifier into package NAME and SUBPATH, scope-aware, so `@scope/pkg/api`
   yields name `@scope/pkg` (root `node_modules/@scope/pkg`, never the scope
   directory) and subpath `api`. The NAME selects installed instances; the
   whole specifier resolves the entry. A subpath advisory is therefore
   anchored at `exports["./api"]` **within this finding's own exact
   PackageInstance**, and never answers for `"."` or vice versa.
2. **The install-PATH probe is gated** on the instance declaring no
   `exports` — precisely the condition under which a path request and a bare
   request provably agree. It remains for instances outside any
   `node_modules` directory (npm workspace members, `file:` links), where no
   install-directory name exists.
3. **The alias handle becomes a BARE specifier.** An aliased instance is
   probed by its install DIRECTORY (`foo-alias`, `@scope/pkg`), which goes
   *through* the `exports` algorithm rather than around it. That
   substitution is gated on OWNERSHIP, never path shape: the instance's own
   `package.json` must declare the advisory's package name — the package
   itself saying "I am `foo`", which is exactly what npm writes for an alias
   install. Without that gate any instance would answer a request for any
   package name with its own root entry, because a substituted specifier
   resolves into the instance by construction. Two same-basename packages
   under different scopes (`@scope/pkg` vs `@other/pkg`) are the shape that
   makes that concrete, and it is pinned.

No package-resolution semantics are added. Every answer still comes from the
same `ts.resolveModuleName`-backed resolver the call graph itself uses —
`exports` (string shorthand, `"."`, explicit subpaths, conditional branches,
wildcard patterns), `main`, the `index` fallback, and the file/package `type`
scope. Where that resolver refuses a surface, resolution returns nothing and
the caller refuses: UNKNOWN, never a sibling scan. P1-A2's union-of-probes
remains, and remains safe for the same reason — an entry contributes a target
only when the call graph holds a real node for that resolved file, so a
candidate from an inactive condition materializes nothing. P1-A1's forwarding
relation is re-used unchanged, now anchored at a subpath's entry too.

### Evidence

Two independent oracles, neither of which asks the analyzer what it thinks.

**`fixtures/package-entry/verify.cjs`** — 24 checks under real `node`, out of
process, asserting by callable IDENTITY and resolved FILE: which specifier
loads which file (or which error code it throws), which callables are
identical to which, and how many times each is actually executed by each
consumer.

**`src/code-intelligence/package-entry.differential-oracle.test.ts`** — 28
shapes, comparing `require.resolve` in a real `node` child process against
`resolveAuthoritativePackageEntries`, requiring exact agreement **including
on every refusal**. This is the evidence for the "adds no semantics of its
own" claim.

Both run in CI. VulnTrace itself never executes target code (AGENTS.md); both
oracles are test-only, and the analyzer side of the differential is pure
resolution.

### Real-world controls

The two subpath-only packages P1-A2 identified in the vendored corpus,
probed by the P1-A3 relation against their real installed copies under
`tests/validation/fixtures/rwb-05-qs-unused-api`:

| Request | P1-A3 | Real `node` |
| --- | --- | --- |
| `dunder-proto` | REFUSED | `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `dunder-proto/get` | `get.js` | `get.js` |
| `math-intrinsics` | REFUSED | `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `math-intrinsics/abs` | `abs.js` | `abs.js` |
| `math-intrinsics/constants/maxSafeInteger` | `constants/maxSafeInteger.js` | same |
| `math-intrinsics/notAThing` | REFUSED | `MODULE_NOT_FOUND` |
| `qs` | `lib/index.js` | `lib/index.js` |
| `qs/lib/parse` | `lib/parse.js` | `lib/parse.js` |

Both packages' ROOT surface still correctly refuses — P1-A2's behavior,
unchanged. What is new is that an advisory explicitly naming one of their
declared subpaths now resolves authoritatively. **No rule in this repository
names such a subpath, so no finding moves verdict because of it.** The
capability is real; the verdict impact on this corpus is zero, and is
recorded as zero rather than implied to be more.

### Corpus

`scripts/p1a3-package-entry-corpus.mjs`. Capability counts describe the
prevalence of a package-entry SHAPE in these corpora only; they are not a
claim about npm at large and imply no verdict movement.

Over the vendored real-world corpus (`tests/validation/fixtures`), 49
installed instances:

| Shape | Instances |
| --- | --- |
| `main` only, no `exports` | 26 |
| declares `exports` | 16 |
| — of which also declare `main` | 14 |
| — with an `exports` `"."` entry | 14 |
| — with the `exports` string shorthand | 0 |
| — with explicit subpaths (49 subpaths total) | 15 |
| — with wildcard subpaths | 0 |
| — SUBPATH-ONLY, no `"."` | 2 |
| — with any conditional branch | 1 |
| — with a CUSTOM (unsupported) condition | 0 |
| scoped names | 0 |
| install directory ≠ manifest name (npm-ALIAS shape) | 1 |
| package-root entry resolved | 45 |
| package-root entry refused | 2 |
| neither `main` nor `exports` | 5 |
| unreadable `package.json` | 2 |

**Authoritative-entry selection differences on that corpus: 0.** The P1-A3
relation selects exactly the same package-root entry as merged main for
every real vendored instance — including all 14 that declare both `main` and
`exports`, where in each case the two happen to name the same file. The
defect shape is real (proved by real `node` and by the fixture), but it does
not occur in *this* vendored set at the package-root surface. Across both
corpora together (146 instances) the 5 differences are all in P1-A3's own
fixture, which is what that fixture is for.

### Verdict differential

Merged main `eb128b6` vs this branch.

| Movement | Count | Where |
| --- | --- | --- |
| AFFECTED → NOT_AFFECTED | 1 | `expmainsafe-lib` — a false AFFECTED removed |
| AFFECTED → UNKNOWN | 1 | `badexports-lib` — a false AFFECTED removed |
| NOT_AFFECTED → AFFECTED | 2 | `subpathfwd-lib/api`, `twin-lib/api` — runtime-reachable false NOT_AFFECTED removed |
| UNKNOWN → AFFECTED | 0 | — |
| UNKNOWN → NOT_AFFECTED | 0 | — |
| NOT_AFFECTED → UNKNOWN | 0 | — |

All four are in `fixtures/package-entry`, all four are corrections in the
sound direction, and each is independently proved by real `node`. The
canonical validation baseline is **unchanged**: 18 passed / 5 KNOWN_FAIL
(`VAL-002`, `VAL-003`, `RWB-03`, `RWB-05`, `RWB-09b`), identical to
`eb128b6`. `RWB-05` remains KNOWN_FAIL on RWF-002, exactly as P1-A1 left it.

### Remaining limitations (deliberately not fixed here)

- **Custom `exports` conditions are not supported.** Only what the existing
  resolver itself surfaces (`import`, `require`, `default`, `node`, `types`)
  is selectable. An entry reachable only through an arbitrary custom
  condition fails closed. 0 instances in the vendored corpus use one.
- **Wildcard subpaths are consumed, never implemented.** Where
  `ts.resolveModuleName` resolves a pattern, the result is used as-is; where
  it does not, the answer is UNKNOWN. There is no home-grown partial
  wildcard matcher, and no test asserts behavior beyond what the resolver
  itself provides.
- **A deep import that bypasses the public entry is still a different
  claim.** `require("pkg/sibling")` at a call site while the advisory names
  `pkg#vulnerable` remains UNKNOWN — unchanged from P1-A2. What P1-A3 adds
  is the *advisory-side* subpath, not a consumer-side equivalence.
- **`"main": false` is read only as "no `main`".** It is treated as the
  absence of a default entry, which is what real Node does for these
  packages, rather than modelled as its own negative assertion.
- **Package-root escape is refused by the resolver, not by a VulnTrace
  check.** `escape-lib` fails closed because `ts.resolveModuleName` refuses
  it. No independent containment check was added, deliberately: a
  second, divergent containment policy is a worse failure mode than one.
- **Cross-package advisory ownership is still refused, not modelled** —
  unchanged from P1-A1/P1-A2.
- **No multi-instance target expansion** — unchanged; instance exactness is
  preserved, advisory → many-instance expansion remains later P1-A work.
- **npm workspaces, pnpm virtual stores beyond canonical paths, Yarn PnP,
  bundler and `browser`-field semantics, and TypeScript `paths` aliases are
  out of scope** and untouched.
- **`export * from` stays unresolved** as a forwarding hop — unchanged from
  P1-A1; P1-B ESM work.

---

## RWF-032 — A monorepo's own local packages had no identity, so advisories about them were answered from project-root resolution with no instance gating (P1-A4)

> **SUPERSEDED IN PART — read "RWF-032 CORRECTION" at the end of this file
> before relying on anything below.** An independent audit blocked the
> first revision of this branch. Its verdict differential was measured
> without a `package-lock.json`, which a real scan requires, and is an
> artifact; its "no identity at all" framing is too strong for the
> production path; and its "fails closed" claim held only of discovery,
> not of the verdict. Two code defects the audit found (silent traversal
> truncation, and Site B certifying negatives without identity) are fixed.

**Classification: soundness / target-identity correction, in BOTH
directions, plus new coverage.** The verdict differential below contains a
removed false NOT_AFFECTED and two removed false AFFECTEDs.

**Discovered:** P1-A4's identity inventory, by probing `identifyModule`
and `resolveAuthoritativePackageEntries` against a real npm-workspace
monorepo before writing any code.
**Reproduced for this task:** by running the branch's own workspace suite
with discovery disabled, which reproduces merged main's behavior exactly
(`ScanOptions.withoutWorkspaceDiscovery`). Every baseline claim below is a
passing assertion in `verdict.workspaces.integration.test.ts § Z`, not a
recollection.

### The defect

`identifyModule` can name a package two ways: from a `node_modules/<name>`
path segment, or from dependency-graph PROVENANCE (`KnownPackageRoots`,
VT-307c-fix-4b). A monorepo's own `packages/lib` matches neither. It has
no `node_modules` segment, and npm writes its lockfile entry as a
versionless `link`, which `buildDependencyGraph` skips because it can form
no `DependencyNode` ("inherent to unversioned/local links", as that file
already said).

So a workspace package's files came back as bare paths — no
`packageName`, no `packageInstance`:

```
packages/lib/index.js  =>  { resolvedFile }        // and nothing else
```

`graphPackageInstances` therefore found no instance of the advisory's
package name, and target resolution took its **Site B** fallback: resolve
`target.module` once from the PROJECT ROOT, bind the export in whatever
file that lands on, or a phantom. That path predates P1-A2 and has no
instance gating and no public-entry authority — for workspace packages, it
was still the live path.

Three consequences, all measured:

1. **A forwarded workspace sink was a false NOT_AFFECTED.** `fwdlib`'s
   entry publishes `vulnerable` by forwarding it to `impl.js#internal`.
   Project-root resolution found no `vulnerable` *defined* in `index.js`
   — because it is a forward — produced a phantom, searched, and certified
   the target unreachable. Real `node` shows the implementation really
   runs from the consumer.
2. **Two packages' evidence was mixed.** A finding about
   `packages/scopedtwin` (which declares `@scope/lib` but is not what the
   name resolves to) was answered with `packages/scopedlib`'s
   genuinely-reached `api.js`. Symmetrically, a finding about the SAFE
   installed `mixedlib` was answered with the vulnerable workspace copy's
   reachability. Both false AFFECTED.
3. **Negatives rested on no entry authority.** Where the project-root
   resolution simply didn't export the advisory's name, main answered
   NOT_AFFECTED — a negative that no public-entry authority supported.

What main did NOT get wrong, pinned as negative results so the defect's
boundary is explicit: a package *under* `node_modules`, even nested inside
a workspace member, always had identity from its path shape, so
instance-exactness already worked there; and a workspace finding never
inherited an installed twin's verdict, because the twin DOES have an
identity and VT-212 instance-exactness refuses rather than substitutes.
Merged main was **uninformative** about local packages, not systematically
wrong about them.

### The fix

One missing authority, added at the identity layer and nowhere else:
`dependencies/workspaces.ts` reads the repository's own `workspaces`
declaration and hands the resulting canonical roots to
`buildKnownPackageRoots`. Everything downstream is untouched P1-A1/A2/A3
machinery, which could not run for these packages before only because it
had no exact instance to run against. **There is no workspace-specific
target resolver, and no workspace-specific forwarding or entry semantics.**

A directory becomes a package root only when BOTH hold: the root
manifest's own `workspaces` declaration covers it, AND it really contains
a readable `package.json`. Authoritative metadata plus a real manifest —
never a directory that merely looks like a package. This is the same
discipline `KnownPackageRoots` already applies to installed packages,
where provenance rather than filesystem shape is what admits a root.

Identity is the **canonical root**. Not the name, not the version, not
both: two workspace packages declaring the same name and version are two
packages, and a workspace copy and an installed copy of the same name and
version are two packages. Conversely two spellings that realpath to one
directory are ONE package — which is not a VulnTrace convention but what
Node does, since it loads and caches by realpath. The fixture's runtime
oracle asserts both directions out of process, including that
`node_modules/lib` and `packages/lib` really produce a single
`require.cache` entry.

### A second defect the differential oracle found

The absolute-install-PATH probe in `resolveAuthoritativePackageEntries`
had **no ownership gate**. A path request resolves into the instance by
construction, so the existing instance-identity check passes trivially and
can reject nothing — meaning any instance would answer a request for ANY
package name with its own `main`/`index`. The package never had to say "I
am `foo`".

That was unreachable in practice while the probe applied only inside
`node_modules`, where the alias probe covers the same ground *with* an
ownership gate. P1-A4 makes packages outside `node_modules` resolvable,
and for them this is the only probe that fires — so the hole stopped being
theoretical. It is now gated on the instance's own manifest declaring the
advisory's name, exactly as the alias probe is. A strict tightening: all
59 P1-A3 package-entry tests are unchanged by it.

### Workspace discovery is bounded, and fails closed

Three plain directory enumerations, each rooted at its pattern's own
literal prefix: a literal path, a trailing `*`, a trailing `**` (depth- and
count-capped). Never a repository-wide `package.json` scan, and
deliberately **not a glob engine** (P1-A4 § NON-GOALS).

Every other pattern shape — negations, a wildcard anywhere but the final
segment, `?`, character classes, brace expansion, extglobs, absolute
patterns, anything containing `..` — discovers nothing and is REPORTED as
unsupported. So is a `workspaces` value whose shape is not an array of
strings or an object with a `packages` array. Reporting matters as much as
refusing: "this repo declares no workspaces" and "this repo declares
workspaces this analyzer cannot read" must stay distinguishable, because a
package that silently disappears is a package a negative verdict can then
be built on.

Two directories are never admitted: the monorepo root (it is not one of
its own child packages) and anything under `node_modules` (installed
packages already have an identity authority; a second one for the same
question is a worse failure mode than one).

**Object-form `workspaces`** (`{"packages": [...]}`), a perfectly valid npm
manifest, previously made `parsePackageJson` **throw** and failed the whole
scan — a hard failure, not a fail-closed one. The raw value is now
preserved and interpreted where the semantics live, exactly as
`exports`/`imports` already are.

### Discovery is not reachability

Admitting a root changes only the ATTRIBUTION of files the analysis
already reached. It loads nothing, adds nothing to any call graph, and
makes nothing reachable. `ModuleLoadClosure` is untouched: it consumes
`identifyModule` exactly as before and its Family A/B/C contracts are
unchanged. A merely-discovered workspace package is not a loaded one.

### Runtime oracle

`fixtures/workspaces/verify.cjs` — real `node`, out of process, 39 checks
establishing ground truth BEFORE any expectation was written. It caught
one of this task's own wrong assumptions immediately (a deep import into a
package declaring no `exports` does resolve, so `safelib/sibling` is
reachable as a path — which is precisely why its existence must not
establish authority).

`workspaces.differential-oracle.test.ts` compares real Node against
VulnTrace on identity and entry, both asked **from the true consumer**
(`packages/app`) rather than from the repository root — the distinction
that decides which of two shadowing copies is correct.

**Disagreements on supported shapes: 0.**

One divergence is characterized rather than removed. Where Node refuses a
name because nothing is INSTALLED under it (two workspace packages both
named `dup`), the entry relation still reports that instance's own `main`
— truthfully, since the package does declare that name. Importability is a
question the relation deliberately does not model. Rather than assert a
refusal it does not make, the guarantee is recovered directly and
asserted: an instance no consumer can import contributes no graph nodes,
so its entry binds no target and AFFECTED is unreachable by construction.

### Verdict differential

Merged main `9a320c4` behavior vs this branch, over all 25 advisory/
consumer pairs in `fixtures/workspaces`:

| Movement | Count | Where |
| --- | --- | --- |
| NOT_AFFECTED → AFFECTED | 1 | `fwdlib` — a false NOT_AFFECTED removed |
| AFFECTED → UNKNOWN | 2 | `scopedtwin`, installed `mixedlib` — two false AFFECTEDs removed |
| NOT_AFFECTED → UNKNOWN | 5 | negatives that no entry authority supported |
| UNKNOWN → AFFECTED | 0 | — |
| UNKNOWN → NOT_AFFECTED | 0 | — |
| AFFECTED → NOT_AFFECTED | 0 | — |

**Zero new NOT_AFFECTED verdicts of any kind**, so the "every
UNKNOWN→NOT_AFFECTED needs manual positive proof" requirement is
vacuously satisfied, and no AFFECTED→NOT_AFFECTED audit is needed.

The single new AFFECTED carries exact instance, authoritative entry,
concrete path (`packages/fwdlib/impl.js`) and runtime agreement — the
oracle asserts the implementation's own marker really comes back from the
consumer.

The 5 NOT_AFFECTED→UNKNOWN are a real **precision cost, recorded rather
than buried**. They are workspace packages now being held to exactly the
standard installed packages already meet: P1-A2's contract for "the
authoritative public entry does not publish this export" is UNKNOWN. Main
produced NOT_AFFECTED there from a project-root resolution with no entry
authority behind it. Giving up a negative is the safe direction, and
keeping one that no authority supports is what RWF-030 exists to prevent.

The canonical validation baseline is **unchanged**: 18 passed / 5
KNOWN_FAIL (`VAL-002`, `VAL-003`, `RWB-03`, `RWB-05`, `RWB-09b`), identical
to `9a320c4`. `RWB-05` remains KNOWN_FAIL on RWF-002, untouched.

### Corpus

Measured across every vendored manifest in `tests/validation/fixtures` and
`fixtures` — **226 manifests**:

| | Count |
| --- | --- |
| manifests declaring `workspaces` | 1 |
| — array form | 1 |
| — object form | 0 |
| — unsupported shape | 0 |
| scoped package names | 4 |

The single `workspaces` declaration is **P1-A4's own fixture**. The
vendored real-world corpus contains **no monorepos at all**, so it can
neither validate nor measure workspace behavior, and nothing here is
evidence about workspace prevalence in the npm ecosystem. Fixture coverage
is not extrapolated into ecosystem coverage.

### Package-manager capability

Based on tested filesystem layout only, never on package-manager branding:

| Layout | Status |
| --- | --- |
| npm workspaces (array form) | supported — tested |
| npm/Yarn workspaces (object `packages` form) | supported — declaration parsing tested |
| Yarn classic workspaces, symlink layout | supported where the layout is ordinary symlinks + realpath — same mechanism, not separately fixtured |
| pnpm workspaces | supported ONLY where ordinary resolver + realpath suffice; `pnpm-workspace.yaml` is NOT read, so a pnpm repo declaring workspaces only there discovers nothing (fails closed) |
| Yarn Plug'n'Play | unsupported — no `.pnp.cjs` interpretation; fails closed |
| `file:` / `link:` dependencies | claimed by workspace discovery deliberately NOT; they remain the pre-existing dependency-graph provenance path's business |
| Nx / Turborepo / Bazel project graphs | unsupported, out of scope |
| lockfile solving, installation | never — no package manager is run |

### Remaining limitations (deliberately not fixed here)

- **`pnpm-workspace.yaml` is not read.** Only the root `package.json`'s
  own `workspaces` field is an authority. A pnpm monorepo that declares
  its packages solely in `pnpm-workspace.yaml` discovers nothing and every
  advisory about its local packages stays UNKNOWN. Fails closed, and is
  the most likely next increment.
- **Glob patterns beyond literal / trailing `*` / trailing `**` are
  refused,** negations included. A repo whose declaration uses them
  discovers nothing from those patterns and is told so.
- **The root package is never an advisory target.** It is excluded from
  discovery by construction. Whether a monorepo root that declares its own
  `main`/`exports` should be representable is left open rather than
  special-cased by name.
- **`workspace:`/`file:`/`link:` specifiers grant no authority.** Only the
  resolved path does. A workspace package that a package manager has not
  materialized into `node_modules` is not importable, and VulnTrace agrees
  with Node rather than inferring the link that would have existed.
- **Duplicate workspace names are answered per-instance, not globally.**
  Each duplicate gets its own symmetric, order-independent answer; there
  is no global "this name is ambiguous" diagnostic.
- **Cross-package advisory ownership is still refused, not modelled** —
  unchanged from P1-A1/A2/A3. A workspace layout does not make cross-
  package target ownership safe, and P1-A4 changes no ownership rule.
- **No multi-instance target expansion** — unchanged; instance exactness
  is preserved, advisory → many-instance expansion remains P1-A5.
- **RWF-002 is untouched**, and `RWB-05` remains UNKNOWN for the
  reachability-scoping reason P1-A1 recorded.

---

## RWF-032 CORRECTION — the record above was measured in a configuration a real scan cannot be in

An independent soundness audit of the P1-A4 branch **blocked** it and found
three things wrong. Two were defects in the code, now fixed; the third was
wrong in this record itself. The account above is preserved as written (it
is what was believed at the time, and the repository keeps its history),
and everything it says that conflicts with what follows is **superseded
here**.

### Correction 1 — "local workspace packages had no identity at all" is too strong

A production scan REQUIRES `package-lock.json` (`cli/scan.ts` returns exit
3 without one), and npm writes a `packages/<dir>` entry for every workspace
member that declares both a `name` and a `version`. `buildDependencyGraph`
turns each into a `DependencyNode` whose `location` is that workspace path,
and `buildKnownPackageRoots` has always admitted those locations. So on
merged `9a320c4`, a **versioned** workspace member already had an exact
`PackageInstance` through ordinary dependency provenance — no workspace
discovery involved.

The defect is real but NARROWER than stated: it applies to local packages
the dependency graph does not enumerate. The canonical case is a
**versionless private workspace package** (`"private": true` with no
`version`), which is ordinary in real monorepos: npm writes its lockfile
entry without a version, `buildDependencyGraph` skips it ("inherent to
unversioned/local links", as that module already said), and the
repository's own `workspaces` declaration is then the only authority that
can name it. `fixtures/workspaces/packages/privlib` is that case.

### Correction 2 — the verdict differential above is an artifact

The original differential was measured against a fixture with **no
`package-lock.json`**. Re-measured with the lockfile a real scan requires,
merged main already produced the branch's answer for every one of the four
headline movements:

| case | main, no lockfile | main, WITH lockfile | branch |
| --- | --- | --- | --- |
| `fwdlib` | NOT_AFFECTED | **AFFECTED** | AFFECTED |
| `@scope/lib/api` @ `scopedtwin` | AFFECTED | **UNKNOWN** | UNKNOWN |
| `mixedlib` @ installed copy | AFFECTED | **UNKNOWN** | UNKNOWN |
| `safelib` | NOT_AFFECTED | **UNKNOWN** | UNKNOWN |

None of those four is a base-vs-branch difference. The claims of "a false
NOT_AFFECTED removed" and "two false AFFECTEDs removed" **do not hold** in
any configuration a scan can run in, and the "5 NOT_AFFECTED→UNKNOWN
precision cost" was likewise already main's behavior.

`fixtures/workspaces` now ships a realistic `package-lock.json`, and the
integration suite loads it, so the P1-A4 matrix is measured in production
configuration.

### Correction 3 — "fails closed" was only true of DISCOVERY

Discovery invents no roots for an unsupported layout, which is what the
original record meant. But a package with no identity fell through Site B
in `resolveTargetNodes`, which resolved the advisory's module from the
project root with no instance gate and no RWF-030 authority, fabricated a
phantom, and let Family C certify it unreachable. The audit reproduced a
**runtime-reachable false NOT_AFFECTED** this way. "Fail closed" was false
at the layer that matters.

### Defect A (found by the audit, fixed) — silent traversal truncation

A `packages/**` walk that hit its depth cap returned its partial result as
complete and reported nothing: 14 nested packages on disk, 8 discovered,
`unsupported` empty. The guard intended to prevent it
(`queue.length > 0` tested after a loop that only exits when the queue is
empty) could never fire. Truncation is now recorded BY the walk, and a
pattern that cannot be enumerated completely contributes no roots and is
reported. The caps stay; a bounded walk must report its bounds, not hide
them.

The directory budget is now per pattern. Shared, it made discovery depend
on declaration order — `["big/**", "small/*"]` found nothing while
`["small/*", "big/**"]` found two packages, same repository, same
declarations.

### Defect B (found by the audit, fixed) — Site B could certify a negative without identity

Positive and negative results now depend on identity differently, because
they are not equally underwritten by it:

- a real graph node for the advisory's export, in the file its own
  specifier resolves to, was allowed to establish **AFFECTED**, on the
  reasoning that missing identity can mis-attribute such a result but never
  fabricate it. **That reasoning was wrong and is superseded — see
  "RWF-032 CORRECTION 2" below**, which records the counter-example and the
  ownership gate that replaced it;
- the same search concluding "unreachable" no longer establishes
  **NOT_AFFECTED**, because nothing confirms the file resolved from the
  project root is the copy the finding is about;
- with no node at all, no phantom is fabricated.

This cannot fire for an installed package (always identified by path
shape), nor for an identified workspace package, so the ordinary negative
"this dependency is never imported" is untouched.

**LOSS OF PACKAGE IDENTITY CANNOT CREATE NOT_AFFECTED.** That is what makes
the fail-closed claim true at the verdict layer.

### Corrected verdict differential (production configuration)

Merged main `9a320c4` vs this branch, over all 26 advisory/consumer pairs
in `fixtures/workspaces`, with the lockfile present:

| Movement | Count | Where |
| --- | --- | --- |
| NOT_AFFECTED → AFFECTED | 1 | `privlib` — a runtime-reachable false negative removed |
| UNKNOWN → AFFECTED | 0 | — |
| UNKNOWN → NOT_AFFECTED | 0 | — |
| AFFECTED → UNKNOWN | 0 | — |
| AFFECTED → NOT_AFFECTED | 0 | — |
| NOT_AFFECTED → UNKNOWN | 0 | — |

One movement, in the sound direction, independently verified: real `node`
executes `privlib`'s forwarded implementation, merged main answers
NOT_AFFECTED for it (reproduced by building `9a320c4`'s own `src` against
this fixture), and the branch answers AFFECTED anchored at
`packages/privlib/impl.js`. **Zero new NOT_AFFECTED of any kind**, so no
positive-proof audit is owed.

> **Scope of this row, clarified by P1-A5 — see "RWF-033 CLARIFICATION"
> at the end of this file.** These 26 pairs are measured through
> `buildFinding` directly, with `packageVersion: "1.0.0"` and
> `matchResult: "affected"` supplied by the harness. That is the right
> experiment for what P1-A4 changed — target identity and reachability —
> but it supplies the applicability that a real scan of a versionless
> package cannot derive. A production `vulntrace scan` of this fixture
> emits **no `privlib` finding at all**, before and after P1-A4 alike.

Isolating the two changes: against the branch's own Site B gate but with
discovery disabled, `privlib` reads UNKNOWN rather than NOT_AFFECTED — the
gate removes the false negative, and discovery converts the resulting
UNKNOWN into an exact AFFECTED. Each change is necessary; neither alone is
sufficient.

The canonical validation baseline is unchanged: 18 passed / 5 KNOWN_FAIL,
`RWB-05` still UNKNOWN on RWF-002.

### What P1-A4 is actually worth, stated honestly

Not "workspace packages had no identity". Specifically:

1. exact `PackageInstance` identity for local packages the dependency
   graph does not enumerate — versionless/private workspace members above
   all;
2. the ownership gate on the absolute-install-path probe, which stopped any
   instance answering for any package name (independently re-verified: 10
   adversarial wrong-package pairs, 0 answers);
3. symlink canonicalization and twin distinctness for local packages,
   verified against real Node;
4. the Site B identity gate, which makes missing identity fail to UNKNOWN
   rather than to a fabricated negative — a guarantee that extends well
   beyond workspaces;
5. a foundation for later workspace coverage.

### pnpm, restated

`pnpm-workspace.yaml` is still not read, and support for it is future
coverage. What has changed is the consequence: a pnpm monorepo's local
packages get no identity, and a target in one now resolves to **UNKNOWN**
at the verdict layer rather than to a NOT_AFFECTED built on absent
identity. That is asserted directly
(`verdict.local-package-identity.integration.test.ts § A`), not argued.
Yarn PnP is unsupported on the same terms.

### Remaining limitations (corrected)

- **`pnpm-workspace.yaml` is not read** — fails to UNKNOWN, proven, not
  assumed.
- **Glob patterns beyond literal / trailing `*` / trailing `**` are
  refused**, and a `**` tree deeper than the cap or wider than the
  per-pattern budget now contributes nothing and says so.
- **A truncated pattern discards even the roots it found.** The safest of
  the available options, and cheap because missing identity can no longer
  produce a negative — but it does cost coverage, and a future revision
  could keep those roots if it propagated incompleteness precisely.
- **The root package is never an advisory target**; unchanged.
- **Duplicate workspace names are answered per instance**, symmetrically
  and order-independently; there is no global ambiguity diagnostic.
- **Cross-package advisory ownership is still refused, not modelled**;
  unchanged from P1-A1/A2/A3.
- **No multi-instance target expansion** — P1-A5.
- **The vendored corpus still contains no monorepos**, so none of this is
  validated against real-world workspace repositories. That limitation is
  unchanged and remains the weakest part of P1-A4's evidence.

---

## RWF-032 CORRECTION 2 — a concrete path to the WRONG package instance was enough for AFFECTED

A second independent audit blocked the first remediation. The two defects it
was written for (silent traversal truncation; missing identity certifying a
negative) were fixed correctly. It found a third, in the half of Site B that
remediation deliberately left open.

### The disproven claim

The first remediation permitted a positive result without identity,
reasoning that a real graph node for the advisory's own export "can
mis-ATTRIBUTE an AFFECTED to the wrong instance, but never fabricate it".
Both halves are false:

```
advisory          : foo
finding instance  : packages/foo      <- publishes only `safe`
node_modules/foo  -> packages/bar     <- publishes `vulnerable`, and runs
runtime           : bar-danger:X
verdict (before)  : AFFECTED, evidence in packages/bar
```

The finding's own package contains no such export, so that verdict is
**fabricated**, not mis-attributed. And it reproduces just as readily with
identity FULLY available — where `packages/bar` is correctly identified as
a different instance — so identity presence was never the discriminator.

### Root cause: an asymmetry between the two sites

Site A has always required `instance === packageInstance` before any node
may answer for a finding (VT-212/ADV2-045: one installed instance must
never inherit another's reachability). Site B — the fallback taken when the
call graph holds no node of the advisory's package NAME at all — had no
equivalent check. It resolved the advisory's module from the PROJECT ROOT
and bound whatever real node it landed on.

The defect is therefore **not workspace-specific**. Workspaces only made it
easy to reach, because a local package whose name resolves elsewhere is an
ordinary monorepo misconfiguration.

### The fix: target ownership, in both directions

Site B now requires the resolved file to belong to the finding's own
`PackageInstance` before it may establish anything. A concrete graph path
into another package proves nothing about this one, and neither does that
other package's absence — so the gate is symmetric: no AFFECTED, and no
NOT_AFFECTED, from a file the finding does not own.

`identityUnverified`, the first remediation's narrower mechanism, is
removed rather than layered on: ownership subsumes it, since a file with no
identity can never equal the finding's instance.

Three things are deliberately untouched:

- a finding with no `packageInstance` (callers predating VT-212) — there is
  no instance to own the target, so there is nothing to compare;
- synthetic name-only test graphs, whose "files" were never on disk;
- the ordinary negative Site B exists for — a package nothing imports. Its
  files are absent from the graph, the advisory's module still resolves
  inside the finding's own instance, and the phantom still certifies
  non-reachability exactly as before.

### The target-authority invariant, stated

A real graph node is **not** sufficient to establish an advisory target.
For a package-owned advisory, authority requires exact package identity,
authoritative public-entry resolution, exact symbol attribution, optional
forwarding, and only then reachability. A concrete path substitutes for
none of those.

### Results

Wrong-package matrix — all ten shapes (identity absent; identity present;
same export name; same version; same manifest name; two local packages
sharing a name; alias-looking directory; scoped advisory; nested
`node_modules`; symlink to the wrong physical package) now return
**UNKNOWN**. AFFECTED and NOT_AFFECTED violations: **0**.

Same-name/same-version twins: a finding for the safe copy no longer borrows
the vulnerable copy's evidence.

Preserved positives and negatives, all asserted: a package that really
publishes and runs the sink is still AFFECTED; forwarding from the
finding's own package is still AFFECTED at the implementation file; a
loaded-but-unused package and a never-imported package are both still
NOT_AFFECTED.

Verdict differential, `38942d3` → this remediation, over the whole
`fixtures/workspaces` matrix: **no movement in any class**. The change is
confined to wrong-package shapes, which the fixture did not contain. The
private/versionless canonical win (`privlib`, NOT_AFFECTED on merged main →
AFFECTED here — under the supplied-applicability harness; see the scope note
above) is unchanged, and the canonical validation baseline remains
18 passed / 5 KNOWN_FAIL.

### What this says about the earlier record

Two successive remediations of the same function each fixed a real defect
and each left a narrower one, in the same place: the boundary between
"there is a file here" and "this file answers for this package". The
surviving rule is the one Site A already had, now applied on both sides —
loss or mismatch of package identity cannot produce a verdict in **either**
direction.

---

## RWF-033 — An advisory's instances shared one identity in the report, and enumeration could not see an instance the lockfile had no version for (P1-A5)

**Classification: explainability correction, plus new coverage. No verdict
in the real-world corpus moved in either direction.** This is the honest
headline: the per-instance *analysis* was already right, and RWF-033 is
mostly about being able to *tell*, plus one genuine absence.

**Discovered:** by inventorying how `cli/scan.ts` selects an installed
instance for an advisory before writing any code, then reading the result
schema and asking what a reader could distinguish.

**Measured against:** merged main at `d812cca`, built and run side by side
with this branch over the same 15 configured corpus projects, sharing one
OSV cache so both sides saw identical advisory inputs.

### What was already correct on main

`buildDependencyGraph` emits one `DependencyNode` per lockfile entry, and
VT-307c-fix-1 already fanned out per node *and* per `location`, calling
`buildFinding` once per install location with that location as the
finding's authoritative `packageInstance`. `graphPackageInstances` already
keys by canonical path rather than name/version; the public-entry memo is
already per-finding and keyed `(instance, specifier)`; there is no finding
dedupe anywhere. None of that needed changing, and none of it changed.

So the true baseline is narrower than "advisories collapsed to one
instance". They did not. Three things around that fan-out did.

### Defect 1 — two instances, one indistinguishable row

A `Finding` carried `{vulnerability, package, version, verdict}`. Two
installs of `foo@1.2.0` at different roots therefore produced two
**byte-identical** JSON objects. The verdicts could legitimately differ —
one AFFECTED, one NOT_AFFECTED — and nothing in the output said which was
which.

This was not hypothetical, and it had already caught a test.
`src/cli/scan.anonymous-export.test.ts`'s twin case selected its finding
with `findings.find((f) => f.package === "anon-lib")` and silently read
whichever twin enumeration emitted first. Changing the enumeration order
flipped that test from AFFECTED to NOT_AFFECTED with no analysis change at
all — package-level collapse, in a test written specifically to prevent it.

The two negative-proof evidence objects already carried an exact canonical
`packageInstance`, so a NOT_AFFECTED was partly identifiable; an AFFECTED
or an UNKNOWN was not identifiable at all.

### Defect 2 — an instance the enumeration could not see

`buildDependencyGraph` skips any lockfile entry with no `name` or no
`version` — "inherent to unversioned/local links", as it says. A private
workspace package (`fixtures/workspaces/packages/privlib`, `{"name":
"privlib"}` with no version) therefore formed no `DependencyNode`, and
P1-A4's workspace discovery fed only `KnownPackageRoots` — *attribution* —
never advisory candidacy.

The result was not a wrong verdict. It was **no verdict**: not AFFECTED,
not NOT_AFFECTED, not UNKNOWN. An advisory naming that package, discovered
through an installed sibling of the same name, was reported for the sibling
and the workspace copy was never mentioned. A reader seeing one
NOT_AFFECTED row reasonably concludes the advisory is handled.

### Defect 3 — applicability was a property of the group, not the instance

Advisory lookup grouped `DependencyNode`s by `name@version`, and that group
key was also the fan-out key. The group's shared version was therefore the
only version its advisories could ever be evaluated against, and an
instance with no established version belonged to no group at all — which is
the mechanism behind defect 2.

### The remediation

`buildPackageInstanceRegistry` (`src/dependencies/package-instances.ts`)
converges the two authorities that can name a package root — every
`DependencyNode` location and every discovered workspace root — on the
**canonical physical root**. Convergence, not concatenation: an npm
workspace member is routinely named three times (its lockfile entry, its
workspace declaration, and the `node_modules/<name>` symlink npm writes),
and all three are one loaded copy at runtime because Node resolves and
caches by realpath. The converse is equally load-bearing and is *not*
dedupe: two genuinely separate physical copies of the same name **and**
version stay two instances.

`findApplicablePackageInstances(registry, advisoryName)` is the named seam
the expansion happens at. Enumeration stays out of target resolution, and
`buildFinding` still reasons about exactly one `PackageInstance` per call
and never sees the others.

Advisory lookup is now keyed by package **name** and the fan-out by
**instance**. One provider query per distinct installed version — the same
query set as before, asserted — then each instance evaluated against its
own version and nothing else. An instance with no version is
`indeterminate`; it never borrows a sibling's.

Ownership reuses P1-A3 exactly rather than inventing a rule: an instance is
selectable by its dependency-graph name *or* by the name its own manifest
declares (`readInstalledPackageName`, already the alias-ownership
authority). Selecting on either is conservative in the safe direction —
over-selecting costs at most an extra UNKNOWN, because instance-scoped
target resolution independently refuses to anchor an advisory at an
instance whose manifest does not own the name, while under-selecting
silently loses a vulnerable copy.

Findings now carry `packageInstance`, rendered inside `buildFinding` from
the finding's own canonical id and the context's own project root — never
accepted as a caller-supplied label, because a label that can disagree with
the identity will eventually name the wrong instance. It is
project-relative inside the project (`node_modules/foo` vs
`packages/app/node_modules/foo`, reproducible across checkouts) and
canonical absolute outside it.

**Site A and Site B were not touched.** The diff of
`src/analysis/verdict.ts` against `d812cca` is exactly two things: the
optional `packageVersion`, and the identity header. Multi-instance
expansion does not reopen Site B as a cross-instance fallback.

### Schema

`findings[].packageInstance` added (optional); `findings[].version` moved
out of `required`. The relaxation is additive and cannot change any
finding that existed before: an instance with no version previously
produced no finding whatsoever, so nothing that carried a version stopped
carrying one. `schemaVersion` is unchanged at `0.6` because that string
tracks the SDD document version, not an independently evolving result
schema.

### Runtime oracle

`fixtures/multi-instance/` is a new hermetic fixture built so the answers
genuinely differ, and
`src/dependencies/package-instances.differential-oracle.test.ts` takes
ground truth from real `node` out of process — `require.resolve`,
`fs.realpathSync`, nearest ancestor manifest. Resolution only; no fixture
code is ever loaded.

Real Node, measured:

| consumer | specifier | loads |
|---|---|---|
| repo root | `twinlib` | `node_modules/twinlib` |
| `packages/app` | `twinlib` | `packages/app/node_modules/twinlib` |
| repo root | `reallib` | `node_modules/reallib` |
| repo root | `aliaslib` | `node_modules/aliaslib` (declares `reallib`) |
| repo root | `privlib` | `packages/privlib` (through a symlink; no version) |
| repo root | `@scope/dup` | `node_modules/@scope/dup` |
| repo root | `scopeddup` | `packages/scopeddup` (declares `@scope/dup`) |

Required mismatch count against VulnTrace's enumeration: **0**, achieved.
Every enumerated root is additionally confirmed out of process to exist,
carry its own manifest, and equal its own realpath.

### Adversarial matrix

Both required counts hold: **false AFFECTED = 0** and **runtime-reachable
false NOT_AFFECTED = 0** across nested twins, workspace + installed,
alias vs real, same-name/same-version twins, scoped twins, versionless
instances, reversed enumeration order, and two advisories over one
instance.

The suites were **mutation-checked rather than assumed**, because a suite
that passes against the defect proves nothing:

| mutation | tests that fail |
|---|---|
| collapse candidates by `name+version` | 6 |
| borrow a versionless instance's version from a sibling | 2 |
| drop canonicalization, so a symlink over-splits | 1 |

### Corpus — stated honestly

Across `fixtures/` and `tests/validation/fixtures/`: 33 projects, 103
converged instances, 11 package names with more than one instance, 19
logical paths converged onto an already-known physical root.

But the breakdown matters more than the totals. The **real-world** corpus
(`tests/validation/fixtures/`) contains exactly two multi-instance
projects, and both are *same name, different versions*:

- `rwb-09`: `semver@7.5.2` beside the alias install `semver-vulnerable`
  declaring `semver@7.5.1`;
- `rwb-11`: `url-parse@1.4.7` nested beside `url-parse@1.4.4` hoisted.

It contains **no same-name/same-version twin and no workspace + installed
pair**. Those shapes exist only in the hermetic fixtures
(`fixtures/multi-instance`, `fixtures/workspaces`) and in the v2
adversarial suite, whose `vt2-vuln-lib@1.0.0` twins are "identical in name,
version and vulnerable export name, distinguishable only by path".

So: **the corpus evidence for the specific defects RWF-033 closes is weak,
and fixture success is not extrapolated to it.** What the corpus does show
is that RWF-033 costs nothing there.

`rwb-11` is worth naming as the real-world shape that already worked and is
now legible: one advisory, `GHSA-8v38-pw62-9cw2`, AFFECTED at
`node_modules/consumer/node_modules/url-parse` and NOT_AFFECTED at
`node_modules/url-parse`. On main those two rows were told apart only by
their differing `version` string; had the versions matched they would have
been identical.

### Verdict differential vs merged main (`d812cca`)

Both trees built and run over the same 15 configured corpus projects with a
shared OSV cache:

| class | count |
|---|---|
| advisories where main emits one finding and this branch emits several | 0 |
| new AFFECTED instances | 0 |
| new NOT_AFFECTED instances | 0 |
| new UNKNOWN instances | 0 |
| findings lost | 0 |
| verdict changed for a matched instance | 0 |

**No movement in any class.** Not vacuous — those projects produce real
findings with real verdicts (rwb-11 alone produces 13 across two
instances); the corpus simply contains none of the shapes that move. Every
new-instance count being zero is also why no manual negative-proof
verification was required: this branch produced no new NOT_AFFECTED
anywhere in the corpus.

The canonical validation baseline is unchanged: **18 passed / 5 known
failures**, the identical five (`VAL-002`, `VAL-003`, `RWB-03`, `RWB-05`,
`RWB-09b`).

### RWB-05 / RWF-002 — untouched, deliberately

Not remediated here. `qs#parse` target identity remains exact and the final
verdict remains UNKNOWN.

`RWB-09b` also remains a known failure, and remains the benchmark-design
issue already recorded against it: the patched `semver@7.5.2` instance is
confidently out of range, so it produces **no finding**, while the oracle
expects the string `NOT_AFFECTED`. Preserving that is deliberate — P1-A5
was explicitly not to change the confident-out-of-range contract. The
branch's own end-to-end matrix asserts that contract per instance: an
out-of-range instance produces no finding while its in-range twin still
does, each matched against its own version.

### Performance

Measured branch vs main through the real `runScanCommand` with a stubbed
provider, N nested instances of one name all reachable, M advisories:

| instances | advisories | findings | main | branch |
|---|---|---|---|---|
| 1 | 1 | 1 | 141 ms | 139 ms |
| 5 | 1 | 5 | 266 ms | 313 ms |
| 10 | 1 | 10 | 422 ms | 444 ms |
| 20 | 1 | 20 | 849 ms | 845 ms |
| 40 | 1 | 40 | 2056 ms | 2068 ms |
| 10 | 5 | 50 | 776 ms | 776 ms |
| 10 | 20 | 200 | 2680 ms | 2699 ms |

Indistinguishable from main within run-to-run noise, which is expected:
main already performed the same fan-out. Cost grows with instances ×
advisories, and the slightly superlinear growth in the instance column is
the call graph itself growing (each added instance adds a consumer package
to the graph), not the expansion. `scan-performance` regression thresholds
are unchanged and still pass (3291 ms / 5000 ms, 9107 ms / 20000 ms).

No cross-instance cache was introduced. The OSV cache is keyed
`(toolVersion, ecosystem, name, version)` and never sees a
`PackageInstance` — correctly, since twins at one version are asking the
same question — and a cache-hit run is asserted to reproduce the full
per-instance split, not merely to return findings.

### Incomplete enumeration — what is and is not claimed

Enumeration is authoritative-metadata-driven: lockfile install paths and
declared workspace roots. It never scans the filesystem for directories
named after a package, and never infers an instance from source text.

Consequently VulnTrace claims "**we analyzed this instance**", never
"**these are all the instances in this application**". No
advisory-level, application-wide NOT_AFFECTED is introduced, and none
should be: verdicts remain per instance. A package physically present but
named by neither authority is not enumerated — and, because negative
proofs remain gated on exact instance identity (P1-A4's Site B gate), such
a package cannot authorize a negative verdict either.

### Remaining limitations (deliberately not fixed here)

- **A workspace member sharing a name with a published package** will be
  queried against the public advisory database for that name. This is how
  every SCA tool treats workspace members, and is usually right — a
  workspace member's name normally *is* its published name — but a local
  package that coincidentally shares a name with a vulnerable public one
  will be evaluated against advisories about that public package. The
  per-instance verdict is still anchored at the local instance and P1-A3's
  ownership check still gates target anchoring, so the realistic cost is an
  extra UNKNOWN rather than a false AFFECTED.
- **Yarn/pnpm workspaces without an npm lockfile** contribute instances
  only through workspace discovery, which is bounded and fails closed
  (P1-A4). pnpm's content-addressed store is reached only where the
  dependency graph or a symlink already names it.
- **`version` is read from the lockfile entry or the workspace manifest**,
  not reconciled against the installed package's own manifest. A lockfile
  that disagrees with what is on disk is not detected here.
- **The real-world corpus does not exercise the shapes this record is
  about** (see Corpus above). That is a gap in the corpus, not a claim
  about the code, and it is the main reason the confidence here rests on
  the runtime oracle rather than on corpus movement.

---

## RWF-033 REMEDIATION — conflicting version metadata, and oracles that could not name an instance

Two defects found by the independent P1-A5 audit. Neither could produce a
wrong AFFECTED or NOT_AFFECTED on any shape the corpus contains, which is
why the audit certified; both are real, and both are fixed here.

### Defect 1 — enumeration order could decide an instance's version

The registry converges several discovery records onto one canonical
physical root. That is right: a lockfile entry, the `workspaces`
declaration, and the `node_modules` symlink npm writes beside a workspace
member are three records about one physical package, and Node loads it
once.

Identity convergence was correct. **Metadata reconciliation was not a
separate step at all** — the first record to claim a root simply kept its
own fields. For `version` that has a consequence, because version decides
advisory applicability. Reproduced directly:

```
node_modules/conf-lib  ->  symlink to packages/conf-lib
lockfile: "packages/conf-lib"      version 1.0.0   (in the advisory's range)
lockfile: "node_modules/conf-lib"  version 5.0.0   (outside it)
```

One physical directory, two contradictory declared versions. Reading the
entries in one order produced a finding; reversing them produced none.
`packageName`, `declaredLocation` and `provenance` were order-dependent the
same way, with explainability rather than soundness at stake.

**The fix** separates the two questions. Records are collected per
canonical root first, reconciled second, over the SET of versions the
records actually declare:

| declared versions | result |
| --- | --- |
| exactly one distinct | that version |
| two or more distinct | `undefined` |
| none | `undefined` |

Being a property of the set, this is order-independent by construction
rather than by care, and a conflict cannot be walked back: `1.0.0`,
`2.0.0`, `1.0.0` stays unresolved. A fold comparing "incoming against
current" would restore `1.0.0` on the third record; this cannot.

Conflict **fails closed**, never to a winner. First, last, highest, lowest
and lexicographic are all arbitrary, and each converts "this project's own
metadata contradicts itself about this directory" into a confident verdict
computed from a version nothing established.

What is actually observable, stated in layers rather than as a single
verdict — an earlier draft of this record said "indeterminate applicability,
UNKNOWN", which is true only when something else already surfaced the
advisory:

1. the instance's reconciled version becomes `undefined`;
2. it therefore contributes **no provider query** — there is no version to
   ask about, and no sibling's version is ever borrowed;
3. if nothing else establishes an advisory candidate for that package name,
   **no finding is emitted at all** for the instance;
4. where an advisory IS materialised anyway — a same-named sibling carries a
   concrete version and its query returns one — applicability for this
   instance is `indeterminate` and the finding is **UNKNOWN**;
5. either way a **diagnostic** records the conflict (`source:
   "dependencies"`), naming the instance and the contradictory versions, so
   outcome (3) is not silent.

Step 5 exists because steps 1–3 are sound but invisible: an instance that
contributes nothing to the report is indistinguishable from a package about
which nothing was wrong. The diagnostic changes no verdict and creates no
finding — a contradiction in the project's own metadata is an absence of
information, not evidence of anything (AGENTS.md: every uncertainty must be
represented explicitly).

The diagnostic is one entry per canonical root however many contradictory
records it had, with the version set sorted and de-duplicated, so its
content does not depend on enumeration order. Nothing is reported for a root
that is merely silent about its version, for records that agree, or for two
genuinely different roots at two versions — that last is ordinary
multi-instance installation, not contradictory metadata.

**Silence is deliberately not conflict.** A record with no `version` makes
no competing claim and is not in the distinct-version set. An ordinary npm
workspace member is routinely described by a lockfile entry carrying its
version and a manifest omitting one; counting that as a contradiction would
make every such package UNKNOWN for no soundness gain. It would also
contradict how every other fallback here reads a silent source —
`identifyModule` prefers a manifest name and falls back to the path;
`buildDependencyGraph` calls a versionless link entry "inherent to
unversioned/local links". None of them reads "this source does not know" as
"this source disagrees".

Evidence: the failure was pinned before the fix (both orders, a three-record
walk-back, a silence control, and a permutation matrix over five metadata
multisets), plus an end-to-end scan of a contradictory lockfile in both
orders and an agreeing-records control.

### Defect 2 — the adversarial oracles selected by package + version

Sixteen v2 fixtures deliberately plant a second install of `vt2-vuln-lib`
at the same name **and** version as the one the host package really
requires — "the TOP-LEVEL vt2-vuln-lib install, which any resolution keyed
on package name and version rather than on install path would find", as the
scenarios themselves say. The decoy exists to catch a name/version-keyed
ANALYZER.

It also catches a name/version-keyed ORACLE, and the oracles were one.
`findings.find(package && version)` returns whichever twin the scan emitted
first, and those twins can carry different verdicts (for ADV2-072: AFFECTED
at the nested install, NOT_AFFECTED at the decoy). The suite passed only
because emission order happened to put the nested copy first — every host
package is named `vt2-<a..t>-lib`, which sorts before `vt2-vuln-lib`. A
fixture named `vt2-w…` would have flipped the suite's answer with no
analysis change whatsoever. P1-A5 changed that emission order, which is
what made this worth fixing now rather than later.

**The fix**: selection filters, then requires a unique result. An ambiguous
selector becomes its own failing outcome — `AMBIGUOUS_SELECTOR(…)`, naming
the instances — never silently resolved by array position. Running that
against the suite is how the sixteen were identified rather than guessed.

Those sixteen now carry `findingSelector.packageInstance`, and the instance
named is **not "whatever makes the test pass"**: it is the install the host
package's own `require` really resolves, taken from real `node` out of
process for all forty fixtures that have a nested copy. It agrees with the
ambiguity probe in every case.

A guard test pins why this mattered: for ADV2-072 it asserts the two
candidates are identical on version, differ on instance, and differ on
**verdict** — so the old selector's answer was decided by ordering — then
asserts instance-keyed selection returns the same finding under both
orderings.

v1 needed no disambiguation (no v1 scenario is ambiguous) and validation's
fixtures contain no same-version twins today; both got the same strictness
anyway. The two `fooFindings[0]` sites in `scan.test.ts` were left alone:
each is already guarded by a `toHaveLength(1)` that makes it unambiguous.

### RWF-033 CLARIFICATION — what RWF-032's `privlib` row does and does not say

RWF-032 records `privlib` moving NOT_AFFECTED → AFFECTED, under the heading
"Corrected verdict differential (production configuration)". That phrase
corrected an earlier artifact (a measurement taken with no
`package-lock.json`); it does **not** mean the row was measured through
`runScanCommand`.

Those 26 advisory/consumer pairs are driven through `buildFinding`
directly, and the harness supplies:

```
packageVersion: "1.0.0"
matchResult:    "affected"
```

`fixtures/workspaces/packages/privlib` declares `{"name": "privlib",
"private": true}` and **no version at all**. So the harness supplies exactly
the applicability a real scan cannot derive for it.

That is the right experiment for what P1-A4 changed. P1-A4 is about target
IDENTITY and REACHABILITY: given that an advisory applies, does the target
bind at the correct instance? The answer — it binds at
`packages/privlib/impl.js`, through the RWF-029 forwarding relation — is
genuine and unaffected by anything in P1-A5.

What it never established is that a production scan could *derive*
applicability for a versionless package. It cannot, and under P1-A5 it
still cannot:

- version is absent, so it is never fabricated and never borrowed from a
  same-named sibling;
- `advisoryQueryVersions` contributes no provider query for an instance
  with no version;
- applicability is therefore `indeterminate`, which `buildFinding`
  short-circuits to UNKNOWN **before** `checkReachability` runs — so such an
  instance can never receive a negative proof or an AFFECTED either.

Measured, both trees, real `vulntrace scan` of `fixtures/workspaces` with a
`privlib` rule and advisory: **16 provider queries and no `privlib` finding,
identically before and after P1-A5.** The instance is enumerated (P1-A5) and
attributed (P1-A4); it simply has no version for an advisory range to be
evaluated against, and no same-named sibling carries one. Where a sibling
*does* carry one, the versionless instance is reported as UNKNOWN rather
than omitted — that is the case `scan.multi-instance.test.ts` pins.

So the two records agree, and the distinction is worth stating plainly:

| question | authority | answer for `privlib` |
| --- | --- | --- |
| Which instance owns the target? | P1-A4 / RWF-032 | `packages/privlib`, exactly |
| Does the target bind and is it reachable? | P1-A4 / RWF-032 | yes, at `impl.js` |
| Does the advisory's version range apply? | P1-A5 | **not established** |
| Final production verdict | P1-A5 | no finding, or UNKNOWN when a sibling surfaces the advisory |

No documentation in this file should now be read as claiming a production
AFFECTED for a versionless package.

---

## RWF-034 (FOUNDATION F1) — Workspace incompleteness was invisible to machines, and a divergent `node_modules` could not contradict the lockfile

Foundation's first task after P1-A closed. It hardens the uncertainty
boundary around `PackageInstance` METADATA. It changes no verdict rule, no
proof contract, no enumeration strategy and no provider interface.

Central rule being enforced: *if metadata needed for advisory applicability
or package identity is known to be incomplete or contradictory, that
uncertainty must be represented explicitly and must never be resolved by
arbitrary preference.*

### P1-A handoff

Base: `30f3a22` (`fix: report a package instance whose declared versions
contradict each other`), certified before editing — clean tree, identical
to `origin/main`, and a focused P1-A smoke of 713 tests across 17 files
covering same-name/same-version twins, Site A/B ownership, RWF-029..033,
Family A/B/C, `ModuleLoadClosure` and `AnalysisProofContext`, all passing.
The audited tree and merged `main` are the same tree.

Two gaps the cumulative P1-A audit left open are closed here. Neither is a
wrong-verdict defect in the workspace case; the second is, in both
directions, in the version case.

### F1-A — the defect: uncertainty that only a human could see

`discoverWorkspacePackages` already DETECTED every layout it cannot
enumerate: an uninterpretable `workspaces` declaration, an unsupported
pattern shape, and (since RWF-032's correction) a truncated traversal. It
returned them in `WorkspaceDiscovery.unsupported`, and `scan.ts` wrote each
one to **stderr and nowhere else**.

So a consumer parsing `ScanOutput.diagnostics` — the CI job, the dashboard,
the `--format html` reader — saw a scan of an incompletely enumerated
monorepo as **indistinguishable from a scan of a fully enumerated one**.
The verdict layer still failed closed throughout (a package with no
identity cannot authorize a negative verdict, per RWF-032's Site B identity
gate), so no verdict was wrong. But AGENTS.md's "every uncertainty must be
represented explicitly" is not satisfied by a line on a stream nothing
structured reads, and "this repository declares no workspaces" and "this
repository declares workspaces in a form I cannot read" reached the report
as the same thing: nothing.

### F1-A — what was inventoried

Every workspace discovery signal, classified before anything was written:

| Signal | Before | After |
| --- | --- | --- |
| Uninterpretable `workspaces` shape | stderr only | `diagnostics[source=workspaces]` |
| Unsupported pattern shape (`!x`, `pkg-*`, `..`, absolute, brace/extglob) | stderr only | `diagnostics[source=workspaces]` |
| Traversal truncated (depth cap 8, 4096 dirs/pattern) | stderr only | `diagnostics[source=workspaces]` |
| `pnpm-workspace.yaml`-only layout | **entirely dropped** | `diagnostics[source=workspaces]` |
| Root manifest unreadable | empty result | `diagnostics` if pnpm-only, else silent (scan already exits 3 earlier) |

Only one signal was genuinely absent rather than merely unpublished: the
pnpm-only layout. Everything else existed and had no way out.

### F1-A — the fix

No second diagnostics architecture. The existing `Diagnostic {source,
message}` channel carries all of it, under `source: "workspaces"`, and the
stderr lines are kept — this adds a channel, it does not move one.

- **Truncation** now also states the consequence: "…so package instances
  under it may not have been analyzed". It does not claim any specific
  package is safe, and the caps stay: the fix for truncation is to REPORT
  reaching them, not to remove them.
- **pnpm-only** is now detected (`pnpm-workspace.yaml` present, root
  manifest declaring no `workspaces`) and reported. No YAML is parsed, no
  pattern is inferred, and **no `PackageInstance` is invented** from the
  file's presence — the analyzer states its own view is incomplete and
  stops. Only the `.yaml` spelling, because that is the only name pnpm
  itself accepts; reporting `.yml` would blame a file pnpm ignores.
- **Determinism**: reasons are deduplicated and sorted (`finish()`). A
  manifest listing the same unsupported pattern twice describes one thing
  to go fix, not two, and reordering `workspaces` must not reorder a
  scan's diagnostics. Asserted as array equality, not set membership.
- **Empty-string version**: `"version": ""` in a workspace manifest is no
  longer read as a version, matching the installed-manifest reader below.
  It would otherwise manufacture a contradiction against a lockfile
  entry stating a real one.

Reaches JSON and HTML with **no schema change** — `diagnostics` is already
`{source, message}` in `schemas/result.schema.json`, and this is additive
content within it.

### F1-B — the defect: the lockfile could not be contradicted

`buildPackageInstanceRegistry` reconciled the version claims of every
DISCOVERY RECORD about a canonical root (lockfile entries, workspace
declaration) and failed closed on disagreement — RWF-033's remediation.
It never consulted **the package actually installed at that root**.

So in a divergent `node_modules`, an advisory range was evaluated against
a version that describes no code on disk. Both directions reproduced
end-to-end through the real scan command before any fix
(`src/cli/scan.metadata-uncertainty.test.ts`):

**Case A — false AFFECTED.** Lockfile `vuln-lib@1.0.0`; installed manifest
`2.0.0`; advisory `< 1.5.0`. Pre-fix output, verbatim:

```json
{ "vulnerability": "GHSA-f1-0001", "package": "vuln-lib",
  "version": "1.0.0", "packageInstance": "node_modules/vuln-lib",
  "verdict": "AFFECTED",
  "evidence": { "reasons": ["vulnerable symbol resolved",
                            "symbol reachable from application entrypoint"] } }
```

A confident AFFECTED, with a reachability path, about a version that is
not installed.

**Case B — silent false negative.** Same divergence; advisory
`>= 2.0.0 < 3.0.0`. The vulnerable version IS what is installed and IS
reachable. Pre-fix: **zero findings and zero diagnostics.** Not UNKNOWN —
nothing at all.

A third case fell out of the same reproduction: an **unparseable installed
manifest** also produced a confident AFFECTED from the declared version.

### F1-B — the fix: one more claim, no new policy

No new applicability policy. The P1-A5/RWF-033 reconciliation model is
reused exactly: the version is a property of the SET of claims about a
root, and the set failing closed is what it already did.

`readInstalledManifestIdentity` (`src/domain/resolved-target.ts`) reads
`<canonical root>/package.json` ONCE and returns both the name authority
P1-A3 already established and a four-way version claim. The four outcomes
are the whole design, and collapsing any two is a bug in one direction or
a large coverage loss in the other:

| Claim | When | Consequence |
| --- | --- | --- |
| `absent` | no manifest at that root (`ENOENT`/`ENOTDIR`) | **no claim** — nothing is installed, so nothing contradicts |
| `untrusted` | manifest exists, unparseable/unreadable, or `version` present but not a non-empty string | **fail closed** — something is installed and we cannot say what |
| `silent` | manifest parsed, no `version` key | **no claim** — a versionless package is routine |
| `declared` | a concrete version | joins the claim set on equal terms |

Reconciliation then reads:

- exactly one distinct claimed version → that version;
- two or more → `undefined` + version-conflict diagnostic;
- none → `undefined`;
- `untrusted` → `undefined` + unreadable-manifest diagnostic, whatever the
  records claim.

### F1-B — authority model, stated

**Neither source wins.** Preferring the manifest destroys every
uninstalled dependency's version (1064 of this repository's own 6584
lockfile entries have no manifest on disk — see Corpus); preferring the
lockfile is the defect. The analyzer's claim is not "I know which of these
is right". It is "this project's own metadata does not agree with itself,
and I will not compute a confident answer from it".

Consequences, all asserted:

- `instance.version` is `undefined` on conflict;
- **zero provider queries** using either contested version — asserted on
  the recorded query set itself, not on the absence of a finding;
- no AFFECTED, and no NOT_AFFECTED derived from arbitrary applicability;
- an explicit, deterministic diagnostic naming the exact
  `PackageInstance`, both versions, and that no advisory version range was
  evaluated against it. The conflict record additionally carries `sources`
  (`declared` / `installed`), because "the lockfile and the disk disagree"
  is a different thing to go fix than "two lockfile entries disagree".

### F1-B — name authority is untouched

`ownershipNames` still unions the lockfile entry's name and the installed
manifest's name (P1-A3 alias semantics). Reconciling versions narrows
WHICH advisories may select an instance not at all — the same single
manifest read now answers both questions instead of one.

### Behavior matrix (every case asserted end-to-end)

| Case | Result |
| --- | --- |
| lockfile `1.2.3` / manifest `1.2.3` | AFFECTED, one query `@1.2.3`, no diagnostic — **unchanged** |
| lockfile `1.2.3` / manifest has no `version` | AFFECTED at `1.2.3` — manifest makes no competing claim |
| lockfile `1.0.0` / manifest `2.0.0`, advisory `<1.5.0` | no AFFECTED, no query, conflict diagnostic |
| lockfile `1.0.0` / manifest `2.0.0`, advisory `>=2.0.0` | no finding, **conflict diagnostic** (was silent) |
| lockfile `1.0.0` / manifest unparseable | no AFFECTED, no query, unreadable-manifest diagnostic |
| workspace manifest `1.0.0`, no lockfile entry | AFFECTED at `1.0.0` — the local manifest is the authority |
| `node_modules/foo` → `packages/foo`, lockfile `1.0.0` vs manifest `2.0.0` | ONE instance, ONE conflict diagnostic, no query |
| `foo@1.0.0` at root A, `foo@2.0.0` at root B | two instances, **no conflict**, AFFECTED preserved |
| conflicted instance beside a consistent sibling | sibling keeps its query and its AFFECTED verdict |
| npm alias `vuln-alias` -> `vuln-lib`, versions agree | AFFECTED, selected by the real name — alias ownership intact |
| npm alias, manifest contradicts the lockfile | no AFFECTED, no query, conflict reported under the real name at the alias directory |
| scoped `@scope/vuln-lib`, manifest contradicts | no AFFECTED, no query, conflict under the full scoped name |
| reversed lockfile entry order | identical diagnostics, verdicts and query set |

### Corpus — stated honestly

**Corrected.** The figures first recorded here (351 roots, 3578 entries)
came from a walk that capped its depth and did not descend through nested
`node_modules` trees, so it silently measured a SUBSET of the repository
and then described that subset as "every tree". The independent audit
re-measured without those limits. The corrected figures, over every tree
with both a lockfile and an installed `node_modules` (1949 project roots,
6584 lockfile entries):

| | Count |
| --- | --- |
| lockfile and manifest both declare a version, and they **agree** | 5482 |
| they **disagree** | **0** |
| manifest **absent** (declared, not installed) | 1064 |
| manifest silent / no version claim | 38 |
| manifest **unreadable** | 0 |

And over 759 manifests for workspace conditions: 3 declare `workspaces`,
and there are **zero** unsupported shapes, zero unsupported patterns, zero
duplicate patterns, zero `**` patterns, and zero pnpm-only layouts.

Every qualitative conclusion is unchanged by the correction, and the two
that matter are now established on a 1.8x larger sample: **0 disagreements
and 0 unreadable manifests.** The corpus does **not** contain a real
conflicting-version case, and does not exercise any of the defect classes
F1 closes. The defects are real and both directions are reproduced
hermetically from constructed trees — but this repository's own trees do
not exhibit them, and no claim is extrapolated from fixture evidence about
how often a divergent `node_modules` occurs in the wild.

The 1064 absent manifests are the load-bearing number: they are why
`absent` must stay a non-claim, and why "make the disk always win" is not
an available fix.

### Differential vs merged main (`30f3a22`)

Whole-suite, both revisions:

| Suite | main | branch |
| --- | --- | --- |
| unit + integration | 149 files / 3687 tests | 152 files / **3719** tests |
| adversarial | 124 / 124 | 124 / 124 |
| validation | 18 pass, 5 known fail | 18 pass, **same 5**, same verdicts |

The delta is exactly `+3 files / +32 tests` — the three files added here.
**Every pre-existing test is unchanged**, so the verdict differential is
empty by construction: no UNKNOWN→AFFECTED, no AFFECTED→NOT_AFFECTED, no
NOT_AFFECTED→UNKNOWN, no finding→no-finding, in either direction, anywhere
in the existing corpus. The validation suite's five known failures report
the same verdicts (UNKNOWN, UNKNOWN, NO_FINDING, UNKNOWN, UNKNOWN) on both
sides.

Semantic movement is confined to trees that do not occur in this corpus:
a divergent or unreadable installed manifest degrades a confident verdict
to no-query-plus-diagnostic, and an incomplete workspace layout gains a
diagnostic. **No new confident verdict is produced anywhere** — every
change is confident→indeterminate or silent→explicit, which is the only
direction this task was allowed to move.

### Performance

**Corrected.** This section first claimed "zero added filesystem cost",
which is too broad a statement of a narrower true one.

The registry already read `<root>/package.json` once per canonical root
(memoized) for the P1-A3 name authority. It now reads the same file once
per canonical root for BOTH name and version. So there are **no added
filesystem syscalls for manifest reads** — the same file, read the same
number of times — and the only added *reads* are for workspace roots that
previously skipped it, bounded by the number of workspace packages.

There is a small CPU increase in the read/parse path, which "zero" did not
admit. Measured by the audit over 400 roots: the new reader takes
**~15.8 ms** against **~13.0 ms** for the previous comparable read. For
scale, the same reader run unmemoized over 20x duplicate locations costs
**~209.6 ms** — so the per-root memoization is doing what it claims, and
the observed registry cost is consistent with the memoized figure.

The dominant cost in this phase is neither: it is the **pre-existing,
unmemoized, per-location `realpath`** in `canonicalizePackageInstancePath`,
measured at **~415 ms for 8000 locations**. F1 does not touch it, and it is
the obvious candidate should this phase ever need optimizing.

The scan-performance suite is unchanged and inside its thresholds (2392 ms
against a 5000 ms bound; 8321 ms against 20000 ms). No memoization refactor
was attempted and no cache was added — an unsound cache across instances is
exactly what RWF-033 spent its effort making unrepresentable.

### Supported / unsupported environment assumptions

- npm and Yarn `workspaces` (array and `{packages: [...]}` forms):
  supported, with the three pattern shapes P1-A4 defines.
- `pnpm-workspace.yaml`: **not parsed, and now explicitly reported** as an
  unsupported/incomplete layout. Deliberately not implemented here.
- Divergent `node_modules`: detected and failed closed, not repaired.
- `npm link` / content-addressed stores outside the project root: the
  canonical root is still the identity; nothing here changes that.

### Remaining limitations (deliberately not fixed here)

1. **A versionless lockfile entry is never enumerated at all.**
   `buildDependencyGraph` forms no `DependencyNode` for an entry without a
   `version` ("inherent to unversioned/local links"), so such a root
   reaches the registry through no authority and there is no instance for
   an installed manifest version to attach to. This is an ENUMERATION gap,
   not a metadata-authority one; closing it changes what a
   `DependencyNode` is. Pinned by a test that asserts the current
   behavior, and it is why the manifest version, in practice, contributes
   **conflict detection rather than new coverage**: every root the current
   enumeration can see already carries a declared version from the
   authority that enumerated it.
2. **A conflicted instance produces no finding, only a diagnostic.** The
   absence is now explicit, but it is still an absence rather than a
   first-class UNKNOWN row. The broader no-finding taxonomy is Foundation
   F3's, and the UNKNOWN taxonomy is not started.
3. **Truncated workspace discovery still discards the roots it did find.**
   Reporting it is half the fix; the other half (RWF-032) is that a
   package with no identity cannot authorize a negative verdict.
4. **No `pnpm-workspace.yaml` parsing**, by instruction. The layout is
   reported, never guessed at.
5. **RWF-002 untouched**, P1-B not started, `PackageInstance` not
   redesigned, the provider layer not redesigned.

## RWF-035 (FOUNDATION F2) — An absent module-load closure was read as a satisfied guard, and an unclassified dynamic reason was read as safe

Foundation's second task. It hardens the PRECONDITIONS of the negative
proof families. It adds no proof family, weakens none, changes no
enumeration strategy, and introduces no new taxonomy.

Central rule being enforced: *a negative proof is valid only when every
required guard is present and explicitly satisfied; missing guard state
and unknown enum values must fail closed.*

### P0 — base and baseline

Base: `f8bdbda` (`docs: correct RWF-034 corpus and performance
measurements`), Foundation F1 / RWF-034 confirmed merged. Clean tree,
identical to `origin/main`. Focused proof baseline before editing — 623
tests across Family A, Family B, Family C, `ModuleLoadClosure`,
`AnalysisProofContext`, the negative-proof contracts and the module-load
absence suite — all passing. Branch:
`foundation-f2-proof-guard-hardening`.

### The two defects, stated precisely

Both are the same shape: **information that was missing was reported as
information that was favourable.**

| | F2-A | F2-B |
| --- | --- | --- |
| Site | `callGraphNegativeProofBlockers(undefined)` | `isClosureWideningReason(<unknown>)` |
| Returned | `[]` — no blockers | `undefined` — falsy, i.e. non-widening |
| Read by caller as | "the loader/syntax guard passed" | "this construct cannot widen the closure" |
| Actually meant | "there was no closure to ask" | "nobody has classified this value" |
| Reachable in production today | **Yes** | No (see below) |

### F2-A — the defect

`callGraphNegativeProofBlockers` returned `[]` for an absent closure. This
was deliberate and documented, in the helper and again at the call site, as
an accepted residual risk: `undefined` merely reproduced the pre-VT-307d
status quo and was "not itself evidence of a blocker".

That reasoning answers the wrong question. The guard does not ask whether
the closure OBSERVED a problem. It asks whether the loader, syntax-validity
and execution-capability precondition has been ESTABLISHED — and an absent
closure establishes nothing. Returning `[]` converted "no information" into
an affirmative all-clear, which is exactly the "absence of evidence treated
as evidence" AGENTS.md forbids.

### F2-A — why it is not cosmetic

Two of the conditions a present closure blocks on are conditions the CALL
GRAPH structurally cannot detect for itself:

- **a syntax error in a loaded member.** `indexSourceFileFromDisk` is
  error-tolerant, so the graph is built from a partial, silently reshaped
  AST; unlike the closure (VT-307c-fix-2) it never checks
  `hasSyntaxErrors`. A `require` and the call that follows it can be
  swallowed by the same error.
- **a loader mutation in a NON-CALL position**
  (`require.extensions['.js'] = hook`). VT-300's own guard inspects
  unresolved CALL EDGES; an assignment produces no edge for it to see.

Only the closure's whole-file scan sees either. Both were reproduced
end-to-end reaching `NOT_AFFECTED` with the closure withheld and every
other precondition unchanged. Measured, pre-fix:

| Scenario | Closure present | Closure absent |
| --- | --- | --- |
| Syntax error in a loaded member | UNKNOWN (`parse_failure`) | **NOT_AFFECTED** |
| `require.extensions['.js'] = hook` | UNKNOWN (`loader_hook_mutation`) | **NOT_AFFECTED** |
| Unresolved module | UNKNOWN | UNKNOWN (the graph's own unresolved edge catches this one) |

Both false negatives were family C. This is a direct soundness regression,
not a theoretical one.

### F2-A — closure consumer inventory

Traced rather than assumed, before editing:

| Consumer | Requires | Absent-closure behavior before | After |
| --- | --- | --- | --- |
| Family A (module-load absence gate, `verdict.ts`) | `closure !== undefined && complete && rootFiles.length > 0 && !contains(instance)` | already fails closed | unchanged |
| Family B (`confirmedAbsentInstance` corroboration, `checkReachability`) | `closure !== undefined && complete && !contains(instance)` | already fails closed | unchanged |
| Family C / the shared call-graph guard (`callGraphNegativeProofBlockers`) | no blocker present | **fail-open** | blocks |
| `entrypointSourceNodes`'s unindexable-entrypoint path | delegates to the closure's own `parse_failure` | **argument had a hole**: with no closure, that `parse_failure` was recorded nowhere | argument now holds |

The fourth row is worth stating separately: that code returns
`incompleteness: []` for an entrypoint it cannot index, justified in a
comment by the fact that the same file is a closure ROOT and so already
records `parse_failure` there. True when a closure exists; vacuous when one
does not. F2-A closes that hole as a side effect rather than by a second
mechanism.

### F2-A — the invariant now

`ModuleLoadClosure` unavailable → a closure-dependent negative-proof
blocker exists. Encoded as a distinct value,
`module_load_closure_unavailable`, in a new `CallGraphNegativeProofBlocker`
vocabulary — deliberately NOT added to `ClosureIncompletenessReason`, which
is the vocabulary of causes a REAL closure emits while traversing, each
paired with a `ClosureIncompleteness` record naming the member it occurred
in. Closure absence has no such member, and modelling it as an
incompleteness reason would mean inventing a fake `importer` for a walk
that never ran.

The resulting UNKNOWN carries an actionable reason naming the blocker and
what is unverified, not a silent fallback.

### F2-A — the cost, stated rather than hidden

A scan with no closure can no longer reach a call-graph-derived
`NOT_AFFECTED` **at all** — including on a project with no widening
construct anywhere. That is intended, and there is a test asserting exactly
that rather than leaving it to be discovered.

In production a closure is absent only when: there were no entrypoints
(nothing was analyzable, and `scan.ts` already diagnoses it); construction
threw (`scan.ts` diagnoses and continues); or the context binding REJECTED
it for not belonging to these entrypoints and this graph — an integrity
failure. Declining to certify a negative in all three is the correct
answer.

### F2-B — the defect, and the part of the premise that was false

The task's premise was that `isClosureWideningReason` is allow-list based
and that a newly-added reason would default to non-widening at build time.
**That half is false, and was measured rather than assumed**: the function
was already an exhaustive `switch` with no `default`, and with
`strict: true` an unclassified value falls off the end and fails to
typecheck. Verified by adding a reason to the union — `TS2366: Function
lacks ending return statement`.

The real defect is at RUNTIME, and it is genuine. Falling off the end
returns `undefined`, which is falsy, so an unrecognized reason was
classified NON-widening. Measured pre-fix:
`isClosureWideningReason("<unknown>") === undefined`. Both consumers fail
OPEN on that:

- `findClosureWideningConstructs` (`loader-constructs.ts`) does
  `if (!isClosureWideningReason(reason)) return;` — it SKIPS recording the
  construct, leaving the closure `complete`;
- `hasReachableClosureWideningBlocker` (`verdict.ts`) does
  `unresolvedEdges.some(e => isClosureWideningReason(e.reason))` — it finds
  no blocker.

Either one lets a negative proof through on the strength of a construct
nobody classified.

### F2-B — the boundary audit

`DynamicCallReason` is internal and type-closed: produced only by
`call-graph.ts` and `loader-constructs.ts`, and carried across **no**
deserialization boundary — every `JSON.parse` in the tree was inventoried
and none of them (the OSV cache included) parses a reason. So the runtime
half is defence in depth, not a reachable production path today. That is a
property of today's code, not a promise about tomorrow's, and it costs one
branch to stop depending on it.

Fail-closed, not fail-loud: the floor returns `true` (widening) rather than
throwing. A scan's contract is that uncertainty becomes UNKNOWN rather than
an exception — the same rule `buildFinding` already follows for an
untrusted `AnalysisProofContext`.

### F2-B — classification matrix (canonical)

No classification decision was changed. Widening (16):
`dynamic_require`, `dynamic_import`, `eval`, `unresolved_module`,
`declaration_only_resolution`, `aliased_require`, `create_require`,
`function_constructor`, `aliased_eval`, `module_require`,
`module_internal_load`, `vm_execution`, `worker_execution`,
`child_process_execution`, `loader_hook_mutation`,
`loader_capability_escape`. Non-widening (3): `unsupported_construct`,
`dynamic_member_access`, `unresolved_target`. Asserted value-by-value.

### F2-B — the enum-addition guard

Two independent compile-time guards, no source-text assertions:

1. `unclassifiedReasonFailsClosed(reason: never)` in the `default` branch.
   Adding a reason without a `case` now reports the OFFENDING VALUE —
   `TS2345: Argument of type '"f2_probe_unclassified"' is not assignable to
   parameter of type 'never'` — instead of pointing at a closing brace.
   Verified by adding a reason and reading the error.
2. `Record<DynamicCallReason, true>` over the test matrix, so a new reason
   absent from both arrays fails to typecheck in the test too. This is what
   makes a new reason visible to a REVIEWER, not only to the compiler.

### Other fail-open defaults in the proof-guard code

Audited within the proof-guard files only, as instructed — not broadened
into a whole-codebase sweep. Every `catch` in `verdict.ts` and
`module-load-closure.ts` already fails closed (returns `[]`, records
`parse_failure`, or falls through to an existing gate).

One same-class defect found and fixed because it was trivial:
`AnalysisProofContextInput.graphTruncated` was optional and defaulted to
`false` — a caller that said nothing about its graph's coverage was
recorded as having asserted the graph was COMPLETE, which is the strongest
claim available and the one VT-202 gates both call-graph proofs on.
Production always passed it explicitly, so no real scan took that default;
it was a hole waiting for a second production caller. Now REQUIRED at the
type level, so no context can be built without stating coverage. Fixed as a
compile-time change, not a new runtime branch.

### Test-harness honesty, and the 81 tests

Hardening F2-A failed 81 existing tests. They were not adjusted to pass —
they were categorized:

- **73 were under-simulating production.** They build real projects, real
  resolvers and real call graphs on disk, but never built a closure,
  because none was required before. `cli/scan.ts` always builds one.
  `buildFindingForTest` now builds a REAL gate-eligible closure by default,
  which makes those tests MORE faithful to production than they were, and
  all 73 pass unchanged.
- **22 call sites in `verdict.test.ts` are genuinely synthetic** (fake
  paths that never exist on disk). They declare it with
  `syntheticGraphHasNoRealFiles`, the same class of narrow, deliberately
  visible affordance as the existing `allowSyntheticNameOnlyTargetBinding`.
- **2 tests exist to prove absence fails closed** and must be able to
  WITHHOLD the closure explicitly, which `moduleLoadClosureUnavailable`
  now expresses — by statement rather than by omission, since an omission
  cannot be told apart from an oversight.
- **1 test (`VT-307d case 14`) encoded the defect itself** — "closure
  unavailable → falls through to the pre-VT-307d path" and still
  `NOT_AFFECTED`. Inverted, with the reasoning recorded in place. The half
  of it that was always right (an unavailable closure must never
  MANUFACTURE absence evidence) is retained and still asserted.
- **1 test moved verdict**, and it was audited rather than edited:
  `verdict.site-b-target-authority` "does not answer for the wrong instance
  in the NEGATIVE direction" went `UNKNOWN → NOT_AFFECTED`.

### The one verdict movement, audited

The finding is about `packages/bar`; `node_modules/foo` points at
`packages/foo`. Nothing resolves to `packages/bar`, so it is absent from
both the call graph and a complete closure, and family B certifies its own
absence with an empty evidence path — no `packages/foo` file appears in it,
which is the invariant the case actually exists to pin. Confirmed against
the real runtime: executing the consumer never loads `packages/bar` at all.

**Verified independent of F2-A by direct control**: with the production
files reverted to `main` and only the closure supplied by the harness, the
case yields `NOT_AFFECTED` identically. The verdict moved because the TEST
gained a closure that production always had — not because the guard
changed.

### Differential vs main

The validation corpus was run on both `f8bdbda` and this branch. **All 23
cases produce identical verdicts.** Movement in every class —
UNKNOWN→AFFECTED, UNKNOWN→NOT_AFFECTED, AFFECTED→UNKNOWN,
AFFECTED→NOT_AFFECTED, NOT_AFFECTED→UNKNOWN, NOT_AFFECTED→AFFECTED — is
**zero**. The same five pre-existing oracle mismatches (RWB-03, RWB-05,
RWB-09b, VAL-002, VAL-003) appear on both, unchanged.

**No new `NOT_AFFECTED` is introduced anywhere**, so the "every new
confident negative gets a manual audit" requirement is satisfied vacuously
at corpus level, and by the single audited test movement above at unit
level.

### RWB-05 / RWF-002

RWB-05 remains the existing known UNKNOWN on both `main` and this branch.
F2 was not used to improve its precision, and no target-relevant
completeness work was done. **RWF-002 is explicitly untouched and
deferred.**

### Contracts

- **VT-CONTRACT-01** (exactly one of family A/B/C on a `NOT_AFFECTED`;
  none otherwise) — intact, and additionally asserted on every new F2-A
  case, including the degraded ones.
- **VT-CONTRACT-02** (family C evidence structurally required;
  `reachableSubgraphComplete: true`, no resurrected `callGraphComplete`) —
  intact.
- **VT-CONTRACT-03** (`AnalysisProofContext` fails closed) — intact, and
  strengthened by `graphTruncated` becoming required.

### Proof precondition table (as the code actually reads)

| Family | Preconditions |
| --- | --- |
| A | exact instance · closure present · `complete` · gate-eligible · `rootFiles.length > 0` · instance not in `loadedPackageInstances` |
| B | exact instance · `graphTruncated === false` · absent from call graph · no reachable closure-widening unresolved edge · complete-MLC corroboration of the exact `PackageInstanceId` · **no call-graph negative-proof blocker (now including closure absence)** |
| C | authoritative exact target · reachable subgraph searched to exhaustion with no unresolved edge · `graphTruncated === false` · exact instance binding · **no call-graph negative-proof blocker (now including closure absence)** |

### False-`NOT_AFFECTED` matrix

| # | Attack | Result |
| --- | --- | --- |
| 1 | graph absence + closure undefined | UNKNOWN |
| 2 | authoritative target unreachable + closure guard unavailable | UNKNOWN |
| 3 | closure construction rejected (no entrypoints / root mismatch / throw) | UNKNOWN |
| 4 | closure incomplete | UNKNOWN (unchanged) |
| 5 | widening dynamic call reason | UNKNOWN (unchanged) |
| 6 | synthetic unknown runtime `DynamicCallReason` | classified widening → blocks |
| 7 | empty entrypoint roots | no gate-eligible closure → UNKNOWN |
| 8 | mismatched proof context | UNKNOWN (unchanged) |

Runtime-reachable false `NOT_AFFECTED`: **0**.

### Positive target authority

Unchanged by design — this task touches no positive path. Wrong-instance,
same-version twins, Site A/B and forwarding controls all pass; the full
adversarial suite (124 cases) passes. Regressions: **0**.

### Performance

Negligible, as expected: the change is one branch and one type. Focused
proof suites and the performance baselines are unchanged (medium synthetic
project 2450ms against a 5000ms threshold; large single file 8338ms against
20000ms). Nothing was optimized.

### Verification

Full suite 3760 passed / 0 failed · adversarial 124 passed · validation
identical to `main` · performance 2 passed · typecheck, lint, prettier,
build, history-validator all clean. No timeout waivers.

### Remaining limitations

1. **RWF-002 is untouched** and remains open.
2. **No target-relevant closure completeness.** A closure is complete or it
   is not; a construct irrelevant to the target still blocks. F2 does not
   change this, and RWB-05 is its standing example.
3. **`traversal_truncated` still does not block** the call-graph proofs, by
   the existing VT-307e argument (it bounds the closure's walk, while
   `graphTruncated` independently guards the graph's). Unchanged and
   re-verified, not revisited.
4. **The F2-B runtime floor is unreachable today.** It is defence in depth
   against a future producer or boundary, not a fix for an observed
   production path.
5. **No generalized proof-mutation harness.** The mutation-like tests here
   withhold one hardened prerequisite at a time; the general framework
   remains F4's.

---

## RWF-036 (FOUNDATION F3) — Uncertainty was a wall of prose, and a candidate that produced no finding said nothing at all

Foundation's third task. It adds no verdict, changes no proof rule, and
moves no verdict anywhere in the corpus. What it adds is the ability to
ANSWER TWO QUESTIONS a machine previously could not ask.

Central rule being enforced: *every uncertainty must be representable as
data, and "no finding" must never be confusable with "proved safe".*

### F2 handoff

Base: `074fc6c` (`test/docs: harden proof-guard invariants, and record
RWF-035`), certified before editing — clean tree, identical to
`origin/main`, F2's three commits present, `module_load_closure_unavailable`
live in production. Focused baseline of 679 tests across 9 files (verdict,
negative proofs, module-load absence, F2 proof guards, Family B/C,
`AnalysisProofContext`, `ModuleLoadClosure`, widening exhaustiveness) plus
154 tests across 8 CLI/diagnostics files, all passing. Validation suite
baseline: **6 failed / 17 passed**, the documented set (VAL-002, VAL-003,
RWB-03, RWB-05, RWB-09b, and one hermeticity assertion).

### F3-A — the defect: uncertainty nothing could count

An UNKNOWN carried an untyped `string[]`:

```
"unsupported_construct at node_modules/qs/lib/parse.js:112"
"could not resolve module \"qs\": ..."
```

and **two of the eight UNKNOWN routes carried nothing whatsoever** — the
HTML report literally rendered *"The scan result records no reason for this
UNKNOWN finding"* and then GUESSED, in prose, which of two causes had
produced it.

So the question that has to be answered before any frontend-completeness
work is scheduled — *how much of our UNKNOWN surface is a coverage gap we
could close, versus an `eval` nobody can ever close?* — could only be
answered by reading scan output by hand. That is the question P1-B is
prioritized from and the question RWF-002 needs data for.

### F3-A — the taxonomy, and why it has six classes and not five

F3 proposed five and said to audit semantics before forcing internal
reasons into them. The audit found three that fit none of the five
honestly.

Each class names a **different kind of work**, which is the only property
that makes a taxonomy worth having:

| Category | What it means | What closes it |
| --- | --- | --- |
| `unmodeled_construct` | the analyzer saw the construct and has not implemented it | frontend work — **this is the class P1-B is prioritized from** |
| `value_uncertainty` | the construct IS modeled; the value/destination is not statically unique | value analysis, never syntax support |
| `capability_escape` | the runtime can reach outside bounded static reasoning | largely nothing — a property of the language |
| `identity_unresolved` | a package/instance/version/entry/target identity fact was never established | metadata and resolution work |
| `analysis_precondition_unmet` | something the decision DEPENDS ON was never established at all | varies; never a syntax gap |
| `budget_exceeded` | a CONFIGURED bound stopped the work | changing a limit, and nothing else |

The sixth class exists because `parse_failure`,
`declaration_only_resolution` and `module_load_closure_unavailable` share
one nature — a precondition was never established — and fit nothing else:

- Filing them under `unmodeled_construct` was the mechanical answer and
  would have **corrupted the one measurement this task exists to produce**.
  None of the three is a syntax a frontend could learn, and all three would
  have sat in the P1-B ranking as work nobody can do.
- Filing them under `budget_exceeded` would have claimed a configured limit
  stopped work no limit touched.

`declaration_only_resolution` is the sharpest case: resolution SUCCEEDED,
onto a `.d.ts`. Identity is established; executable source was never
obtained. That is why it is not `identity_unresolved`.

### F3-A — orthogonality, stated as a test rather than as a comment

`isClosureWideningReason` (domain/graph.ts) answers a **different question**
— can this construct load a module the graph never discovered? — and is a
SOUNDNESS boundary the proof rules consume. The category is an explanation.

Neither is derived from the other, and `domain/uncertainty.test.ts` proves
it by exhibiting both cross-pairs rather than asserting the intent:

| | widening | non-widening |
| --- | --- | --- |
| `capability_escape` | `eval` | — |
| `identity_unresolved` | `unresolved_module` | `unresolved_target` |
| `analysis_precondition_unmet` | `declaration_only_resolution` | — |
| `unmodeled_construct` | — | `unsupported_construct` |
| `value_uncertainty` | — | `dynamic_member_access` |

If the two axes were one fact, the widening set and the escape set would be
equal. They are not, and that is asserted directly.

### F3-A — exhaustiveness is a compile error, verified by breaking it

Four sites, all compile-enforced:

1. `Record<UncertaintyReason, UncertaintyCategory>` — the mapping table;
2. `Record<DynamicCallReason, UncertaintyCategory>` — every edge reason is
   classified;
3. `AssertIsUncertaintyReason<ClosureIncompletenessReason>`;
4. `AssertIsUncertaintyReason<ModuleLoadClosureUnavailableBlocker>`.

Verified by adding a probe member `"f3_probe_new_reason"` to
`DynamicCallReason` and confirming **all four fail to build** (plus F2's own
`never` floor, which also fires). The probe was then reverted; `git diff`
on `domain/graph.ts` is empty.

An initial version of (3) used
`Object.fromEntries(...) as Record<...>`, which **typechecks regardless** —
the cast defeats the very check it appears to perform. Replaced with a type
constraint, which cannot be cast around.

At RUNTIME an unrecognized value is **never dropped** (F3 § 28): it is
reported as `unclassified_uncertainty_reason` under `capability_escape`,
the most severe class, mirroring `isClosureWideningReason`'s own
fail-closed floor. Dropping would understate uncertainty, the one direction
this analyzer must never err in. Unreachable today — the unions are
type-closed and no deserialization boundary carries one — and that is a
property of today's code, not a guarantee about tomorrow's.

### F3-B — the second defect: no-finding said nothing

Two completely different states reached a consumer as **identical bytes**:

```
"this advisory confidently does not apply to this instance"
"nobody could determine whether this advisory applies"
```

`ScanOutput.unreportedCandidates` separates them. It is **not findings**:
no `verdict`, no `evidence`, no `confidence`, its own top-level array, and
no code path converts one into a `JsonFinding`.

The required `disposition` field is the whole design:

- **`not_applicable`** — the installed version is outside every affected
  range. Real information, arrived at with certainty. It carries **no
  `category` at all**, structurally, so a consumer summing categories
  cannot count patched packages as analysis gaps.
- **`undetermined`** — applicability could not be established.

**Neither is a `NOT_AFFECTED`.** A `not_applicable` entry is a statement
about version ranges and nothing else: no reachability analysis ran, so no
negative proof exists and nothing may promote it to one. The entry's own
`detail` says so in words, and the HTML section repeats it where a reader
skimming headings will see it.

Four `undetermined` sources — three previously stderr-only, one **entirely
invisible**:

| Source | Before F3 | Category |
| --- | --- | --- |
| workspace enumeration truncated | `diagnostics` only | `budget_exceeded` |
| workspace declaration uninterpretable | `diagnostics` only | `identity_unresolved` |
| unsupported pattern / pnpm-only layout | `diagnostics` only | `unmodeled_construct` |
| version conflict / untrusted manifest | `diagnostics` only | `identity_unresolved` |
| **versionless instance, no advisory surfaced for the name** | **nothing at all** | `identity_unresolved` |

The last one is a genuine hole this task found. `advisoryQueryVersions`
correctly contributes no query for an instance with no established version.
An instance whose SIBLINGS have versions is still rescued into its own
honest UNKNOWN (F3 § 4 says to preserve that, and it is preserved). But
when nothing surfaced for the package NAME, the instance was evaluated
against nothing, produced no finding, and vanished. It is now recorded —
and deliberately **not** given a fabricated advisory finding, because there
is no advisory to name (F3 § 4, self-review attack K).

### F3-B — the diagnostics boundary

`diagnostics` is **unchanged**: same source, same words, same count. It is
the operational channel a human reads. `unreportedCandidates` is the
analysis-semantics channel a machine aggregates.

Where one condition appears in both, they carry the **same sentence** — the
structured entry's `detail` is byte-identical to the diagnostic's `message`
— so the two can never word one fact differently (self-review attack L).
Asserted, not intended: `scan.f3-no-finding.test.ts` compares them directly.

Workspace reasons had to become typed for this, because the four of them
map onto **three different categories**. One English sentence cannot be
aggregated into that.

### Schema: additive, no version bump

`unknownReasons` (per finding) and `unreportedCandidates` (top level) are
new OPTIONAL properties. Nothing gained a `required` entry; the schema
declares no `additionalProperties` constraint anywhere, so there was none
to violate. **A result produced before F3 still validates.** AFFECTED and
NOT_AFFECTED findings serialize byte-identically to before — `unknownReasons`
is omitted, not written as `[]`.

`unreportedCandidates` is optional in the schema and always emitted by the
producer, so a consumer never has to tell "nothing was unreported" from
"this scan predates the field".

### THE MEASUREMENT (F3 § 30–§ 32)

Run over the 17-case real-world validation corpus via
`scripts/measure-uncertainty.mjs`, which copies each fixture to a temp
directory first (VT-302) and drives the real CLI against the live OSV API,
exactly as `validation.test.ts` does.

```
findings:              85
UNKNOWN findings:      70
  ...with reasons:     70   (every one; none reasonless)
unreported candidates:  4
  not_applicable:       4
  undetermined:         0
```

By category, in **occurrences**:

| Category | Occurrences |
| --- | --- |
| `analysis_precondition_unmet` | 65 |
| `unmodeled_construct` | 42 |
| `identity_unresolved` | 41 |
| `value_uncertainty` | 5 |
| `capability_escape` | **0** |
| `budget_exceeded` | **0** |

**This table is misleading unless read with the next paragraph, and saying
so is the point of recording it.**

`analysis_precondition_unmet`'s 65 occurrences are **entirely
`no_vulnerable_symbol_rule`, and they are a CORPUS ARTIFACT, not an
analyzer gap.** Each fixture configures exactly ONE rule — the advisory
under test — so every other advisory the live OSV API returns for the same
installed packages produces an UNKNOWN meaning "this benchmark has no rule
for that advisory". Verified by reading the fixtures' `rules.yml`. It says
nothing about VulnTrace's capability and must not be reported as though it
did.

Excluding it, the corpus's analyzer-attributable uncertainty is **5 UNKNOWN
findings**:

| Finding | Blockers |
| --- | --- |
| VAL-002, VAL-003, RWB-03, RWB-10 (one each) | `vulnerable_target_unresolved` — `identity_unresolved` |
| RWB-05's `qs` finding | `unsupported_construct` ×42, `unresolved_target` ×37, `dynamic_member_access` ×5 |

### RWF-002 blocker distribution (F3 § 31)

RWB-05 stays `UNKNOWN`. Its precision was not improved and was not
attempted. What is now visible is **what prevents Family C**:

| Category | Reason | Occurrences |
| --- | --- | --- |
| `unmodeled_construct` | `unsupported_construct` | 42 |
| `identity_unresolved` | `unresolved_target` | 37 |
| `value_uncertainty` | `dynamic_member_access` | 5 |
| `capability_escape` | — | **0** |

The headline for P2: **not one of RWB-05's 84 blocker occurrences is a
capability escape.** None of them is a construct that can load or execute
code the graph never discovered, so none is a fundamental limit of static
analysis. That is a materially different conclusion from "real code
contains `eval`, so UNKNOWN is inevitable", and it could not be drawn from
the prose before.

**84 IS NOT A WORK ESTIMATE, and this record must not be read as one.**
The independent F3 audit flagged an earlier phrasing here ("all of it is
closeable work, split roughly half frontend coverage and half target/export
resolution") as exactly that misreading, and it was right to. What the
number measures is the SHAPE of the uncertainty, not the cost of removing
it:

- The count does **not** prove that all 84 must be modeled, or that 84
  occurrences imply 84 pieces of work. They collapse into three distinct
  reasons, and a single frontend or resolution change can discharge many
  occurrences at once.
- It does **not** prove remediation is easy. "Classified as a category
  that is in principle analyzable" is a statement about the KIND of
  uncertainty, not about its difficulty.
- Most importantly, it does **not** establish that modeling is the remedy
  at all. **RWF-002 is not "implement every blocker"; it asks whether an
  unresolved edge is RELEVANT to a path to the vulnerable target.** A
  later solution may discharge most of these 84 by proving they cannot
  reach or influence the target -- target-relevant completeness -- without
  modeling a single one of them. That is a genuinely different remedy from
  frontend work, it is the one RWF-035's own limitation #2 already names,
  and nothing in F3 chooses between them.

What F3 does establish is narrower and still useful: the observed blockers
are, in principle, analyzable or relevance-classifiable, rather than
capability escapes that would foreclose both routes.

### Top unmodeled constructs (F3 § 32) — and why the signal is not yet actionable

Ranked, as requested:

| Reason | Occurrences | Findings blocked |
| --- | --- | --- |
| `unsupported_construct` | 42 | 1 |

That is the **whole** ranking, and it is the most important limitation this
task surfaces. `unsupported_construct` is the call graph's own
undifferentiated catch-all for "a callee expression shape I have no rule
for". Knowing there are 42 of them does not tell anyone which syntax to
implement.

**So P1-B's actual first step is not to implement a construct — it is to
SPLIT `unsupported_construct` by syntactic shape.** F3 deliberately does
not do that (it would be a frontend change, which this task forbids), but
the taxonomy is built to absorb it: new tokens drop into
`UNCERTAINTY_REASONS` under the same category, and the compile-time
exhaustiveness checks force each one to be classified.

### Soundness: no verdict moved

The acceptance condition (F3 § 24). Classification is observational — every
entry is derived from the same blockers the verdict rules already acted on,
AFTER those rules ran. No branch condition was touched and no branch reads a
classification. Removing the field would change no verdict anywhere.

Validation suite after F3: **6 failed / 17 passed — identical IDs, identical
expected/actual pairs, identical counts to the baseline.**

| Case | Baseline | After F3 |
| --- | --- | --- |
| VAL-002 | expected AFFECTED, got UNKNOWN | unchanged |
| VAL-003 | expected NOT_AFFECTED, got UNKNOWN | unchanged |
| RWB-03 | expected AFFECTED, got UNKNOWN | unchanged |
| RWB-05 | expected NOT_AFFECTED, got UNKNOWN | unchanged |
| RWB-09b | expected NOT_AFFECTED, got NO_FINDING | unchanged |
| 17 others | pass | pass |

0 new false AFFECTED; 0 new runtime-reachable false NOT_AFFECTED
(adversarial 124 passed, unchanged). An `AFFECTED` carries no
`unknownReasons` at all, and neither does a `NOT_AFFECTED` — asserted
structurally, because attaching a reason to a finding that has a reproduced
path or a positive proof would invite "how sure are we about this
AFFECTED?", a question this analyzer does not answer.

### RWB-09b, clarified without being forced

RWB-09b is **not** forced to `NOT_AFFECTED`, and its verdict is unchanged.
What changed is that the state is now explicit:

```json
{
  "stage": "advisory_applicability",
  "disposition": "not_applicable",
  "vulnerability": "GHSA-c2qf-rxjj-qqgw",
  "package": "semver",
  "packageInstance": "node_modules/semver",
  "version": "7.5.2",
  "reason": "advisory_not_applicable_to_installed_version",
  "detail": "installed version 7.5.2 is outside every affected range declared by GHSA-c2qf-rxjj-qqgw, so this advisory does not apply to this instance; no reachability analysis was performed and this is not a proof of non-reachability"
}
```

The benchmark can now decide how to score it against a fact rather than
against a silence. The oracle is left exactly as it was — F3 does not
adjust an oracle to match the tool.

The same mechanism fires for RWB-09a's patched sibling and for both
`url-parse` instances in RWB-11: 4 entries across the corpus, each naming
its exact instance.

### Performance (F3 § 35)

Reason mapping is a `Map` lookup per blocker and one sort per finding.
Measured A/B on `rwb-05-qs-unused-api`, the heaviest UNKNOWN case in the
corpus (84 blocker occurrences aggregated into 3 entries), 7 runs each,
base `074fc6c` rebuilt in place versus F3:

| Build | median wall | median reported `totalMs` | wall range |
| --- | --- | --- | --- |
| `074fc6c` | 12728 ms | 10627 ms | 12533–12838 |
| F3 | 12653 ms | 10547 ms | 12486–12770 |

The ranges overlap and F3 measures marginally faster, so the overhead is
**below this harness's noise floor** — not "small", but unmeasurable at the
scale the corpus reaches. No optimization was attempted or needed.

### Verification

F3 focused suites: `domain/uncertainty.test.ts` 33, verdict taxonomy matrix
19, no-finding matrix 15, HTML 10, schema additivity 5. Full suite
**3842 passed / 0 failed** across 158 files. Adversarial 124 passed.
Validation identical to baseline. Performance 2 passed. Typecheck, lint,
prettier, build, history-validator all clean. No timeout waivers.

These totals are the FINAL ones, counted after the audit remediation
below. An earlier draft of this record said 3833 across a no-finding
matrix of 11; both were written before the last two commits landed and
were stale rather than wrong-in-kind. The independent audit caught it,
which is the sort of thing a record's own numbers should never need
catching for -- gate totals are now written last, not mid-task.

Two of the new tests were **wrong on first write and were fixed rather than
weakened**, both worth recording because both were asserting something
false about the system:

1. The category-ordering test asserted `eval` sorts before
   `unsupported_construct`. It does not — `unmodeled_construct` is declared
   first. Rewritten to a case where count order and declaration order
   genuinely DISAGREE (20 × `eval` versus 1 × `unsupported_construct`), so
   it now proves what it claimed to.
2. The capability-escape test asserted a `new Function(src)()` finding has
   no `unmodeled_construct` anywhere. It legitimately does: the call on the
   constructed function is a second, separate `unsupported_construct` edge,
   and that edge IS a real coverage gap. Asserting the blanket negative
   would have been asserting that F3 COLLAPSES co-occurring blockers — the
   opposite of what § 19 requires. Narrowed to assert the escape's own
   entry.

### Audit remediation — the one behavior F3 added and did not cover

The independent F3 audit found that `installed_version_unavailable` — the
single genuinely NEW no-finding path this task introduced, and one this
record leads with — **had no committed test.** The audit reproduced it by
hand and confirmed it was reachable and correct, but nothing guarded it:
it appeared only in `cli/scan.ts` and in the mapping table, and the corpus
measures zero `undetermined` candidates, so neither the suite nor the
benchmark would have noticed if it regressed to silence. AGENTS.md
requires a test for every behavior change, and this was the behavior
change.

Closed by four regressions driven through the real `runScanCommand`
orchestration, not through the mapping helper — the helper cannot say
whether the orchestration still reaches the path:

- a versionless workspace package with no versioned sibling produces **no
  provider query at all**, no finding, and exactly one `undetermined`
  candidate naming its exact instance, with no `version` and no
  `vulnerability` key;
- neither an AFFECTED nor a NOT_AFFECTED is reached, and it is explicitly
  not the out-of-range conclusion;
- the SIBLING CONTROL: with a versioned sibling present, the provider is
  queried once with the sibling's own version, and the versionless
  instance still carries no version — it reaches its own instance-local
  UNKNOWN (`advisory_version_applicability_indeterminate`) rather than
  borrowing one, which is the § 4 rescue this task had to preserve;
- the two representations are mutually exclusive: when the rescue happens,
  `unreportedCandidates` is empty.

The entry is selected by REASON rather than array position, so the
assertions cannot silently start testing a different entry.

Mutation-checked rather than assumed: disabling the production guard
(`if (candidate.version === undefined && relevant.length === 0)`) fails
exactly one of the four and no others, so the regression genuinely
exercises the path instead of passing regardless.

### Remaining limitations

1. **`unsupported_construct` is one undifferentiated bucket.** The P1-B
   signal this task was asked to produce is real but not yet actionable;
   splitting that token by syntactic shape is the genuine next step, and it
   is frontend work this task is forbidden to do.
2. **The corpus cannot measure `capability_escape` or `budget_exceeded`.**
   Both are 0 occurrences — no fixture contains an `eval` on a reachable
   path, and no fixture is large enough to hit a limit. Both are covered by
   unit and integration tests, so the classification is exercised; what is
   missing is real-world FREQUENCY data for them. Any claim that real
   projects are mostly blocked by escapes is, on this evidence, unsupported
   in either direction.
3. **65 of 70 corpus UNKNOWNs are a benchmark artifact.** Until the
   fixtures carry rules for every advisory OSV returns, corpus-level
   category totals are dominated by `no_vulnerable_symbol_rule` and must
   always be reported with it excluded. F7's scorecard should exclude it at
   the source.
4. **RWF-002 is untouched** and remains open. F3 measured the SHAPE of its
   uncertainty; it did not move it, did not cost it, and did not choose
   between its two possible remedies (model the blockers, or prove them
   target-irrelevant). See the blocker-distribution section above.
5. **`analysis_precondition_unmet` mixes two ownerships.** The independent
   F3 audit observed that it holds analyzer-owned preconditions
   (`parse_failure`, `module_load_closure_unavailable`) alongside
   `no_vulnerable_symbol_rule`, whose gap is really target-intelligence /
   configuration — an operator supplies a rule, the analyzer does not
   establish one. The classification is still correct and, importantly,
   correctly keeps no-rule OUT of `unmodeled_construct`, where it would
   corrupt the P1-B ranking. But the six categories have no way to express
   WHO owns a remediation, and F7's scorecard will likely want an
   orthogonal owner/remediation-domain dimension. Deliberately not designed
   or added here: it is a second axis, not a seventh category, and
   inventing it on the way past would be exactly the unforced widening F3
   is meant to avoid.
6. **`unreportedCandidates` does not enumerate packages that were never
   discovered.** A workspace entry says an unknown NUMBER of candidates may
   be missing; it cannot say which, because nothing enumerated them. That
   is honest rather than complete, and no mechanism here can improve it.
7. **No VEX, and no fourth verdict.** The verdict set is still exactly
   `AFFECTED` / `NOT_AFFECTED` / `UNKNOWN`.

## RWF-037 (FOUNDATION F4) — Every negative-proof prerequisite was guarded; nothing stated the invariant those guards share

Foundation's fourth task. It adds **no proof rule, no verdict, no
production code and no production behavior**. What it adds is a harness
that can ask one question systematically, of every prerequisite of every
negative proof:

> If exactly one thing a valid `NOT_AFFECTED` depends on is removed,
> corrupted, mismatched or made uncertain — does that proof actually
> disappear?

Central rule being enforced: *a negative proof must be MONOTONIC with
respect to lost information. Less trusted information must never produce
more confidence.*

### F3 handoff

Base: `4d0f58e` (`docs: clarify RWF-002 blocker interpretation, and correct
stale gate totals`), certified before editing — clean tree, identical to
`origin/main`, F3's five commits present (`d15106e`..`4d0f58e`), the
uncertainty taxonomy live. Focused baseline of **916 tests across 14 files**
(Family A/B/C, VT-CONTRACT-01/02/03, `ModuleLoadClosure` + its differential
oracle, `AnalysisProofContext`, F2 proof guards, F3 taxonomy, same-version
twins, Site A/B authority), all passing. Validation suite baseline:
**5 failed / 18 passed**, the documented benchmark set (VAL-002, VAL-003,
RWB-03, RWB-05, RWB-09b).

### The gap, stated precisely

`domain/evidence.ts` already states the negative-proof contract as a table:
three families, each with an enumerated list of prerequisites that must ALL
hold. Every one of those prerequisites is guarded in production, and every
guard has a regression test — written when the guard was added, in the
shape of the defect that motivated it.

That is a set of point checks. What none of them states is the property
the whole set is supposed to have. The difference matters in a specific,
non-theoretical way: a point check proves that ONE historical defect does
not recur. It says nothing about a prerequisite whose defect has not
happened yet, and nothing at all about whether the family's prerequisite
LIST is the list the code actually reads.

F4 does not add guards. It takes each family's real, valid proof and
removes its prerequisites one at a time.

### Proof-input inventory (built from source, not from docs)

Traced through `analysis/verdict.ts` (`buildFinding`, `checkReachability`,
`resolveTargetNodes`), `analysis/module-load-closure.ts` and
`analysis/analysis-context.ts`. What a negative proof actually reads:

| input | read by | where |
| ----- | ------- | ----- |
| `packageInstance` (exact canonical id) | A, B | family A gate; Site A instance match; Site B ownership gate |
| authoritative target identity | C | `resolveAuthoritativePackageEntries` + forwarding, Site A |
| target ownership (`identifyModule(...) === packageInstance`) | A, C | family A gate's last conjunct; Site B's `ownedByFinding` |
| entrypoint roots | A, B, C | closure roots; reachability sources; every proof's `entrypointRoots` |
| `CallGraph` | B, C | instance discovery; the reachability BFS |
| `graphTruncated` | B, C | `buildFinding`'s VT-202 branch |
| reachable-subgraph completeness | C | `analyzeReachability` returning `unknown` on any unresolved edge |
| reachable closure-widening blocker | B | `hasReachableClosureWideningBlocker` (VT-300) |
| `ModuleLoadClosure` presence | A, B, C | family A gate; family B corroboration; `callGraphNegativeProofBlockers` |
| `closure.complete` | A, B | family A gate; family B corroboration |
| `closure.incompleteness` reasons | B, C | `callGraphNegativeProofBlockers` + `invalidatesCallGraphNegativeProof` |
| `closure.rootFiles` non-empty | A | family A gate's gate-eligibility re-assertion |
| `closure.loadedPackageInstances` | A, B | `closureContainsPackageInstance` |
| `AnalysisProofContext` brand + mark | A, B, C | `isAnalysisProofContext`, fails closed |
| closure↔entrypoint and graph↔entrypoint binding | A, B, C | `createAnalysisProofContext` DROPS a closure failing either |

Two facts from that trace are load-bearing below and are NOT in any prose
description of the families:

1. **Family A does not read the call graph at all.** It is decided at Site
   B, ahead of `graphTruncated` and ahead of VT-300's widening guard. So
   `graphTruncated` and a widening call edge are NOT family A
   prerequisites.
2. **Family B and family C read the closure DIFFERENTLY.** B's
   corroboration requires `complete === true` outright; C is gated by
   `callGraphNegativeProofBlockers`, which excludes `traversal_truncated`.
   The same closure can therefore withdraw B and leave C standing.

Both are asserted as CONTROL rows rather than left as comments.

### The three baselines (F4 § 2)

Each is a real on-disk project, analyzed by the real production
composition — `loadTsProject` → `createModuleResolver` →
`buildGateEligibleModuleLoadClosure` → `buildCallGraph` →
`createAnalysisProofContext` → `buildFinding`. No mock resolver, no
hand-written closure, no stub that could skip a guard.

| baseline | project | why this family |
| -------- | ------- | --------------- |
| **A** | `vuln-lib` installed; the entrypoint loads nothing | graph discovers no instance of the name (Site B), complete closure does not contain it |
| **B** | two installs of one name/version; the entrypoint requires and calls the TOP-LEVEL one | graph discovered the OTHER instance (Site A, no match); closure corroborates the nested twin's absence |
| **C** | `vuln-lib` loaded and called — on its SAFE export only | package is in the graph AND in the closure; the one resolved target has no call path |

A test asserts the three are genuinely different shapes (A's instance is
absent from both closure and graph; C's is present in both), so a later
edit cannot silently collapse them into one project analyzed three times.

### Why "expect UNKNOWN" is NOT the invariant (F4 § 8)

The obvious harness asserts that every mutation produces `UNKNOWN`. That
assertion would be wrong, and the architecture is why: the three families
make **genuinely different claims**. Family A says an instance cannot
LOAD. Family C says a resolved symbol is never CALLED. A mutation that
destroys A's premise need not touch C's.

**Takeover accounting.** The metric counts **5** ledgered takeovers. They
are NOT equivalent evidence, and are separated here by what the resulting
state would mean in production:

| # | ledger row | → | class |
| - | ---------- | - | ----- |
| 1 | `A\|closure_reports_this_exact_instance_as_loaded` | C | **synthetic-only** |
| 2 | `A\|package_instance_withdrawn_entirely` | C | supported-API shape |
| 3 | `B\|graph_absence_claim_is_no_longer_true` | C | production-representative state |
| 4 | `C\|target_ownership_withdrawn_via_instance_mismatch` | B | **ghost-instance-backed** |
| 5 | `C\|composite:wrong instance + lookalike target node` | B | **ghost-instance-backed** |

1. **Synthetic-only.** A's claim is destroyed; C's is not, and the audit
   asserts C's own guards independently. But the mutation manufactures a
   state — closure says loaded, graph has no node of the package — that no
   real project reaches by this route. A second test builds the REAL
   construct that produces that pair (an ESM `export * from` re-export,
   which call-graph discovery does not follow) and pins that production
   reaches **UNKNOWN** there, because the hidden call leaves an unresolved
   edge in the reachable subgraph. This takeover is a property of the
   synthetic input and is not evidence about production.
2. **Supported-API shape.** With no `packageInstance` there is no instance
   for family A's gate to be about, and Site B's ownership check is
   explicitly skipped for such callers (pre-VT-212 compatibility). Family C
   then answers, soundly — its claim is about the target. `cli/scan.ts`
   always supplies an instance, so this shape is part of the supported
   `buildFinding` contract rather than of the shipped scan path.
3. **Production-representative state, synthetically constructed.** A graph
   that HAS traversed the instance is an ordinary production state; the row
   reaches it by inserting a node rather than by writing a project that
   produces one. Family B's "never traversed" premise becomes false and B
   correctly goes; family C answers about the target.
4 & 5. **Ghost-instance-backed — excluded from production-soundness
   claims.** The finding's instance is changed to a path where nothing is
   installed. Family C is correctly withdrawn (the target does not belong
   to that instance), and what answers is a family-B absence proof about
   the ghost path — TRUE, but vacuously so. The decisive property still
   holds and is asserted: the replacement names the mutated instance and
   never borrows the baseline's identity. What these two rows do NOT
   establish is anything about production, which cannot construct the
   input — see the ghost-instance section below.

A **sixth** takeover, **A + `traversal_truncated` → C**, is asserted by its
own audit test and is deliberately NOT in the ledger (it is not a matrix
row, so it is not counted in the 49). It is the single documented exclusion
in `invalidatesCallGraphNegativeProof`: A needs `complete` and loses it; C
is governed by `graphTruncated`, which is still `false`. The same test pins
the boundary — the same closure truncated AND carrying any other reason
blocks C too.

The invariant the harness actually enforces is narrower and true:

> the mutated, now-unsupported ORIGINAL proof is never still reported.

### Mutation outcome model (F4 § 7)

Every row is classified, not pass/failed:

| class | meaning |
| ----- | ------- |
| `invalidated_to_unknown` | the proof is gone and nothing replaced it |
| `invalidated_by_takeover` | gone; an INDEPENDENT family carries the verdict |
| `invalidated_to_affected` | gone; a positive path was established instead |
| `not_a_prerequisite` | a CONTROL row — the family does not depend on this input, and correctly stands |
| `unsafe_survival` | **forbidden** — the original proof survived its own invalidating mutation |

### Family A mutation matrix

| mutation | outcome | resulting |
| -------- | ------- | --------- |
| `closure_absent` | invalidated | UNKNOWN / `module_load_closure_unavailable` |
| `closure_incomplete_parse_failure` | invalidated | UNKNOWN / `parse_failure` |
| `closure_incomplete_unresolved_module` | invalidated | UNKNOWN / `unresolved_module` |
| `closure_roots_empty_so_gate_ineligible` | invalidated | UNKNOWN (context drops it first) |
| `closure_roots_are_a_foreign_file` | invalidated | UNKNOWN |
| `closure_reports_this_exact_instance_as_loaded` | invalidated | **takeover → C** (audited) |
| `package_instance_changed_to_a_different_location` | invalidated | UNKNOWN / `vulnerable_target_unresolved` |
| `package_instance_withdrawn_entirely` | invalidated | takeover → C |
| `entrypoint_roots_mismatched` | invalidated | UNKNOWN |
| `graph_no_longer_covers_the_entrypoints` | invalidated | UNKNOWN |
| `graph_truncated` | **control** | A stands — A never reads the call graph |
| `widening_call_edge_in_the_graph_only` | **control** | A stands — VT-300 governs B, not A |
| `incompleteness_recorded_without_clearing_complete` | **control** | A stands — A's gate reads `complete` |

### Family B mutation matrix

| mutation | outcome | resulting |
| -------- | ------- | --------- |
| `closure_absent` | invalidated | UNKNOWN / `package_instance_absence_uncorroborated` |
| `closure_incomplete_parse_failure` | invalidated | UNKNOWN / same |
| `closure_incomplete_traversal_truncated` | invalidated | UNKNOWN / same — B requires `complete` outright, unlike the blocker partition |
| `graph_truncated` | invalidated | UNKNOWN / `call_graph_truncated` |
| `closure_reports_this_exact_instance_as_loaded` | invalidated | UNKNOWN / same |
| `widening_construct_reachable_from_an_entrypoint` | invalidated | UNKNOWN / `closure_widening_construct_reachable` |
| `loader_blocker_recorded_on_the_closure` | invalidated | UNKNOWN / `loader_hook_mutation` |
| `package_instance_swapped_to_the_REACHED_twin` | invalidated | **AFFECTED** (audited) |
| `graph_absence_claim_is_no_longer_true` | invalidated | the "never traversed" premise is false; B gone |
| `entrypoint_roots_mismatched` | invalidated | UNKNOWN |
| `the_OTHER_instance_is_removed_from_the_graph` | invalidated | no longer Site A at all |
| `closure_forgets_the_OTHER_instance` | **control** | B stands — corroboration is about THIS instance |
| `non_widening_unresolved_edge` | **control** | B stands — bounded uncertainty cannot load an undiscovered instance |

### Family C mutation matrix

| mutation | outcome | resulting |
| -------- | ------- | --------- |
| `closure_absent` | invalidated | UNKNOWN / `module_load_closure_unavailable` |
| `closure_incomplete_parse_failure` | invalidated | UNKNOWN / `parse_failure` |
| `loader_hook_blocker_recorded_on_the_closure` | invalidated | UNKNOWN / `loader_hook_mutation` |
| `declaration_only_blocker_recorded_on_the_closure` | invalidated | UNKNOWN / `declaration_only_resolution` |
| `graph_truncated` | invalidated | UNKNOWN / `call_graph_truncated` |
| `reachable_subgraph_no_longer_complete` | invalidated | UNKNOWN / `unsupported_construct` |
| `widening_construct_reachable_from_an_entrypoint` | invalidated | UNKNOWN / `dynamic_require` |
| `authoritative_target_node_removed` | invalidated | UNKNOWN / `vulnerable_target_unresolved` |
| `target_ownership_withdrawn_via_instance_mismatch` | invalidated | **takeover → B** (audited, ghost-backed — see below) |
| `entrypoint_roots_mismatched` | invalidated | **AFFECTED** (positive takeover — see below) |
| `root_coverage_lost_entirely` | invalidated | UNKNOWN / `no_entrypoints_available` |
| `package_instance_withdrawn_entirely` | **control** | C stands — C's claim is about the TARGET |
| `closure_incomplete_traversal_truncated_only` | **control** | C stands — the documented exclusion, from C's side |
| `closure_forgets_this_instance_is_loaded` | **control** | C stands — C never claims the package is unloaded |
| `an_existing_call_path_to_a_non_target_severed` | **control** | C stands |
| `a_non_target_node_of_the_same_package_removed` | **control** | C stands |
| `a_loaded_file_identity_rewritten_in_the_closure` | **control** | C stands |

`reachable_subgraph_no_longer_complete` deliberately uses a NON-widening
unresolved edge, which isolates `reachableSubgraphComplete` from both
VT-300's widening guard and `graphTruncated`: that construct could not load
a new module and no limit was hit — the search simply met something it
could not resolve, which is precisely what the field denies.

**`entrypoint_roots_mismatched` on family C is AFFECTED, and is NOT an
isolation test.** Its two siblings (families A and B) reach UNKNOWN because
the context binding drops a closure whose `rootFiles` are no longer these
entrypoints. Family C's row does not stop there: repointing the roots at
`node_modules/vuln-lib/index.js` also makes the vulnerable library file
ITSELF the reachability root, from which `vulnerable` genuinely is
reachable — so `buildFinding` returns AFFECTED from the positive branch,
which sits ahead of every closure check. That is correct (declare a
library's own file as your entrypoint and its exported vulnerable symbol
really is reachable from it) and it is a sound outcome: family C's proof is
gone, and what replaces it is a positively reproduced path, not a surviving
negative.

But one input change here produces TWO semantic effects — closure unbinding
AND a new reachability root set — and for family C the second dominates.
The independent audit confirmed this by disabling the context-binding
guard: families A and B's `entrypoint_roots_mismatched` rows failed, and
family C's did not. The row therefore proves the invariant it asserts (the
original proof does not survive) but does NOT attribute that to the guard
its name suggests. Kept under its current name with this caveat rather than
renamed, because the row's assertion is unchanged and renaming it would
edit the matrix this remediation is scoped out of.

**Three invalidating rows use a closure state no builder emits.**
`loader_blocker_recorded_on_the_closure` (family B),
`loader_hook_blocker_recorded_on_the_closure` and
`declaration_only_blocker_recorded_on_the_closure` (family C) add an
`incompleteness` record while leaving `complete: true`. The real builder
derives `complete` FROM `incompleteness`, so it never produces that pair;
these are **synthetic proof-domain tests**, not production-reachable
scenarios. Their value is that they isolate which closure FIELD each guard
reads: `callGraphNegativeProofBlockers` acts on `incompleteness` alone,
without leaning on `complete`, which makes the row strictly stricter than
the production shape. Their limitation is the other half of that: they are
evidence about guard behavior under inconsistent inputs, and must NOT be
read as evidence that production can construct such a closure. The
production-shaped equivalents (`complete: false` WITH the blocker) are
covered by the `closure_incomplete_*` rows, and by the real in-source
`require.extensions` project used in the mutation-check below. The family A
control `incompleteness_recorded_without_clearing_complete` uses the same
synthetic state for the same reason.

### PackageInstance isolation (F4 § 13)

- **Same-version twins**, both reaching `NOT_AFFECTED`. That verdict
  agreement is what makes it the sharp test: only the EVIDENCE can reveal
  identity confusion. They get different families (B for the untraversed
  one, C for the loaded one) and each names its own root.
- **Symlink alias**: one physical directory under two paths. Canonicalized
  to ONE instance — same verdict, same family, not two answers.
- **Scoped lookalike**: `@scope/vuln-lib`'s vulnerable export is genuinely
  called; the finding about the unscoped install is family A, and its
  proof's instance contains no `@scope` segment.
- One invariant over all baselines: a proof's instance always equals the
  finding's instance. Family C carries none at all — deliberately, since
  its evidence is about the target — so there is nothing to mis-name.

### Target identity (F4 § 14)

- A sibling package publishing the same export NAME, genuinely called,
  produces neither a false AFFECTED nor a proof that names the sibling.
- A lookalike target node inserted in a sibling root does not supply family
  C's witness.
- The sharp version: the real target node removed AND a same-named node
  added in a sibling root in the same breath → **UNKNOWN /
  `vulnerable_target_unresolved`**, not a substituted lookalike.
- A target whose module resolves outside the finding's instance
  establishes neither an authoritative target nor a negative proof.

### AnalysisProofContext (F4 § 11) and immutability (F4 § 12)

Foreign closure, foreign graph, entrypoints-and-closure swapped together,
a stale same-project context over a different root set, a mutated
`graphTruncated`, an unbranded object cast into the parameter, and a
THAWED spread of a real context (which loses the non-enumerable mark) —
**all eight fail closed to UNKNOWN with no proof object.**

**What is actually frozen, stated precisely.** The context WRAPPER is
frozen: writes to `graphTruncated` and `moduleLoadClosure` throw. The
`entrypoints` ARRAY is snapshotted (copied) and frozen, so the root SET
cannot be extended after binding. Nothing else is.

The independent audit measured the full surface. After
`createAnalysisProofContext` returns:

| input | snapshot? | frozen? |
| ----- | --------- | ------- |
| `projectRoot`, `graphTruncated` | primitives | effectively yes |
| `entrypoints` (the array) | copied | **yes** |
| `entrypoints[i]` (the objects) | shared identity | **no** |
| `moduleLoadClosure` | same object | **no** |
| `graph` | same object | **no** |
| `knownPackageRoots` (a `Map`) | same object | **no** |

So the accurate statement is NOT "the proof context is immutable" and NOT
"the entrypoints are frozen" without qualification. It is: **the wrapper is
frozen and the entrypoint array container is snapshotted and frozen, but
several referenced proof inputs — and the entrypoint objects themselves —
are neither snapshotted nor transitively frozen.** The context binds
IDENTITIES of live objects; it does not certify immutable proof facts.

**The attack, and how it is reached.** The sharp form is the task's attack
G: not "could the evidence be weakened" but "could a blocker be DELETED
after the context was built". Reproduced: a scan whose closure genuinely
recorded `loader_hook_mutation` answers UNKNOWN; emptying `incompleteness`
and setting `complete = true` turns the same context into a family C
`NOT_AFFECTED`. **The write does change the answer.**

The access path matters and an earlier draft of this record got it wrong.
It is NOT that some third party must already hold the context. The audit
performed the same write through **the caller's own retained alias to the
input** — the `moduleLoadClosure` variable the caller passed in — never
touching the context object at all. Post-binding mutation is possible
through **any retained alias to a referenced proof input**, and the
constructor hands the caller's own references straight through. The audit
demonstrated the same class of write through the `graph` alias and through
an `entrypoints[i]` object, both of which also moved the verdict.

**Why it is nonetheless unreachable in production today**, which is a
lifetime argument and not an "no hostile attacker" argument:

- there is exactly ONE production caller of
  `createAnalysisProofContext` (`cli/scan.ts:631`);
- after that line, no production code references `moduleLoadClosure`,
  `graph` or `knownPackageRoots` again — the only later occurrence is a
  comment;
- no production code anywhere writes to a `ModuleLoadClosure` field;
- graph edges are pushed only during `buildCallGraph`'s own construction,
  before any context exists;
- `knownPackageRoots` is never `set`/`delete`d after it is built;
- nothing caches or persists a graph or a closure — the only cache in the
  tree is the OSV advisory cache.

**Judgment (independent audit): NON-BLOCKING HARDENING.** Mutable aliases
exist, and mutating them does change a verdict; current production
ownership and lifetime retain no writer after context binding, and no
production mutation path was found; but the invariant rests on that
lifetime rather than on anything structural — `readonly` is erased at
runtime and the freeze is shallow. Deliberately NOT fixed in F4, whose
scope requires a concrete exploit before touching production.

**Flagged for future Foundation work.** Possible approaches, none chosen or
designed here: snapshot or deep-freeze the proof-critical inputs at binding
time; make the `CallGraph` and `ModuleLoadClosure` structures immutable
after construction; or enforce single-owner lifetime more strongly so a
retained alias cannot exist. Each has a real cost (copying every closure
and graph per scan, or a wider type change), which is why this is recorded
as a decision to be made rather than made in passing.

One more documentation defect, noted and NOT fixed here because it is
pre-existing production prose rather than anything F4 added:
`analysis/analysis-context.ts` describes the context as "ONE immutable
object" and "Immutable and created once per scan". Per the measurement
above that overstates what the constructor delivers, and should be narrowed
to the wrapper-frozen / references-live statement when that file is next
touched. F4 changed no production file and does not change it here.

### Monotonicity (F4 § 19) and restoration (F4 § 20)

Three ladders add uncertainties one at a time (closure absent → graph
truncated → unresolved edge → target removed, and similar for B). At every
rung the verdict stays UNKNOWN with no proof object; confidence is never
restored. The family-A ladder deliberately starts with the mutation that
hands over to C, so it also proves a second uncertainty cannot resurrect A
— it can only take C away too.

Four restoration cases confirm each mutation is CAUSAL: remove → UNKNOWN →
restore the original inputs → the same family, the same instance, the same
target.

### Composition (F4 § 23)

Six two-prerequisite attacks. Five reach UNKNOWN. The sixth — wrong
instance + lookalike target node — is the audited takeover, and its own
invariant is asserted instead: whatever answers is about the MUTATED
identity, never the baseline's.

### Test-harness hardening (F4 § 24) — the one behavior change, and it is test-only

`buildFindingForTest`'s `syntheticGraphHasNoRealFiles` escape hatch
synthesizes a closure with `complete: true` and
`loadedPackageInstances: []`. Read by family A's gate — complete, non-empty
roots, this instance absent from the loaded set — an EMPTY loaded set
satisfies the last conjunct for **every instance there could ever be**.
Such a closure proves every installed package unloadable.

F2's audit found this safe, and was right, for a reason that was entirely
accidental: the suites passing that flag happen not to pass a
`packageInstance`, and family A's gate is unreachable without one. That is
a property of today's call sites, not an invariant. One new synthetic test
that added a `packageInstance` would have minted a false `NOT_AFFECTED`
with every production guard intact and **the test harness supplying the
forged evidence** — the worst possible source, because the suite that
should catch the regression would be its origin.

F4 makes the accident a rule (option C of the task's three: fail loudly).
A synthesized default closure and a `packageInstance` may not coexist; the
caller must supply a truthful closure or declare absence. It fails loudly
rather than deriving something, because there is nothing truthful to
derive — the files these graphs describe do not exist, so no traversal can
establish what such an instance loads. The refusal message names the
hazard and both remedies, and a test asserts it does.

**Backward compatibility (F4 § 25), audited before the change.** Three
files touch the flag. `verdict.test.ts` uses it at 22 call sites and passes
no `packageInstance` at any of them. `verdict.module-load-absence.test.ts`
uses it at 18 call sites, every one of which supplies a
`moduleLoadClosure` or sets `moduleLoadClosureUnavailable`. So the rule is
a no-op for all 40 existing sites, which is what the full suite confirms.
Classification of the four categories the task asks for: production-like
tests build a real closure and are untouched; synthetic verdict tests are
instance-blind and are untouched; intentionally closure-absent tests
declare it and are untouched; package-instance-sensitive tests must now be
explicit, and already were.

### Mutation-check results (F4 § 26)

Each guard was disabled in production source, the F4 suite re-run, and the
source restored. Every one produced failures, and in every case the § 28
metric test caught it independently of the individual rows.

Counts below are the ones the INDEPENDENT AUDIT re-measured against the
final 89-test suite. An earlier figure of 10 for the absent-closure guard
was measured before the suite grew by three tests and is superseded:

| guard disabled | how | F4 tests failed |
| -------------- | --- | --------------- |
| absent closure fails closed | `callGraphNegativeProofBlockers(undefined)` → `[]` | **11** |
| `graphTruncated` (VT-202) | `buildFinding`'s branch made unreachable | **6** |
| family A exact-instance ownership | dropped the `identifyModule(...) === packageInstance` conjunct | **3** |
| `reachableSubgraphComplete` | reachability `unknown` treated as `unreachable` | **5** |
| `AnalysisProofContext` closure binding | closure kept unconditionally | **8** |
| family B closure corroboration | the `complete` + not-contained conjunction forced true | **5** |
| F4's own § 24 harness rule | the refusal removed | **1** |

The family-B corroboration guard was added by the independent audit, which
observed it was the one B-specific guard the original check set omitted.
Disabling it fails exactly the four rows whose labels name closure
corroboration (`closure_absent`, `closure_incomplete_parse_failure`,
`closure_incomplete_traversal_truncated`,
`closure_reports_this_exact_instance_as_loaded`) plus the metric.

**Scope.** These are CAUSAL SENSITIVITY checks for selected guards, not an
exhaustive enumeration of every guard in the proof path. What each row
establishes is that the matrix rows naming a guard fail when that guard is
removed — i.e. the tests are not passing for some unrelated reason.

`git diff` confirmed clean source afterwards, on both the original run and
the audit's re-measurement.

### Mutation summary metric (F4 § 28)

```
total proof mutations:            49
invalidated original proof:       38
  -> UNKNOWN:                     31
  -> legitimate family takeover:   5
  -> legitimate AFFECTED:          2
control rows (not a prerequisite):11
UNSAFE ORIGINAL PROOF SURVIVED:    0
```

The metric is asserted, not printed: `unsafe_survival` must be 0, and the
ledger must be non-trivially populated across all three families — an
empty ledger would otherwise make every per-row check vacuous.

**What this metric is, and is not.** It is a BOUNDED REGRESSION METRIC over
selected proof prerequisites, evaluated against a mixture of
production-like and deliberately synthetic states. It establishes that no
invalidated proof survived any of these 49 mutations.

It is NOT:

- exhaustive proof of global soundness — it covers the prerequisites the
  code reads, not the value space, and not prerequisites nobody thought to
  mutate;
- evidence that all 49 states are production-reachable — three invalidating
  rows use a closure shape no builder emits, and two of the five takeovers
  are backed by a `packageInstance` production cannot enumerate;
- evidence that transitive immutability holds — it does not (see the
  immutability section).

### Contracts under mutation (F4 § 9, § 10)

`expectExactlyOneProof` runs on **every** outcome the suite produces, not
once at the end: a `NOT_AFFECTED` carries exactly one negative-proof
evidence object and anything else carries none (VT-CONTRACT-01). No
mutation produced a proof-less or double-proof `NOT_AFFECTED`.

VT-CONTRACT-02 is asserted on family C proofs produced UNDER MUTATION, not
only on a pristine baseline: `reachableSubgraphComplete: true`, and
`callGraphComplete` absent from the evidence object and from the whole
serialized finding. Family B's evidence is checked for the same retired
name.

### Taxonomy is observational (F4 § 18)

F3's tokens are asserted on 20 rows, through an OPTIONAL field whose
failure never affects the proof invariant. The harness would remain valid
if the taxonomy were renamed or removed: no row's soundness assertion
reads it, and `classifyMutation` never consults it. One expectation was
corrected during development — `root_coverage_lost_entirely` reports
`no_entrypoints_available`, because with no roots `checkedAny` is false and
that branch answers ahead of the closure blocker the empty root set also
produces. Both are correct; the matrix records which one production
actually reports.

### Production differential (F4 § 30)

**Zero, and established by comparing the BUILT ARTIFACT rather than by
reasoning about which directories look production-ish.**

The whole change is five files:

```
src/analysis/verdict.f4-proof-mutation.test.ts     (new, test)
src/testing/finding.f4-closure-hardening.test.ts   (new, test)
src/testing/proof-mutation.ts                      (new, test harness)
src/testing/finding.ts                             (test harness)
tests/validation/FINDINGS.md                       (this record)
```

Filtering the changed-file list for anything that is not a `*.test.ts`,
not under `src/testing/`, and not under `tests/` returns **nothing**.

That is still a claim about paths, so it is checked against what actually
ships. `tsconfig.build.json` excludes `src/**/*.test.ts` and
`src/testing/**` outright, and `dist/` contains no `testing` directory.
Building both trees to separate output directories and diffing them:

- **146 emitted `.js` / `.d.ts` files, byte-identical.**
- The `.map` files differ in exactly one way — the absolute checkout path
  embedded in `sources[]` (worktree vs. main). Normalizing that path makes
  them identical too.

So there is no production behavior to move, and the differential is a
measurement rather than an argument. Worth stating precisely, because the
mutation suite LIVES in `src/analysis/`: a directory-based check would
report a diff there and be wrong about what it meant.

### False-AFFECTED control (F4 § 29)

Positive authority untouched: wrong-instance Site B, same-version twins,
forwarding, cross-package re-export, coincidental export names, alias and
scoped identity, local package identity, and multi-instance scan all pass
unchanged. **0 new false AFFECTED.**

The mutation suite itself produces **two** AFFECTED outcomes, matching the
metric's `invalidated_to_affected: 2`. Both are positive takeovers: the
original negative proof is invalidated, and what replaces it is a
positively reproduced path rather than a surviving negative.

- **`B|package_instance_swapped_to_the_REACHED_twin`.** The finding is
  repointed at the other same-name/same-version install — the one the
  entrypoint actually requires and calls. Family B's "never traversed"
  premise is false for it, and the evidence path lies inside the REACHED
  instance (asserted: no path step under the nested twin), so nothing is
  borrowed from the baseline's instance.
- **`C|entrypoint_roots_mismatched`.** Repointing the roots at the library
  file makes that file the reachability root, from which `vulnerable` is
  genuinely reachable. Family C's proof is gone and AFFECTED is the honest
  answer for that root set. See the family C matrix note for why this row
  is not an isolation test.

### Performance (F4 § 31)

Production runtime unchanged (no production code). `scan-performance`: both
baselines pass — 2410ms against the 5000ms threshold, 8181ms against the
20000ms threshold.

F4's own focused suite: **97 tests in ~1.7s of test time** (~5.2s wall,
including transform and collect).

Full suite, both sides measured directly rather than inferred:

| | files | tests | wall |
| - | ----- | ----- | ---- |
| main (`4d0f58e`) | 158 | 3842 | 276s |
| this branch | 160 | 3939 | 187s–228s (three runs) |

F4 adds **2 files and 97 tests**. The wall-clock figures are NOT a
meaningful delta and are recorded only so nobody reads one as one: this
machine's own variance across runs of the SAME tree (187s to 228s) is an
order of magnitude larger than anything F4 contributes, and main's figure
was measured while another suite was running. The honest statement is the
test-time one: **~1.7s added to a suite whose own test time is ~195s**. No
optimization attempted, and none needed.

### Verification

Focused gate (30 files): **1212 passed**. `npm test`: **3939 passed / 160
files**. Adversarial: **124 passed**. Validation: **5 failed / 18 passed**
— byte-identical to main's documented benchmark set, re-measured on main
during this task to confirm. `scan-performance`: 2 passed. `typecheck`,
`lint`, `prettier --check`, `build`, `validate:history`: all clean. No
timeout waivers were used.

### RWB-05 / RWF-002 / P1-B — untouched, deliberately

RWF-002 is not remediated, not re-interpreted and not measured differently
here. RWB-05 still reports UNKNOWN, for the same reason F3 recorded, and
its blockers are unchanged. P1-B was not started. The verdict semantics,
the Family A/B/C design and the uncertainty taxonomy are all unchanged.

### Remaining limitations (deliberately not fixed here)

1. **The harness mutates INPUTS, not analyzed source.** It answers "does
   this guard read this field correctly", not "can a real project produce
   this state". Where the distinction matters the record says so — the
   closure-says-loaded takeover is exactly that case, and is paired with
   the real construct that produces the same pair, which reaches UNKNOWN.
   A source-level mutation harness is a different and larger instrument.
2. **A `packageInstance` naming no real install yields a vacuously true
   family-B proof ("ghost instance").** Reproduced independently by the
   audit. Precisely:
   - production **cannot** construct it — `packageInstance` is enumerated
     from the dependency graph's own install locations via the instance
     registry, and the audit confirmed the ghost path is absent from
     `KnownPackageRoots`;
   - the **harness can** fabricate it, by handing `buildFinding` a literal
     path string;
   - family B then gives a **vacuous** absence proof: absence from
     `loadedPackageInstances` is trivially true for something never
     installed, and family B's contract presupposes a real enumerated
     install;
   - **2 of the 5 proof-family takeovers are backed by such ghost
     instances** (rows 4 and 5 in the takeover table above).

   This is acceptable as a proof-domain test — it is exactly where the
   no-identity-borrowing property is checked, and that property holds: the
   proof names the path it was asked about and never the baseline's. Those
   two takeovers are nonetheless **excluded from any claim about
   production-reachable soundness.** The production-shaped version of the
   same property is the same-version twins case, which uses two real
   installs.
3. **Transitive mutability of referenced proof inputs.** The context
   wrapper is frozen and the entrypoint array is snapshotted, but the
   closure, the graph, `knownPackageRoots` and the entrypoint objects are
   live aliases; mutating any of them after binding changes the verdict.
   Classified by the independent audit as NON-BLOCKING HARDENING —
   production-unreachable today by ownership and lifetime, not enforced
   structurally. See the immutability section for the evidence and the
   future-hardening options.
4. **Coverage is per-prerequisite, not per-input-value.** 49 mutations over
   the prerequisites the code actually reads, not a fuzz over the value
   space. A prerequisite that exists but is read nowhere would not be
   discovered by this harness — that is what the source inventory, not the
   matrix, is for.
5. **Three baselines, one package shape.** Each family has one minimal
   baseline. A second baseline per family (an ESM project, a workspace
   link) would broaden the matrix; it would not change what any row
   asserts, and the existing family-specific suites already cover those
   loading shapes.
6. **No new verdict, no VEX, no fourth state.** The verdict set is still
   exactly `AFFECTED` / `NOT_AFFECTED` / `UNKNOWN`.

## RWF-038 (FOUNDATION F5) — The analyzer re-asked the filesystem the same question thousands of times

Foundation's fifth task. It adds **no proof rule, no verdict, no evidence,
no proof family, no uncertainty reason and no change to `PackageInstance`
identity**. What it adds is three per-scan memos and one per-scan index,
each keyed exactly, each incapable of merging two distinct
`PackageInstanceId`s, and each discarded when the scan returns.

Central rule being enforced: *a faster wrong answer is a regression.*
Every structure introduced here is DERIVED from an analysis that is
already final, and every answer it can return is one the analyzer would
otherwise have recomputed for the same inputs on the same filesystem.

### F4 handoff

Base: `d3dd220` (`docs: correct RWF-037 mutation audit record`), certified
before editing — clean tree, identical to `origin/main`, F4's six commits
present (`edf132b`..`d3dd220`), the proof-mutation harness live. Full
baseline on that SHA, measured rather than assumed: **160 files / 3,939
tests passing**, 187s.

### Measure first

The prior audit recorded roughly *~415 ms per 8,000 locations* for
per-location `realpath` work. That number was re-derived rather than
inherited, because a hotspot that moved would have made this whole task
optimize the wrong thing.

Method: a removable counting instrumentation (call counts AND distinct-key
counts) applied to `canonicalizePackageInstancePath`,
`readInstalledPackageName`, `readInstalledManifestIdentity`,
`identifyModule`, `readInstalledVersion`, `declaresExports`,
`resolveAuthoritativePackageEntries`, `graphPackageInstances` and
`ts.resolveModuleName`, driven over all 15 real-package fixture projects in
`tests/validation/fixtures/` with the OSV boundary stubbed from each
fixture's own `rules.yml` so findings are actually produced. (The existing
`scan-performance` guards cannot see this cost at all: their provider
returns no advisory, so no finding is built and `checkReachability` never
runs.)

**Baseline totals across the corpus (main, `d3dd220`):**

| operation | calls | distinct keys | redundancy |
| --------- | ----: | ------------: | ---------: |
| `realpathSync` (via `canonicalizePackageInstancePath`) | 2,991 | 82 | 97.3% |
| `identifyModule` | 2,870 | 175 files | 93.9% |
| manifest reads (all readers) | 2,896 | 45 roots | 98.4% |
| of which `readInstalledPackageName` | 2,830 | 45 roots | 98.4% |
| graph-node identifications in `graphPackageInstances` | 2,614 | — | — |
| `ts.resolveModuleName` | 1,095 | — | — |

**Phase split (same runs), which is what stops this record overclaiming:**

Parsing/graph construction is **~90%** of corpus wall time; reachability is
**6.7%** (5.25s of 78.2s); provider time is ~0 with a stub. The redundant
identity work measured above is real and overwhelming as a COUNT, but at
~53 µs per `realpathSync` and ~63 µs per manifest read on this machine it
is only ~340 ms of a 78s corpus. **F5's claim is an operation-count and
asymptotic claim, not a wall-clock one**, and the corpus numbers below say
so plainly.

### Ranked hotspots, and the one that actually matters

1. **`graphPackageInstances` — the multiplier.** `verdict.ts` re-derived
   "which installed instances of this package name does the call graph
   contain" by walking EVERY graph node and identifying each one, once per
   resolved advisory target. Each identification cost one `realpathSync`
   plus one `package.json` read. Cost: `findings × targets × nodes`,
   unbounded in graph size. `identifyModule` call count tracks graph-node
   visits almost exactly (2,870 vs 2,614), which is what identifies this
   as the source.
2. **`identifyModule` itself**, from the module-load closure's
   per-loaded-file instance enumeration. Not a multiplier, but O(files),
   and on a large project the closure IS the reachable file set — this is
   where the prior audit's 8,000-location figure comes from.
3. **`readInstalledPackageName`**, 2,830 of the 2,896 manifest reads, and
   almost all of them reached through (1) and (2).
4. `ts.resolveModuleName` — 1,095 calls, and resolution is 1.1% of corpus
   wall time. **Measured NOT to be a hotspot**, so it was left alone (see
   "Deliberately not done").

The single worst shape in the corpus is `lodash-4.17.15`: a 690-node call
graph built from **two** files, producing 697 identity calls, 700
`realpathSync` calls and 697 manifest reads.

### What was built

**1. `ScanModuleIdentityCache` (`domain/resolved-target.ts`).** Three maps
and a counter block, created once per scan.

| memo | key | value | stored when |
| ---- | --- | ----- | ----------- |
| `identities` | the whole `resolvedFile` string | the `ModuleIdentity` | always |
| `canonicalPaths` | `path.resolve(rawPath)` | the realpath | **only on success** |
| `manifestNames` | canonical package root | the declared `"name"` | **only when present and valid** |

The cache BINDS one `KnownPackageRoots` at construction and is consulted
only by a caller holding that same registry **by reference**. That is what
makes the key complete: `identifyModule(resolvedFile, knownPackageRoots)`
is a pure function of exactly those two arguments and the filesystem, so
`(registry, resolvedFile)` is the whole input set. Nothing is keyed on a
package name, a basename, a version or a directory prefix.

A caller holding a *different* registry is not served and not overridden —
the request falls through to the uncached computation, which is the pre-F5
behavior. A mismatched cache therefore costs performance and can never
cost correctness. `identifyModule`'s cached and uncached paths call ONE
shared body (`computeModuleIdentity`), so there are not two
implementations to keep in agreement.

**2. `ScanAnalysisCaches` + `GraphPackageInstanceIndex`
(`analysis/scan-caches.ts`, new).** Created by
`createAnalysisProofContext` — deliberately, because that factory already
binds the graph, the registry, the entrypoints and the resolver into one
frozen object. That placement is what makes the public-entry memo's key
complete rather than merely conventional: the inputs its key leaves
implicit (resolver, reference context derived from `projectRoot`,
entrypoint files, registry) are fields of the one context that owns the
memo, and a memo reachable only through that context cannot be consulted
under a different set of them.

**3. Public-entry memo lifetime, per-finding → per-scan.** Its key was
already exact (`packageInstance` + `requestedModuleSpecifier`, NUL-joined);
only its lifetime prevented it from serving the shape it exists for —
several advisories naming one installed package.

### Ordering, proved rather than asserted

The index is built in ONE forward pass over `graph.nodes`, appending into
each package name's bucket. For a fixed package name the instances
therefore appear in first-seen-among-that-name's-nodes order — exactly the
order the per-name walk produced, because that walk visited the same nodes
in the same order and skipped the others. This matters because
`resolveTargetNodes` materializes `[...instances.entries()]` and selects
from that sequence.

`scan-caches.f5-graph-index.test.ts` asserts it against the walk it
replaces, as an oracle reproduced in the test file, with entry order AND
each file set's order compared — under forward AND reversed node order,
plus an assertion that the two orderings genuinely differ so the
comparison is not vacuous.

### The index is an accelerator, never an authority

`graphPackageInstancesByName` returns `undefined` — meaning "scan the graph
yourself", never "there are none" — in every case where the caller's inputs
are not provably the ones the index was derived from:

- no caches supplied (an untrusted context, or a caller that has none);
- the caller's graph is not the caches' graph (reference inequality);
- the caller's registry is not the caches' registry;
- `graph.nodes.length` no longer matches the indexed count.

Conflating those with an empty answer would be the cached-absence defect a
performance layer must never introduce: an empty result reads as
`confirmedAbsentInstance` in `resolveTargetNodes`, which **is** positive
evidence. The distinction is asserted directly — an absent package name
returns a defined, empty map; a stale node count returns `undefined`.

`buildFinding` withdraws the caches entirely for a context that fails its
runtime identity check, exactly as it already withdraws the module-load
closure. A fabricated context's "index" is never read.

### Failures are never cached as success

This is the one place a cache could turn a transient failure into a
durable one, and it deliberately does not:

| situation | behavior |
| --------- | -------- |
| `realpathSync` throws | fall back to the normalized absolute path, **memoize nothing**, re-attempt next time |
| manifest missing (`ENOENT`) | path-derived name, **memoize nothing** |
| manifest unreadable (permissions) | path-derived name, **memoize nothing** |
| manifest malformed JSON | path-derived name, **memoize nothing** |
| manifest parses, no usable `"name"` | path-derived name, **memoize nothing** |

Each row has its own test asserting the answer equals the uncached one AND
that the relevant map is still empty. One test writes a manifest that did
not exist at first request and confirms a later read sees the declared
name rather than the earlier absence.

The asymmetry costs one `realpathSync` per request in a case that does not
arise for a package root the analyzer's own resolver or dependency graph
just discovered — which the corpus confirms: 181 realpath calls remain for
82 distinct inputs, i.e. the failure path is essentially unexercised there.

### Operation-count results

Same corpus, same instrumentation, re-applied to the branch:

| operation | main | branch | change |
| --------- | ---: | -----: | -----: |
| `realpathSync` | 2,991 | **181** | **−93.9%** |
| manifest reads (all readers) | 2,896 | **125** | **−95.7%** |
| `readInstalledPackageName` | 2,830 | **59** | **−97.9%** |
| full `graphPackageInstances` walks | 17 | **0** | **−100%** |
| graph-node identifications | 2,614 | 2,225 | −14.9% |
| `identifyModule` calls | 2,870 | 2,481 | −13.6% |
| `ts.resolveModuleName` | 1,095 | 1,095 | **0%** |
| distinct files / canonicalize inputs / roots | 175 / 82 / 45 | 175 / 82 / 45 | **0%** |

Two rows deserve reading carefully rather than being quoted as wins:

- **`identifyModule` calls barely move, and that is correct.** The index
  still REQUESTS an identity per graph node; what changed is that those
  requests are served from the memo at no filesystem cost. The distinct-key
  counts are identical on both sides (175/82/45), which is the actual
  evidence that the same questions are being asked and only the answering
  got cheaper.
- **`ts.resolveModuleName` is unchanged by design**, not by omission.

Worst-case fixtures, where the multiplier lived:

| fixture | graph nodes | realpath (main → branch) | manifest reads (main → branch) |
| ------- | ----------: | -----------------------: | -----------------------------: |
| `lodash-4.17.15-vulnerable-call-unknown` | 690 | 700 → **5** | 697 → **4** |
| `lodash-4.17.15-safe-call-unknown` | 690 | 700 → **5** | 697 → **4** |
| `rwb-09-semver-multi-instance` | 369 | 857 → **15** | 848 → **12** |
| `rwb-03-fast-xml-parser-method` | 97 | 109 → **9** | 104 → **6** |
| `rwb-05-qs-unused-api` | 176 | 269 → **59** | 248 → **40** |

`rwb-09`'s graph-node identifications also halve (738 → 369): it has two
resolved targets, and the index is built once per scan instead of once per
target.

### Wall time — reported honestly

| | main | branch |
| - | ---: | -----: |
| corpus total (15 fixtures, one run each) | 79,601 ms | 78,154 ms |
| `npm test` wall | 187 s | 199 s |

**~1.8%, which is within this machine's run-to-run noise and is NOT
claimed as an improvement.** Per-fixture deltas go both ways (e.g.
`rwb-11` 2,482 → 2,766 ms, `rwb-09` 6,872 → 6,508 ms), and the `npm test`
figure moves the WRONG way while adding 40 tests, which is the same noise
seen from the other side (F4 measured 187-228 s across three runs of one
unchanged tree). The reason is
already stated above and was known before the work started: parsing and
graph construction are ~90% of this corpus's wall time, and the ~340 ms of
redundant identity work F5 removes is ~0.4% of it. F5 removes an
asymptotic multiplier that this corpus is too small to expose in
milliseconds; it does not make parsing faster and does not claim to.

The scaling guard added to `scan-performance` is where the removal is
visible as time: a fixture with one 40-file installed package and an
advisory count scaled 4 → 32 must stay under a 4× wall-time ratio. Before
F5 each advisory re-walked every graph node, so total work grew with the
product.

### No regression in the guards that existed

`scan-performance`, all three cases: 2,397 ms against the 5,000 ms medium-
project threshold; 8,224 ms against the 20,000 ms single-large-file
threshold; the new F5 scaling case passing its ratio bound. No threshold
was raised.

### Memory cost and bounds

Every structure is bounded by the scan's own input scale, and the bound is
structural rather than a limit that had to be imposed:

| structure | one entry per | corpus max observed |
| --------- | ------------- | ------------------: |
| `identities` | distinct resolved file the analysis reached | 92 |
| `canonicalPaths` | distinct canonical package root | 21 |
| `manifestNames` | distinct canonical package root | 19 |
| `byPackageName` | distinct package name in the graph | small |
| `publicEntries` | distinct (instance, specifier) pair asked | 2 |

The `publicEntries` figure is the per-scan maximum (rwb-09), corrected
from an earlier 14 that was the corpus TOTAL across all fifteen scans —
every other row in this table is already a per-scan maximum, so the
mismatched one overstated the bound. Corrected per the independent audit's
own measurement.

Nothing is keyed by anything an advisory, a rule, a package name or any
other attacker-influenced string contributes, so no input can grow these
beyond the file set the analyzer already holds in memory. The one key with
any rule influence is `publicEntries`' specifier half, which comes from a
rule target's own `module` field and is bounded by the loaded ruleset
times the instances actually analyzed — never by untrusted input, and only
populated for work the scan already performed. Values are
strings and small objects already referenced elsewhere. A bounds test
asserts the exact entry counts for a 20-package / 40-file project (40 / 20
/ 20).

### Invalidation: none, by placement

Every cache's lifetime is one immutable analysis pass, so there is no
invalidation logic — the design point §30 asks for. The identity memo is
created in `runScanCommand` after `knownPackageRoots` is final and before
the first consumer (the module-load closure, which runs before the proof
context exists, and which is where a large project pays this cost in
bulk). The graph index and public-entry memo are created by
`createAnalysisProofContext`, after the graph, truncation decision and
closure are all final.

### Phase boundaries the indexes sit over

| phase | assumed stable | index over it |
| ----- | -------------- | ------------- |
| dependency discovery | `knownPackageRoots` once built | identity memo binds it |
| graph construction | `graph.nodes` once `buildCallGraph` returns | graph index |
| target resolution | resolver + entrypoints + project root | public-entry memo |
| verdict evaluation | everything above | nothing cached |

**No proof outcome is memoized.** There is no cached `NOT_AFFECTED`, no
cached `UNKNOWN`, no cached proof family and no cached reachability result.

### Reachability caching — deliberately NOT done

§11 asks for conservatism and §12 forbids memoizing proof outcomes until
the proof-input boundary is structurally immutable. Both were honored, and
for the reason F4 recorded: `AnalysisProofContext` freezes its wrapper and
snapshots `entrypoints`, but the closure, the graph, `knownPackageRoots`
and the entrypoint OBJECTS remain live aliases. A reachability cache's key
would have to include every one of those by value, and it cannot while
they are mutable references. **F5 does not attempt it, and does not
worsen the boundary** — it adds a node-count staleness check where there
was previously no check at all, and every index refuses rather than
answers when it fires.

That check detects growth or shrinkage of the node list. It does NOT
detect a node mutated in place; nothing in this codebase does, and F5 does
not claim otherwise. This is the F4 transitive-mutability debt, carried
forward unchanged.

### Manifest readers: not consolidated, deliberately

Four readers exist: `readInstalledPackageName` (name),
`readInstalledManifestIdentity` (name + a four-outcome version claim),
`verdict.ts`'s `readInstalledVersion`, and `package-entry.ts`'s
`declaresExports`. §5 says to prefer one existing per-scan memo and to
consolidate **only if semantics are identical**. They are not —
`readInstalledManifestIdentity` distinguishes `absent` from `untrusted`
from `silent` precisely because collapsing them is a soundness bug in one
direction — so they were not merged.

What the measurement showed is that they did not need to be: 2,830 of the
2,896 reads came through `readInstalledPackageName`, and the other three
are already O(instances), not O(nodes × findings). Only the one hot reader
is memoized, and memoizing it does not create a second authority — it is
still the only reader of an installed package's declared name, and
`dependencies/package-instances.ts`'s own existing per-scan manifest memo
(over the DIFFERENT reader) is untouched. Post-F5 counts:
`readInstalledManifestIdentity` 52, `declaresExports` 14,
`readInstalledVersion` 0.

### Resolver reuse — already correct, nothing to do

`createModuleResolver` is called **once per scan** in `cli/scan.ts` and
returns a stateless object; there was no repeated construction to remove.
`ts.resolveModuleName` is invoked without a `ts.ModuleResolutionCache`,
which is a real available optimization — and a **measured non-hotspot**:
1,095 calls, 1.1% of corpus wall time. Taking it would mean changing
resolution machinery for ~1% of a cost that is not the bottleneck, so it
is recorded as a remaining hotspot rather than attempted here.

### Identity controls — twins, aliases, scopes, symlinks, cross-root

Every shape identity attribution distinguishes is asserted **as a
differential against the uncached function**, not against a fixed expected
value, so the assertions keep testing equivalence even if attribution
itself changes later. Each is checked twice — once on the miss path, once
with every answer served from the memo — because a memo that were merely
correct on the miss path would pass a single-pass check.

| shape | asserted |
| ----- | -------- |
| `foo@1.0.0` at two physical roots | two `PackageInstanceId`s, never one |
| two roots whose manifests declare DIFFERENT names | neither answers for the other |
| `@scope/pkg` vs `pkg` | distinct names, distinct instances |
| `@a/pkg` vs `@b/pkg` | distinct, suffix collision impossible |
| npm alias (`semver-vulnerable` declaring `"semver"`) | same declared name, two instances |
| symlink and its physical target | **converge** (one instance) |
| two symlinks to two different targets | **do not converge** |
| same relative path under two project roots, ONE cache | two instances |
| memo bound to registry A, queried with registry B | bypassed; A's memo unpoisoned |

End to end through `runScanCommand`, the same properties are re-asserted on
real verdicts: two `twin@1.0.0` installs produce two findings with
DIFFERENT verdicts (a merge would collapse them to one); an alias and its
canonical namesake stay two; a scoped package resolves AFFECTED while its
unscoped namesake does not inherit that reachability; a workspace member
reached through its `node_modules` symlink produces exactly ONE finding
(a failure to converge would show as a phantom duplicate).

### Concurrency and cross-scan isolation

No mutable cross-scan cache state affects a cached analysis result —
confirmed by inspection and by test.

Stated that precisely, rather than as "there is no module-scope mutable
state", because the independent audit found the stronger phrasing is
false: `scan-caches.ts` holds one module-scope `Map`, `EMPTY_INSTANCES`.
It is a permanently-empty SENTINEL — the answer returned for a package
name the graph contains no instance of — never written by any code in this
repository, and every reference that escapes is typed `ReadonlyMap`, so
poisoning it would take a deliberate cast. It carries no scan data, so it
cannot carry data between scans. The claim that matters is therefore the
one above: no cache state that participates in an analysis answer is
shared across scans.

Two scans of DIFFERENT projects that install the
same package name and version at the same RELATIVE path, run
**concurrently** via `Promise.all`, produce results identical to running
each alone, and neither's findings reference the other's root. A unit test
asserts a second cache starts cold (0 hits, 1 miss) for a path the first
cache already answered — which would fail immediately if any memo were
hoisted to module scope.

### Provider query differential

The scan's provider query set is compared directly, per fixture, between
main and this branch, and a recording provider in the end-to-end suite
asserts the shape: exactly one query per (package name, installed
version), twins at the same version sharing one query (the pre-existing
`advisoryQueryVersions` contract), and no query issued twice. **No
deduplication was added and none was removed.**

### Verdict / evidence / candidate / diagnostic differential

Method: both sides scan all 15 fixtures into FIXED destination paths, so
absolute install paths are identical and the outputs are byte-comparable.
Compared whole: exit code, stderr, sorted provider query set, and the
entire JSON output with exactly two fields normalized —
`scan.id` (a fresh UUID per run) and `timings` (wall-clock). Nothing else
is normalized, so `findings` (vulnerability, package, version,
packageInstance, verdict, confidence, target, evidence, negative proofs,
`unknownReasons`), `unreportedCandidates` (stage, disposition, reason,
category, instance), `coverage` and `diagnostics` are all compared
verbatim.

**Result: all 15 fixtures BYTE-IDENTICAL.** 17 findings, 52 provider
queries and 2,240 diagnostics compared; zero differences.

The comparison is not vacuous — the corpus exercises all three verdicts
and all three negative-proof families:

| verdict / proof | fixtures |
| --------------- | -------- |
| `AFFECTED` | lodash-template, rwb-01, rwb-02, rwb-04, rwb-08, rwb-09 (x2), rwb-11 |
| `UNKNOWN` | lodash x2, rwb-03, rwb-05, rwb-10 |
| `NOT_AFFECTED` family A (`confirmedAbsentFromModuleLoadClosure`) | rwb-06 |
| `NOT_AFFECTED` family B (`confirmedAbsentInstance`) | rwb-11 |
| `NOT_AFFECTED` family C (`confirmedUnreachableTarget`) | rwb-07 |

An all-UNKNOWN corpus would have proved nothing: the negative proofs are
exactly what a caching defect would fabricate, and they are present,
unchanged, and produced through the caches on the branch side.

**Where this differential is NOT non-vacuous, stated plainly.** The
independent audit measured the comparison surface and found two classes
where "identical" is true but carries no information:

- **`unreportedCandidates`: all fifteen fixtures produce ZERO.** Nothing
  was compared. Every candidate class F3 defines — `workspace_discovery`,
  `package_identity` / `installed_version_unavailable`,
  `advisory_applicability` — is absent from this corpus.
- **`diagnostics`: all 2,240 come from a single source, `call-graph`.**
  The classes a caching defect would most plausibly suppress — workspace
  truncation, pnpm-only layouts, malformed manifests, version-conflict
  provenance — are not represented at all.

So the earlier sentence "`unreportedCandidates` ... are all compared
verbatim" is true of the mechanism and misleading about the evidence. The
actual F5 safety argument for those classes is not the differential; it is
that **their producing code is untouched and receives no F5 cache**:
`dependencies/workspaces.ts`, `dependencies/package-instances.ts`,
`domain/uncertainty.ts` and `analysis/uncertainty.ts` are byte-identical
to `d3dd220`, and `cli/scan.ts`'s entire change is four effective lines
that create the identity memo and pass it to the closure and the context —
`discoverWorkspacePackages` and `buildPackageInstanceRegistry` are called
exactly as before and are handed no cache. That is a stronger argument
than a differential over a corpus that never exercises them, but it is a
DIFFERENT argument, and the record should not have let the differential
appear to cover ground it does not.

The behavioural coverage for those classes comes from the focused suites
instead, which do run on this branch and do exercise them:
`scan.workspace-uncertainty`, `workspaces.uncertainty`,
`workspaces.truncation`, `scan.metadata-uncertainty`, `scan.f3-no-finding`
and `package-instances.differential-oracle`.

### Verification

Every gate run to completion on this branch. **No timeout waivers.**

| gate | result |
| ---- | ------ |
| F5 focused suite (3 files) | **40 passed**, 2.33s test time |
| `npm test` | **163 files / 3,979 passed** (main: 160 / 3,939) |
| adversarial | **124 passed** — identical to main |
| `scan-performance` | **3 passed** (2,397ms / 5,000; 8,224ms / 20,000; F5 ratio guard) |
| output differential vs `d3dd220` | **15/15 fixtures byte-identical** |
| `typecheck` | clean |
| `lint` | clean |
| `prettier --check` | clean |
| `build` | clean |
| `validate:history` | clean — 30 bootstrap tasks and kit files present |

Included in `npm test` and re-checked as the soundness gate this work
could most plausibly have broken: the **F4 proof-mutation harness**
(`verdict.f4-proof-mutation.test.ts`, `finding.f4-closure-hardening.test.ts`),
Family A/B/C, `AnalysisProofContext` / VT-CONTRACT-03,
`ModuleLoadClosure` and its differential oracle, F2 proof guards, F3
taxonomy and no-finding reasons, same-version twins, alias/scoped
identity, workspaces, public-entry and target resolution, and the
RWF-029..037 representatives. **The F4 mutation metric is unchanged: 0
unsafe survivals.** No mutation test became stale, which was the specific
risk of adding memoization underneath a harness that removes proof inputs
one at a time — the caches are bound by reference to the very inputs those
mutations replace, so a mutated input is a different object and is never
served from a memo built for the original.

The **validation suite was not re-run**: it hits the live OSV API, and its
documented benchmark set (5 failed / 18 passed) is a network-dependent
measurement that this work cannot affect — the offline differential above
covers the same 15 fixtures with the provider stubbed, and found zero
movement.

### Self-review — the fifteen attacks, and where each is answered

| # | attack | answer |
| - | ------ | ------ |
| A | same-name/version twin cache collision | key is the whole `resolvedFile` / canonical root; twin tests, unit and end-to-end |
| B | same relative path under different project roots | one cache, two roots, two instances — asserted |
| C | symlink normalization too aggressive | converge test AND non-converge test (two links, two targets) |
| D | alias/scoped collision | alias, `@scope/pkg` vs `pkg`, `@a/pkg` vs `@b/pkg` |
| E | error cached as safe absence | nothing is memoized on any failure; five tests, each also asserting the map stayed empty |
| F | stale graph index after mutation | node-count guard → `undefined` → full walk; asserted. In-place node mutation is NOT detected and is recorded as F4 debt |
| G | global cache contamination across scans | no module-scope state; cold-second-cache test; concurrent two-scan test |
| H | nondeterministic Map iteration changes output | index order proved equal to the walk's, forward and reversed; reversed-declaration-order scan compared |
| I | cached target from wrong PackageInstance | public-entry key is the canonical `PackageInstanceId`; graph index refuses a foreign graph/registry |
| J | proof/result caching crosses context | no proof outcome is cached at all; untrusted context has its caches withdrawn |
| K | diagnostics disappear due to memoization | full diagnostic differential; plus a workspace-truncation diagnostic test |
| L | provider query set changes | query sets compared per fixture; recording-provider assertions |
| M | unreportedCandidate changes | compared verbatim in the differential |
| N | performance gain only a benchmark artifact | gains asserted as operation counts on real fixtures, not synthetic timings; wall-clock reported as within noise rather than claimed |
| O | memory grows without scan-scale bound | entry counts asserted exactly; no key derives from advisory/rule/package input |

### Deliberately not done

- **`ts.ModuleResolutionCache`** — measured non-hotspot (1.1% of wall).
- **Manifest-reader consolidation** — semantics differ; §5's own condition
  not met.
- **Reachability / proof-result caching** — blocked on F4's mutability
  debt, per §11 and §12.
- **Threading a cache through `canonicalizePackageInstancePath` itself** —
  its remaining callers (`cli/scan.ts`, `workspaces.ts`,
  `package-instances.ts`) are already O(instances); the public identity
  authority's signature is unchanged.
- **RWF-002, P1-B, verdict semantics, proof families, `PackageInstance`
  identity semantics** — all untouched.

### Remaining hotspots (for whoever takes performance next)

1. **Parsing / graph construction, ~90% of wall time.** The single
   largest, and untouched by F5. `scan-performance`'s own notes already
   identify a shared per-scan source-index cache between `buildCallGraph`
   and the module-load closure as worth ~35% of the closure's added cost;
   the other ~65% is irreducible by design (VT-307c-fix-3).
2. **`ts.resolveModuleName` without a resolution cache** — 1.1%, real but
   small, and it touches resolution semantics.
3. **The closure's `findClosureWideningConstructs` whole-file scan** —
   deliberately duplicated work, load-bearing for soundness.

**Performance is not solved.** F5 removed one multiplier and left the
dominant cost exactly where it was.

### CI gate remediation — the wall-clock ratio was worse than flaky

F5's first multiplier guard timed two scans (4 advisories vs 32) and
required the ratio under 4x. CI failed it at **4.07** (134ms vs 546ms).

The reflex fix is to raise the threshold. That was not done, because
measuring first showed the gate did not own the property it claimed to:

| | ratios observed | fails at 4.0 |
| - | --- | ---: |
| F5 **intact**, 10 local runs | 1.88 / **3.32 median** / 5.88 | **1 / 10** |
| graph index **entirely disabled**, 4 runs | 2.71 / **3.15 median** / 3.24 | **0 / 4** |

It failed on correct code and passed on the exact regression it existed to
catch. Both halves have one cause: restoring the per-advisory graph walk
costs ~3,900 in-memory identity lookups instead of ~160, and map reads are
invisible beside parsing and graph construction — while ordinary variance
on a ~200ms denominator is not. **No choice of threshold separates those
two**, so raising it would have preserved a gate with no discriminating
power and merely stopped it complaining. The comment claiming the expected
ratio was "near 1" was also wrong: the median is 3.3, because 32 advisories
genuinely do 8x the per-finding work — real work F5 neither removes nor
should.

**The replacement measures operations, not time.** An intact scan's
verdict-phase identity requests are exactly:

```
identityRequests = graphNodes + advisories + 6
```

verified exactly at graphNodes ∈ {33, 123, 243} × advisories ∈ {1, 4, 8,
16, 32}, byte-identical across repeated runs. One graph pass, plus one
ownership check per finding, plus a small fixed public-entry cost. The
pre-F5 shape is `graphNodes × advisories`.

The gate asserts the SLOPE — identity requests added per additional
advisory — bounded at 4:

| | per-advisory identity requests |
| - | ---: |
| F5 intact | **1** |
| graph index disabled | **124** (= one per graph node) |

with an absolute restatement (`≤ graphNodes + 4 × advisories`) so the
bound survives someone changing the advisory counts. Two further
deterministic assertions cover the other F5 reuse claims: the verdict
phase performs **zero** `realpath` and **zero** manifest reads (the
per-scan memo already paid for them during closure construction), and the
public-entry memo holds **one** key for all 32 advisories (they share an
instance and a specifier, differing only in exported symbol).

**Mutation-checked, both directions.** Disabling the graph index in source
fails the gate with `identity requests per advisory: 124 ... expected 124
to be less than or equal to 4` — 31x over the bound. Under that same
mutation the entire wall-clock suite still passes 3/3, which is the
clearest statement of what was actually wrong with the old gate. The
zero-filesystem assertion carries its own in-test control: withholding the
scan's memo makes the counters non-zero while leaving the findings
identical, so `toBe(0)` is not vacuously true.

**What the stopwatch is still for.** A single generous absolute ceiling
(10,000ms, ~9x the slowest of ten local samples and ~18x CI's) remains in
`scan-performance.test.ts` as a catastrophic-regression smoke. It is
documented there as NOT a multiplier guard — it demonstrably does not
catch one — and the existing 5,000ms and 20,000ms thresholds were not
touched. The deterministic gate runs in the default `npm test` suite,
where it costs ~8s and needs no isolation from parallelism, because
nothing it asserts is a clock reading.

Alternatives considered and rejected: raising 4.0 → 4.5 (preserves a gate
with no discriminating power); repeated medians (reduces variance, still
measures the wrong quantity — the regression barely moves the clock);
larger workloads (more wall time, same conflation). Deterministic counters
were preferred because they encode the eliminated multiplier directly.

### Remaining limitations

1. **Corpus scale.** 15 fixtures, largest graph 690 nodes, at most 2
   findings each. That is enough to measure the redundancy RATIO
   decisively (94–98%) and not enough to show the multiplier in
   milliseconds. A project with thousands of nodes and dozens of findings
   is where this matters, and none is vendored here.
2. **The staleness guard is a node COUNT.** A node mutated in place after
   the index is taken is undetected. This is the F4 transitive-mutability
   debt; F5 adds a check where there was none and does not close it.
3. **Failure memoization is refused, not optimized.** A project where
   `realpath` consistently fails gets no canonicalization memo at all.
   That is the deliberate trade: correctness over a case that does not
   arise for roots the analyzer itself just discovered.
4. **Wall-clock improvement is not demonstrated.** The honest claim is a
   non-regression plus a large operation-count reduction plus a scaling
   guard. Anyone quoting a percentage speed-up from this work is quoting
   noise.
5. **No cross-scan or global cache, by rule.** A repeated scan of the same
   project re-does everything. That was out of scope and remains so.

## RWF-039 (FOUNDATION F6) — The invariants had owners nobody had written down, and the metadata validator was checking something else entirely

Foundation's sixth task. It adds **no proof rule, no verdict, no evidence,
no proof family, no uncertainty reason, no analyzer capability and no
change to any production source file**. What it adds is an authoritative
map from invariant to owning test, one command that runs those owners, an
offline semantic differential that proves its own coverage, and the commit
metadata check that `validate:history` was assumed to be and never was.

Central rule being enforced: *a gate should fail because an invariant
broke, not because the runner happened to be 20 ms slower.*

### F5 handoff

Base: `3286394` (`docs: record the CI gate remediation, and correct three
audit findings`), certified before editing — clean tree, identical to
`origin/main`, F5's six commits present (`d286767`..`3286394`), the
deterministic multiplier gate live.

Full baseline on that SHA, measured rather than assumed:

| gate | result |
| ---- | ------ |
| `npm test` | **164 files / 3,982 passed**, 215s |
| `test:adversarial` | **124 passed**, 51s |
| `test:performance` | **3 passed** — 2,521/5,000ms; 8,705/20,000ms; 2,080/10,000ms |
| `validate:history` | passed |

### 1. Gate inventory, and what each one is actually for

| gate | invariant protected | determinism | runtime | CI |
| ---- | ------------------- | ----------- | ------: | -- |
| `npm test` | everything below, plus all unit/integration coverage | deterministic, offline | 215s | yes |
| `test:foundation` *(new)* | the Foundation invariants, as a subset | deterministic, offline | 45s | yes *(new)* |
| `test:adversarial` | overfitting detection | deterministic, offline | 51s | yes |
| `test:performance` | catastrophic wall-clock regression | **environmental** | 18s | yes |
| `test:validation` | real-world CVE behaviour | **network + live OSV** | varies | no |
| F4 mutation harness | `unsafe_survival === 0` | deterministic | ~12s | via `npm test` |
| F5 multiplier gate | operation-count complexity contract | deterministic | ~9s | via `npm test` |
| F5 graph-index suite | refusal ≠ absence | deterministic | ~3s | via `npm test` |
| VT-CONTRACT-01/02/03 | proof-shape contracts | deterministic | ~2s | via `npm test` |
| schema suite | `result.schema.json` compatibility | deterministic | ~1s | via `npm test` |
| fixture integrity | no ignored test input | deterministic (shells to git) | <1s | via `npm test` |
| differential oracles (4) | analyzer vs **real Node** | deterministic, offline | ~25s | via `npm test` |
| `validate:history` | bootstrap-kit archive | deterministic | <1s | **was not in CI** |
| commit metadata *(new)* | no model names / session telemetry | deterministic | <1s | yes *(new)* |

Two findings from the inventory itself, both corrected here:

1. **`validate:history` was never run by CI.** The workflow ran build,
   typecheck, lint, prettier, `npm test`, performance and adversarial. The
   script existed and nothing invoked it.
2. **The four differential oracles are already offline.** They shell out
   to the real `node` binary for ground truth, never to a network. They
   needed classifying, not replacing.

### 2. Invariant ownership map

`src/testing/foundation-invariants.ts`. Twenty-two invariants across 29 owner files, each with
its deterministic owner(s) and a note saying why those owners and not
others.

It is **data, not prose**, and that is the whole point.
`foundation-invariants.test.ts` fails if the map names a test that does
not exist, names one `test:foundation` does not execute, or if the gate
runs a file the map does not account for. Both directions, so coverage
cannot be claimed on paper. That assertion earned its place immediately:
it failed on its first run because the map's own owner was missing from
it.

Duplicate oracles were avoided deliberately. Where an invariant has more
than one owner, each owns a different face — `absent-mlc-fails-closed` is
owned by `verdict.f2-proof-guards` for the fail-closed direction and by
`verdict.module-load-absence` for the proof that is legitimately produced
when the closure IS present, which is what stops the first being vacuous.

`LIVE_SIGNALS` classifies what is deliberately NOT an owner, with a reason
for each, and a test asserts nothing under `tests/` owns an invariant.

### 3. F4 mutation gate

`unsafe_survival === 0` was already the hard gate, and the informational
distribution counts were already lower bounds rather than frozen values.
Both left as they are: F6 § 3 explicitly warns against freezing counts
that may legitimately grow.

One strengthening. `expectExactlyOneProof` asserted a proof COUNT, and a
count of one is satisfied by a proof object that is present and
malformed — which is exactly the state a mutation could produce. It now
asserts VALIDITY: every surviving `NOT_AFFECTED` carries a well-formed
member of its own family — A/B naming an instance, C naming a target and
resting on `reachableSubgraphComplete === true` — and every other verdict
carries none.

### 4–7. PackageInstance, proof contracts, F2, F3

All four were already owned by deterministic suites inside `npm test`;
none was skipped, optional or conditionally executed. F6's contribution
is that they are now *named* owners that a single command runs and that a
test keeps honest.

Specifically checked and confirmed already gated: same-name/version twins,
distinct roots, symlink convergence, alias semantics, scoped/unscoped
collision, workspace/installed identity; VT-CONTRACT-01/02/03; absent MLC,
syntax failure, loader mutation, `graphTruncated`, unknown runtime
`DynamicCallReason`; exactly three verdicts, structured UNKNOWN reasons,
no-finding distinct from Finding, `not_applicable` distinct from
`undetermined`, old-compatible schema output.

### 8. F5 cache / index gate

Already covered: foreign registry refusal, `undefined` ≠ absence, twins
not colliding, exact-instance public-entry keys, failed filesystem and
manifest operations never memoized as success, concurrent scans sharing
no state.

F6 adds the half nobody had reached — see § 12.

As F6 § 8 requires, nothing here asserts "there are no module-scope
mutable objects", which is false: `EMPTY_INSTANCES` remains, documented,
as the shared empty sentinel. It is never written to.

### 9. F5 multiplier gate

Left exactly as F5 remediated it: an exact operation-count bound, with no
wall-clock ratio anywhere. Mutation-checked below; it still catches a
disabled graph index, by a factor of 31.

### 10. Wall-clock's role

The three remaining ceilings (5,000ms / 20,000ms / 10,000ms) are kept and
**not tightened**. They are coarse "did something explode" smoke. The
complexity contract is the operation-count gate, which has no threshold
to tune. Both facts are now stated in README.md and in the config
comments rather than living only in a remediation record.

### 11. Threshold-ratchet policy

Implemented as the lightest thing that can actually stop a ratchet rather
than as a paragraph nobody reads: the three ceilings are pinned in
`foundation-invariants.test.ts` as well as in the guard file. Raising one
to make CI green is therefore a deliberate two-file edit, and the failure
message names the record where the measurement and justification must go.

### 12. The graph-index refusal gap — first misdiagnosed, then closed

**This section originally claimed the mutation below was an equivalent
mutant. That claim was wrong, and an independent audit disproved it. The
corrected account follows; the error is left visible because how it was
reached is the useful part.**

Mutating `graphPackageInstances`'s refusal fallback to

```
return indexed ?? new Map();
```

— reading "the index cannot answer" as "this package has no instances" —
passes the entire Foundation gate **and** the full `npm test` run: 167
files, 4,177 tests, zero failures. That much was correctly measured.

**The equivalence argument was wrong.** It ran: `resolveTargetNodes`
concludes a family-B absence only inside `if (instances.size > 0)`, and
`confirmedAbsentInstance: true` appears exactly once in `verdict.ts`
inside that block, so an empty answer cannot reach it. Every clause of
that is true. The conclusion drawn from it — that the mutation therefore
has no effect — does not follow, and inverts what the guard means. That
guard is not why an empty answer is *safe*; it is why an empty answer
*loses the proof*.

`resolveTargetNodes` has two structurally different sites (VT-301B):

- **Site A** (`instances.size > 0`) is the only place the analyzer knows
  "the graph holds other instances of this name but never traversed THIS
  one" — which is the entire premise of a family-B proof.
- **Site B** (`instances.size === 0`) performs an independent,
  instance-blind re-resolution. It has no knowledge of which instances the
  graph contains and so cannot conclude family B at all.

So the mutation skips Site A, discards the knowledge family B is made of,
and the independent resolution lands on a *different* instance than the
finding's own — which the proof guards then correctly refuse to certify.

**The discriminating state**, which the audit constructed and which is now
a gate: same-name/same-version twins, the finding about the UNREACHED
twin, the index forced to refuse. Measured on that fixture:

| source | verdict | proof |
| ------ | ------- | ----- |
| clean | `NOT_AFFECTED` | family B, naming the unreached twin |
| refusal read as absence | **`UNKNOWN`** | **none** |

**Why the first replacement test did not catch it.** It used a finding
whose instance IS reached and whose target IS called. In that state Site A
and Site B agree — Site B's independent resolution lands on the same
instance and finds the same target, so the answer is `AFFECTED` either
way. The case could not fail. It reported coverage of the fallback
contract while being structurally incapable of detecting its loss, which
is the same failure mode F6 was built to eliminate, reproduced inside F6's
own remediation.

**Final classification of mutation C.** Not equivalent. It is a
**conservative precision regression**: `NOT_AFFECTED` (family B) →
`UNKNOWN`, in a graph-index-refusal/staleness state only.

- It does **not** fabricate a negative proof. The direction is toward
  claiming less, which is the safe direction under AGENTS.md.
- It **is** semantically observable in production output.
- Normal production does not currently enter the stale-index refusal
  state, because every proof context builds its caches from its own graph.
- The fallback contract is nonetheless now deterministically gated, rather
  than argued away.

`scan-caches.f5-graph-index.test.ts` now owns both halves, and they are
different contracts, deliberately kept apart:

- *a refusal falls back to the walk* — the reached/`AFFECTED` case. A
  stale index costs time and changes no answer.
- *a refusal preserves the family-B proof* — the unreached-twin case. The
  walk still establishes the proof the index's absence would have cost,
  naming the exact twin the finding is about and not its sibling.

Both assert the refusal actually occurred before asserting anything about
it, so neither can pass vacuously.

### 13. The offline semantic differential

F5's differential compared whole JSON documents byte for byte over 15
vendored real-package fixtures, as a one-off script outside the suite.
Its own audit recorded two places where "identical" carried no
information: **zero** `unreportedCandidates` across all fifteen fixtures,
and all **2,240** diagnostics from a single source, `call-graph`.

The replacement (`src/testing/foundation-differential.test.ts`, with its
corpus in `foundation-corpus.ts`) is committed, hermetic, network-free,
and runs under both `npm test` and the Foundation gate. Nine synthetic
projects go through the real `runScanCommand` with only the OSV boundary
stubbed.

**It compares semantics, not snapshots.** A byte diff of a large document
fails loudly and says nothing; the reader has to work out which of the
thousands of changed lines mattered. The projection reduces a scan to
what Foundation protects — which instance got which verdict, which proof
family answered, which candidate classes and diagnostic sources appeared,
in what order — so a failure names the invariant. A stored baseline was
rejected for a second reason: regenerating a snapshot is
indistinguishable from accepting a regression.

**Coverage, asserted rather than claimed:**

| class | covered by |
| ----- | ---------- |
| `AFFECTED` | affected-direct-call, family-b-unreached-twin |
| `UNKNOWN` | unknown-dynamic-dispatch |
| `NOT_AFFECTED` family A | family-a-never-loaded |
| `NOT_AFFECTED` family B | family-b-unreached-twin |
| `NOT_AFFECTED` family C | family-c-safe-export-only |
| exact multi-instance identity | family-b-unreached-twin (same name, same version, two roots, two verdicts) |
| `installed_version_unavailable` | candidate-version-unavailable |
| `advisory_not_applicable_to_installed_version` | candidate-not-applicable |
| `installed_manifest_untrusted` | candidate-manifest-untrusted |
| diagnostic source `call-graph` | several |
| diagnostic source `dependencies` | candidate-manifest-untrusted |
| diagnostic source `workspaces` | candidate-workspace-incomplete |

### 14. Non-vacuity

The gate does not merely have fields for these classes; it **asserts each
one actually occurred**. Every verdict, all three proof families, all
three required candidate reasons, both dispositions, all three stages,
three diagnostic sources, more than one distinct `packageInstance`, and at
least one `AFFECTED` carrying a witness path.

Each of those assertions carries the reason it exists, naming the F5 gap
it closes, so a future reader deleting one knows what they are deleting.

Verified by mutation: dropping the `not_applicable` candidate from
`cli/scan.ts` fails the per-case assertion, the required-class assertion
and the disposition assertion — three independent reports of the same
defect the F5 corpus could not have seen at all.

### 15. Live validation

`tests/validation/` remains, unchanged and not removed. It is classified
in `LIVE_SIGNALS` as a **live / environmental integration signal**: real
network, real OSV, real npm packages. Useful evidence and a
provider-movement detector; not a deterministic correctness oracle, and
not the sole oracle for anything. Advisory-database movement cannot make
core Foundation CI flaky, because no Foundation invariant depends on it —
asserted structurally, by a test forbidding any `tests/` path from
appearing as an owner.

### 16. Output determinism

Each corpus case is re-scanned twice: once identically, and once with its
rules and advisories declared in **reverse order**. Findings, proof
families, `unknownReasons`, `unreportedCandidates` and diagnostic sources
must be identical both times. Order-dependence is invisible to a single
run.

### 17. Path normalization

F6 § 17 warns about an earlier harness that saw `mkdtemp` differences and
normalized paths. The danger is precise: normalization that collapses
paths makes `PackageInstance` A and `PackageInstance` B compare EQUAL, so
the differential would certify exactly the identity defect it exists to
catch.

The mapping here is **bijective below the root**. Only the temp-root
prefix is replaced, by a token derived from the case name; every suffix
survives byte for byte. Three assertions hold it: the twin case requires
`node_modules/vuln-lib` and `node_modules/host/node_modules/vuln-lib` to
remain distinct at the same name and version; no output may leak an
absolute temp path; and a direct unit check of the mapping itself.

Worth recording: `packageInstance` is already emitted project-root-
relative by `describePackageInstance`, so instance identity never
depended on this function. Normalization matters for diagnostic messages
and witness paths, which do embed absolute paths.

### 18. Schema gate

Every corpus output is validated with the **production** validator
(`validateScanOutput`), not a separately-configured Ajv instance that
could disagree with the one the CLI enforces — and a disagreement would
favour passing. A guard asserts the documents put in front of it really
do carry all three verdicts, all three proof families and populated
`unreportedCandidates`.

Old-compatible output and explicit rejection cases remain owned by
`cli/result-schema.negative-proof.test.ts`; duplicating them here would
be the duplicate oracle § 2 warns against.

### 19. Fixture integrity

`fixtures-are-committed.test.ts` already guards the exact `dist/` shape
that once passed locally and broke CI, and already asserts that rule is
still ignored so the check is not vacuous. Kept as-is and named in the
map.

### 20. Harness invariants

`finding.f4-closure-hardening.test.ts` retained and named as the owner of
"a package-sensitive default closure cannot be fabricated; an
intentionally absent closure is explicit; synthetic F4 states are not
presented as production-reachable evidence."

### 21. The history validator gap

The audit question was why

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

passed `validate:history`. Read rather than guessed, and the answer is
not that the rule was weak.

**There was no rule.** `scripts/validate-history.mjs` validates the
*bootstrap-kit archive*: that `docs/history/tasks/` holds 30 task files
and that nine kit files exist. It reads no commit, opens no git object,
and has no concept of a trailer. The gap was total, not partial. The name
`validate:history` made the connection look plausible; nothing
implemented it. And CI never ran it either way.

**The premise in the task brief was also incomplete.** It names two F5
commits. A sweep of all 228 commits found **three** offenders:

| commit | violation |
| ------ | --------- |
| `86c8669` (2026-09-08, pre-F5) | model name in `Co-Authored-By`, **plus** a `Claude-Session:` trailer carrying a claude.ai session URL |
| `26cb448` (F5) | model name in `Co-Authored-By` |
| `3286394` (F5, the F6 base) | model name in `Co-Authored-By` |

So the practice predates F5 by a week, and one commit carries session
telemetry as well as a model name.

### 22. The prospective rule

`scripts/commit-metadata-policy.mjs`, a pure function over one commit's
metadata, separated from the git walk precisely because a rule that can
only be exercised by making real commits cannot be unit-tested — and an
untested rule is how this gap arose.

Scoping is the delicate part, since F6 § 22 forbids rejecting ordinary
prose that mentions a model:

- **Identity trailers** (`Co-Authored-By`, `Signed-off-by`,
  author/committer names) name a person or agent. A model identifier
  there is never prose. Model patterns apply in these positions **only**.
- **Telemetry** — claude.ai URLs, opaque `session_...` handles,
  `*-Session:` trailers, `Generated-by:` model trailers — has no
  legitimate prose use, so it is rejected anywhere in the message.
- **Everything else**, including prose naming a model and the entire
  contents of the tree, is out of scope. The policy takes a commit record
  and has no filesystem access at all.

Model patterns require vendor **and** family or version (`Claude Opus 5`,
`Claude-Opus-5`, `Claude 3 Haiku`, `Claude 5`, `claude-opus-5`,
`claude-3-5-sonnet-20241022`, `GPT-5.6`, `Gemini 2.5`), never a bare
family word — `Opus` and `Haiku` are ordinary English, and `Claude` alone
is the allowed form.

### 23. Historical baseline

Main is **not** rewritten. The three offenders are published and cited by
RWF-038; rewriting to erase a metadata defect that changes no code would
invalidate every SHA those records reference.

Primary mechanism: the policy applies to `F6_BASE_SHA..HEAD` only — one
named commit, not a list, needing no maintenance as history grows.

Secondary mechanism: the three known offenders are also listed
explicitly, each with its reason. This is not redundancy for its own
sake. The range alone degrades silently in a **shallow clone**
(`actions/checkout@v4` fetches depth 1 by default, so there is no base
commit to compute a range from) and under a **rebase**, which would move
those commits to new SHAs past the cutoff. CI now checks out full history
so the primary mechanism works there.

Neither mechanism can hide a new violation: a new commit is not in the
list, and is in the range.

The grandfathering is held honest by four assertions: each exempted commit
really does violate the policy; each is an ancestor of the base; each
carries a stated reason; and — walking all 228 commits of merged history —
the offenders found are **exactly** the exempted set. A new violation
merged to main fails there even if nobody ran the gate.

### 24. Metadata mutation-check

33 synthetic cases, hermetic, creating no commits. 17 forbidden forms are
each asserted rejected **and** matched by the rule that owns them, so a
rule that stops matching cannot hide behind another that fires. A further
test asserts every declared rule is exercised by at least one case.

Six kinds of ordinary prose are asserted **accepted**: a subject about a
GPT-5 provider adapter, a body comparing model families, a body using
"session" in English, a `claude.com` link, prose using "generated", and a
message that describes this very policy.

That last one is a regression case, not a hypothetical. The first version
of the claude.ai rule matched the bare domain anywhere, and it rejected
the commit introducing the policy — whose message has to name the host it
forbids in order to explain itself. A rule that a commit documenting the
rule cannot pass is a rule nobody can document. The pattern now requires a
URL with a path; the historical offender is still caught.

### 25–27. Command, fast/full split, failure messages

`npm run test:foundation` — 29 files, 1,356 tests, ~45s. A **subset** of
`npm test`, asserted structurally to be one, so the two cannot disagree
and CI does not run the full suite twice. The fast/full split is
documented in README.md as a table.

Failure messages name invariant, case, expected and actual throughout —
`VERDICT SET CHANGED`, `PROOF BINDING VIOLATED`, `UNREPORTED CANDIDATE
MISSING`, `NON-VACUITY FAILED`, `INDEX REFUSAL CHANGED THE ANSWER`,
`WALL-CLOCK THRESHOLD CHANGED`, and the metadata gate's per-rule report.

### 28. Gate mutation-checks

Every mutation applied to a clean tree and reverted after.

| # | mutation | caught by | signal |
| - | -------- | --------- | ------ |
| A | absent module-load closure read as a satisfied guard | `verdict.f2-proof-guards`, `verdict.module-load-absence` | **4 tests fail** |
| B | identity memo keyed by basename, collapsing twins | `resolved-target.f5-identity-cache`, **offline differential** | **17 tests fail**; differential reports `VERDICT SET CHANGED` |
| C | index refusal read as absence | `scan-caches.f5-graph-index` (the unreached-twin case, added in remediation) | **fails**: `FAMILY-B PRECISION REGRESSION`, NOT_AFFECTED/B -> UNKNOWN. Originally misdiagnosed as an equivalent mutant; see § 12 |
| C′ | stale index treated as authoritative | `scan-caches.f5-graph-index` (both the unit case and the new fallback case) | **2 tests fail**; the non-vacuity guard reports the refusal stopped happening |
| D | graph index disabled | `scan-caches.f5-multiplier` | **fails**: 124 identity requests per advisory against a bound of 4 |
| E | `not_applicable` candidate dropped | **offline differential** (×3), `scan.f3-no-finding` | **4 tests fail** |
| F | real commit with model name + session trailer | `validate:commit-metadata` | **exit 1**, all four rules reported with invariant/expected/actual |

C is the most informative row, though not for the reason first recorded.
It was reported as an equivalent mutant; an independent audit disproved
that by constructing the unreached-twin state, and it is now gated. The
lesson it carries is about the mutation-check itself: a mutation that
survives is evidence of missing coverage until proven otherwise, and
"proven otherwise" means a discriminating experiment, not a source-reading
argument.

### 29. Repeated-run stability

Five consecutive runs of `npm run test:foundation`, same commit, same
machine:

| run | result | wall |
| --- | ------ | ---: |
| 1 | 29 files / 1,356 passed | 48s |
| 2 | 29 files / 1,356 passed | 46s |
| 3 | 29 files / 1,356 passed | 45s |
| 4 | 29 files / 1,356 passed | 46s |
| 5 | 29 files / 1,356 passed | 47s |

**Semantic result identical 5/5.** Wall clock varied by 3s (45-48s), which
is reported separately and is not a failure: nothing in this gate asserts
on elapsed time, which is the property that makes the 5/5 meaningful
rather than lucky.

### 30. Runtime

| gate | runtime |
| ---- | ------: |
| `test:foundation` | ~45s |
| `npm test` | ~215s |
| `test:adversarial` | ~51s |
| `test:performance` | ~18s |
| typecheck / lint / prettier / build | ~35s combined |
| `validate:history` | <1s |

The fast gate is ~21% of the full suite's runtime and does not duplicate
it: CI's total grows by ~45s, not by a second full run.

### 31. Production differential

**Zero build-input changes.** `git diff 3286394..HEAD -- src`, excluding
`*.test.ts` and `src/testing/**` (which `tsconfig.build.json` excludes
from the build), is empty. The compiler sees byte-identical input, so the
artifact is necessarily identical — a stronger statement than comparing
hashes of two builds.

Everything F6 changed is tests, scripts, config or docs. The listing below
is the code/config diff; it deliberately excludes this record's own file,
`tests/validation/FINDINGS.md`, which the remediation commits also change
— an independent audit noted that stating "15 files" while writing into a
16th reads as an omission, so the scope is named explicitly here rather
than implied by the list:

```
 .github/workflows/ci.yml                        |   22 +
 README.md                                       |   62 ++
 package.json                                    |    4 +-
 scripts/commit-metadata-policy.d.mts            |   42 +
 scripts/commit-metadata-policy.mjs              |  264 +++
 scripts/validate-commit-metadata.d.mts          |   18 +
 scripts/validate-commit-metadata.mjs            |  204 +++
 src/analysis/scan-caches.f5-graph-index.test.ts |  235 +++
 src/analysis/verdict.f4-proof-mutation.test.ts  |   41 +
 src/testing/commit-metadata-policy.test.ts      |  451 ++++++
 src/testing/foundation-corpus.ts                |  487 +++++++
 src/testing/foundation-differential.test.ts     | 1059 ++++++++++++++
 src/testing/foundation-invariants.test.ts       |  226 +++
 src/testing/foundation-invariants.ts            |  402 ++++++
 vitest.foundation.config.ts                     |   92 ++
```

### 32. Verification

Every gate run to completion on this branch. **No timeout waivers, and no
performance threshold relaxed.**

| gate | result | runtime |
| ---- | ------ | ------: |
| `test:foundation` (new) | **29 files / 1,356 passed** | 45-48s |
| `npm test` | **168 files / 4,192 passed** (base: 164 / 3,982) | 200s |
| `test:adversarial` | **124 passed** — v1 34/34, v2 88/88; identical to base | 50s |
| `test:performance` | **3 passed** — 2,362/5,000ms; 8,231/20,000ms; 2,048/10,000ms | 19s |
| `typecheck` | clean | 23s |
| `lint` | clean | 19s |
| `prettier --check .` | clean | 24s |
| `build` | clean | 13s |
| `validate:history` | clean — archive intact; commits after the base carry no model names or session telemetry | <1s |

Every wall-clock guard passed **further inside** its ceiling than the
baseline did (2,362 vs 2,521; 8,231 vs 8,705; 2,048 vs 2,080), which is
run-to-run noise and is recorded only to show nothing was relaxed to make
them pass.

**Live validation (`test:validation`) was NOT run**, and is reported
separately by design (§ 15): it needs the network and the live OSV
database, and its result is integration evidence rather than a gate. Its
status is therefore *not established by this task*, which is the honest
statement — the suite is unchanged and no Foundation invariant depends on
it.

One inherited caveat found while verifying, and left alone because fixing
it is outside F6's scope: **`npm test` is not itself fully offline.**
`src/vulnerabilities/osv-provider.integration.test.ts` queries the real
OSV API inside the default run. It passed here. It means the FULL suite
carries a network dependency that the Foundation gate does not — the fast
gate excludes it and is genuinely hermetic — and it is worth someone's
attention later, since a provider outage can currently fail `npm test`.

### 33. Limitations — what this does NOT establish

**These gates do not prove the analyzer is sound.** They prove a specific,
enumerated set of Foundation-established distinctions is still drawn, on a
corpus small enough to reason about. Nothing here is a proof of global
soundness, and the invariant map is a map of what is *guarded*, not of
what is *true*.

Specifically:

- **The differential corpus is synthetic and small.** Nine hermetic
  projects. It covers every class it claims, and it claims only what it
  covers — but real npm packages are larger and stranger than anything in
  it. `tests/validation/` and the adversarial suites remain necessary for
  different reasons, and neither substitutes for the other.
- **Non-vacuity is per-class, not per-path.** "At least one family B proof
  occurred" does not mean every way of producing one is exercised.
- **The metadata policy is heuristic at the edges.** It requires vendor
  plus family or version, so a model named in an identity trailer in a
  form nobody has used yet would pass. It is scoped to be conservative in
  the false-positive direction on purpose, and § 24 records why.
- **Mutation-checking samples.** Six mutations plus one variant is not a
  mutation-adequacy score. Mutation C shows the sampling is informative,
  not that it is complete.
- **Wall-clock guards remain environmental.** They are kept deliberately
  generous and are not a complexity contract. A real performance
  regression smaller than the ceiling will not be caught by them — by
  design; that is the operation-count gate's job, and only for the one
  multiplier it owns.
- **Performance is still not solved.** F5 removed one multiplier; F6 adds
  no optimization and measures no new hotspot.
- **The invariant map checks names, not meanings.** Its consistency tests
  assert that every owner EXISTS and is GATED, and that the gate runs
  nothing unmapped. They cannot assert that a named file actually tests
  the invariant it is named for — an independent audit found exactly one
  such misattribution (§ 34 B). Reviewing a map entry still requires
  reading the owner.
- **RWF-002 is untouched**, as is P1-B. F6 changes no analyzer verdict
  semantics and adds no analyzer capability.

### 34. Independent audit, and what it changed

F6 was submitted for independent gate-adequacy audit, which returned
**BLOCKED** on three defects. The audit's central method is the one worth
recording: it did not re-run the gates and check they were green, it
deliberately broke invariants and asked whether the gate that CLAIMS to
own each one actually fails. Three times, the answer was no.

**A. Mutation C was misclassified as an equivalent mutant.** Disproved by
constructing the discriminating state (unreached twin + forced index
refusal), which moves the verdict from `NOT_AFFECTED`/family B to
`UNKNOWN`. § 12 above carries the corrected account and the final
classification. Closed by a new deterministic case in
`scan-caches.f5-graph-index.test.ts` that asserts the verdict, the proof
family, and the exact twin the proof names; applying mutation C now fails
`test:foundation` with `FAMILY-B PRECISION REGRESSION`.

**B. `schema-additivity` was mapped to an owner that does not test it.**
The map named `cli/result-schema.negative-proof.test.ts`, whose five
describes are all VT-CONTRACT-01/02 negative-proof shape tests; it
contains no additivity case at all. The real assertions lived in
`cli/output.test.ts`, which the Foundation gate did not run. This is the
precise failure the map exists to prevent — coverage claimed on paper —
and the map's own consistency tests could not catch it, because they check
that an owner EXISTS and is GATED, never that it tests the invariant it is
named for. That limitation is inherent to the mechanism and is now stated
in § 33.

Closed by extracting the additivity assertions wholesale into
`cli/result-schema.additivity.test.ts` — moved, not duplicated, so the
assertions are the same ones that have run since F3 — gating it, and
re-owning the invariant. Mutation-checked: making
`findings[].unknownReasons` required in `schemas/result.schema.json` (the
exact non-additive change that would retroactively invalidate archived
results) fails the mapped owner on both legacy-acceptance cases.

**C. The offline differential omitted `confidence` and `target`.** Both
are `JsonFinding` fields; neither was projected, so a change moving every
confidence or retargeting every finding left the differential green.

Closed, and the first attempt at closing it is instructive: merely adding
the fields to the projection did NOT catch a confidence mutation, because
the differential's comparisons are run-against-run, so a global move
shifts both sides equally and stays equal. The fields had to be pinned to
EXPECTED VALUES — the target every fixture's `rules.yml` declares, and
confidence tracking the verdict (present on `AFFECTED`, absent otherwise).
Mutation-checked both ways: halving confidence fails with `CONFIDENCE
CHANGED`, altering the resolved symbol fails with `TARGET CHANGED`.

**D/E, non-blocking.** Stale test counts in this record corrected. The
`npm test` live-OSV dependency is now documented in README.md rather than
only here: one suite inside the default run queries the live API
unconditionally, so a provider outage can redden CI. It predates F6 and
isolating it remains a follow-up; `test:foundation` contains no network
access, verified by running it with the network disabled.

**What the audit also confirmed**, by independent reproduction rather than
by reading this record: the build artifact is byte-identical to the base
(`ba9e5c7b…`, 296 files, both revisions built and hashed); the 28 files
the gate ran were exactly the 28 the map named; removing an owner from
either the map or the config fails; mutations A, B, D, E and F all fail
the intended gate with specific messages; the threshold-ratchet guard
fails on a one-file threshold change; grandfathering is three exact SHAs
with no date or pattern rule, and a bad base SHA fails the suite while
making the CLI scan more rather than less.

One environmental caveat the audit surfaced and F6 does not fix: running
the gate inside a user namespace (`unshare -r`) maps the process to root,
which defeats the `chmod 000` in a pre-existing F5 identity-cache case and
fails it. That is root-sensitivity in a test that predates F6, not a
network dependency, and not something this task changed.

---

## RWF-040 (FOUNDATION F7) — The invariants were real, owned and tested, and a new contributor still had to reconstruct them from commit history

Foundation's seventh and closing task. It adds no verdict, changes no proof
rule, and moves no verdict anywhere in the corpus. **Zero production files
changed.**

Central rule being enforced: *a guarantee nobody can find is not a
guarantee, and a number nobody re-derives is not a measurement.*

### F6 handoff

Base: `dcb5da1` (`docs: correct RWF-039 audit findings`), certified before
editing — clean tree, identical to `origin/main`, F6/RWF-039 present.
Baseline at that commit, all green:

| gate | result |
| --- | --- |
| `npm run test:foundation` | 29 files / 1,356 tests, 48.35s |
| `npm test` | 168 files / 4,192 tests, 212.97s |
| `npm run test:adversarial` | 2 files / 124 tests |
| `npm run test:performance` | 1 file / 3 tests |
| `npm run test:validation` (LIVE) | 12 passed / 5 failed, all known, 0 unexpected |

### F7-A — the defect: the truth existed, and it was unfindable

Every Foundation invariant had an owner. Every proof family had a
precondition. Every cache had a failure policy. **None of it had a home a
reader could be pointed at.** The authoritative statement of what
`NOT_AFFECTED` means lived in a 100-line doc comment on a TypeScript
interface; the `AnalysisProofContext` mutability judgment lived in an RWF
record 10,000 lines into this file; the cache contracts lived in a
different one 500 lines further on.

The concrete consequences, all found by looking rather than assumed:

1. **`README.md` positioned VulnTrace as "not a generic SCA scanner"** —
   true, but stated as a negation, with no statement of what it *is*. The
   expected workflow (scanner → candidate → per-instance triage) appeared
   nowhere.
2. **`docs/REAL-WORLD-BENCHMARK-V0.1.md` still opened with "Nothing in this
   document has been implemented."** All ten cases plus the three VT-303
   siblings had been implemented for weeks.
3. **A source document was cited six times and had never existed.**
   `docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md` is referenced by four
   directories' worth of committed files. A history search over every ref,
   filtered to additions, finds no commit that ever added it.
4. **The one measurement Foundation exists to produce was three tables deep
   in a record**, with the warning that makes it readable ("65 of these are
   a corpus artifact") in a different paragraph from the table itself.

### F7-B — the authoritative document set

Four documents, chosen so that each answers a question a reader actually
arrives with, rather than mirroring the task structure that produced them:

| Document | Answers |
| --- | --- |
| `docs/ARCHITECTURE.md` | "How is this put together, and what are the rules?" — pipeline, `PackageInstance` identity, metadata uncertainty, the `UNKNOWN` taxonomy, `unreportedCandidates`, provider boundary, target authority, cache/index contracts, testing tiers, history policy, user and contributor workflows, the Go boundary |
| `docs/SOUNDNESS-CONTRACT.md` | "What does this verdict mean, and what is the proof relative to?" — the three verdicts, families A/B/C, VT-CONTRACT-01/02/03, `ModuleLoadClosure`, `AnalysisProofContext`, how to add a family, three worked examples |
| `docs/SCORECARD.md` | "What is the measured state?" — generated |
| `docs/OPEN-DEBTS.md` | "What do you know you haven't finished?" — eleven named debts, RWF-002, P1-B entry criteria and initial direction |

`docs/SDD.md` and `docs/adr/` are **kept unchanged** and reclassified as
historical. Rewriting a design record to match what was later built
destroys the only artifact that says what was intended; the four documents
above declare themselves current where they disagree.

### F7-C — three things the documentation was tempted to say, and does not

These are the claims a closing document most wants to make, and each one
would have been false:

- **NOT** "`AnalysisProofContext` is immutable." The wrapper is frozen and
  the `entrypoints` array is snapshotted and frozen; `moduleLoadClosure`,
  `graph`, `knownPackageRoots` and the entrypoint OBJECTS are live aliases.
  F4's audit moved a verdict through the caller's own retained alias. The
  documents state the per-field table and call it a hardening debt.
  (`analysis/analysis-context.ts`'s own prose still says "ONE immutable
  object" — F4 recorded that as a documentation defect to fix when the file
  is next touched, and F7 changed no production file, so it stands.)
- **NOT** "the indexes are immutable." The node-count guard detects growth
  and shrinkage and does not detect in-place mutation. Nothing does.
- **NOT** "performance improved." F5 removed one multiplier and established
  a STRUCTURAL operation-count property. Parsing and graph construction are
  still ~90% of wall time and were not touched. No wall-clock improvement
  is claimed anywhere.

### F7-D — the scorecard, and why it is not a score

`docs/SCORECARD.md` is generated by `scripts/generate-scorecard.mjs` from
the artifacts that own each value: the invariant map, the uncertainty
taxonomy, the five vitest configs, `cases.json`, `result.schema.json`,
`package.json` and this file's own status table. TypeScript data modules
are read by transpiling and importing them, so a count cannot disagree with
the thing it counts.

**No 0-100 quality score.** Soundness is not a scalar: averaging a gate
that must never fail with a coverage figure expected to be partial destroys
the meaning of both. The output is a nine-section table whose columns are
*Metric, Current, Source, Interpretation, Limitation* — and the
`Limitation` column is the one a summary would drop, which is why it is
mandatory.

**Two source kinds, kept apart.** *Structural* values are re-derived on
every `--check`. *Measured* values are the output of a command and live in
`docs/scorecard-data/measurements.json`, each carrying its command, commit
and date, with live ones labelled `LIVE` and non-deterministic. `--check`
proves the scorecard matches the recording; only re-running proves the
recording is fresh, and the document says so rather than implying
otherwise.

**Drift is a test failure**, not a convention:
`src/testing/docs-contract.test.ts` runs `--check` under `npm test`. It is
deliberately NOT in the Foundation gate — a stale document is not a
soundness invariant, and diluting what a red Foundation gate means is worse
than a stale document.

### F7-E — two generator defects, found by generating

Both were in F7's own new code and are recorded because the first one
reproduces a misreading this whole task exists to prevent:

1. **The RWF register parser reported RWF-002 as closed.** It classified a
   row as open only if the status began with "Open". RWF-002's status reads
   *"Bypassed for unloaded packages (VT-307d); the underlying
   reachability-scoping tradeoff remains open"* — so the scorecard's first
   generated output said **2 open**, silently dropping the most consequential
   open item in the project. Fixed by giving the parser three states; the
   scorecard now reports `Still open 2` and `Open in part 1 — RWF-002`,
   with the "not an implementation task count" warning attached to that row.
2. **Three npm scripts were classified as offline and are not.**
   `test:coverage` and `test:integration` both run the live
   `osv-provider.integration.test.ts`. The fix derives the classification
   from each script's actual command text rather than from a hand-kept list
   of names, so a new script cannot be silently miscategorised.

### F7-F — the worked examples are generated, not typed

Three examples (`AFFECTED`, `NOT_AFFECTED`, `UNKNOWN`) in
`docs/SOUNDNESS-CONTRACT.md` § 7 are produced by scanning a real project
with the real analyzer through `foundation-corpus.ts`, validated against
`schemas/result.schema.json`, and byte-compared to the document. Only the
temp root, the scan's random UUID and elapsed milliseconds are normalized —
**instance paths survive verbatim**, because collapsing them is exactly how
an example would stop demonstrating the instance exactness it exists to
show.

The `NOT_AFFECTED` example is deliberately family C, not family A: family
A's premise is that nothing loads the package, which reads as "the tool
found nothing" to someone skimming. The family C example shows a package
that IS loaded and IS called, on its safe export, with a positive
unreachability proof naming the target and the entrypoint roots.

A first version of the generator embedded the scan's random UUID in the
committed example, which would have failed the drift check on the very next
run. Caught by running the check twice.

### F7-G — the link checker, and what it found

`scripts/check-docs.mjs` checks two things across the eight authoritative
documents: every `npm run <script>` exists, and every repository path
resolves. It deliberately does not lint prose or fetch external URLs (which
would make the check network-dependent, the exact property the Foundation
gate exists to avoid).

It found the phantom audit document immediately. It also, in its first
version, produced forty false positives by resolving repository paths
relative to the document's own directory and by demanding that
ILLUSTRATIVE paths (`pkg/other.js`, `qs/lib/index.js`) exist — both fixed,
and the second is why backticked paths are only checked when their first
segment is a real top-level or `src/` directory. A third version had to
strip fenced code blocks, because `return lib[name](x)` is a line of
JavaScript and reading it as a markdown link to a file called `x` is how a
link checker earns its reputation.

The phantom citations in `tests/validation/README.md` and
`docs/VALIDATION-STRATEGY.md` are **annotated in place** rather than
deleted. The ones in this file and in `fixtures/*/README.md` are **left
untouched**: they are records of what was true when written, and rewriting
a record to hide a broken pointer is worse than the pointer.

### Soundness: no production semantic movement

The acceptance condition (F7 § 43). **No file under `src/` changed except
one added test** (`src/testing/docs-contract.test.ts`). No analyzer file,
no schema, no rule, no fixture. Every verdict in the corpus is
byte-identical to the base, which is what the offline differential and the
live validation run below assert.

Validation suite after F7: **5 failed / 12 passed — identical IDs,
identical expected/actual pairs, identical counts to the baseline**, and
the regenerated `tests/validation/REPORT.md` is byte-identical to the
committed one, so the record it holds is confirmed current rather than
merely old.

### Foundation status

**Foundation (F1–F7) is COMPLETE.**

What it delivered: the uncertainty a verdict rests on is machine-readable
(F1, F3); every proof prerequisite fails closed and is proven load-bearing
by mutation (F2, F4); per-scan performance state exists and can never
become proof authority (F5); every invariant has a named, executed,
non-drifting owner (F6); and all of it is written down, generated and
checked (F7).

What it explicitly did **not** deliver: any of the eleven debts in
`docs/OPEN-DEBTS.md`. Foundation's job was to make the guarantees explicit,
owned and measurable — not total. The entry criteria for P1-B are stated
there, and they are met.

P1-B's first step is **not** to implement a construct. It is to split
`unsupported_construct` by syntactic and semantic shape, because that
single undifferentiated token is the entire top of the unmodeled-construct
ranking, and until it is split the evidence cannot choose the feature work.

### F7 REMEDIATION — the independent audit blocked on a misattributed mutation

The record above stands as written; this section is appended, not merged
into it. The independent audit of F7 returned **BLOCKED** on one required
finding, plus one recommended and one strongly-recommended item and four
minor ones. Still zero production files changed.

**The blocker (F-1): `ARCHITECTURE.md` § 9.1 attributed F6's Mutation C to
the wrong failure.** The section argued that conflating index refusal with
absence "would manufacture family-B proofs out of a cache miss" and then
cited Mutation C as the demonstration. F6 measured the opposite outcome.
Mutation C — the refusal fallback replaced with `return indexed ?? new
Map()` — produces an EMPTY map, which fails `resolveTargetNodes`'s
`instances.size > 0` test, skips Site A (the only site that knows the
premise of a family-B proof) and falls through to Site B's instance-blind
re-resolution. Measured: clean `NOT_AFFECTED`/family B, mutated **`UNKNOWN`
with no proof**. F6 classifies it as a *conservative precision regression*
that claims LESS and explicitly "does not fabricate a negative proof".

The fabrication warning belongs to **C′**, which F6 lists separately as
"stale index treated as authoritative": a stale but NON-EMPTY answer
passes `instances.size > 0` and can omit the very instance the graph did
traverse, so Site A concludes `confirmedAbsentInstance` for an instance
that was in fact reached — and that IS positive evidence.

§ 9.1 now documents C and C′ as two defects with opposite risk profiles,
with the measured verdict/proof table for C and the Site-A mechanism for
C′. The audit was right that collapsing them is how a reader ends up
believing the safe failure was the dangerous one. No other authoritative
document made the same conflation (searched).

**F-2 — family C's guard conditions were incomplete.**
`SOUNDNESS-CONTRACT.md` § 3 listed only `reachableSubgraphComplete`, while
`verdict.ts` enforces two further preconditions ahead of the proof:
`graphTruncated === false` (VT-202, `verdict.ts`'s truncation return) and
fully-derived entrypoint reachability roots (P0-Z,
`entrypoint_root_incomplete`). Both are now stated as preconditions
enforced by `buildFinding` rather than as evidence fields — which is what
they are — together with the explicit note that `graphTruncated === false`
is NOT a claim of call-graph completeness. The retired `callGraphComplete`
name appears nowhere.

**F-3 — the RWF status classifier could drop a row in silence.** The audit
mutation-tested it: rewording RWF-002's status from "…remains open" to
"…is still outstanding" put it in NO bucket, leaving 20 + 2 + 0 = 22
against 23 parsed rows, with no error. The drift check catches the CHANGE
but a regeneration would then bless a scorecard showing the project's most
consequential open finding as neither open nor partly open.

Classification is now **total**: an unrecognised status is a hard failure
naming the row id and its raw text, and a partition assertion requires
`open + partlyOpen + fixed === rows`. Deliberately not keyed on any RWF
id — RWF-002 classifies because its wording is recognised, not because it
is special-cased. Re-verified by mutation: the unrecognised wording now
fails both `generate-scorecard.mjs` and `--check` with

```
FINDINGS.md: the status of 1 register row(s) could not be classified as
open, open-in-part or fixed. ...
  RWF-002: "**Bypassed for unloaded packages (VT-307d)**; the underlying
  reachability-scoping tradeoff is still outstanding — see below"
```

and the restored register still reports 23 / 20 fixed / 2 open / 1
open-in-part.

**Minor items, batched.** (F-4) The uncertainty-distribution rows rendered
a date but no commit, so the OLDEST measurement in the file — `72a925b`,
taken at a different commit from every gate run — had the least checkable
provenance; they now carry the same command/commit/date shape as every
other measured row. (F-5) `OPEN-DEBTS.md` D-01 now records that
`analysis/analysis-context.ts`'s own prose still calls the context "ONE
immutable object", overstating what the constructor delivers, and that it
should be narrowed when that file is next touched — the instruction was
previously carried only in this record. (F-6) `SCORECARD.md` pointed at
"§ RWF-002", a heading that does not exist; it points at D-06. (F-7) D-10's
citation of the never-committed benchmark audit passed the link checker
only because it happened to be written WITHOUT backticks — an exception
that depends on prose formatting is an accident, not an exception, and
re-formatting the filename the obvious way would have reddened the suite
for a correct document. The path is now declared in `KNOWN_MISSING` with
its reason, the checker reports the count on every run, and it FAILS if the
file ever appears so the exception cannot outlive the problem. Verified in
both directions: emptying the exception makes the checker fail on D-10;
creating the file makes it fail as a stale exception.

The checker's scope is also now stated in its own header: file and path
references only, **anchors are not validated** (a `#fragment` is stripped
before the path is checked). The authoritative documents cite sections as
prose — "§ 9.1" — rather than as anchor links, which sidesteps that
limitation rather than solving it.

**Still zero production semantic movement.** The only file under `src/`
that F7 touches remains the added `src/testing/docs-contract.test.ts`, and
`tsconfig.build.json` excludes both `src/**/*.test.ts` and `src/testing/**`,
so the shipped artifact cannot be affected by it — 296 files, unchanged.

---

## RWF-041 (P1-B1 / P1-B2) — The frontend gap was measurable in aggregate and unactionable in detail, so P1-B had nothing to prioritize from

The first task of P1-B, and deliberately not a capability. It adds no
frontend support, resolves no additional call, moves no verdict anywhere in
either corpus, and closes no known failure. What it changes is what the
analyzer can *say* about the code it already fails to model.

Central rule being enforced: *a number that names no mechanism is not
evidence, and splitting a reason is never the same thing as closing a gap.*

### F7 handoff

Base: `094b4b9` (`docs: close the remaining F7 audit findings, and record
the remediation`), certified before editing — clean tree, identical to
`origin/main`, F7/RWF-040 present. Baseline at that commit, all green:

| gate | result |
| --- | --- |
| `npm run test:foundation` | 29 files / 1,356 tests, 45.98s |
| `npm test` | 169 files / 4,198 tests, 267.96s |
| `npm run test:adversarial` | 2 files / 124 tests, 55.02s |
| `npm run test:performance` | 1 file / 3 tests |
| `node scripts/measure-uncertainty.mjs` (LIVE) | reproduced `docs/SCORECARD.md` § 7 exactly: 42 frontend, 65 target-intelligence, 41 identity, 5 value |

### 1. The defect: one token, eight different jobs

`docs/SCORECARD.md` § 7 could say the real-world corpus contained **42
`unsupported_construct` occurrences** and nothing more. That number names
no syntax, no mechanism and no owner. It cannot distinguish "we do not
track what a local variable holds" from "we have no class-instance model"
from "we do not evaluate `a || b`" — three different pieces of work, with
three different owners and three different risk profiles, reported as one
bucket. `docs/OPEN-DEBTS.md` D-07 recorded this as the blocker on P1-B's
own prioritization; this record closes it.

The rule the decomposition had to respect is the one that makes the F3
taxonomy worth having at all: **the six UNCERTAINTY CATEGORIES ARE
UNCHANGED**. Nothing here is a seventh category. The new detail lives one
level below `unmodeled_construct`, at the reason level, and it explains an
`UNKNOWN` that the proof rules had already decided on their own.

### 2. Emitter inventory

Every production path that emits `unsupported_construct` was traced before
anything was edited. There are exactly **two**, and they are the same
construct twice:

| # | Site | Function | Shape available | Consumer | Category | Target relevance known here? |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `src/code-intelligence/call-graph.ts` (`classifyCall`, terminal fallback) | call expression | the callee `ts.Expression`, the whole `SourceFile`, the file's `ModuleModel` | `CallEdge.resolution.reason` → reachability blockers → `unknownReasons`, `evidence.reasons`, `diagnostics` | `unmodeled_construct` | **No.** The graph is built before any advisory target is resolved. |
| 2 | `src/code-intelligence/call-graph.ts` (`classifyNew`, terminal fallback) | `new` expression | same | same | `unmodeled_construct` | **No**, same reason. |

Both are reached only after every resolution path has already failed —
loader classification, `bindCallee`, re-export chasing, local function
lookup, known-global and builtin checks, VT-208 instance-method
type-checking, VT-210 higher-order flow, VT-214 aliasing, VT-213 inline
callbacks. That ordering is why the family is a *residue* rather than a
category: it is, by construction, whatever is left.

The fact that **target relevance is unknowable at both sites** is load
bearing for § 8 below. A subtype can never mean "this matters".

### 3. Raw shapes, measured before any name was chosen

Both emitters were temporarily instrumented (a throwaway probe, never
committed) to record the callee's `SyntaxKind`, its receiver chain, the
containing file and the source text, then run over both corpora:

- the 17-case real-world corpus (`tests/validation`, live OSV) — **2,351** occurrences;
- the 124-test adversarial corpora (`tests/adversarial` v1 + v2) — **11** occurrences.

**WHICH TOTAL IS USED WHERE, because the two are adjacent and easy to
confuse.** **2,362** is the RAW-SHAPE INVENTORY total: both corpora, used
in this section only, to justify the subtype vocabulary. It came from a
throwaway probe inside the two emitters and is therefore NOT re-derivable
from any committed script — the method is recorded here, the numbers are
not reproducible by running the repository. **2,351** is the GRAPH-WIDE
PRIORITIZATION total: the real-world corpus alone, and it IS reproducible,
by `node scripts/measure-frontend-gaps.mjs`. Every count in § 6, § 7, § 13
and the scorecard is the reproducible 2,351 figure; the 11-occurrence
difference is exactly the adversarial corpora, which are deliberately
excluded there because they are synthetic shape fixtures, not real
projects, and would distort a project-spread measurement.

**2,362 raw occurrences (2,351 + 11), 21 distinct raw `(emitter site,
calleeKind, receiver-root kind, chain depth)` shapes.** The adversarial
corpus contributes occurrences but introduces NO shape the real-world
corpus does not already have, which is why the distinct-shape count is 21
for either corpus alone and for the two combined.

Combined, every row exact:

| raw shape | n |
| --- | --- |
| `call` PropertyAccess, root Identifier, depth 1 | 1,110 |
| `call` Identifier, depth 0 | 547 |
| `call` PropertyAccess, root CallExpression, depth 1 | 177 |
| `call` PropertyAccess, root Identifier, depth 2 | 122 |
| `call` PropertyAccess, root `this`, depth 1 | 114 |
| `call` PropertyAccess, root `this`, depth 2 | 76 |
| `call` PropertyAccess, root RegExp literal, depth 1 | 47 |
| `new` Identifier, depth 0 | 28 |
| `call` FunctionExpression (IIFE), depth 0 | 24 |
| `call` PropertyAccess, root Parenthesized, depth 1 | 24 |
| `call` PropertyAccess, root NewExpression, depth 1 | 23 |
| `call` PropertyAccess, root ArrayLiteral, depth 1 | 20 |
| `call` ElementAccess, root Identifier, depth 1 | 18 |
| `call` CallExpression (`f()()`), depth 0 | 11 |
| `call` PropertyAccess, root `this`, depth 3 | 6 |
| `call` Parenthesized, depth 0 | 4 |
| `new` Parenthesized, depth 0 | 4 |
| `call` PropertyAccess, root FunctionExpression, depth 1 | 2 |
| `call` PropertyAccess, root StringLiteral, depth 1 | 2 |
| `call` PropertyAccess, root TemplateExpression, depth 1 | 2 |
| `call` PropertyAccess, root Identifier, depth 3 | 1 |
| **total** | **2,362** |

**Reconciliation.** Top 14 rows = 2,341; remaining 7 rows = 21; total
2,362 = 2,351 real-world + 11 adversarial. *Corrected after independent
audit* — the table as first published listed REAL-WORLD-ONLY counts under
the COMBINED total and gave an aggregated tail of 27, which matched
neither corpus (the real-world tail is 21, for a real-world total of
2,351). No classification, count or recommendation depended on the error;
see § 19.

The raw table is exactly why the vocabulary is **not** one reason per
`SyntaxKind`. Three readings decided the design:

1. `a.b()` and `a['b']()` are the *same* failure — `symbol-binder.ts`
   reads a string-literal key statically and fails on both identically.
   Separate `SyntaxKind`s, one gap.
2. `x.m()` and `this.m()` share a `SyntaxKind` and are *different*
   failures — one is a binding you could look up, the other has no binding
   to look up at all.
3. Parentheses, `!`, `as` and `satisfies` appeared as "shapes" purely
   because the probe did not unwrap them. They are spellings, not
   semantics.

### 4. The final vocabulary

The organizing question is always **where did the value being called come
from?** — never what the parser called the node.

| Subtype | Means | Example |
| --- | --- | --- |
| `unsupported_callee_binding` | a bare name attributable to no import, declaration, parameter, builtin or global | `isArray(x)`, `new Ctor(o)` |
| `unsupported_receiver_binding` | member call whose receiver is a name whose value was never traced | `stack.set(k, v)`, `stack['delete'](k)` |
| `unsupported_this_receiver` | member call on `this`/`super`; no class-instance receiver model | `this.parse(text)` |
| `unsupported_indexed_receiver` | the receiver came out of an index the binder cannot read | `funcs[index].apply(...)` |
| `unsupported_call_result_receiver` | the receiver is whatever a call returned | `makeRe().test(v)` |
| `unsupported_literal_receiver` | the receiver is constructed inline — value known, members not modelled | `/re/.exec(v)`, `[a, b].join('\|')` |
| `unsupported_expression_receiver` | the receiver is produced by an operator the analyzer does not evaluate | `(value \|\| '').trim()` |
| `unsupported_computed_callee` | the callee is not a name or member access at all | `(function () {})()`, `f()()` |
| `unsupported_construct` | **retained**, as the runtime floor | anything unmeasured or future |

Eight subtypes from 21 raw shapes. Each satisfies the design rules: it
describes an observable frontend condition, is derivable from the callee
alone, is deterministic, and implies nothing about relevance,
exploitability or any commitment to implement it.

**Deviation from the task's § 11, stated deliberately.** The task names the
fallback `unsupported_construct_other`. The fallback is instead the
existing `unsupported_construct` token. Introducing a new name would have
*removed* a value from a published schema enum, whereas retaining it keeps
the change strictly additive (§ 9) and keeps the floor's meaning exactly
what it always was. The requirement — an explicitly retained, reported,
justified fallback — is met; only the spelling differs.

### 5. Mapping rules, and the one precedence decision

Classification (`src/code-intelligence/unsupported-construct.ts`) unwraps
parentheses/`!`/`as`/`satisfies`, then peels every member step whose
property name is statically readable, then names whatever the receiver
turned out to be.

The only non-obvious rule is **precedence**, and it is stated as one
sentence so two readers cannot order it differently: *when a callee has
more than one unmodeled step, the step nearest the call wins.*
`this[LRU_LIST].toArray()` is an `unsupported_indexed_receiver`, not an
`unsupported_this_receiver` — modeling `this` alone would still not
attribute the value whose member is being called.

**Exhaustiveness is deliberately NOT compiler-enforced here**, unlike
`isClosureWideningReason`'s `never` floor. A `never` check would turn a
future TypeScript syntax addition into a build break; this function must
instead return the generic floor for anything it has not been taught, so a
new construct degrades to `UNKNOWN` rather than crashing a scan or — far
worse — resolving into a negative proof. Exhaustiveness *is* enforced in
the two places where it protects soundness: `DynamicCallReason` →
`isClosureWideningReason` (a `never` parameter) and `UncertaintyReason` →
`UNCERTAINTY_REASON_CATEGORY` (a total `Record`). Adding a subtype without
classifying it in both is a compile error naming the token.

### 6. The corpus distribution

Reproducible: `node scripts/measure-frontend-gaps.mjs`. Rendered into
`docs/SCORECARD.md` § 7.1 from `docs/scorecard-data/measurements.json`.

**Two counts per subtype, and confusing them is the whole trap.**
*Graph-wide* is every unresolved edge anywhere the builder walked, across
all 17 projects — the shape of real JavaScript, not a work queue.
*Blocking* is the subset a search for a real vulnerable target actually
traversed — the occurrences that cost a verdict.

| Subtype | Graph-wide | Blocking | Projects | Packages | Containing fns | Domain |
| --- | --- | --- | --- | --- | --- | --- |
| `unsupported_receiver_binding` | 1,185 | 10 | 16 | 25 | 612 | value-flow |
| `unsupported_callee_binding` | 571 | 28 | 11 | 21 | 352 | value-flow |
| `unsupported_this_receiver` | 190 | 0 | 5 | 5 | 88 | frontend syntax/modeling |
| `unsupported_call_result_receiver` | 176 | 0 | 13 | 12 | 127 | call graph |
| `unsupported_literal_receiver` | 98 | 0 | 13 | 13 | 61 | frontend syntax/modeling |
| `unsupported_indexed_receiver` | 68 | 0 | 12 | 11 | 57 | value-flow |
| `unsupported_computed_callee` | 42 | 4 | 10 | 11 | 26 | call graph |
| `unsupported_expression_receiver` | 21 | 0 | 10 | 9 | 16 | value-flow |
| `unsupported_construct` (floor) | **0** | **0** | 0 | 0 | 0 | — |
| **total** | **2,351** | **42** | | | | |

**Mapping coverage is complete.** Every measured occurrence carries a
specific subtype; the retained floor's count is **zero** in both corpora.
The floor is kept anyway — see § 5 — and is proven reachable by a focused
test (`super()`, a shape no corpus occurrence exercised and which therefore
deliberately got no subtype of its own).

**Before/after reconciliation:**

```
BEFORE   unsupported_construct .............. 42
AFTER    unsupported_callee_binding ......... 28
         unsupported_receiver_binding ....... 10
         unsupported_computed_callee ........  4
         unsupported_construct (floor) ......  0
                                             ---
                                              42
```

Every other reason count in the corpus is unchanged: 65
`no_vulnerable_symbol_rule`, 37 `unresolved_target`, 5
`dynamic_member_access`, 4 `vulnerable_target_unresolved`. 85 findings, 70
`UNKNOWN`. **The UNKNOWN count did not move, and it was not supposed to.**

### 7. Concentration, and the trap in it

Graph-wide: top-1 share **50.4%** (`unsupported_receiver_binding`), top-3
**82.8%**, long tail (5 subtypes) **17.2%**. Blocking: top-1 **66.7%**
(`unsupported_callee_binding`), top-2 **90.5%**.

**The two columns rank the subtypes differently, and that disagreement is
the most useful thing in the measurement.** The most common construct in
real JavaScript is not the one that most often costs a verdict.

Project concentration cuts the other way for each:
`unsupported_receiver_binding` appears in **16 of 17** projects and **25**
packages — it is a property of JavaScript, not of one library.
`unsupported_this_receiver`, third by graph-wide count, appears in only
**5** projects and **5** packages (`fast-xml-parser`, `lodash`, `semver`,
`semver-vulnerable`, `yallist`) — class-heavy libraries. Ranking it third
on occurrences alone would have been exactly the § 23 mistake.

**Occurrences are not distinct gaps — and the unit here is the CONTAINING
FUNCTION, not the call site.** A call-graph diagnostic names the graph node
an unresolved edge departs *from*, i.e. the enclosing function, so one node
carries one entry per unresolved call inside it. The number of distinct
call sites is not recoverable from this data and is claimed nowhere.

2,351 occurrences arise in **1,339 distinct subtype-and-containing-function
pairs** (the sum of the column above; a function carrying two different
subtypes counts once per subtype, so this is an upper bound on the number
of distinct functions, not a count of them). The 42 blocking occurrences
arise in just **14 containing functions** — 19 subtype-and-function pairs —
with 17 of them inside the single function
`qs/lib/stringify.js#stringify@58:17`, 13 of those one subtype.

*The unit was labelled "site" when first published; corrected after
independent audit. The values did not change.*

### 8. Target relevance, sampled honestly

All 42 blocking occurrences come from **one case**, RWB-05, across five
packages (`qs` 27, `get-intrinsic` 12, `object-inspect` 1, `call-bound` 1,
`es-define-property` 1).

Reading the actual sites: they lie in `qs`'s **`stringify`** path and in
the `get-intrinsic`/`call-bound` intrinsic-lookup helpers it pulls in. The
vulnerable target for `GHSA-hrpp-h998-j3pp` is in `qs`'s **`parse`** path.

- *clearly irrelevant to the target*: **none provable** — the current
  architecture cannot prove a blocker irrelevant, which is RWF-002 itself.
- *likely on a target-relevant path*: **none**. Nothing in the sample is on
  the `parse` path.
- *unknown relevance*: **all 42**.

They block the verdict today only because the family-C exhaustive-search
proof is unscoped: any unresolved edge in the reachable subgraph forces
`UNKNOWN`. **So the one target-relevant sample available is a case where
frontend modeling may be the wrong lever entirely** — RWF-002 reachability
scoping could discharge all 42 without modeling a single construct.

This is recorded, not resolved. **RWF-002 remains open**, and its
occurrence data is used here for measurement only.

### 9. What moved in production, and what did not

Production change is confined to making the decomposition observable:

- `src/code-intelligence/unsupported-construct.ts` — new, the classifier.
- `src/code-intelligence/call-graph.ts` — the two fallbacks call it.
  Nothing else: same edge, same `type`, same `from`, same location, same
  `unknown` resolution.
- `src/domain/graph.ts` — eight tokens added to `DynamicCallReason`, each
  classified **non-widening**, exactly as the token they refine.
- `src/domain/uncertainty.ts` — eight tokens added, each classified
  **`unmodeled_construct`**, exactly as the token they refine.
- `schemas/result.schema.json` — both reason enums extended.

**Schema compatibility is additive.** No value was removed and no value
changed meaning. All nine share `unmodeled_construct`, so a consumer
aggregating by category is unaffected. A consumer matching the literal
string `unsupported_construct` will see fewer of them; the schema
description now says so and tells such a consumer to match the
`unsupported_` prefix or aggregate by category instead.

### 10. Differential: base vs branch, whole real-world corpus

Both builds were run over identical copies of all 17 fixtures and compared
field by field (`scan`, `coverage`, `diagnostics`, `unreportedCandidates`,
and every field of every finding).

**Disallowed differences: 0.** Identical across all 17 cases: finding
count, vulnerability identity, package, **version**, **`packageInstance`**,
target, **verdict**, confidence, evidence path,
`confirmedAbsentFromModuleLoadClosure`, `confirmedAbsentInstance`,
`unreportedCandidates` disposition and reason, coverage, and the provider
query set.

**No new `NOT_AFFECTED`. No new `AFFECTED`.** Verdicts are byte-identical.

Intended deltas, and only these:

- **`unknownReasons`**, on exactly one finding (RWB-05 / `qs@6.10.1` /
  `node_modules/qs`), reconciling 84 → 84 occurrences.
- **`diagnostics`**, 2,351 entries relabelled. Verified element by element:
  same count, same order, same `source`, and **same site** — only the
  leading reason token differs, and only from `unsupported_construct` to an
  `unsupported_*` subtype.
- `evidence.reasons`, same count, same sites, same token change.

### 11. Mutation checks

**Ownership (§ 41).** Re-pointing `unsupported_receiver_binding`'s branch
at `unsupported_this_receiver` fails **5** focused tests. The vocabulary is
genuinely gated; no test passes merely because the category is right.

**Observational-only (§ 42).** Re-pointing the same branch at the generic
`unsupported_construct` floor changes the reason detail as expected (10
occurrences move to the floor in RWB-05) and produces **0 disallowed
differences** in the full differential — verdicts, proofs, evidence,
targets, `packageInstance` and provider queries all still identical to
base, and the totals still reconcile at 84. A subtype can be moved
anywhere inside the family without moving anything a consumer decides on.
That is the proof that this is a reporting change.

### 12. Overlap with `DynamicCallReason`, deliberately not absorbed

`dynamic_member_access` already names a precise construct: a dynamic
property **in callee position** (`obj[key]()`). `symbol-binder.ts` emits it
before the fallback is reached, it stays `value_uncertainty`, and this work
does not touch it — proven by a focused test.

The near neighbour is `unsupported_indexed_receiver`, where the dynamic
index produced the **receiver** and the call itself is an ordinary named
member access (`funcs[index].apply()`). These 68 occurrences were *not*
re-routed onto the existing token, on purpose: re-routing would move them
to a different uncertainty **category**, which would stop the before/after
totals reconciling and would be a semantic change, not the observability
change this task is scoped to. Whether they *should* be re-routed is a
real question and is left open rather than answered silently here.

### 13. Candidate capability blocks (P1-B2)

Grouped by shared mechanism, shared code path and shared fail-closed
boundary — not by popularity.

| Block | Subtypes | Graph-wide | Blocking | Mechanism |
| --- | --- | --- | --- | --- |
| **A — named binding attribution** | `callee_binding`, `receiver_binding` | 1,756 (74.7%) | 38 (90.5%) | resolve a NAME (callee or receiver) to the value it was bound to |
| **B — receiver provenance from expressions** | `call_result_receiver`, `literal_receiver`, `indexed_receiver`, `expression_receiver` | 363 (15.4%) | 0 | evaluate a receiver EXPRESSION to a value |
| **C — receiver/`this` modeling** (candidate, see § 15) | `this_receiver` | 190 (8.1%) | 0 | recover the receiver a method body runs against — **spans ≥2 receiver models; not one mechanism** |
| **D — computed callee** | `computed_callee` | 42 (1.8%) | 4 | the callee is an expression, not a name |

Blocks B and C are both weaker than this table's single rows suggest.
Block B is the weakest: its four subtypes share a *position*
but not a mechanism (interprocedural returns, builtin prototypes, index
evaluation and operator folding are four different jobs). It is listed as
one candidate because a reader will otherwise assemble it themselves; it
should be split before anyone implements it. Block C is one *token* but not
one *mechanism* — § 15 breaks its 190 into bundle, prototype and class
receiver shapes, and it too needs splitting before implementation.

### 14. Recommended block #1 — A, named binding attribution

**Evidence.** The only recommendation both measurements agree on. Block A
is **74.7%** of graph-wide occurrences and **90.5%** of blocking ones; it
appears in **16 of 17** projects and **25** packages, so it is not one
library's idiom; and its two subtypes share their *first* step — attributing
a name to the value it was bound to — through the same machinery:
`analyzeCalleeShape` reads the root identifier and property chain for both
positions in one function, and `resolveLocalAlias` already attempts both
(`const doIt = vulnerable; doIt()` and `const o = { run: vulnerable };
o.run()`).

**They are not symmetric, and the original wording overstated it.**
`unsupported_callee_binding` needs binding resolution alone: resolve the
name, and the callable is in hand. `unsupported_receiver_binding` needs
binding resolution *plus a member lookup on the resolved value*, which is a
second step with its own failure modes. They belong in one block because
they share the machinery and the soundness boundary, not because the work
is identical.

**Architectural hotspots** (recorded, deliberately not refactored):
`bindCallee`/`analyzeCalleeShape` (`src/code-intelligence/symbol-binder.ts`),
and in `src/code-intelligence/call-graph.ts` the existing partial machinery
this gap is the documented fallback of — `resolveLocalAlias` (VT-214),
`resolveHigherOrderCallTarget` (VT-210), `resolveInlineCallbackArgument`
(VT-213), `findLocalFunctionNodeId`, plus `resolveSingleAssignmentValue`
(`src/code-intelligence/local-aliases.ts`). The dominant real shape is the module-scope capture —
`var isArray = Array.isArray; … isArray(x)` and the
`callBound('Array.prototype.join')` idiom — which today falls through every
one of those.

**Expected uncertainty reduction: unknown, and deliberately not
estimated.** Occurrences are not work items and blockers are not tasks.
The honest statement is that Block A is where the *evidence* concentrates,
not that closing it removes 1,756 UNKNOWNs — and the RWB-05 reading in § 8
is a live warning that scoping, not modeling, may be what discharges the
blocking ones.

**Soundness risks, in priority order.** Every one of these is a risk of
*fabricating a resolved edge*, which is the only kind of mistake that can
manufacture a false `NOT_AFFECTED`:

1. **Reassignment.** A binding traced to one value that is later reassigned
   must not resolve. `let`/`var` and any captured binding assigned more
   than once must stay `UNKNOWN` (VT-214 already draws this line for `const`
   and must not be widened casually).
2. **Shadowing.** An inner binding with the same name is a different value.
3. **Conditional initialization.** `var f = a ? g : h` is two values; one
   must not be picked.
4. **Cross-module capture.** A name bound to an imported value must go
   through the existing resolution path, not a new parallel one.
5. **Non-widening must be preserved.** If a newly-resolvable binding can
   name a *module*, it is a loader construct and belongs to
   `loader-constructs.ts`, not here.

### 15. Block #2 CANDIDATE — C, receiver/`this` modeling (exploration, not yet an implementation block)

**This section was rewritten after independent audit.** It originally
called C "the largest single coherent mechanism". That claim was **not
supported by its own data** and has been withdrawn. What follows is what
the measurement actually shows.

**The counts.** 190 graph-wide occurrences, 88 distinct containing
functions, **5 of 17** projects, 5 packages, and **0 blocking occurrences**
— it costs no verdict in this corpus today.

**Concentration (reproducible: `node scripts/measure-frontend-gaps.mjs`,
`topLibraryFiles`).** Keyed on the library file rather than the install
path, because `lodash` is installed by two fixtures and keying on the
absolute path would halve its contribution:

| library file | occurrences | share |
| --- | --- | --- |
| `node_modules/fast-xml-parser/lib/fxp.cjs` | 86 | 45.3% |
| `node_modules/lodash/lodash.js` | 62 | 32.6% |
| `node_modules/semver-vulnerable/classes/comparator.js` | 12 | 6.3% |
| rest (semver/yallist, 12 files) | 30 | 15.8% |

**Top file 45.3%, top two files 77.9%.** That is heavier concentration
than any subtype in Block A, and the project/package spread (5/5) hides it
entirely — which is exactly the § 23 trap this record warns about
elsewhere and failed to apply to its own second recommendation.

**At least two different receiver models, possibly three.** `this` is one
keyword standing for several unrelated modeling problems:

- **86 — `fast-xml-parser/lib/fxp.cjs`**: a webpack-style bundled CJS file.
  Its receivers are entangled with **RWF-006** (*"a webpack-bundled,
  `Object.defineProperty`-getter-defined class export isn't recognized as a
  constructible/method-bearing target"*), which is an **open finding in
  this same register**. These 86 must NOT be counted as evidence for a
  simple `this` capability: some or all of them may be discharged by, or
  blocked on, RWF-006's own bundle-shape work. Which, is unmeasured.
- **62 — `lodash/lodash.js`**: prototype/UMD-style receivers, where methods
  are attached by assignment (`LodashWrapper.prototype.x = …`) rather than
  declared in a class body. Recovering the receiver here is prototype
  reconstruction, not class-instance resolution.
- **~40 — `semver`/`semver-vulnerable`/`yallist`**: genuine ES class
  instance methods, the case VT-208/VT-216 already resolve for *named*
  receivers and do not cover for `this`. This is the only slice for which
  "extend the existing instance-method resolution to `this`" is an accurate
  description of the work.

**Therefore C is a CANDIDATE EXPLORATION BLOCK, not a validated
implementation block.** Implementation coherence is **not proven**; on
present evidence it is unlikely to be one change. Before any B4
implementation, the 190 should be split into bundle-shape, prototype-shape
and class-shape receivers and each sized separately — a short analysis
task, not a capability.

**And C is not obviously the right #2 even then.** Block B has more
occurrences (363) and wider spread (13 projects) but is not one mechanism;
if B is split, its `call_result_receiver` half (176, 13 projects, 12
packages, far flatter concentration) is a legitimate rival for the slot.
With zero blocking occurrences on either side, that choice should be
re-made against a corpus that has more than one blocking case, not settled
here.

### 16. Parallelization judgment — SEQUENTIAL

Blocks A and C **should not be implemented in parallel.** The
independence was looked for and is not there:

- **Shared code path.** Both land in the same fallback ladder in
  `classifyCall`. A and C both insert resolution attempts into it, and the
  ladder's ORDER is semantically load-bearing (VT-305's builtin check is
  explicitly ordered after VT-213 for a reason recorded in its own comment).
  Two concurrent edits to that ordering cannot be reviewed independently.
- **Shared resolver.** C's natural implementation extends
  `resolveInstanceMethod`, which is reached only after A's paths fail;
  changing which calls A resolves changes which calls C ever sees.
- **Shared differential.** Both change the edge set of the same corpus.
  Merged concurrently, a verdict change could not be attributed to either
  one, and verdict changes are exactly what must be attributable.
- **Shared fixtures.** Both would extend `call-graph.test.ts`'s fallback
  cases, which are now pinned to specific subtypes.

Default was sequential; nothing displaced it.

**The order, stated explicitly rather than left to be inferred:**

| step | content | status |
| --- | --- | --- |
| **P1-B3** | **Block A — named binding resolution** (`unsupported_callee_binding` + `unsupported_receiver_binding`) | recommended, evidence-backed, ready to scope |
| **P1-B4** | **Block C candidate — receiver/`this` modeling** | **not ready**: needs the bundle/prototype/class split in § 15 first |

B3 comes first. B4 is a candidate, and its own pre-implementation
decomposition is a prerequisite, not part of it. Nothing here authorizes
starting either.

### 17. What this task explicitly did not do

- **Coverage is unchanged.** Not one additional call resolves. The corpus's
  UNKNOWN count is identical, and if it had dropped that would have been a
  defect in this work, not a win.
- **RWF-002 remains open**, untouched, and is the single largest caveat on
  the blocking column.
- No framework callbacks, no new built-in modeling, no negative-proof
  change, no relaxation of `UNKNOWN`.
- The `unsupported_` family is still, by construction, the *residue* of the
  resolution ladder. A subtype is a better name for a residue, not a
  smaller one.

### 18. Limitations

1. **The blocking column has a sample size of one project.** Recorded as
   `docs/OPEN-DEBTS.md` D-12. It closes by adding corpus cases whose
   vulnerable target is genuinely behind a frontend gap, not by re-reading
   these numbers.
2. **Graph-wide counts over-weight large dependencies.** `lodash` alone is
   1,106 of the 2,351. The containing-function and project columns are
   given for exactly this reason and should be read first — and, as § 15
   shows, project spread alone can still hide severe file concentration.
3. **The remediation-domain tags in § 6 are judgments, not measurements.**
   They are reporting metadata and no rule reads them.
4. **`unsupported_indexed_receiver`'s relationship to
   `dynamic_member_access` is unresolved** — see § 12.
5. **`unsupported_literal_receiver` groups two arguably different jobs.**
   `/re/.test(v)` needs builtin-prototype knowledge; `new Parser().parse(v)`
   (23 of the 98) needs class-member resolution, which is VT-208's
   territory. They are grouped because both are "the value is known right
   here and its members are not modelled" — a provenance-free lookup, not a
   tracing problem — but this is a judgment, and if Block B is ever split
   the `new`-rooted half may belong with block C instead.
6. **The measurement is live.** It queries the real OSV API, so a rerun can
   differ because the advisory database moved rather than because this
   repository changed.
7. **The raw-shape inventory in § 3 is not reproducible from this
   repository.** It came from a throwaway probe inside the two emitters;
   the method is recorded, the numbers are not re-derivable by running any
   committed script. Everything in § 6 onward is reproducible
   (`scripts/measure-frontend-gaps.mjs`).

### 20. Audit remediation (post-`9ec4631`)

An independent audit of this record accepted the engineering and rejected
the record. **No production code, classification rule, schema value or
measured number changed** in the remediation; the differential against base
is still zero and the totals are still 2,351 graph-wide / 42 blocking / 0
on the generic floor, re-run after every edit below. What changed is what
this document claims:

1. **§ 3 arithmetic (F1).** The ranked raw-shape table listed real-world
   -only row counts under the combined 2,362 total, with an aggregated tail
   of 27 that matched neither corpus. Recomputed from the recorded probe
   data: the table is now the combined corpus, every row exact, tail 21,
   summing to 2,362, with the reconciliation stated.
2. **Corpus totals (§ 3).** 2,362 (raw inventory, both corpora, not
   reproducible) versus 2,351 (graph-wide prioritization, real-world only,
   reproducible) are now explicitly separated, with which total is used
   where.
3. **Unit correction (F2).** What this record and the scorecard called a
   "site" is the CONTAINING FUNCTION the unresolved edge departs from, not
   a call site — one function carries many occurrences. Renamed here, in
   `docs/SCORECARD.md` § 7.1, in `measurements.json`
   (`distinctContainingFunctions`) and in `scripts/measure-frontend-gaps.mjs`.
   Values unchanged. The distinct-call-site count is not recoverable from
   this data and is now claimed nowhere.
4. **Hotspot path (F3).** `resolveSingleAssignmentValue` was cited in
   `local-values.ts`, a file that does not exist. It is
   `src/code-intelligence/local-aliases.ts`. Every other Block A owner was
   re-verified against source at the same time; all eight exist as cited.
   (The audit's own suggestion of `symbol-binder.ts` was also wrong — the
   path was taken from the source, not from either report.)
5. **Block C rationale (F4).** The claim that C is "the largest single
   coherent mechanism" is **withdrawn**. Measured: 45.3% of its 190 sit in
   one webpack-bundled file entangled with the open **RWF-006**, 32.6% are
   prototype/UMD receivers in `lodash.js`, and only ~40 are the ES-class
   case the existing VT-208/216 machinery would extend to. C is now a
   CANDIDATE requiring a bundle/prototype/class split before any B4
   implementation, and `scripts/measure-frontend-gaps.mjs` now reports
   `topLibraryFiles` so that concentration is recomputable rather than
   transcribed.
6. **Block A symmetry (F5).** "Differing only in whether the name sits in
   callee or receiver position" overstated the symmetry: the receiver case
   additionally needs a member lookup on the resolved value. Narrowed.
   Block A's rank is **unchanged** — the audit independently reproduced its
   evidence.
7. **B3/B4 order (§ 16).** Previously inferable only from section
   headings; now stated as an explicit table. B3 = Block A. B4 = Block C
   candidate, gated on its own decomposition.

The original report was wrong about these seven things and this section
says so rather than presenting the corrected text as what was always
written.

---

## RWF-042 (P1-B3) — Named bindings were resolved by spelling, not by scope, so an inner declaration could be answered with an outer declaration's value

The first P1-B capability block, and the first one chosen from measured
evidence rather than intuition (RWF-041 § 16 ranked Block A —
`unsupported_callee_binding` + `unsupported_receiver_binding` — first).

It is two pieces of work that turned out to be the same piece of work.
Block A's *gap* is that too few named bindings resolve. Block A's *defect*,
found while building the gap's fix, is that the bindings which already
resolved were resolved **by name**: whole-file, first-match-wins, with no
notion of scope and no notion of evaluation order. Widening a lookup that
cannot see shadowing would have widened the wrong thing.

Central rule being enforced: *a name is not a binding. Resolving one
without the other fabricates edges, and a fabricated edge is the only
error class that ends in a wrong verdict rather than an honest UNKNOWN.*

### P1-B1/B2 handoff

Base: `ef07321` (`docs: correct the P1-B measurement record after
independent audit`), certified before editing — clean tree, identical to
`origin/main`, RWF-041 present. Baseline at that commit, all green:

| gate | result |
| --- | --- |
| `npm run test:foundation` | 29 files / 1,356 tests |
| `npm test` | 170 files / 4,221 tests |
| `npm run test:adversarial` | 2 files / 124 tests |
| `npm run test:performance` | 1 file / 3 tests |
| `node scripts/measure-frontend-gaps.mjs` (LIVE) | reproduced `docs/SCORECARD.md` § 7.1 **exactly**: 2,351 graph-wide, 42 blocking, 0 on the generic floor |

### 1. Block A baseline, re-measured (not taken from RWF-041)

| Block A subtype | Graph-wide | Blocking | Projects | Packages | Containing fns |
| --- | --- | --- | --- | --- | --- |
| `unsupported_receiver_binding` | 1,185 | 10 | 16 | 25 | 612 |
| `unsupported_callee_binding` | 571 | 28 | 11 | 21 | 352 |
| **Block A total** | **1,756** | **38** | — | — | — |

The remaining 4 of the corpus's 42 blockers are
`unsupported_computed_callee`, which is not Block A.

### 2. Semantic failure-mode inventory

RWF-041 counted occurrences by SYNTAX. That cannot say which resolution
STAGE failed, so every Block A occurrence was re-classified by running the
real analyzer with a temporary probe at the fallback edge, recording each
call site's callee text, and re-resolving its root name against a
scope-correct model of the file. 1,554 distinct occurrences were
classifiable (the remainder are duplicate scans of the same library file):

| Failure mode | Count | Stage | Example |
| --- | --- | --- | --- |
| Parameter — value arrives from every call site | 502 | D (higher-order) | `func.call(...)` inside `function apply(func, ...)` |
| Authoritative binding, value is a member of an ambient global | 309 | G (value shape) | `var funcToString = Function.prototype.toString;` |
| Use written above its own initializer | 139 | E/I (order) | `isArray(...)` above `var isArray = Array.isArray;` |
| Authoritative binding, value is a call result | 101 | G → Block B | `var nativeKeys = overArg(...)` |
| Authoritative binding, value is an operator expression | 88 | G → Block B | `var x = cond ? a : b;` |
| Reassigned in its own scope | 115 | H (stability) | `var source = ...; source = ...;` |
| Authoritative binding, value is a literal/array/regex | 107 | G → Block B | `var reIsUint = /^(?:0\|[1-9]\d*)$/;` |
| Declared without an initializer | 34 | C | `var result; result.push(...)` |
| Authoritative binding, value is `new X()` | 20 | G → Block C | `const parser = new XMLParser();` |
| Authoritative binding, value is another NAME | 6 | B (alias) | `var freeParseInt = parseInt;` |
| **Authoritative binding, value is a function expression** | **2** | **B/G — the resolvable one** | `var parseValues = function parseQueryStringValues() {...}` |
| Ambiguous / unbound / other | ~131 | A/I | — |

**The inventory is the finding.** Block A is not one gap. Roughly a third
of it is higher-order parameter flow, which P1-B3 § 12 holds out of scope;
most of the rest is a binding that resolves perfectly well onto a VALUE
whose content belongs to Block B or Block C. The part that is genuinely a
named-binding gap — a name bound to a callable this file already contains
— is **small**, and saying so is more useful than a percentage.

### 2a. Why the one small row matters anyway

`source-index.ts`'s `extractFunction` names a function expression by its
OWN name when it has one. So

```js
var parseValues = function parseQueryStringValues(str, options) { ... };
```

is indexed as `parseQueryStringValues`, and `findLocalFunctionNodeId`'s
name match against `parseValues` misses it entirely. In real `qs`, both
`parseValues` and `parseKeys` are written this way, and both are called
from `module.exports = function (str, opts)` — the route into that
package's entire parse implementation.

### 3. The defect: resolution by spelling

`resolveSingleAssignmentValue` (local-aliases.ts) answers *"is there a
`const <name> = ...` anywhere in this file?"* — whole-file, name-only,
first-match-wins. The call graph's alias paths used it as though it
answered *"what does this reference bind to?"*. It does not, and the gap
between the two questions is observable:

| Construct | Behavior on `ef07321` | Correct |
| --- | --- | --- |
| `const fn = danger;` at module scope, `const fn = safe;` inside a function, `fn()` in that function | resolved to **`danger`** | `safe` |
| `function main() { fn(); }` written ABOVE `const fn = danger;` | resolved to **`danger`** | unresolved (temporal dead zone) |

Both FABRICATE an edge. Neither was caught by the corpus, because neither
shape occurs in it — which is exactly why they are recorded here rather
than treated as theoretical: the corpus is not a proof of absence.

### 4. What was built

`src/code-intelligence/named-bindings.ts` — one resolver, one soundness
rule, stated once:

> A name resolves only when a unique declaration owns it in the innermost
> scope that declares it, that declaration carries exactly one value,
> nothing ever assigns to the name again, and the reference is evaluated
> after that value exists.

Each refusal carries its own cause (`no_declaration`,
`ambiguous_declarations`, `parameter`, `import_binding`, `destructuring`,
`no_initializer`, `reassigned`, `used_before_initialized`, `alias_cycle`,
`alias_chain_too_long`), so the call graph can fall through to the
machinery that owns a case instead of guessing at it.

**Scope model.** `var`/`function` belong to the nearest enclosing FUNCTION
scope; `let`/`const`/`class`/parameters are confined to their BLOCK scope;
imports belong to the source file; a named function expression binds its
own name only inside itself. The first scope walking outward that owns any
declaration is the binding scope — an outer declaration is never consulted
once an inner one exists, and two declarations in that one scope are an
ambiguity, not a tie to break.

**Assignment stability.** The whole owning scope is searched for any write
to the name — `=`, every compound assignment, `++`/`--`, `for...of`/`in`
targets, and destructuring assignment targets. The search is deliberately
OVER-approximate: it counts a write to a same-named binding that shadows
this one in a nested scope. That costs resolutions and can never invent
one. The opposite bias is how RWF-013/013b happened.

**Evaluation order.** A value binding resolves only when the reference
starts at or after its initializer ends. Function DECLARATIONS are exempt
and take a separate result kind, because hoisting is complete before any
statement in the scope runs.

**Alias chains.** Followed one hop at a time through the same resolution,
so every hop gets the same guarantees, with visited declarations recorded
so `a = b; b = a;` fails closed. Bounded at 8 hops.

### 5. Callee and receiver stay separate (§ 5)

They are not one path, because what each must prove differs. A callee
needs one authoritative callable. A receiver needs an authoritative value
**and** an authoritative member on it — and a resolved receiver whose
member cannot be read authoritatively resolves to nothing at all, never to
"call something on this value".

Supported callee forms: a name bound to a local `function` declaration; a
name bound to a function or arrow EXPRESSION (including a named one under
a different binding name — § 2a); a name bound to another resolvable
reference, handed to the existing import machinery; a destructured name,
handed to the existing destructuring path; any of these through an alias
chain.

Supported receiver forms: a name bound to an object literal, whose named
property is read directly; a name bound to a reference (identifier or
member chain), where appending the member reconstructs an ordinary named
access — which is what makes `const x = obj; x.m()` behave exactly as
`obj.m()` does; either through an alias chain.

### 6. Block boundaries held (§ 13, § 14, § 16, § 17)

Nothing became resolvable merely because its root name did. A call-result
receiver (`const x = factory(); x.m()`) stays Block B; a constructed
receiver (`const x = new Thing(); x.m()`) stays Block C; literals, regexes,
arrays and operator expressions stay on their own Block B reasons;
`obj[key]()` stays `dynamic_member_access` and `obj[key].m()` stays
`unsupported_indexed_receiver`; `this.m()` stays
`unsupported_this_receiver`. Each is pinned by a test that asserts the
REASON, not merely that nothing resolved.

**Reason migration: zero.** Every non-Block-A subtype's count is
byte-identical before and after (§ 8), so the Block A reduction is
resolution, not relabelling.

### 7. The fabricated edge the differential caught

The first working build resolved **4** more calls. Three were the intended
qs/lodash shapes. The fourth was wrong.

`lodash.js` line 413, at module scope:

```js
var freeParseInt = parseInt;      // the AMBIENT GLOBAL
```

and, 14,000 lines later, *inside* `runInContext`:

```js
function parseInt(string, radix, guard) { ... }   // lodash's own, unrelated
```

The alias chain resolved `freeParseInt` to the bare name `parseInt`, found
no declaration for it in that file, and handed the name onward anyway —
where a name-only match paired it with lodash's own `parseInt` and
attributed `toNumber`'s call to the wrong function entirely.

It surfaced only as `callsResolved` rising by one in two cases, with no
verdict to make it visible. The resolver now propagates a refusal instead
of handing a name onward, except when the refusal means another resolver
owns the name (`import_binding`, `destructuring`). Pinned by a test built
from the real lodash shape.

**This is the argument for the differential.** A capability task that
measured only its own wins would have shipped it.

### 8. Measured result — honest, and small

| Metric | Base `ef07321` | P1-B3 | Δ |
| --- | --- | --- | --- |
| `unsupported_callee_binding` (graph-wide) | 571 | 569 | **−2** |
| `unsupported_receiver_binding` (graph-wide) | 1,185 | 1,185 | 0 |
| **Block A total** | **1,756** | **1,754** | **−2** |
| Block A blocking a verdict | 38 | 38 | 0 |
| All frontend gaps (graph-wide) | 2,351 | 2,349 | −2 |
| Generic `unsupported_construct` floor | 0 | 0 | 0 |
| Every other subtype | — | — | **all 0** |

**Split as § 21 requires:** 2 resolved to modeled graph behavior, 0 moved
to another UNKNOWN reason, 1,754 still unresolved.

### 9. Graph differential — every new edge, named

One case in seventeen changes. Nothing else in the corpus moves at all.

| Case | `callsResolved` | `callsDynamic` | Total edges |
| --- | --- | --- | --- |
| RWB-05 | 229 → **231** | 264 → **262** | unchanged |

Both new edges leave `qs/lib/parse.js#<anonymous>@239:18` — the
`module.exports = function (str, opts)` region — and are the calls to
`parseValues` (line 246) and `parseKeys` (line 254), each a `var` bound to
a named function expression whose own name differs from the binding's.
Provenance: § 2a.

**Edges removed: none.** Total edge count is unchanged in every case; the
two moved from `unknown` to `resolved`. No unexpected removal to
investigate.

The two soundness fixes (shadowing, order) removed no corpus edge, because
neither shape occurs in the corpus. They are proven by unit test, not by
the differential, and § 3 says so rather than claiming corpus evidence
this task does not have.

### 10. Verdict and proof differential

Compared field by field across all 17 deterministic cases: finding count,
vulnerability, package, version, `packageInstance`, `target`, `verdict`,
`confidence`, `evidence.path`, `evidence.reasons`, `negativeProof`,
`unknownReasons`, `unreportedCandidates`, `coverage`.

| Delta class | Count |
| --- | --- |
| Verdict changes | **0** |
| Confidence changes | **0** |
| `negativeProof` changes | **0** |
| New `AFFECTED` | **0** |
| New `NOT_AFFECTED` | **0** |
| `packageInstance` / `target` changes | **0** |
| `unreportedCandidates` changes | **0** |
| `coverage` changes | 1 case (RWB-05), § 9 |

No proof family (A/B/C) is entered, left or altered anywhere in the
corpus. There is no proof-delta table below because there are no proof
deltas — which is the expected shape for a change that only ever converts
an UNKNOWN edge into a resolved one on a path no negative proof depends on.

### 11. Blocker and target-relevance analysis (§ 23)

Blockers: **38 → 38**. No benchmark blocker was reduced, so there is
nothing to classify as target-relevant or irrelevant, and nothing is
claimed.

Why, specifically: RWB-05's Block A blockers concentrate in
`qs/lib/stringify.js` (25 of 38) and `get-intrinsic` (10), not in
`parse.js`. Of the 17 in `stringify@58:17` alone, the dominant shape is a
PARAMETER — `sideChannel.has(...)`, `filter(...)`, `serializeDate(...)`,
`encoder(...)`, `formatter(...)` — which is higher-order value propagation
(§ 12, out of scope), and the rest resolve onto ambient globals
(`var isArray = Array.isArray`) that carry no graph node.

**Block A's blocking contribution is dominated by a mechanism B3 was
scoped not to build.** That is a real finding about the block's ranking,
and it belongs to D-12's caution rather than to this task's success
criteria.

### 12. Mutation controls (§ 30–33)

Each guard was weakened in turn and the suite re-run. All four are
load-bearing.

| Mutation | Weakening | Tests that fail |
| --- | --- | --- |
| Reassignment | drop the `isAssignedWithin` gate | 4 — reassigned binding, branch assignment, loop assignment, reassigned receiver |
| Shadowing | resolve from the source file instead of the scope chain | 4 — shadowed binding, shadowing binds own value, parameter shadowing, shadowed receiver |
| Order | allow a later initializer to satisfy an earlier use | 2 — call before initializer, receiver before initializer |
| Instance | unwrap an alias chain past the last useful NAME | 3 — aliased imported receiver, twin receiver isolation, twin alias chain |

The instance mutation is the informative one: discarding the name `dep` in
`const dep = require("pkg"); const alias = dep;` discards the only thing
that identifies WHICH install the value came from, and both same-name
same-version twin tests fail immediately.

### 13. Exact PackageInstance (§ 18)

Three twin tests: two installs, identical name and identical version, one
nested under the wrapper that uses it. A callee binding, a receiver
binding and a three-hop alias chain each resolve to the wrapper's OWN
install, and the top-level twin receives no resolved edge at all. Every
assertion checks the target's module PATH — a name check would pass
against the wrong instance, which is the failure being excluded.

### 14. Performance and cache lifetime (§ 34, § 35)

No new cache, no global mutable state, no new memoization. Resolution is a
bounded walk up the reference's own scope chain plus a bounded walk of the
owning scope's subtree, both per call site that has already failed every
cheaper path, and both over AST nodes already in memory.

`npm run test:performance` passes unchanged (3/3), and the corpus scans
showed no wall-clock regression. The pre-existing per-file `const` cache in
local-aliases.ts is untouched and still serves loader-constructs.ts and
commonjs-reexports.ts, which P1-B3 deliberately does not modify.

### 15. What P1-B3 did NOT do

Not attempted, and each left on its precise UNKNOWN reason: higher-order
parameter propagation (§ 12 — and the largest single Block A mode);
`this`/class/prototype modeling (§ 14); call-result value modeling (§ 13);
webpack/bundle modeling (§ 15, RWF-006); dynamic member access (§ 16);
`new X()` callee binding in `classifyNew`, which has no alias path at all
and whose resolution would land on constructor modeling.

`resolveSingleAssignmentValue` itself is UNCHANGED. Its whole-file,
name-only semantics still serve loader-constructs.ts and
commonjs-reexports.ts. Only the call graph's named-binding paths were
moved onto the scope-aware resolver — widening the change to those two
callers is its own task with its own differential, not a quiet rider on
this one.

### 16. Implications for B4

1. **Block A is not exhausted, and what remains is not Block A work.**
   ~500 of its occurrences are higher-order parameter flow and ~600 resolve
   onto Block B/C value shapes. Building "more Block A" would mostly mean
   building Block B or higher-order analysis under a Block A label.
2. **The blocking column still rests on one case** (D-12), and this task
   is direct evidence for that caution: Block A ranked first on both
   columns and moved neither.
3. **A `new X()` receiver is 20 occurrences** including the real
   `rwb-03-fast-xml-parser-method` fixture's `const parser = new
   XMLParser(); parser.parse()`. That is a Block C decomposition question,
   and RWF-041's own § F4 correction already says Block C needs a
   bundle/prototype/class split before implementation.

### 17. REMEDIATION after independent soundness audit (appended, not rewritten)

An independent audit of `28ac5a1` returned
**P1_B3_NAMED_BINDING_RESOLUTION_BLOCKED**. Everything in § 1-§ 16 above
stands as written EXCEPT the two claims corrected in § 17.4 and § 17.5,
which were wrong when they were written and are left in place with their
corrections beside them rather than edited away.

The audit's verdict was right. The architecture was judged sound; two
classes of FABRICATED EDGE survived it, both found by probing shapes the
corpus does not contain.

#### 17.1 Defect A — destructured bindings owned nothing

`declarationsOwnedBy` recognised a parameter only when its name was a
plain identifier. A binding PATTERN therefore introduced no declaration at
all, the scope walk continued outward, and an outer binding answered for a
name that shadows it:

```js
const a = danger;
function main({ a }) { a(); }   // resolved to danger; calls the argument
```

Confirmed for object patterns, array patterns, defaults, renames, nested
patterns, rest elements, arrow functions and methods — and for receivers
(`function main({ obj }) { obj.m(); }`) as well as callees. Present on the
base commit too, so not a regression this task introduced; but § 4's
"an outer declaration is never consulted once an inner one exists" was
false as written, and the shadowing matrix never tested a pattern.

**Fixed** by collecting every identifier a binding pattern BINDS, for
parameters and catch clauses as well as variable declarations. The
binding's VALUE is still not resolved — it comes from the caller — so the
refusal stays `parameter`. Owning the NAME was the whole job. A renamed
pattern binds its LOCAL name and not its property name
(`{ source: local }` binds `local`), which is asserted in both directions.

#### 17.2 Defect B — object-literal members were not authoritative

Resolving a receiver to an object literal is half a proof; the MEMBER has
to be authoritative too. The shared `findObjectLiteralPropertyValue` took
the FIRST matching property, ignored spreads and knew nothing about a
later `obj.m = ...`. None of that mattered while only a direct `obj.m()`
could reach it. P1-B3 let an ALIAS reach it, and three fabricated edges
followed:

| shape | resolved to | the property actually holds |
| --- | --- | --- |
| `{ m: danger, m: safe }` | `danger` | `safe` — the LAST definition wins |
| `{ m: danger, ...other }` | `danger` | whatever the spread supplies |
| `const obj = { m: danger }; obj.m = safe;` | `danger` | `safe` |

**Fixed** in three parts:

1. **Last definition wins.** Once spreads and computed keys are excluded,
   the literal's own text fixes property order completely, so reading the
   last definition is not an evaluator — it is the language's own rule,
   and it resolves strictly MORE than refusing on duplicates would.
2. **Any spread refuses**, including one written before the key, where
   ordering would in fact make the key authoritative. Modeling that needs
   a value this analyzer cannot see, and one obviously-sound rule beats
   two rules that each have to be right.
3. **Any write to that member name in the binding's scope refuses.** The
   check deliberately does NOT match the receiver: a write reaches an
   object through the binding, through any alias, or through a parameter
   it was passed to, and matching the receiver by NAME would be the same
   resolve-by-spelling mistake this whole block exists to avoid. It is
   over-approximate (an unrelated `other.m = v` costs a resolution) and
   order-insensitive (a write below the call refuses the call). Both costs
   are precision; the alternative costs soundness.

Accessors, method shorthands and computed keys remain fail-closed and were
not broadened.

#### 17.3 The one verdict this changed, and why it is the safe direction

`fixtures/commonjs-invocation-provenance-soundness`'s `valid.js` writes,
under its own heading **"object members that must NOT be read"**:

```js
const overwritten = { bail }; overwritten.bail = safeFn; overwritten.bail();
const duplicated  = { bail, bail: safeFn };              duplicated.bail();
const escaping    = { bail }; patch(escaping);           escaping.bail();
```

In all three the property ends up holding `safeFn`. Base and `28ac5a1`
resolved all three to the THROWING `bail` — three fabricated edges, in a
file whose source says they must not be read. With them removed the
reachable subgraph is honestly incomplete, so the Family C proof that
`verdict.invocation-provenance-soundness.integration.test.ts` asserted is
no longer available and that case is now **UNKNOWN**.

**This is a negative proof this engine should not have been able to
issue.** A proof withdrawn is the safe direction; no proof was invented,
no AFFECTED appeared, and RWF-028's own property — that export authority
is not withdrawn for an invocation it cannot prove abrupt — is untouched
and still asserted by the per-shape matrix in
`module-model.invocation-provenance-soundness.test.ts`, which passes
unchanged.

#### 17.4 CORRECTION to § 14 — the performance claim was false

§ 14 said "the corpus scans showed no wall-clock regression". That was
wrong. Measured on `lodash` (3 runs each, the largest real fixture):

| build | median | vs base |
| --- | --- | --- |
| base `ef07321` | 13.6 s | — |
| `28ac5a1` (audited) | 20.2 s | **+48%** |
| after remediation | 11.5 s | **−15%** |

The cause was structural, not incidental: every question about a scope was
answered by walking that scope's subtree once PER QUERY, and `lodash.js`
asks ~1,700 times inside one ~16,000-line function expression. `qs` and
`fast-xml-parser` were within noise throughout, which is why a small
corpus total hid it.

**Fixed, not accepted.** Each of the three questions is now a per-scope
index built by one walk and answered by hash lookup, keyed on the scope
NODE in a `WeakMap` — scan-local, dying with the AST, with no cross-scan
state and nothing keyed by name or path. The two order-sensitive rules
(the temporal dead zone and the alias-chain visited set) are computed per
reference OUTSIDE the indexes and deliberately not cached.

`named-bindings.performance.test.ts` pins the property structurally rather
than by stopwatch: after the first reference in a scope, every later
reference must cost ZERO additional walks, whatever it asks about.
Deleting the caches makes it fail — and takes 44 s to do so, which is the
regression itself, measured.

#### 17.5 CORRECTION to § 4 — the scope-model claim was overstated

§ 4 said "an outer declaration is never consulted once an inner one
exists". True for every form it had modeled; false for binding patterns,
which it had not. The accurate statement, and the one now covered by
tests, is:

> A name is owned by the innermost scope that declares it in ANY of the
> modeled forms — `var`/`function` hoisted to the function scope,
> `let`/`const`/`class` in their block, parameters and catch bindings in
> theirs INCLUDING every identifier a binding pattern binds, imports at
> the file. Once a scope owns a name, resolution never continues outward
> for it, and two declarations in that scope fail closed.

#### 17.6 The PackageInstance control was weaker than described

The audit found the twin mutation collapsed the RESOLUTION PATH rather
than instance sensitivity: the tests failed because the expected edge
vanished, not because a sibling was borrowed. § 12's description of it was
therefore wrong about the mechanism.

**Strengthened.** The control now asserts, FIRST, that no resolved edge
attributes `parse` to a path under the top-level twin, and reports the
borrowed path when one does. Under a mutation that genuinely collapses
instance identity — resolving a `require()` from the entry file instead of
from the importer that wrote it — all three twin tests now fail naming
`node_modules/vuln-pkg/index.js`, the sibling, instead of `expected false
to be true`.

#### 17.7 Differential after remediation

| comparison | result |
| --- | --- |
| vs audited `28ac5a1`, all 17 cases | **zero deltas** — verdict, confidence, proof, target, PackageInstance, finding count, unknown reasons, unreported candidates, coverage, diagnostics |
| vs base `ef07321`, all 17 cases | unchanged from § 9/§ 10: only RWB-05, `callsResolved` 229 → 231, zero verdict and zero proof deltas |
| Block A | **1,756 → 1,754**, unchanged by the remediation |
| blocking | **42 → 42**, unchanged |

The soundness fixes changed NOTHING in the real-world corpus, because none
of the fabricated-edge shapes occurs in it. That is the honest reading and
the reason they are pinned by unit tests: a corpus that does not contain a
shape is not evidence the shape is handled. The one behavioural change
lives in a unit fixture (§ 17.3) that was written to contain exactly these
shapes on purpose.

RWB-05's two authoritative edges (`parseValues`, `parseKeys`) survive
unchanged, re-verified against source: each declared once, never
reassigned, not shadowed at the use site, used after its initializer.

#### 17.8 Mutation battery after remediation

Nine controls, each weakening one guard and each breaking the tests that
own it: reassignment (4), shadowing (8), evaluation order (2),
destructured-binding ownership (8), duplicate keys (2), spreads (2),
member writes (4), instance identity (3, by sibling borrow), and the scope
index (2, structurally).

---

## RWF-043 — A call to a bare name is attributed to any same-named function in the file, whatever scope it was declared in

**Discovered:** while building P1-B3's corpus differential (RWF-042 § 7).
Not hypothesized — the first working build emitted a wrong edge in real
`lodash`, and the mechanism behind it turned out to be wider than the path
P1-B3 was changing.

**Symptom.** `findLocalFunctionNodeId` (`src/code-intelligence/call-graph
.ts`) resolves a bare-identifier call by searching the file's indexed
functions for one whose NAME matches, and taking the first:

```ts
const match = prepared.index.functions.find((fn) => fn.name === callee.text);
```

`prepared.index.functions` is every function in the file at every depth, so
a call at module scope can be attributed to a function declared inside an
unrelated closure:

```js
function main() { helper(); }          // no `helper` is in scope here
function outer() {
  function helper() {}                 // ...but this one is matched anyway
  return helper;
}
```

Confirmed on `ef07321` and still present: `main`'s call receives a
`resolved` edge to `outer`'s inner `helper`.

**The real-world shape.** `lodash.js` writes, at module scope:

```js
var freeParseInt = parseInt;                        // the ambient global
```

and, ~14,000 lines later inside `runInContext`, its own unrelated
`function parseInt(string, radix, guard)`. Any route that reaches the name
`parseInt` and then asks this function pairs the two.

**Impact.** **Soundness, in the fabricating direction.** It invents a call
edge to a function the program does not reach through that name. An
invented edge cannot produce a false `NOT_AFFECTED` (it only ever adds
reachability), but it can produce a **false `AFFECTED`**, and it can make
an evidence path name a function that was never called. No such verdict
has been observed in the current corpus — the lodash occurrence changed
`callsResolved` and no verdict — and absence of an observation is not
absence of the defect.

**Why the name match exists.** It is the workhorse path for the ordinary
case (`function a() { b(); } function b() {}`), which is correct far more
often than not, and it predates any scope model in this engine.

**Status: partly addressed by P1-B3.**

*Closed* on the named-binding paths. `resolveNamedBinding`
(`named-bindings.ts`) is scope-aware, and it no longer hands a name onward
to this matcher when the name has no declaration in the file — which is
what excluded the lodash edge. Pinned by
`named-bindings.soundness.test.ts`'s ambient-global test, built from the
real lodash shape.

*Open* on the direct-call path (`classifyCall`'s own
`findLocalFunctionNodeId` call, and `resolveAliasedValue`'s identifier
fallback). Closing it means routing direct local-call attribution through
the same scope model, which is a different capability from named-binding
resolution — a different set of call sites, a different differential, and
its own risk of removing edges the corpus currently depends on. P1-B3
deliberately did not absorb it.

**What the audit added, and it matters for reading the scope above.** The
open matcher can OVERRIDE the named-binding resolver's own guards at a
shared call site, because the two are alternative paths to the same edge
and the older one runs first. Measured on the audited commit and still
true:

| shape | `resolveNamedBinding` says | the edge that is actually emitted |
| --- | --- | --- |
| `function main() { fn(); }` above `const fn = () => {};` | refuses — used before initializer | RESOLVED, by name match on the arrow's inferred name |
| `function main() { helper(); }` with `helper` declared inside another function's block | refuses — not in scope | RESOLVED, by name match |
| `const outer = function inner() {}; inner();` at module scope | refuses — `inner` binds only inside itself | RESOLVED, by name match |

So B3's scope, order and stability guarantees hold for the resolutions B3
MAKES; they do not make the call graph as a whole scope-correct while this
path remains. Nothing in RWF-042 should be read as claiming otherwise, and
this finding stays **open in part** until the direct-call path is routed
through the same scope model.

**How to close it.** Give `findLocalFunctionNodeId` the reference NODE
rather than its text, resolve the name through `resolveNamedBinding`, and
accept only a function whose declaration the binding actually names —
falling back to UNKNOWN, never to the first same-named function. Expect
edge REMOVALS in the corpus differential, and expect each one to need
explaining rather than celebrating.

---

## RWF-043 (P1-B3b) — Closed: direct-call attribution now resolves the binding, and the "cannot cause a false NOT_AFFECTED" claim was wrong

**Closed by:** P1-B3b, on base `779e219`.

### 1. The correction that matters most

Both the summary table above and RWF-043's own **Impact** paragraph say
this:

> An invented edge cannot produce a false `NOT_AFFECTED` (it only ever
> adds reachability), but it can produce a **false `AFFECTED`**.

**That is false.** It is left in place above because this file preserves
what was believed at the time; it is corrected here, and it should not be
repeated anywhere.

The error is in the word *adds*. The matcher did not run alongside the
honest resolution — it ran **first**, and the edge it produced **replaced**
the one that would otherwise have been emitted. The honest edge for a call
this analyzer cannot attribute is `unknown`, and an `unknown` edge inside
the reachable subgraph is exactly the thing that withholds
`reachableSubgraphComplete`. So the chain is:

1. a call the analyzer genuinely cannot attribute would emit an `unknown`
   edge — the blocker;
2. the same-name matcher resolves it to a borrowed local instead;
3. the blocker is **displaced**, not joined;
4. the reachable subgraph now contains no unresolved edge and looks
   exhaustively searched;
5. proof family C certifies it;
6. the verdict is `NOT_AFFECTED` — for a program that really does invoke
   the vulnerable function.

This is reproduced end to end, through the real module-load closure, the
real call graph and the real finding builder, in
`src/analysis/verdict.direct-call-binding-authority.integration.test.ts`:

```js
const trimNewlines = require('trim-newlines');

function end(x) { return x; }          // innocuous local

function applyFn(end, value) {
  return end(value);                   // `end` here is the PARAMETER
}

function normalize(input) {
  return applyFn(trimNewlines.end, input);   // the real vulnerable path
}
```

On `779e219` this scan returns `NOT_AFFECTED`, with
`confirmedUnreachableTarget.reachableSubgraphComplete: true` and **zero**
unknown edges in the whole graph. After P1-B3b it returns `UNKNOWN` with
the blocker intact. `UNKNOWN` is the correct answer: the exposure is real
but flows through a parameter this analyzer does not model, so there is
neither a path to assert nor a proof to claim.

The general lesson, which outlives this finding: **a fabricated edge is
not conservative in either direction.** Reasoning about it as
"over-approximation" is only valid for an analyzer that ADDS edges to an
otherwise-complete graph. This one replaces uncertainty with a guess, and
replacing uncertainty is what destroys a negative proof.

### 2. What was actually wrong

`findLocalFunctionNodeId` matched identifier TEXT against
`prepared.index.functions` — a flat, whole-file, first-match-wins index of
every function-like node in the file. That index is not a scope, and it
carried none of the information the question needs. Every shape below
fabricated an edge on `779e219`; each is now pinned in
`src/code-intelligence/call-graph.direct-call-binding-authority.test.ts`.

| # | shape | what the matcher returned |
| --- | --- | --- |
| A | `const a = () => {}; function f({ a }) { a(); }` | the outer arrow |
| B | the same with a function expression | the outer expression |
| C | `const a = () => {}; function f(a) { a(); }` | the outer arrow |
| D | a block `let a = param` shadowing `function a() {}` | the outer declaration |
| E | `const x = function inner() {}; inner();` | the expression, from outside its own body |
| F | an inner `function a(){}` shadowing an outer one | the OUTER one |
| G | a function declared inside a sibling scope | that function, never in scope |
| H | `catch (a) { a(); }` | the outer declaration |
| I | a bare `helper()` with `helper` only a class METHOD | the method |
| J | `let a = () => {}` reassigned elsewhere | the initializer's value |
| K | `class Thing {}; function main(Thing) { new Thing(); }` | the outer class |

Two further classes the pre-implementation review did not identify, both
found by the corpus differential:

- **the matcher named the wrong same-named function outright.**
  `yallist.js` line 109 is `push(this, arguments[i])` inside
  `Yallist.prototype.push = function () {...}`. The flat index names that
  assigned expression `push` and reaches it first, so the matcher
  resolved the call to **the method containing it**, inventing
  self-recursion where the real code calls the module-level
  `function push (self, item)` 275 lines later. Same shape in `yallist`'s
  `unshift` and `lru-cache`'s `del`. Three occurrences in the corpus.
- **the matcher pre-empted VT-210.** 22 call sites in
  `lodash.js` are higher-order (`arrayFilter`'s `predicate(...)`), where
  VT-210 can resolve the real function passed at the call site. Because
  the matcher ran first, they were attributed to an unrelated top-level
  `predicate`/`iteratee` instead. Six of them resolve, as `callback`
  edges, to the same target the matcher had named; the other sixteen
  turned out to be VT-210 making an arbitrary single-target claim of its
  own, and section 6 refuses them. Calling all 22 "corrections" was an
  accounting error the audit caught.

### 3. What replaced it

One question, asked of the one lexical model
(`named-bindings.ts`): *which declaration does this particular reference
bind to?* Four resolved shapes yield a node and nothing else does — a
hoisted `function` declaration, a function/arrow expression held by a
stable binding, a named function expression seen from inside itself, and
a `class`. Every refusal, for any cause, yields UNKNOWN. ~~**No name-based
fallback remains anywhere in the call graph**~~.

**CORRECTION (P1-B3b remediation).** The struck sentence was wrong, and
an independent audit caught it before this branch merged. Two name
comparisons survived inside VT-210, the higher-order rescue that runs
after this authority, and each could decide an edge on its own -- one of
them by overriding a refusal this authority had just issued. They are
corrected in section 6 below. The sentence stays here, struck rather
than deleted, because the claim was made and has to remain legible as a
claim that was wrong.

All four former call sites now route through it: `classifyCall`,
`classifyNew`, `resolveAliasedValue`'s identifier fallback, and VT-210's
inline-argument lookup.

The two narrow authorities the matcher held legitimately were moved INTO
the lexical model rather than re-implemented beside it (there is exactly
one scope model in this engine, and adding a second would have recreated
the divergence this finding is about):

- **local class construction.** `new Thing()` resolves to the class the
  name lexically denotes — its explicit `constructor`, or the synthesized
  entry VT-215 creates for an implicit one. Scope-aware, refused when the
  binding is reassigned, refused in the temporal dead zone. 7 occurrences
  in the corpus, all preserved.
- **named function-expression self-reference.** `inner` inside
  `const outer = function inner(n) {...}` resolves to the expression
  itself, and **only** inside its own body. 7 occurrences, all preserved.

### 4. The measured differential

Over the 15 real-world fixtures in `tests/validation/fixtures/`
(372 files):

| | count |
| --- | --- |
| call/construct sites the matcher resolved | **4364** |
| of those, where the binding names the identical declaration | **4075** |
| — via a `function` declaration | 3704 |
| — via a stable function/arrow binding | 357 |
| — via a `class` (all `new`) | 7 |
| — via a function-expression self-name | 7 |
| sites B3 resolves that the matcher MISSED | 12 |

At the graph level, 234 edges change, and every one is classified:

| class | count | fabricated? |
| --- | --- | --- |
| callee is a `parameter` | 76 | yes |
| binding is `reassigned` | 36 | yes |
| binding holds a non-callable value | 12 | yes |
| `used_before_initialized` | 85 | no — precision only, RWF-044 |
| matcher pre-empted VT-210 (same target, edge type only) | 6 | no — target identical |
| VT-210 single-target claim over a multi-valued parameter | 29 | yes — now UNKNOWN (section 6) |
| VT-210 refusal falling through to the inline callback | 2 | no — target is the function passed at that call |
| matcher named the wrong function | 3 | yes — now resolves to the right target |

Packages affected: `lodash` (138), `semver` + `lru-cache` + `yallist`
(69), `fast-xml-parser` (14), `object-inspect` + `qs` (8). **No verdict
changes on any of the 17 real-world cases** — all 17 are byte-identical
to base, including all four surviving `NOT_AFFECTED` proofs and all six
`AFFECTED` verdicts. No new negative proof is introduced.

That last sentence is the point D-12 draws out: the corpus stayed
entirely green across a change that removed a live false-`NOT_AFFECTED`
mechanism. A green corpus differential is not a soundness result.

### 5. Status as first implemented (superseded by section 7)

The open half named in the original finding — `classifyCall`'s matcher
call and `resolveAliasedValue`'s identifier fallback — is gone, along
with two call sites the original finding did not name.

This section originally read "**Closed.** No text-only path can decide a
call or construct edge." An independent audit disproved that sentence
before the branch merged; section 6 records what it found and what
closing it actually required.

### 6. VT-210's own text authority (P1-B3b remediation)

Sections 1-5 describe removing the flat same-name matcher from the four
direct-call sites. An independent audit of that work found the job
half-done: the higher-order rescue those sites fall through to, VT-210,
kept **two** name comparisons of its own, and a third defect in how it
chose among candidates.

**(a) Which name is a parameter.**

```ts
enclosing.parameters.findIndex(
  (p) => ts.isIdentifier(p.name) && p.name.text === callee.text)
```

This asks whether a name *spells* a parameter, not whether the reference
*binds* to one, so every inner declaration that shadows a parameter's
name matched. The audit's reproduction:

```js
function vulnerable() {}
function invoke(fn) {
  {
    function fn() {}
    fn();
  }
}
function main() { invoke(vulnerable); }
```

`fn()` binds the inner `function fn() {}`. The binding model refuses the
name (two declarations own it in `invoke`'s scope) and VT-210 then
**overrode that refusal**, reinterpreting the call as a call to the
parameter and redirecting it to `vulnerable`. On the pre-B3b base the
flat matcher happened to get this shape right, so B3b's first
implementation made the graph *worse* here -- a new wrong-target edge.

Fixed by `resolveParameterDeclaration` (named-bindings.ts), which returns
the exact `ParameterDeclaration` node a reference binds to, or nothing.
Parameter IDENTITY, not spelling, is now what admits a call to VT-210.

**(b) Which call sites belong to the enclosing function.**

```ts
node.expression.text === functionName
```

A whole-file search by name, so a different function of the same name in
an unrelated scope donated its arguments. Replaced by
`callSitesOfDeclaration`, which walks the file once, resolves every
bare-identifier call through the same lexical model everything else
uses, and buckets the results by the DECLARATION the callee denotes.
Later queries are a map lookup, so the new authority proves strictly
more than the text scan while costing less; `higherOrderCallSiteIndexBuildCount`
lets a test assert that structurally instead of with a stopwatch.

**(c) How many targets a parameter may have.**

VT-210 took the first identifier argument that resolved and ignored every
other call site -- including sites passing a different function, an
inline function, or a call result. That is not a resolution, it is a
sample. `lodash`'s `arrayMap` receives `baseToString` at one site and
`castArrayLikeObject` at three others; the graph claimed `baseToString`
because it is written first.

This matters for the same reason the flat matcher did. **A resolved edge
suppresses the `unknown` blocker that withholds
`reachableSubgraphComplete`**, so an arbitrary pick among real candidates
is the RWF-043 displacement mechanism arriving through the higher-order
path instead of the flat index. The rule now:

- every authoritative call site of the exact declaration must agree on
  one callable -- then VT-210 may name it;
- two distinct callables: UNKNOWN;
- any argument this analyzer cannot name (inline function, call result,
  member expression): UNKNOWN, rather than skipping that site and
  claiming another one's identifier;
- a call site passing no argument at that position is ignored, and only
  that case is ignored: the parameter is `undefined` there, so calling it
  throws before reaching anything and it provably contributes no target;
- a recursive call passing the parameter itself resolves to a parameter,
  which is not authoritative, so the whole question is refused -- which
  is also what makes the walk terminate without recursion.

**Measured effect.** 29 edges lose a single-target claim across the
corpus (14 distinct sites in `lodash`, ×2 fixtures, plus one in
`lodash.template`): `arrayMap`, `arrayFilter`, `baseFlatten`,
`baseExtremum` (×2 parameters), `baseSortedIndexBy` (×2 sites),
`baseFindIndex`, `baseSum`, `baseGetAllKeys`, `baseClone` (×2),
`baseZipObject`, `hasPath`. Every one is a genuinely multi-valued
higher-order parameter. Two further edges (`baseFindKey`'s `eachFunc`)
now fall through to VT-213 and resolve to the inline callback literally
passed at that call -- a strictly more local target than the
`baseForOwn` VT-210 had guessed.

**Zero new resolved edges.** An intermediate version of this fix derived
the enclosing function from `parameter.parent` alone, which also admitted
calls nested inside closures the function creates and ADDED three resolved
edges in `lodash`/`lodash.template`. Widening higher-order reach is a
separate question with its own soundness burden, so the nearest enclosing
function must still BE the parameter's owner, exactly as before. The
remediation is a tightening in every direction.

**Verdicts are unchanged** across all 17 real-world cases, including all
four surviving `NOT_AFFECTED` proofs. No new negative proof appears.

**(d) Class callability.** The audit also found class authority leaking
into the plain-call path: `Thing()` and, newly on the audited commit,
`const Alias = Thing; Alias();` produced edges into the constructor.
Calling a class throws a `TypeError` before the constructor body runs, so
those edges describe an execution that cannot happen -- and the alias
form was a regression, since the pre-B3b matcher left it UNKNOWN. Binding
resolution now carries the invocation form (`"call"` vs `"construct"`), a
`class` answers only to `construct`, and every function-like declaration
still answers to both because `new Ctor()` on a `function` is ordinary
JavaScript.

### 7. Status after remediation

**Closed.** The four flat-index matcher sites are gone; VT-210 identifies
its parameter by declaration and its call sites by declaration; a
higher-order parameter resolves only on unique authoritative provenance;
class authority is construct-only.

No text-only comparison in the DIRECT-CALL or HIGHER-ORDER paths can now
decide a target. Three textual comparisons remain in `call-graph.ts`, and
the audit's lesson is to name them rather than to summarise them away:

- export-name mapping across a module boundary, where the name genuinely
  IS the key;
- `resolvesToUnrelatedConstructor`, a refusal-only guard that can
  withhold an edge but never create one;
- `findDestructuredBindingSource`, reached only after this module has
  already proved the reference binds to a destructuring pattern, but
  which then picks the pattern by a whole-file first-match on the bound
  NAME. That one CAN decide a target, and it can decide it wrongly. It
  is recorded as **RWF-045** rather than fixed here, because it is a
  pre-existing path (verified identical on the P1-B3 base `779e219`),
  it is not one of the five items this remediation was scoped to, and
  it needs its own corpus differential.

Still open, deliberately: **RWF-044** (`used_before_initialized`
precision debt) and **RWF-045** (the destructuring bridge above).


### 8. Post-merge correction: rest parameters (hotfix)

**Found after merge**, by the final focused re-audit of section 6's work,
while checking every parameter shape that reaches VT-210. Recorded here
rather than as a new RWF entry because it is the same finding's own
mechanism and is completely fixed by the one-line guard below (register
convention: a post-merge correction to a closed finding appends to its
remediation history).

**The defect.**

```js
function vulnerable() {}
function invoke(...fn) {
  fn();
}
invoke(vulnerable);
```

VT-210 read the argument at the rest parameter's position and attributed
`fn()` to `vulnerable`. But a rest parameter binds the ARRAY of the
remaining arguments, never one of them, so `fn` is `[vulnerable]` and
`fn()` throws. The edge describes an execution that cannot happen.

**Why section 6 did not catch it.** Section 6 replaced spelling with
declaration identity, and on that axis it is correct here:
`resolveParameterDeclaration` returns exactly the right declaration,
because `fn` genuinely IS that `ParameterDeclaration`. The error is one
step further on — exact binding identity does not by itself tell you what
the binding HOLDS. It is the same error class as calling a class without
`new`, which section 6 (d) closed; this shape was simply missed.

**Pre-existing, not introduced by P1-B3b.** The text matcher section 6
replaced (`p.name.text === callee.text`) matched a rest parameter's name
just as happily. Reproduced identically on the P1-B3 base `779e219`, on
the pre-remediation `c46f12a`, and on merged `a6922ff`. P1-B3b's rewrite
neither created nor widened it; it retained it.

**Measured corpus occurrences: ZERO.** The call-graph differential over
all 15 real-world fixtures is byte-identical before and after the fix —
5838 edges either way, no verdict, proof, instance or target movement.
The shape is rare because calling a rest parameter always throws, so no
working program contains it.

**The fix.** `resolveHigherOrderCallTarget` refuses a parameter carrying
`dotDotDotToken` before reading positional provenance. The guard lives in
that consumer, not in `resolveParameterDeclaration`: the binding lookup's
answer is correct and other consumers may legitimately want it, so making
the model deny a binding that exists would be the wrong repair.

An INDEXED read (`fn[0]()`) is deliberately not rescued by this change —
it is an element access, and the dynamic-member boundary already owns it.

**Section 7's closure is otherwise intact.** The four flat-index matcher
sites, VT-210 parameter identification, VT-210 enclosing-call
identification and multi-valued provenance all stand as recorded.
RWF-044 and RWF-045 are unaffected and remain open.

### 9. Post-merge correction: defaulted parameters and omitted arguments (hotfix)

**Found after merge**, by the post-B3b soundness follow-up, continuing
section 8's sweep of every parameter shape that reaches VT-210. Recorded
here rather than as a new RWF entry for the same reason section 8 was: it
is this finding's own displacement mechanism, arriving through a third
door, and it is completely fixed by the guard below (register convention:
a post-merge correction to a closed finding appends to its remediation
history).

**The defect.**

```js
function fallback() {}
function actual() {}

function invoke(fn = fallback) {
  fn();
}

invoke(actual);
invoke();
```

`fn` is `actual` on one path and `fallback` on the other. VT-210 returned
`actual` as THE unique authoritative target.

The cause is a single skip in `resolveHigherOrderCallTarget`'s provenance
loop:

```ts
const arg = site.arguments[paramIndex];
if (!arg) {
  continue;
}
```

and the comment that justified it — that an omitted argument leaves the
parameter `undefined`, so `fn()` throws before reaching a callable and the
site provably contributes no target. That is correct for a plain
parameter and **false for a defaulted one**: the omitted site does not
leave the parameter `undefined`, it runs the initializer. Having
discarded the one site that disagreed, the loop found exactly one
candidate and called it unique.

**Why section 6 did not catch it, and why section 8 did not either.**
Section 6 replaced spelling with declaration identity, and is right here
too — `fn` genuinely is that `ParameterDeclaration`. Section 8 then asked
what a correctly-identified declaration HOLDS, and found the rest case.
This one is a third question again: not which declaration, and not what
that declaration holds on the path the loop looked at, but **whether the
loop looked at every path**. The uniqueness rule section 6 built is sound
only if every authoritative call site is accounted for, and this skip
silently excused one class of site from that accounting.

**The displacement is real and was reproduced end-to-end, not argued.**
`verdict.direct-call-binding-authority.integration.test.ts` carries a
second oracle beside RWF-043 § 1's: a `applyFn(fn = end, value)` whose
default names the vulnerable package export, called once with an
innocuous local and once with no argument. On merged `d3417c8` the
analyzer resolved `fn(value)` to the innocuous local, left **no**
unresolved edge in the reachable subgraph, certified
`reachableSubgraphComplete`, and returned a **Family C `NOT_AFFECTED`**
for a vulnerable function the program really does invoke. Measured by
mutation: reinstating the bare `continue` moves that case from family `-`
to family `C`. This is the same false-negative-proof class as § 1, so the
struck "can only add reachability" clause is wrong for a third distinct
mechanism.

**Pre-existing, not introduced by P1-B3b.** The text matcher section 6
replaced skipped argument-less sites in exactly the same way, and the
first-match-wins loop that preceded section 6's uniqueness rule never
consulted a second site at all. Reproduced on merged `d3417c8` by running
the new regressions against unmodified production code: 4 of the 11 new
unit cases and all 3 oracle cases fail there; the 7 control cases already
pass, and pass unchanged after the fix.

**The minimal sound rule.** If the parameter carries an initializer AND
any authoritative call site omits the argument at that position, VT-210
refuses the whole question. It is deliberately **syntactic** and
deliberately **not** a default-value model:

- it does not resolve the initializer, so `fn = fallback` with only
  omitted call sites stays UNKNOWN rather than becoming an edge to
  `fallback`. Naming it would open a second provenance authority
  (default-value provenance) that the defect never required, and
  precision is not what was unsound here;
- it does not try to prove a particular initializer non-callable.
  `fn = 42` really does throw on the omitted path, so `actual` would in
  fact be safe to name — but nothing here MODELS the initializer's value,
  and reading non-callability off a literal's spelling is the inference
  this analyzer refuses everywhere else. Conservative UNKNOWN, recorded
  as a known precision cost rather than taken.

**Measured corpus occurrences: ZERO** — and, unlike section 8, *not*
because the shape is unnatural. An AST-accurate probe (not a regex) over
all 1,571 committed `.js`/`.cjs`/`.mjs`/`.ts` files — every fixture,
every vendored real-world benchmark package and all 217 nested fixture
`node_modules` trees — looking for a named function declaration with a
non-rest parameter carrying an initializer, that parameter called as a
bare identifier directly in its owner's body, and same-file call sites of
the owner, found:

- 4,020 named function declarations;
- 70 non-rest parameters with a default initializer;
- **1** of those called bare in its owner's own body —
  `defaultParamShadow(bail = safeFn)` in
  `fixtures/commonjs-invocation-provenance-soundness/node_modules/fixture-lib/param-shadow.js:56`,
  itself a deliberate fixture for this very family;
- **0** with both an omitted and a provided-identifier call site.

The single match has only an omitted site, so the loop found no candidate
at all and returned `undefined` before the fix and `undefined` after it —
identical output, which is why the corpus is inert.

**The shape is nonetheless common in real published JavaScript**, and
this is worth stating because section 8's zero meant something different.
The same probe over a 4,550-file sample of real published packages (this
repository's own installed `node_modules`: `typescript`, `rollup`,
`vite`) found **15** occurrences of the exact displacement shape,
including `typescript`'s own
`contains(array, value, equalityComparer = equateValues)` — 86 same-file
call sites, 81 of them omitting the comparer and 4 passing one. Before
this fix VT-210 would have attributed that parameter to whichever
comparer those 4 sites name, for a function whose overwhelmingly common
path uses the default. Nothing about the correctness of this fix is
conditional on the vendored corpus's zero; the runtime hazard is proved
by the oracle above and the incidence by this sample.

**Differential: byte-identical.** The real-world validation verdict table
is identical before and after (12 PASS / 5 KNOWN_FAIL / 0 UNEXPECTED / 17
cases). A full call-graph dump — every edge of all 48 fixture projects
that carry a `vulntrace.yml` or a `src/` entry, across both fixture
roots, 3,203 nodes and 6,499 edges — is **byte-identical** between
`d3417c8` and this branch: zero edges added, zero removed, zero retargeted,
and so no verdict, proof, `PackageInstance` or target movement.

Confirmed a second way, independently of the dump: the new guard was
instrumented to log every firing and the entire suite re-run (`npm test`,
foundation, validation, adversarial). It fired 10 times in total — 9
inside its own new regressions, and exactly **1** anywhere else, on
`defaultParamShadow#0` in the fixture named above. That one site has no
provided-argument call site, so the pre-fix loop ended with no candidate
and returned `undefined`, which is what the guard now returns directly.
One firing, no changed answer: the corpus-inertness is measured, not
assumed.

**The unique-provenance invariant, restated.** A parameter may be given a
unique callable target only when EVERY authoritative call site is
accounted for and none of them can leave the parameter holding a
different or unknown runtime value. Five site shapes, four of which
refuse: a different target; a value this analyzer cannot name (inline
function, call result, member expression, reassigned binding); an
unresolvable import; an omitted argument for a parameter WITH an
initializer. Only the fifth — an omitted argument for a parameter with NO
initializer — genuinely contributes nothing, because the value is then
`undefined` and the call throws before reaching a callable.

**Parameter-shape checklist (read-only audit, no implementation beyond
the defect above).** Every shape that can reach VT-210 positional
provenance, its runtime value semantics, its current eligibility and its
soundness status:

| shape | runtime value at the parameter | VT-210 eligibility | soundness |
| --- | --- | --- | --- |
| plain (`fn`) | the argument at that position, or `undefined` when omitted | eligible; unique-provenance rule applies | sound — the omitted case genuinely contributes no callable |
| default (`fn = expr`) | the argument, or `expr`'s value when omitted or `undefined` | eligible only while no site omits the argument; refused otherwise | sound as of this section; **precision limit**: an omitted site refuses even when `expr` is a resolvable identifier or provably non-callable |
| rest (`...fn`) | the ARRAY of remaining arguments, never one of them | refused outright (§ 8) | sound |
| destructured (`{fn}`, `[fn]`, and the `= obj` / `= arr` defaulted forms) | a property/element of the argument object, not the argument | never eligible — the name binds a `BindingElement`, not the `ParameterDeclaration`, so `resolveParameterDeclaration` returns nothing | sound (fail-closed); precision limit, deliberately not broadened — see RWF-045 |
| TypeScript optional (`fn?: T`) | identical to plain: the argument, or `undefined` | eligible; `questionToken` carries no initializer, so the new guard does not fire | sound — same reasoning as plain |

`fn?: T = expr` is not legal TypeScript, and the grammar forbids an
initializer on a rest parameter, so no shape can be simultaneously
defaulted and rest, or defaulted and optional. The two guards therefore
cannot contend for one declaration; a regression pins that they coexist
in one signature.

**Sections 7 and 8's closures are otherwise intact.** The four flat-index
matcher sites, VT-210 parameter identification, VT-210 enclosing-call
identification, multi-valued provenance and the rest-parameter guard all
stand as recorded. RWF-044 and RWF-045 are unaffected and remain open;
neither was touched here.


---

## RWF-044 — B3's positional order rule refuses legitimate calls in deferred-execution contexts

**Discovered:** P1-B3b's corpus differential (RWF-043 § 4).

**Class: PRECISION, not soundness.** Every refusal here costs an edge
that is correct in fact. None of them fabricates anything. The failure
direction is UNKNOWN, which is the direction this engine is allowed to
fail in.

**Symptom.** B3's evaluation-order rule (P1-B3 § 9) refuses a reference
written textually above the initializer that would give the name its
value:

```js
function forEach(fn) {
  forEachStep(this, fn);        // refused: `forEachStep` is declared below
}
const forEachStep = (self, fn) => { /* ... */ };
```

The rule is right about the *statement* order and wrong about the
*execution* order. `forEach`'s body does not run when the module is
loaded; it runs when something calls `forEach`, which cannot happen
before the module has finished initializing. So the initializer has
always completed by the time the reference is evaluated.

**Measured extent.** 85 call-graph edges across the corpus, concentrated
in `fast-xml-parser`'s `lib/fxp.cjs` (14, a minified single-line bundle)
and `lru-cache`/`semver`'s class-heavy modules (the remainder). These
edges existed on `779e219` only because the same-name matcher resolved
them despite B3's refusal — which is to say the analyzer was getting the
right answer for the wrong reason, and removing the wrong reason removed
the answer with it.

**Why it is not fixed in P1-B3b.** Deciding that a reference is only
evaluated after module initialization means modeling deferred execution:
which function bodies can run during module load and which cannot. That
is a real capability with its own soundness burden — a wrong answer in
this area fabricates edges, which is the direction P1-B3b exists to
close. Bolting a heuristic onto B3 ("a reference inside a function body
is exempt from the order check") would be exactly the kind of
plausible-but-unproven rule this block removed, and it is wrong for an
IIFE, for a function called during initialization, and for a class static
initializer.

**How to close it.** Model the set of function bodies reachable from
module-load execution, and exempt from the positional check only a
reference whose enclosing body is provably NOT in that set. The
module-load closure work (RWF-002, VT-307a) already computes a closely
related thing and is the natural place to start.

**Do not** close it by relaxing the order rule generally. The rule is
what stops a call above `const fn = danger` being attributed to `danger`,
and that attribution is a fabricated edge (RWF-042 § 9).


---

## RWF-045 — The destructuring bridge still selects its pattern by name

**Discovered:** by the independent audit of P1-B3b's remediation, while
enumerating every textual comparison left in `call-graph.ts`.

**Not a P1-B3b regression.** Reproduced identically on the P1-B3 base
`779e219`. P1-B3b removed the flat same-name matcher from the four
direct-call sites and corrected VT-210; this path was touched by neither.

**Symptom.** `resolveNamedCalleeBinding` asks the binding model about a
callee, and one refusal — `destructuring` — is deliberately routed
onward rather than treated as final, because the call graph has its own
machinery for that shape. But that machinery finds the pattern by name:

```ts
findDestructuredBindingSource(callee.text, prepared.index.sourceFile)
```

which walks the whole file and takes the FIRST `const { <name> } = src`
it meets, at any depth, in any scope.

**Reproduction.**

```js
const dangerMod = require('./danger.js');
const safeMod = require('./safe.js');

function outer() {
  const { run } = dangerMod;   // first match in the file
  return run;
}
function main() {
  const { run } = safeMod;     // what `run()` below actually binds to
  return run();
}
```

The edge from `main` resolves to `danger.js#run`.

**Why the gate does not save it.** `resolveNamedBinding` proves that this
reference binds to *a* destructuring in its innermost declaring scope —
that much is authoritative. It does not say WHICH pattern, and the
name-keyed search that answers that question can cross scopes freely.
Declaration authority stops one step short of the answer.

**Impact.** Soundness, fabricating direction, and by RWF-043's own
corrected reasoning that includes the false-`NOT_AFFECTED` direction: the
edge REPLACES the honest `unknown` one, so it can displace the blocker
that withholds `reachableSubgraphComplete`. No such verdict is observed
in the current corpus, and — exactly as D-12 warns — that is not
evidence of absence.

**How to close it.** The same move that closed RWF-043: hand the
reference NODE to the lookup instead of its text, and return the binding
element the reference actually denotes. `resolveNamedBinding` already
walks to the owning declaration; the destructuring case should return
that `BindingElement` the way `resolveParameterDeclaration` now returns
the exact `ParameterDeclaration`, so the caller never has to search for
it. Expect a corpus differential, and expect some edges to be withdrawn.

**Do not** close it by treating the `destructuring` refusal as final.
That would remove legitimate resolutions (a destructured rename off a
namespace import is a real, common shape) for a defect that is about
pattern SELECTION, not about the bridge existing.

---

## RWF-045 — REMEDIATED: the destructuring bridge now starts from the binding element

**Branch:** `rwf-045-destructured-binding-source-authority`, based on the
merged main `b9bb81b` (P1-B3, P1-B3b, the VT-210 rest-parameter hotfix and
the VT-210 default-parameter hotfix all present).

**Scope.** Pattern SELECTION only. This does not broaden what the
destructuring bridge supports, does not touch RWF-044's deferred-execution
precision, and does not move RWF-006/RWF-001/Block C.

### The old mechanism, exactly

`resolveNamedCalleeBinding` routes ONE refusal from `named-bindings.ts`
onward rather than treating it as final:

```ts
if (binding.kind === "unresolved" && binding.cause === "destructuring") {
  const destructured = findDestructuredBindingSource(
    callee.text,                    // <- TEXT
    prepared.index.sourceFile,      // <- the WHOLE FILE
  );
```

`findDestructuredBindingSource` walked the entire file and returned the
FIRST `const { <name> } = <identifier>` it met, at any depth, in any
scope. Its inputs were a STRING and a `SourceFile`; its lookup key was the
bound name; its search scope was the file; its ordering was source order,
first match wins, and it returned `{ source, propertyName }` — from which
the caller synthesized `source.propertyName` and handed it to
`resolveAliasedValue`, i.e. to the full import/member provenance chain.

The gate in front of it does not save it. `resolveNamedBinding` proves the
reference binds to *a* destructuring in its innermost declaring scope —
that much is authoritative — but it names no declaration. The name-keyed
search that answered "WHICH pattern?" could cross scopes freely.
Declaration authority stopped one step short of the answer.

**Caller inventory.** `findDestructuredBindingSource` had exactly ONE
production caller, `resolveNamedCalleeBinding` (call-graph.ts), and one
doc reference in `named-bindings.ts`'s `destructuring` cause. Both are
updated. `grep -rn findDestructuredBindingSource src/` now returns
nothing outside this record.

### Minimal reproduction

```js
const dangerMod = require('./danger.js');
const safeMod = require('./safe.js');

function outer() {
  const { run } = dangerMod;   // first match in the file
  return run;
}
function main() {
  const { run } = safeMod;     // what `run()` below actually binds to
  return run();
}
```

- reference node: the `run` in `return run()` inside `main`
- exact BindingElement: `run` in `const { run } = safeMod`
- owning VariableDeclaration: `{ run } = safeMod`
- initializer/source: `safeMod`
- old helper result: `{ source: dangerMod, propertyName: "run" }`
- wrong target chosen: `danger.js#run`
- why: `outer`'s pattern is written first, and first-match-by-name wins

### The authoritative replacement

`named-bindings.ts` gains `resolveDestructuredBindingElement(reference)`,
which reuses the EXISTING shared lexical authority
(`findBindingDeclaration`) and returns the exact `ts.BindingElement` — the
same move `resolveParameterDeclaration` makes for VT-210. No second scope
resolver was introduced; the `ScopeDeclaration` record already carried the
element node, so the extension is a narrow accessor, not new machinery.

`call-graph.ts`'s `findDestructuredBindingSource(name, sourceFile)` is
replaced by `resolveDestructuredBindingSource(reference)`. The new flow is:

```
reference
  -> resolveDestructuredBindingElement (authoritative lexical lookup)
  -> exact BindingElement
  -> element.parent            (the exact ObjectBindingPattern)
  -> pattern.parent            (the exact VariableDeclaration)
  -> declaration.initializer   (the exact source identifier)
  -> resolveAliasedValue       (the EXISTING import/member provenance)
```

**API design.** The unsound call is now inexpressible: the function takes
a `ts.Identifier` reference node and there is no name-keyed entry point to
reach. `findDestructuredBindingSource("run", ...)` does not typecheck and
does not exist.

**No text-first fallback.** A refusal from the shared binding model is
never rescued by a file scan. If `resolveDestructuredBindingElement`
returns nothing, the call stays UNKNOWN. The gate is unchanged and still
admits ONLY the `destructuring` cause, so `parameter`, `reassigned`,
`used_before_initialized`, `ambiguous_declarations` and `alias_cycle`
remain final.

### Behaviour, shape by shape

| shape | result | why |
| --- | --- | --- |
| `const { run } = safe; run()` | resolves to `safe.run` | the element's own declaration |
| `const { run: execute } = safe; execute()` | resolves to `safe.run` | property key read off THIS element, after identity |
| `const { run: execute } = safe; run()` | UNKNOWN | `run` is not bound; a property key is not a local name |
| outer/inner same name | each to its OWN source | declaration identity, not source order |
| sibling scopes | each to its OWN source | neither declaration is in scope at the other's call |
| parameter shadowing | never the outer source | the gate refuses with cause `parameter` |
| block shadowing | never the outer source | the block `const` owns the reference |
| `let {run} = safe; run = other; run()` | UNKNOWN | `const`-only; stale provenance refused |
| `var { run } = safe` | UNKNOWN | rebindable |
| `const { run = fallback } = source` | UNKNOWN | two possible runtime values; **changed** — the old helper mapped this to `source.run` unconditionally |
| `const { api: { run } } = source` | UNKNOWN | nested member path not modeled; no same-name attribution |
| `const [run] = source` | UNKNOWN | array patterns bind by position |
| `const { other, ...run } = source` | UNKNOWN | rest holds the remaining properties |
| `const { run } = require("./safe.js")` | resolves, unchanged | a destructured REQUIRE is an import binding; `source-index.ts` indexes it and the import machinery owns it. The bridge is never consulted |

**Declaration kinds.** `const` only, as before. `let`/`var` are refused
rather than trusted, which is what makes reassignment fail closed.

**DELIBERATELY NO ORDER RULE.** A reference written textually above its
own destructuring behaves exactly as it did before this change. The
temporal-dead-zone question is the deferred-execution debt RWF-044 owns;
it applies equally to every `const` in the module, and answering it here
for one binding form only would move that boundary under cover of a
name-authority fix.

### PackageInstance

Exact install identity is preserved because the source identifier handed
to `resolveAliasedValue` is now the one written in the declaration the
reference actually binds to, and that identifier is resolved against its
OWN file's module model. A twin fixture pins it: two installs of `lib`
at the same version, one top-level and one nested under `wrapper`, both
exporting `run`; the destructuring inside `wrapper` resolves to wrapper's
nested install. Package name, version, local binding name, property key
and exported member are all identical across the twins, so nothing but
install identity can satisfy the assertion.

The existing PackageInstance gates (`package-instances.test.ts`,
`package-instances.differential-oracle.test.ts`,
`resolved-target.workspace-twins.test.ts`) pass unchanged.

### Corpus prevalence

`scripts/rwf-045-corpus.mjs`, over `fixtures/`,
`tests/adversarial/v1/fixtures`, `tests/adversarial/v2/fixtures` and
`tests/validation/fixtures` (1283 files). It gates each call site exactly
as production does — the bridge is counted only for a `destructuring`
refusal — and runs the SHIPPING resolver from `dist/` against a verbatim
copy of the base helper.

| measure | count |
| --- | --- |
| files scanned | 1283 |
| files with bridge call sites | 18 |
| projects with bridge call sites | 12 |
| bridge call sites | 54 |
| old helper hits | 1 |
| new helper hits | 1 |
| sites with >1 same-name candidate | 0 |

**This is not a soundness argument.** Prevalence says how often the corpus
happens to exercise the shape, not whether the old rule was safe. The
defect is reproduced by construction in the focused suites and by the
end-to-end oracle; that is the evidence, and D-12's warning applies to the
zero in the last row.

### Graph differential

Merged main `b9bb81b` vs this branch, every changed edge classified:

| class | count |
| --- | --- |
| A. fabricated wrong-source edge removed | 0 |
| B. wrong target corrected | 0 |
| C. honest edge retained | 1 |
| D. conservative UNKNOWN introduced | 0 |
| E. unexpected | **0** |

The single corpus hit resolves to the identical source identifier and
property under both rules. **Edge additions: none** — no branch-only edge
exists to audit. **Edge removals: none** — so there is nothing here to
celebrate OR to charge as precision loss; the corpus simply does not
contain the adversarial shape. The behaviour change is real and is pinned
by construction in the focused suites, not by corpus movement.

### Verdict / proof differential

`npm run test:validation` on `b9bb81b` and on this branch produce
BYTE-IDENTICAL result tables: 18 passed, the same 5 pre-existing known
failures (RWB-03, RWB-05, RWB-09b, VAL-002, VAL-003), same expected/actual
verdicts throughout. No finding, verdict, confidence, target,
PackageInstance, evidence path, negative proof, unknown reason or
unreported candidate moved, so no manual audit of a moved verdict is owed.

**No new negative proof appears anywhere**, so RWF-026's manual-audit
obligation for a new Family C proof is not triggered.

### Family C / AFFECTED impact — both directions

RWF-043 established that a fabricated resolved edge can DISPLACE the
blocker that withholds `reachableSubgraphComplete`. RWF-045 is the same
mechanism on the destructuring bridge, and
`src/analysis/verdict.destructured-binding-source-authority.integration.test.ts`
reproduces BOTH directions end to end on `b9bb81b`:

- **False `NOT_AFFECTED`.** An innocuous local destructuring of `end` is
  written first; the function that really destructures `end` off the
  vulnerable package has its call resolved to the local function instead.
  The vulnerable target leaves the reachable subgraph, no unresolved edge
  remains to withhold the proof, Family C certifies it, and the scan
  reports `NOT_AFFECTED` for a call the program really makes. Confirmed:
  on base the verdict is `NOT_AFFECTED`; on this branch it is `AFFECTED`.
- **False `AFFECTED`.** Swap the two destructurings and the innocuous call
  resolves to the VULNERABLE export, reporting `AFFECTED` against a
  program that never touches it.

RWF-045 is therefore **not one-directional**, and the original record's
"fabricating direction" framing is corrected accordingly.

### Text-authority sweep

Every surviving destructuring-related text read in production:

| site | use | classification |
| --- | --- | --- |
| `call-graph.ts` `resolveDestructuredBindingSource` — `propertyName ?? name` | selects the member AFTER the element is settled | property selection after identity — **safe** |
| `call-graph.ts` `findObjectLiteralPropertyValue` — `name.text === propertyName` | reads a property off an ALREADY-authoritative receiver value | property selection after identity — **safe** |
| `named-bindings.ts` `boundName: element.name.text` | keys the per-SCOPE declaration index | identity lookup, scope-bounded — **safe** |
| `commonjs-reexports.ts` `candidates.set(element.name.text, …)` | top-level-only, and guarded by `declarationCounts.get(name) === 1` | identity lookup, guarded by a uniqueness refusal — **safe** |
| `call-graph.ts` `rootIdentifierOf` | only feeds `isKnownGlobalIdentifier` | refusal-only — **safe** |
| `source-index.ts` `extractRequireBindings` localName | file-scope import table keyed by local name | **unsafe authority — but NOT destructuring-specific**; recorded as RWF-046 below |

No unsafe authority survives in RWF-045's owned path.

### Performance

No index and no new traversal were added. The whole-file walk per query is
GONE — it is replaced by the existing scope-index lookup plus a fixed
number of parent-pointer hops (element → pattern → declaration →
initializer), so the change is strictly cheaper per query, not merely
bounded. `named-bindings.performance.test.ts` (which counts
`namedBindingScopeIndexBuilds`) and
`call-graph.higher-order-index.performance.test.ts` pass unchanged, and
`npm run test:performance` passes. No structural operation-count test was
added because no new index or traversal exists to bound.

### Mutation testing

Each mutation was applied to production source and the focused suites
re-run; every one fails as required.

| mutation | effect | result |
| --- | --- | --- |
| restore the whole-file first-same-name scan | 10 tests fail, incl. all 5 oracle tests | **killed** |
| treat the property key as the local binding name | 2 renaming tests fail | **killed** |
| ignore shadowing (weaken the gate AND the lookup) | 11 tests fail, incl. parameter shadowing | **killed** |
| ignore reassignment (drop `const`) | 2 stability tests fail | **killed** |
| collapse PackageInstance (resolve specifiers from the project root) | the twin test fails | **killed** |

Two of these had to be RETARGETED after a first attempt survived, and the
survivals are themselves findings worth recording:

- Mutating only `resolveDestructuredBindingSource` could not break
  shadowing, because shadowing is enforced EARLIER — a shadowed name
  refuses with cause `parameter`, so the bridge is never reached. The
  honest mutation weakens the gate too, and then the shadow tests fail.
- Replacing the source identifier with a fresh same-TEXT identifier did
  not break instance isolation, because module resolution is per-FILE:
  within the correct file, the source's text is sufficient. Instance
  identity is carried by WHICH FILE resolves the specifier, so the real
  collapse mutation is in `module-resolver.ts`, and that one does fail the
  twin test.

### Residual limitations

1. Nested patterns, array patterns, defaulted elements, rest elements,
   non-`const` declarations and non-identifier sources all stay UNKNOWN.
   These are refusals, not gaps that fabricate.
2. The defaulted-element refusal is a genuine, deliberate PRECISION LOSS
   against the base, which resolved `const { run = fallback } = source` to
   `source.run` unconditionally. Zero corpus sites are affected.
3. No order rule — see above; RWF-044 owns it.
4. RWF-046 (below) remains open and can still collapse two function-local
   requires that bind the same local name.

### Closure

**Closed.** The single production caller is declaration-authoritative, the
name-keyed entry point no longer exists, and every gate passes. Closure is
scoped to destructured-binding SOURCE SELECTION and claims nothing about
RWF-046, RWF-044, RWF-006, RWF-001 or Block C.

### Boundaries

- **RWF-043** (direct/local + higher-order same-name authority) is
  untouched and its record is not rewritten. RWF-045 is a separate finding
  on a separate path that happens to share RWF-043's displacement
  mechanism; sharing a mechanism is not sharing a fix.
- **RWF-044** (used-before-initialized / deferred execution) — no
  implementation movement, deliberately, as recorded above.
- **RWF-006, RWF-001, Block C** (bundle exports, call-result exports,
  prototype receivers, `this` modeling) — no implementation movement.

---

## RWF-046 — The import table was file-wide and name-keyed

**Discovered:** while auditing what remained of import/require provenance
authority after RWF-042 and RWF-043 removed the flat name matchers from
the value-binding and direct-call paths.

**Base:** `b9bb81b`. Reproduced there in every shape below.

### The defect

`symbol-binder.ts`'s `bindCallee` answered *which module does this name
denote?* with one line:

```ts
moduleModel.imports.find((imp) => imp.localName === shape.rootIdentifier)
```

`ModuleModel.imports` is a flat list built by `source-index.ts` from one
traversal of the whole file. A row records that *some* `require(...)`
somewhere bound *some* name — never WHICH declaration did it, and never
where. So two declarations spelled the same are two indistinguishable
rows, and `find` returns whichever appears first in the file.

This is the same mistake twice removed already, surviving one layer
down. RWF-042 and RWF-043 made the call graph ask which DECLARATION a
name binds to; `bindCallee` then threw that answer away and re-asked the
module question by spelling.

### The three reproduced shapes

**A. A function-local require borrowed the file-scope one.**

```js
const source = require("outer");
function f() {
  const source = require("inner");
  source.run();            // -> node_modules/outer/index.js
}
```

**B. Sibling functions collapsed onto the first-written package.**
`a()`'s `require("pkg-a")` answered for `b()`'s `require("pkg-b")`.

**C. A reassigned require-bound source kept stale provenance.**

```js
let source = require("safe");
source = other;
source.run();              // -> still node_modules/safe
```

**The control that fixes the blame.** The structurally identical shapes
with NO require involved (`const fn = danger` outside,
`const fn = safe` inside) already failed closed on the base, because
`named-bindings.ts` owns them. The defect belonged to import provenance,
not to lexical binding generally — which is exactly why it survived two
remediations of lexical binding.

### Impact — both directions, and both reproduced

RWF-042's original record claimed a fabricated edge risks only a false
`AFFECTED`; RWF-043 § 1 corrected that, because a fabricated edge
REPLACES the honest `unknown` one and so displaces the blocker that
withholds `reachableSubgraphComplete`. RWF-046 was reproduced in both
directions rather than argued into one:

- **False `AFFECTED`** — outer `require("vulnerable-mod")`, inner
  `require("safe-mod")`, inner call: resolved to the vulnerable module.
- **False `NOT_AFFECTED`** — the same file with the two swapped: the
  inner *vulnerable* call resolved onto the outer *safe* module.

### It was live in this repository's own fixtures

The corpus differential (7,776 call-graph edges over `fixtures/` and
`tests/validation/fixtures/`, base vs branch) changed **13** edges:

| # | Class | Where |
|---|---|---|
| 6 | wrong first-match target replaced by the exact one | `target-side-reexport/verify.cjs` 49, 84, 113, 143, 177, 282 — each a block-scoped `const lib = require("<its own lib>")`, all six collapsed onto `direct-lib#vulnerable` |
| 2 | correct target added where the base had UNKNOWN | same file, 64 (`onehop-lib/safe.js`) and 267 (`twoname-lib/impl.js`) — the base looked the member up on the wrong module and failed |
| 1 | **fabricated** edge removed | same file, 306: `main("x")` inside `for (...) { const main = require(\`./src/${name}.cjs\`); }`. The specifier is a template with a substitution and denotes nothing statically; the base borrowed the `main` require from a *different block six lines later* and emitted a resolved edge |
| 1 | stale reassignment provenance removed | `gopd/index.js:8` — real npm code: `var $gOPD = require('./gOPD'); if ($gOPD) { try { $gOPD([], 'length'); } catch (e) { $gOPD = null; } }` |
| 1 | conservative UNKNOWN introduced | same file, 160: the `reassigned-lib` block. The base resolved it to `direct-lib#vulnerable`; the branch reaches the right module and then correctly cannot attribute its reassigned export |
| 2 | UNKNOWN both sides, reason corrected | `commonjs-entrypoint-root-widening/verify.cjs` 24, 64: `unresolved_target` → `unsupported_callee_binding`. Both are dynamic template-literal requires, so there is no module whose export could be missing; the new reason says what is actually wrong |

**Unexpected changes: zero.** No verdict moved: `npm run test:validation`
reports the identical 5 known failures with identical verdicts on the
base and on the branch, and every other suite is unchanged.

### Corpus prevalence

Measured over 885 JS/TS files in `fixtures/` and
`tests/validation/fixtures/`, real installed `node_modules` included.
Units are stated because they are three different denominators:

| Metric | Count | Unit |
|---|---|---|
| call sites whose callee root is an identifier (the lookups the table answered) | 19,005 | sites |
| require bindings with a literal specifier | 902 | bindings |
| — of them file-scope | 897 | bindings |
| — of them function-local | 5 | bindings, in 3 functions |
| require-bound names also declared elsewhere in the same file | 18 | bindings |
| reassigned require-bound names | 1 | bindings |
| destructured require bindings | 28 | bindings |
| requires with a NON-literal specifier | 73 | sites |
| ESM import bindings | 142 | bindings |

Low prevalence is a fact about this corpus, not a measure of severity:
5 function-local bindings and 1 reassignment produced 13 wrong or
changed edges including an outright fabrication, and both verdict-facing
oracles reproduce. Lazy `require` inside a function is idiomatic in real
published packages.

### The fix

`named-bindings.ts` gains `resolveImportProvenanceDeclaration`, built on
the SAME `findBindingDeclaration` that already decides shadowing — no
second scope resolver. It returns the EXACT declaration node that owns
the reference (an ESM import binding node, a `VariableDeclaration` whose
initializer is a literal `require`, or the `BindingElement` of a
destructured one), or a refusal. `symbol-binder.ts` derives the
specifier from that node.

> **This section as first written claimed the `BindingElement` path was
> exact. It was not, and the claim is corrected rather than deleted.**
> Locating the element exactly is necessary but not sufficient: the
> element must also be shown to NAME a property of the module object,
> and the first implementation did not check that. See
> **RWF-046a** below, found by independent audit after this remediation
> merged into the branch.

`bindCallee` no longer takes a `ModuleModel`. The parameter is removed
rather than left unused, so no later caller can reach for the table as
an authority again. `ModuleModel.imports` remains the right answer to
"what does this FILE load", which the module-load closure and the
loader-construct pass still ask.

**Reassignment invalidates provenance**, under the rule `resolveFrom`
already applies to a `let`/`var` value: a `const` cannot be rebound, and
for anything else the whole owning scope is searched, because a closure
can run the write later.

**Evaluation order is deliberately NOT checked here.** A reference
written above its own `const x = require(...)` is RWF-044's question.
Adding the check would move precision for a reason unrelated to binding
identity, and RWF-044 stays open and out of scope.

### Mutation controls

Each guard was weakened in turn and the suite re-run:

| Mutation | Tests that fail |
|---|---|
| restore file-wide name-keyed lookup as a fallback | 10 |
| resolve the declaration against the source file only, ignoring function/block scope | 12 |
| make the reassignment check always return `false` | 6 |
| collapse a path specifier onto its bare package name | 1 (the twin identity control, by design) |

The suite also fails in 16 places when run against the base commit's
production files, which is what makes it a regression suite rather than
a description of current behaviour.

### Boundaries

- **RWF-045 is NOT closed by this, and is NOT a prerequisite for it.**
  The two are separate authority layers: RWF-045 decides *which
  destructuring declaration owns a bound name*, RWF-046 decides *which
  module the exact source identifier denotes*. RWF-045 remains open and
  name-keyed in `findDestructuredBindingSource`; nothing here touches it.
- **RWF-044, RWF-006, RWF-001, RWF-043/VT-210** — unchanged.
- **ESM import identity** — unchanged in behaviour; the ESM cases now
  read their specifier off the same declaration node instead of the
  table, and the existing import suites are green.

### One survivor, recorded rather than fixed

`loader-constructs.ts` still keys three relations on identifier TEXT
against `context.model.imports` (`wholeModuleBuiltinFor`,
`isNamespaceBuiltinBinding`, `namedBuiltinBindingOf`). They are in the
loader-construct CAPABILITY layer, not on any call-edge target path:
their output is an `unknown(unsupported_construct)` refusal or an
exemption from one, never a resolved target. A probe confirms the
shadowing case fails closed today — `const Module = require("module")`
with a parameter `Module` shadowing it inside a function yields
`unknown(unsupported_callee_binding)`, not a fabricated capability.

They are left alone deliberately: they share no code with `bindCallee`,
and changing loader-construct semantics is explicitly outside this
remediation. Recorded here so the next audit finds them named rather
than having to re-derive them.

---

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

## RWF-047 — A require-bound module object keeps its attribution across a member write

**Discovered:** by the scoped re-audit of RWF-046a, while sweeping the
binding grammar for shapes where a local name could still reach an
exported name. Not a shape RWF-046 touches.

**Neither introduced nor expanded by RWF-046/046a.** Measured
identically on `b9bb81b` and on this branch:

```js
const mod = require("pkg");
function patched() {}
function f() {
  mod.run = patched;
  mod.run();        // resolves to pkg#run, on BOTH
}
```

**The asymmetry.** `named-bindings.ts` exposes `isMemberAssignedWithin`,
and the call graph uses it for an object-literal receiver: `const obj =
{ m: danger }; obj.m = safe; obj.m()` correctly refuses, because a
`const` binding to an object literal freezes the BINDING and not the
OBJECT. A require-bound module object has exactly the same property —
`const` freezes `mod`, not `mod.run` — and no equivalent check governs
it.

### Why this is NOT recorded as precision debt

The re-audit suggested "pre-existing precision debt". That
classification is not adopted here, because it may well be wrong, and
the distinction is the whole question:

- a **precision gap** costs an edge that was correct in fact, and fails
  toward UNKNOWN — the direction this engine is permitted to fail in;
- a **missing invalidation** yields an edge that is WRONG, pointing at
  `pkg#run` while the program calls `patched`. That is an attribution
  the analyzer states and the runtime contradicts, which is the
  fabricated-edge class — and by RWF-043 § 1's corrected reasoning a
  fabricated edge also displaces the honest `unknown` blocker, so the
  false-`NOT_AFFECTED` direction is in scope too.

Calling it precision debt on an auditor's word would file a possible
soundness finding under a heading that exempts it from the soundness
gate. It stays unclassified until measured.

### The minimal reproduction needed to decide it

Three things, none of them yet done:

1. **Does the wrong edge reach a verdict?** Build the shape above with
   the advisory naming `pkg#run`, where `patched` is safe and `run` is
   vulnerable, and scan. If the finding is AFFECTED on a path the
   runtime never takes, it is a false AFFECTED and the class is
   settled.
2. **The reverse direction.** Make `run` safe and `patched` vulnerable
   and confirm whether the analyzer reports NOT_AFFECTED over a target
   the program does reach — the displacement case, which matters more.
3. **Real `node` ground truth** for both, in the style of this repo's
   circular-import fixtures, so the runtime answer is measured rather
   than argued.

Only after 1–3 can this be classified. **Do not fix it before it is
classified**: the fix differs by class. A precision gap would be
addressed by extending `isMemberAssignedWithin` to require bindings; a
fabricated-edge class needs that plus an audit of every other receiver
whose members are read without an invalidation check.

**Prevalence is unmeasured** and is not a reason to defer: monkey-
patching a required module (`mod.foo = wrapper`) is an established
JavaScript idiom, and the corpus's silence on the RWF-046a shapes is
exactly what D-12 warns against reading as absence.
