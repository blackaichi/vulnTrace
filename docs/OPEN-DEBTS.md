# Known Open Debts, and the Entry Criteria for P1-B

**Authoritative.** Everything the project knows it has not finished, stated
specifically enough to act on. There is no entry here reading "technical
debt": a debt that cannot be named cannot be discharged, and a vague one
is indistinguishable from not knowing.

Companion documents: [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`SOUNDNESS-CONTRACT.md`](SOUNDNESS-CONTRACT.md),
[`SCORECARD.md`](SCORECARD.md).

**None of these is a blocker for P1-B.** § 3 says what a blocker would be.

---

## 1. The register

### D-01 — `AnalysisProofContext` is not transitively immutable

**What.** The context wrapper is frozen and the `entrypoints` array is
snapshotted and frozen. The referenced `moduleLoadClosure`, `graph`,
`knownPackageRoots` and the individual entrypoint **objects** are live
aliases: neither snapshotted nor deep-frozen.

**Why it matters.** A write through a retained alias to any of those
**does move a verdict** — F4's audit turned an `UNKNOWN` into a family-C
`NOT_AFFECTED` by emptying a closure's `incompleteness` through the
caller's own variable, never touching the context.

**Why it is not a blocker.** Exactly one production caller builds a
context; no production code retains or writes any of those inputs
afterwards; no production mutation path was found. The invariant rests on
**ownership and lifetime**, not on structure — `readonly` is erased at
runtime and `Object.freeze` is shallow.

**The production comment still overstates it.** `src/analysis/analysis-context.ts`
describes the context as "ONE immutable object" and "Immutable and created
once per scan". Per the table above that is stronger than what the
constructor delivers: `Object.freeze` is applied to the wrapper and to the
copied `entrypoints` array, and to nothing else. F4 recorded this as a
documentation defect and deliberately did not touch it (F4 changed no
production file); F7 changed no production file either, so it stands. **It
should be narrowed to the wrapper-frozen / references-live statement when
that file is next touched** — this entry exists so that instruction is not
carried only in a commit message.

**Shape of a fix** (none chosen): snapshot or deep-freeze the
proof-critical inputs at binding; make `CallGraph` and `ModuleLoadClosure`
immutable after construction; or enforce single-owner lifetime so a
retained alias cannot exist. Each has a real cost — copying every closure
and graph per scan, or a wide type change — which is why it is a decision
to be made rather than made in passing.

**Detail:** [`SOUNDNESS-CONTRACT.md` § 5](SOUNDNESS-CONTRACT.md).
**Related:** D-02, and the reason no reachability result is cached.

### D-02 — Index staleness is not structurally enforced

**What.** F5's per-scan indexes assume the graph and registry are stable
after construction. The guard is a **node-count** comparison: it detects
growth or shrinkage of the node list, and does **not** detect a node
mutated in place. Nothing in this codebase does.

**Why it is not a blocker.** Current production types and lifetimes make
such a mutation unreachable without a cast. That is the same lifetime
argument as D-01, and it carries the same caveat: the indexes are not
magically immutable, and this document does not claim they are.

**Note what is already right:** every index **refuses** rather than
answering when the guard fires, and a refusal falls back to the
authoritative walk. Refusal is never absence
([`ARCHITECTURE.md` § 9.1](ARCHITECTURE.md)).

### D-03 — `npm test` is not offline

**What.** `src/vulnerabilities/osv-provider.integration.test.ts` queries the
live OSV API unconditionally, inside the default `npm test` run.

**Why it matters.** A provider or network outage can turn the full suite —
and therefore CI — red for reasons unrelated to any change. `npm test` is
therefore **not** a deterministic oracle, and must not be described as one.

**Why it is not a blocker.** `npm run test:foundation` contains no network
access at all, and it is the deterministic oracle. This defect predates the
Foundation gate.

**Shape of a fix:** isolate or stub that suite, or move it behind the same
`LIVE_SIGNALS` classification as `test:validation`.

### D-04 — One Foundation-gate test is root-sensitive

**What.** Running the gate inside a user namespace (`unshare -r`) maps the
process to root, which defeats the `chmod 000` a pre-existing F5
identity-cache case relies on, and that case fails.

**Why it is not a blocker.** It is root-sensitivity in a test that predates
F6, not a network dependency, and not a property of the analyzer. Ordinary
developer and CI environments are unaffected.

**Shape of a fix:** detect an effective-root process and skip the case with
an explicit message, rather than letting it fail misleadingly.

### D-05 — The invariant map checks membership, not semantic adequacy

**What.** `src/testing/foundation-invariants.test.ts` proves that every
named owner exists and is executed by the gate, and that the gate runs
nothing the map does not account for. It cannot prove an owner's assertions
are **sufficient** for the invariant it claims.

**Why it matters.** An owner whose assertions were weakened would still
pass the map. F6's own audit found exactly this shape once — an invariant
mapped to a file that contained no case for it at all, coverage claimed on
paper — and it was fixed by extracting a focused owner. The class of defect
is not structurally prevented.

**Shape of a fix:** mutation-testing each owner against the invariant it
claims, in the manner of the F4 proof-mutation harness. That is a
substantial piece of work and is not scheduled.

### D-06 — RWF-002: target-relevant completeness

**What.** One unresolved or dynamic construct **anywhere** in an
entrypoint's reachable call graph currently prevents family C for every
vulnerability checked against that entrypoint, even when the construct is
entirely unrelated to the target.

**Status: OPEN.** Partially bypassed for unloaded packages (family A covers
that case); the underlying reachability-scoping tradeoff remains.

**The nuance that is most often got wrong.** The measured blocker count for
the largest affected case — 84 occurrences, collapsing into 3 distinct
reasons — **is not an implementation task count**, and must never be quoted
as one:

- 84 occurrences do not imply 84 pieces of work; one change can discharge
  many at once.
- "Classified as a category that is in principle analyzable" is a statement
  about the **kind** of uncertainty, not about its difficulty.
- Most importantly, **modeling is not necessarily the remedy at all**.
  RWF-002 is not "implement every blocker": it asks whether an unresolved
  edge is *relevant to a path to the vulnerable target*. A future solution
  may discharge most of those occurrences by proving them irrelevant to the
  target — **target-relevant completeness** — without modeling a single one
  of them. That is a genuinely different remedy from frontend work, and
  nothing measured so far chooses between them.

What the measurement **does** establish is narrower and still useful: the
observed blockers are, in principle, analyzable or relevance-classifiable,
rather than capability escapes that would foreclose both routes. Not one of
the 84 is a construct that can load or execute code the graph never
discovered.

**F7 does not plan its remediation**, and this document does not schedule
it.

### D-07 — `unsupported_construct` was too coarse — CLOSED by P1-B1

**What it was.** `unsupported_construct` was the call graph's
undifferentiated catch-all for "a callee expression shape I have no rule
for", and the whole of the corpus's top unmodeled-construct ranking.
Knowing there were 42 occurrences of it told nobody which syntax to
implement.

**What closed it.** P1-B1 (`tests/validation/FINDINGS.md` RWF-041) measured every
occurrence in the real-world and adversarial corpora and split the token
into **eight** subtypes named for the modeling gap behind each one, with
`unsupported_construct` retained as their runtime floor. Every occurrence
in the measured corpus now carries a specific token and the floor's count
is **zero**. The distribution is in [`SCORECARD.md` § 7.1](SCORECARD.md),
reproducible with `node scripts/measure-frontend-gaps.mjs`.

**What it did NOT do, and this matters.** Coverage is unchanged: the
analyzer models exactly what it modelled before, no verdict moved, and the
corpus's UNKNOWN count is identical. Splitting a reason is an
observability change, never a capability one.

**What replaced it.** Not a debt but a caution, carried forward into D-12:
occurrence counts are still not work items, and the corpus's *blocking*
occurrences all come from a single case.

### D-08 — Parsing and graph construction remain the dominant cost

**What.** Parsing and graph construction are roughly **90% of scan wall
time**, and F5 did not touch them. F5 removed one multiplier — per-advisory
identity work is now O(nodes) + O(1) per advisory — and left the dominant
cost exactly where it was.

**Explicitly not claimed.** No wall-clock performance improvement is
claimed from F5. The property that was established is **structural**: an
exact operation-count gate with no threshold to tune. The wall-clock
guards are coarse catastrophic-regression ceilings and were not improved.

**Known remaining candidates**, in measured order: a shared per-scan
source-index cache between `buildCallGraph` and the module-load closure
(~35% of the closure's added cost); `ts.resolveModuleName` without a
resolution cache (measured at 1.1% of wall time — real but small, and it
touches resolution semantics); the closure's whole-file widening scan
(deliberately duplicated work, load-bearing for soundness).

### D-09 — Known validation failures

Five of the 17 real-world cases are kept **deliberately failing**, because
a disagreement with an independently-researched oracle is recorded rather
than fixed away or re-scoped to match the tool.

| Case | Expected | Actual | Cause |
| --- | --- | --- | --- |
| `RWB-03` | `AFFECTED` | `UNKNOWN` | RWF-006 — a webpack-bundled, getter-defined class export is not recognised as constructible/method-bearing. |
| `RWB-05` | `NOT_AFFECTED` | `UNKNOWN` | **D-06 (RWF-002)**. The target now resolves exactly; what blocks the proof is unresolved edges elsewhere in `qs`'s own real dependencies. |
| `RWB-09b` | `NOT_AFFECTED` | `NO_FINDING` | **A benchmark oracle-design limitation, not an analyzer defect.** The correct result really is no finding at all — the instance is confidently outside every affected range — and the case format has no way to express that as an expected outcome. |
| `VAL-002` | `AFFECTED` | `UNKNOWN` | RWF-001 — a UMD `module.exports` assignment via a locally-aliased variable is invisible to export detection. |
| `VAL-003` | `NOT_AFFECTED` | `UNKNOWN` | RWF-001, the same gap in the other direction — which is the point: it degrades precision **both** ways and never produces a false answer. |

`RWB-09b` needs a case-format revision (an explicit "no finding for this
instance" expectation), not an analyzer change.

### D-10 — A benchmark audit document is cited but has never existed

**What.** `docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md` is cited as a source by
six committed files across four directories. It has never been committed at
any point in the repository's history.

**Why it matters.** Six citations of a document that does not exist is not
a typo anyone was going to notice by reading. The findings attributed to it
are real and are reproduced in `tests/validation/FINDINGS.md`; the
*document* is not in the repository.

**What F7 did:** added `scripts/check-docs.mjs` so this class of defect
fails a test rather than surviving indefinitely, and annotated the
citations in the authoritative documents. The historical records that cite
it are **not** edited — they are a record of what was true when written,
and rewriting a record to hide a broken pointer is worse than the pointer.

The reference is **declared** to the checker rather than hidden from it:
`KNOWN_MISSING` in `scripts/check-docs.mjs` names this exact path and the
reason, the checker reports the count of declared missing references on
every run, and it **fails if the file ever appears** — so the exception
cannot quietly outlive the problem. Nothing about this document's contents
is reconstructed or invented; only the citation is accounted for.

### D-11 — Frontend/modeling uncertainty is where the remaining pressure is

**What.** After excluding benchmark target-intelligence and configuration
artifacts, the analyzer-attributable `UNKNOWN` pressure in the real-world
corpus is concentrated in **frontend and modeling uncertainty**. Since
P1-B1 closed D-07 it is no longer dominated by one opaque token: it is
dominated by two named gaps, `unsupported_receiver_binding` and
`unsupported_callee_binding`, which together are 75% of the corpus's
graph-wide frontend occurrences and 90% of the ones that actually block a
verdict.

**This is a strategic signal, not a defect.** It is the evidence P1-B is
prioritized from. See [`SCORECARD.md` § 7.1](SCORECARD.md) for the
per-subtype measurement, and § 2 below for the distinction it rests on.

### D-12 — The frontend-gap ranking rests on one blocking case

**What.** Every one of the 42 frontend occurrences that actually blocks a
verdict in the real-world corpus comes from **a single case** (RWB-05),
where they collapse into 19 distinct call sites in 13 functions. The
graph-wide distribution spans 17 projects and 25 packages and is a far
broader sample, but it measures constructs the analyzer *meets*, not
constructs that *cost a verdict*.

**Why it matters.** The two columns rank the subtypes differently, and a
reader who takes either one alone as a work plan will be wrong in a
different direction. Worse, RWB-05's blockers sit in `qs`'s *stringify*
path while its vulnerable target is in the *parse* path — so RWF-002
reachability scoping could discharge all 42 without modeling anything.

**Not closeable by measurement.** It closes by the corpus gaining more
cases whose vulnerable target is genuinely behind a frontend gap, not by
re-reading the numbers already taken.

**Update — P1-B3 is direct evidence for this caution (RWF-042).** Block A
ranked FIRST on both columns and, once built, moved the blocking column by
**zero**. The reason is now measured rather than suspected: RWB-05's Block
A blockers concentrate in `qs/lib/stringify.js` (25 of 38) and
`get-intrinsic` (10), and their dominant shape is a PARAMETER — a value
arriving from every call site — which is higher-order propagation, not
named-binding resolution. Across the whole corpus, ~500 of Block A's 1,554
classifiable occurrences are that same parameter mode and ~600 more are
bindings that resolve perfectly well onto a value whose CONTENT belongs to
Block B or Block C.

The debt is therefore **wider than first written**: a subtype's rank does
not predict what building it will yield, because the subtype names the
SYNTAX that failed and not the MECHANISM that would fix it. A capability
block should be scoped from the semantic failure-mode inventory
(RWF-042 § 2), not from the occurrence table alone.

**Second update — the corpus is not a soundness oracle either (RWF-042
§ 17).** An independent audit blocked P1-B3's first implementation over
two classes of fabricated call edge. Both were invisible here: fixing them
moved the corpus by **zero** — no verdict, no proof, no edge, no
occurrence. The shapes that exposed them (a destructured parameter
shadowing an outer binding; an object literal with duplicate keys, a
spread, or a later `obj.m = ...` write) simply do not appear in these 17
projects.

This cuts both ways and the second way is the uncomfortable one. A green
corpus differential says nothing about soundness for shapes the corpus
lacks, so it can neither confirm nor deny a fabricated edge — and the one
behaviour that DID change was a negative proof in a unit fixture that
turned out to have been resting on three such edges. Adversarial unit
coverage is not a supplement to the benchmark here; for this class of
defect it is the only instrument that works.

**Third update — the corpus can stay green while a live false-`NOT_AFFECTED`
mechanism is removed (RWF-043, P1-B3b).** This is the sharpest datum of
the three, because it is not about shapes the corpus lacks. The corpus
CONTAINED the defect: 124 fabricated call edges across `lodash`,
`semver`, `lru-cache`, `yallist`, `fast-xml-parser`, `qs` and
`object-inspect`, including three where the analyzer resolved a call to
the wrong function outright. P1-B3b removed all of them and corrected 25
more that were pointing at the wrong target.

The corpus did not move. All 17 real-world verdicts are byte-identical
before and after — same verdicts, same proof families, same four
`NOT_AFFECTED` certifications, same six `AFFECTED` findings. The
benchmark's own blocker counts did not change either.

Meanwhile the defect being removed was demonstrably capable of producing
a false `NOT_AFFECTED` with a complete Family C proof — shown end to end
on a fifteen-line program in
`src/analysis/verdict.direct-call-binding-authority.integration.test.ts`.

So the caution has to be stated more strongly than "the corpus cannot see
shapes it lacks". **A green corpus differential is not evidence of
soundness even for a defect the corpus contains**, because whether a
fabricated edge reaches a verdict depends on where it sits relative to
the reachability search, not on whether it exists. Every one of those 124
edges was real, in real installed packages, on every scan — and not one
of them happened to sit on a proof-critical path in these 17 projects.
The next corpus, or the next advisory against the same corpus, has no
such guarantee.

The instrument that found this was an adversarial oracle written from the
MECHANISM (displace the blocker, certify the subgraph) rather than from
observed corpus behaviour. That is the only instrument that works for
negative-proof defects, and D-12's practical rule follows from it: a
soundness claim must be discharged by a test that reproduces the
mechanism, never by a differential that failed to notice it.

### D-13 — RWF-044: the positional order rule is wrong for deferred bodies

**What.** `named-bindings.ts` refuses a reference written textually above
the initializer that would give its name a value (P1-B3 § 9,
`used_before_initialized`). The rule reads STATEMENT order, but what
matters is EXECUTION order, and a function body does not execute at the
point it is written:

```js
function forEach(fn) {
  forEachStep(this, fn);        // refused — `forEachStep` is declared below
}
const forEachStep = (self, fn) => { /* ... */ };
```

`forEach`'s body only runs once something calls `forEach`, which cannot
happen before the module has finished initializing, so the initializer
has always completed by then.

**Class: precision, never soundness.** Every refusal costs an edge that
is correct in fact, and the failure direction is UNKNOWN — the direction
this engine is permitted to fail in. Nothing here can fabricate.

**Extent.** 85 call-graph edges across the real-world corpus, in
`fast-xml-parser`'s minified `lib/fxp.cjs` and in `lru-cache`/`semver`'s
class-heavy modules. They resolved before P1-B3b only because the
same-name matcher overrode B3's refusal — the analyzer was reaching the
right answer for a reason that was independently unsound (RWF-043), and
removing that reason removed these answers with it. No verdict in the
corpus depends on them today.

**Why it is still open.** Closing it means modeling deferred execution:
which function bodies can run during module load and which provably
cannot. A heuristic — "a reference inside a function body skips the order
check" — is wrong for an IIFE, for a function invoked during
initialization, and for a class static initializer, and shipping it would
reintroduce exactly the plausible-but-unproven reasoning P1-B3b removed.

**How to close it.** Reuse the module-load closure (D-06/RWF-002,
VT-307a), which already computes a closely related set, and exempt from
the positional check only a reference whose enclosing body is provably
outside it. Do **not** relax the order rule generally: it is what stops a
call above `const fn = danger` being attributed to `danger`.

Recorded in full as RWF-044 in `tests/validation/FINDINGS.md`.

### D-14 — A remediation introduced the defect class it was closing

**Not an open debt.** Both halves are fixed. It is recorded here because
the *pattern* is the debt, and the register is where this project keeps
the lessons that generalise.

**What happened.** RWF-046 replaced a file-wide, name-keyed import table
with declaration identity. Its own destructuring branch then named an
export with `element.propertyName ?? element.name` — the local
identifier's TEXT — for any binding element it accepted. For an array
element there is no property name, so:

```js
const [, run] = require("pkg");
run();                            // resolved to pkg#run
```

Array index 1, resolved by spelling. The base commit returns UNKNOWN, so
the fix introduced a fabrication of exactly the kind it was removing,
one layer in. Recorded as RWF-046a; closed by a shape boundary that
mirrors RWF-045's, clause for clause.

**Why the gates were silent, and why that is the point.** Every gate
passed: typecheck, 1356 foundation tests, 4375 unit/integration tests,
124 adversarial, and the RWF-046 suite's own 25 cases plus four mutation
controls. The corpus contains **zero** array-pattern requires, zero rest
elements and zero defaulted elements on a require pattern, so the graph
differential could not have seen it. After the remediation that
differential is still 13 edges, unchanged line for line.

**This is D-12's rule hitting the same project twice.** D-12 says a
soundness claim must be discharged by a test that reproduces the
MECHANISM, not by a differential that failed to notice it. RWF-046's
first implementation had mechanism tests — and every one of them bound a
name with an object shorthand or a rename, so the suite explored the
shape it had already got right. A differential of 13 edges and a suite
of 25 tests both pointed at the same blind spot and neither could see
it.

**Two practical rules this produced**, both now embodied in the § J
suite rather than left as advice:

1. **State the boundary, not the counterexample.** Gating on "not an
   array pattern" would have answered the audit and left the same
   substitution reachable through a rest element and a default. What the
   code must prove — a static, single-valued property of the module
   object — is the thing to write down.
2. **A negative test needs a fixture that can fail loudly.** Every
   package in § J exports every name its cases bind, so a regression
   RESOLVES. Against a package missing those names a fabrication
   degrades to `unresolved_target`, which is still `unknown` and passes
   a naive assertion — which is how a fabricating path hid behind
   green tests here.

**A guard belongs in exactly one place.** The shape checks were removed
from `symbol-binder.ts` when the boundary moved into
`named-bindings.ts`. A guard enforced in two layers is a guard whose
mutation test passes with either copy deleted, which is the same
false-comfort failure in miniature.

Recorded in full as RWF-046a in `tests/validation/FINDINGS.md`.

## 2. Target intelligence is not analyzer uncertainty

This distinction is the easiest way to produce a misleading benchmark
summary, so it is stated on its own.

`no_vulnerable_symbol_rule` is a **target-intelligence, configuration and
provider artifact**. It means *"this scan has no rule describing what the
vulnerable symbol of that advisory is"*. It is **not** evidence that the
JavaScript frontend could not understand the code — the frontend was never
asked.

In the real-world corpus it is the single largest reason by occurrence,
entirely because of how the corpus is built: each fixture configures
exactly one rule, the advisory under test, so every *other* advisory the
live OSV API returns for the same installed packages produces an `UNKNOWN`
meaning "this benchmark has no rule for that". Reporting that as frontend
failure would put permanent non-work at the top of a roadmap.

**Reporting convention.** Benchmark reporting carries a second,
orthogonal dimension alongside the uncertainty category:

| Remediation domain | Means |
| --- | --- |
| `frontend` | the analyzer saw the construct and does not model it |
| `target intelligence` | no rule, or no resolvable target, for the advisory |
| `metadata` | an identity or version fact was not established |
| `provider` | the candidate source could not answer |
| `budget` | a configured bound stopped the work |
| `unsupported capability` | a runtime escape nothing static can follow |

**This is reporting metadata only.** It is **not a seventh `UNKNOWN`
category**, it appears in no scan output, and no proof rule reads it. The
six-category taxonomy in [`ARCHITECTURE.md` § 6.1](ARCHITECTURE.md) is
unchanged.

## 3. P1-B entry criteria

Foundation is complete — and P1-B may start — when all of the following
hold. Note what is deliberately **not** required: that every known
limitation is fixed. Foundation's job was to make the guarantees explicit,
owned and measurable, not to make them total.

1. **F7's documentation and scorecard are accurate** — each contract
   describes what the code actually does, and every scorecard value comes
   from a measured or structural source.
2. **The Foundation gates are green** — `npm run test:foundation`, plus the
   full suite, adversarial, performance, typecheck, lint, format, build and
   `validate:history`.
3. **No open P0 or Foundation soundness blocker** — no known path to a false
   `NOT_AFFECTED` or a silently dropped finding.
4. **A benchmark baseline is recorded** — the real-world corpus has a
   measured, reproducible state that a later change can be compared against.
5. **The open debts are explicitly bounded** — every one named, with why it
   is not a blocker. That is this document.

## 4. P1-B initial direction

**Strategy, not implementation. Nothing below is built.**

**Step one is not to implement a construct.** It is to **split
`unsupported_construct` by syntactic and semantic shape** (D-07). Until
that exists, the ranking that would tell anyone which feature to build has
exactly one row in it, and that row names a catch-all.

The taxonomy is already built to absorb the split: new tokens drop into
`UNCERTAINTY_REASONS` under the same category, and the compile-time
exhaustiveness checks force each one to be classified.

**Step two is to let the benchmark evidence choose the feature work.**
Re-measure after the split, and take the top rows.

**Do not pre-commit** to callbacks, builtin modeling, framework support or
any other feature before that evidence exists. Each is plausible; none is
currently evidenced; and the whole reason the uncertainty taxonomy was
built was so that this decision could stop being made from intuition.
