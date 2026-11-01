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

