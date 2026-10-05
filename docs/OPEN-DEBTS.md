# Known Open Debts, and the Entry Criteria for P1-B

**Authoritative.** Everything the project knows it has not finished, stated
specifically enough to act on. There is no entry here reading "technical
debt": a debt that cannot be named cannot be discharged, and a vague one
is indistinguishable from not knowing.

Companion documents: [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`SOUNDNESS-CONTRACT.md`](SOUNDNESS-CONTRACT.md),
[`SCORECARD.md`](SCORECARD.md).

**All but one of these is a blocker-free debt; D-16 is not.** § 3 says
what a blocker would be, and D-16 meets it: a known, reproduced path to a
false `NOT_AFFECTED` that is on `main` today. § 3 criterion 3 is annotated
accordingly rather than left to read as satisfied.

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

### D-03 — `npm test` is not offline — CLOSED by D-03

**What it was.** Four suites inside the default `npm test` run queried
the live OSV API unconditionally with no stub:
`src/vulnerabilities/osv-provider.integration.test.ts` (the only one this
entry originally named), `osv-normalizer.integration.test.ts`,
`version-matching.integration.test.ts` and `src/cli/scan.integration.test.ts`
(all four found by task `D-03`'s own premise check, AGENTS.md § D,
re-run after each suite found — this entry's original "What" undercounted
by three). `tests/validation/validation.test.ts`'s 17 cases queried live
OSV the same way, via `runScanCommand`'s default provider.

**Why it mattered.** A provider or network outage could turn the full
suite — and therefore CI — red for reasons unrelated to any change.
`npm test` was therefore not a deterministic oracle, and a live advisory
database could move a `test:validation` finding between two runs of
identical code, making its differential non-attributable to a change
under review.

**What closed it.** Task `D-03`: `scripts/record-osv-snapshot.mjs`
records real OSV answers once (`tests/validation/osv-snapshot.json` —
every query the real pipeline issues for every validation case, plus
`scan.integration.test.ts`'s own `lodash@4.17.4`, all captured by running
the real pipeline once with a recording provider wrapped around a real
`OsvProvider`, not guessed by hand; `src/vulnerabilities/osv-provider.fixtures.json`
— the two response envelopes the provider-level tests need). The new
`SnapshotOsvProvider` (`src/testing/snapshot-osv-provider.ts`) now serves
`validation.test.ts` and `scan.integration.test.ts` from that snapshot;
the other three suites stub `OsvProvider`'s own `fetchImpl` with the
recorded response bodies instead, keeping them exercising the real
`OsvProvider` request/response/zod-schema pipeline. `npm test` and
`npm run test:validation` are both fully offline. Verified: rerunning
`npm run test:validation` against the snapshot reproduced OPEN-DEBTS
D-09's five known failures exactly, case by case, for the same reason
each, with zero unexpected changes.

**What it did NOT do.** `npm run test:validation` is still not promoted
to a CI gate — five of its cases are deliberately kept failing (D-09) and
the suite asserts the expected verdict unconditionally, so it exits
non-zero by design regardless of network access; CI promotion needs a
separate decision (converting the five to an explicit "expected to fail"
form) and is a new backlog row, not part of this closure. A snapshot also
freezes what OSV said at recording time — re-running
`scripts/record-osv-snapshot.mjs` is how it tracks OSV database changes
going forward, not automatic.

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
than fixed away or re-scoped to match the tool. (Five until task A-3a,
which added `RWB-07`; six until task A-4, which restored it; see its
row.)

| Case | Expected | Actual | Cause |
| --- | --- | --- | --- |
| `RWB-03` | `AFFECTED` | `UNKNOWN` | RWF-006 — a webpack-bundled, getter-defined class export is not recognised as constructible/method-bearing. |
| `RWB-05` | `NOT_AFFECTED` | `UNKNOWN` | **D-06 (RWF-002)**. The target now resolves exactly; what blocks the proof is unresolved edges elsewhere in `qs`'s own real dependencies. |
| ~~`RWB-07`~~ | `NOT_AFFECTED` | `NOT_AFFECTED` since task A-4 (`UNKNOWN` from A-3a to A-4) | **Passing again since task A-4**, which admitted `JSON.parse`'s first position mechanically (`tests/oracle/builtin-admission.test.ts`): its hooks are protocol members and Proxy traps, accounted at their definitions since A-4. The history: **Task A-3a's fail-closed default, a sound precision cost.** `loadModernConfig(text)`, an exported function, hands its parameter to `JSON.parse`, whose first position coerces an object through `toString` / `Symbol.toPrimitive`: protocol hooks no position admission can cover before task A-4 accounts protocol members (ADR 0008's allowlist admission ruling, condition (b)). REMEDIATION-PLAN § 5a anticipated it; A-4 must re-admit the position ("A-3a additions"). |
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

### D-14 — RWF-046: a function-local `require` binds at FILE scope

**What.** `source-index.ts`'s `extractRequireBindings` keys a `require()`
binding on its `localName` in a file-level import table, with no scope
attached. A `require` written inside a function body is registered as
though it bound at module scope, so two functions binding the same local
name to different specifiers collapse onto whichever was indexed first:

```js
function a() { const { run } = require('./safe.js');   return run(); }
function b() { const { run } = require('./danger.js'); return run(); }
```

Both calls resolve to `safe.js#run`. `b`'s edge is fabricated.

**Class: soundness, both directions.** By the displacement argument
D-12/RWF-043 established, the wrong resolved edge REPLACES the honest
`unknown` one, so it can withdraw the blocker that withholds
`reachableSubgraphComplete` as readily as it can invent an exposure.

**Not destructuring-specific.** The non-destructured form
(`const mod = require('./danger.js'); mod.run()`) collapses identically.
That is precisely why RWF-045 did not fix it: RWF-045 owns the
destructuring bridge's pattern SELECTION, and this defect lives in the
import table underneath it. Fixing it there would have overstated
RWF-045's closure.

**How to close it.** The same move that closed RWF-043 and RWF-045: key
the binding on its DECLARATION and resolve references through the shared
lexical authority in `named-bindings.ts`. That module already refuses such
a reference with cause `import_binding`, so the work belongs on the
symbol-binder side of that refusal — not in a second resolver.

Do **not** close it by restricting the import table to top-level requires.
Most function-local requires are genuinely unambiguous, and dropping them
trades a soundness defect for a large precision loss.

Recorded in full as RWF-046 in `tests/validation/FINDINGS.md`.
### D-15 — A remediation introduced the defect class it was closing

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

**What this does to § 3 criterion 3**, which requires *no known path to
a false `NOT_AFFECTED` or a silently dropped finding*. Two separate
answers, and they differ:

- **The INTRODUCED array fabrication never violated it.** It existed
  only on an unmerged branch, between the first RWF-046 implementation
  and the audit that found it. Criterion 3 is a statement about
  Foundation — about `main` — and `main` never carried this defect. The
  register was not wrong about the state it describes.
- **Five PRE-EXISTING defects WERE on `main` while the criterion read
  as satisfied** (RWF-046b: computed, numeric and string-literal
  property keys resolving by local text, a defaulted element resolving
  two runtime values to one target, and a reassigned destructured
  binding keeping stale provenance). Each is a fabricating-direction
  defect, and by RWF-043 § 1's corrected reasoning a fabricated edge
  displaces the honest `unknown` blocker, so each was a path to a false
  `NOT_AFFECTED`. They were unknown, not tolerated — but criterion 3
  says *no known path*, and "known" is a fact about what has been
  looked for, not about what is there.

So the criterion held as written and did not hold as intended, and the
gap between those two readings is the interesting part. It was closed
by an audit sweeping a grammar exhaustively, not by the corpus
differential, which had zero instances of all five shapes and reported
no movement for any of them. The honest conclusion is not that the
criterion was violated but that **it cannot be discharged by a
differential**, which is D-12's rule arriving for the third time.

**The class is now the thing to gate, not the instances.** Local text
standing in for a resolved name has now been found and closed in four
independent locations — RWF-043, RWF-045, RWF-046, and RWF-046a/046b —
each discovered only after the previous one was fixed. Four is enough
to stop treating them as coincidences. See RWF-046b in
`tests/validation/FINDINGS.md` for the site-by-site table.

Recorded in full as RWF-046a in `tests/validation/FINDINGS.md`.

### D-16 — RWF-047: a member write on a require-bound module object is not modelled, and it is a live path to a false `NOT_AFFECTED`

**OPEN, and it is a soundness blocker.** Unlike D-14 and D-15, this one is
not a closed lesson. It is on `main` today.

**What.** `call-graph.ts`'s `resolveNamedReceiverBinding` consults
`named-bindings.ts`'s `isMemberAssignedWithin` before reading a member off
an OBJECT-LITERAL receiver, because a `const` binding to an object literal
freezes the BINDING and not the OBJECT. A require- or import-bound module
object has exactly the same property — `const` freezes `mod`, not
`mod.run` — and the require/import resolution path consults no equivalent
check.

```js
const mod = require("pkg");
mod.run = patched;
mod.run();            // the analyzer says pkg#run; node calls patched
```

**Classified as CLASS B** — correct binding identity, wrong runtime-value
semantics. The binding of `mod` is entirely right: the right declaration,
the right module, the right install. What is wrong is that the module's
*static export table* is substituted for the *runtime value of a property
on a mutable object*. It is not class A (no local text reaches an export
name here — asserted positively against a fixture that exports `patched`,
so a text fabrication would have been loud) and not class C (nothing is
collapsed: with the write unconditionally above the call there is exactly
one runtime value, it is determinate, and the analyzer never held it).

**Why it is a blocker and D-14/D-15 were not.** Both directions reproduce
end to end on `main`, with no production change:

- **false `AFFECTED`** — `AFFECTED` published on a RESOLVED edge into an
  export the program overwrote before calling;
- **false `NOT_AFFECTED`** — `NOT_AFFECTED` published with a **complete
  Family C proof** (`reachableSubgraphComplete: true`, zero unresolved
  edges in the whole graph) over an export real `node` executes.

The second is the displacement mechanism of RWF-043 § 1: the stale
attribution does not merely name the wrong callable, it supplies a
RESOLVED edge where the honest answer is unresolved, removing the
`unknown` blocker that would have withheld the negative proof. A control
that changes only the receiver to a local object literal breaks the chain
at exactly that link.

**Reach.** Seven of ten measured module-receiver shapes reach it: plain
assignment, `Object.defineProperty`, `delete`, a write through an alias, a
write inside a called function, a write at module scope, and an ESM
DEFAULT import of a CommonJS module. An ESM *namespace* import does not,
and for the runtime's reason rather than the analyzer's: a Module
Namespace object is sealed, so the write is a `TypeError` and no
displacement is possible.

**Prevalence, measured** (instrument:
`tests/binding-grammar/require-member-write-prevalence.mjs`): 33
occurrences in 4,383 files of this repo's installed npm tree (`ajv`,
`isexe`, `prettier`, `zod`); 97 in the 422 files of the 17-case validation
corpus. **No corpus case's verdict moves today**, and that is a fact about
the corpus rather than about the defect: 96 of the 97 are `node-forge`
assembling its whole public API by writing members onto the object from
`require('./forge')` — including `pki`, through which RWB-06's advisory
target `node-forge#pki.verifyCertificateChain` is reached — but RWB-06 and
RWB-06A are both proved `NOT_AFFECTED` by **Family A**, established before
the call graph is consulted at all. Per D-12 that silence is not evidence
of safety.

**Not fixed here, deliberately.** RWF-047's record required the class to
be established before a fix was attempted, because the fix differs by
class: a class-B soundness defect needs the invalidation extended to
require/import-bound receivers *plus* an audit of every other receiver
whose members are read without an invalidation check. That audit is not
done, and which other receivers share the gap is not measured.

**What this does to § 3 criterion 3.** It breaks it, and this time
without any of D-15's qualification.

D-15 could argue that criterion 3 "held as written and did not hold as
intended", because the defects on `main` were unknown and the criterion
says *no known path*. **That argument is not available now.** The path is
known, it is reproduced by committed tests, it is on `main`, and it is
recorded here. Criterion 3 as written — *no known path to a false
`NOT_AFFECTED` or a silently dropped finding* — is **false on `main` as
of this commit**.

That assertion has now been wrong twice: once in substance while reading
as satisfied (D-15's five pre-existing RWF-046b defects), and once
outright, here. The pattern across D-15 and this entry is the same one
D-12 names: a criterion about the absence of a defect class cannot be
discharged by any differential, and it has not once been falsified by one.
RWF-046b was found by sweeping a grammar; RWF-047 was found by sweeping
the same grammar and then asking what happens to the OBJECT after it is
correctly bound. Both times the corpus reported no movement.

Recorded in full, with both reproductions, the real-`node` ground truth
and the widening table, as RWF-047 in `tests/validation/FINDINGS.md`.

### D-17 — Three read-only audits found ~70 further reproduced defects; the soundness contract does not hold on `main`

**OPEN. Documentation only — recorded by task `record-soundness-audits`;
no code changed.**

**What ran.** Three read-only investigations, reproducing everything end
to end against real Node on `main` (`ea5d25b` for the independent audit;
`62b52b9` for both premise-sweep rounds — main did not move between the
two rounds): an independent audit (`AUD-01`…`AUD-16`) and two rounds of a
sweep checking every "this cannot happen because…" code comment in the
call-graph, module-model, loader and intake layers against a real scan
and real Node (`PRM-01`…`PRM-116`). Nothing was committed, branched or
edited by any of the three; every finding is a synthetic-fixture
reproduction with a positive control, a negative control and a
loud-fixture assertion (every reproduction requires the fixture package
and asserts every bound name really is a function, so a fabricated
target would fail loudly rather than degrade to a quiet `UNKNOWN`).

**What was found, by failure class** (see `tests/validation/FINDINGS.md`
for the full register; each finding below is one row there):

Counted programmatically from the register's own failure-class field (a
finding carrying more than one failure class — for example `AUD-05`,
silent drop in one direction and false `AFFECTED` in the reverse — is
counted once in each row it belongs to, so rows do not sum to 67):

| Failure class | Count | IDs |
| --- | --- | --- |
| false `NOT_AFFECTED` | 46 | `AUD-01,02,03,04`; `PRM-12..33,37,38,60,61,62,63,101..109,112..116` |
| silent drop | 11 | `AUD-05,06,07,08,09,10`; `PRM-34,64,65,66,111` |
| false `AFFECTED` | 6 | `AUD-05,13,14`; `PRM-25,61,107` |
| false reason | 4 | `AUD-12,15`; `PRM-36,110` |
| scan abort | 2 | `AUD-11`; `PRM-35` |
| disclosure | 2 | `AUD-16`; `PRM-67` |

`PRM-01`…`PRM-10` are KNOWN aliases of `AUD` findings, and
`PRM-11` is a second surface of `RWF-047` (D-16) — neither is counted
again above. Round 1's `PRM-40`…`PRM-52` and round 2's `T-1`…`T-12` are
TRUE premises, not findings, and round 2's `U-1`…`U-4` are UNVERIFIED
suspicions, not reproduced — neither group is registered.

**Why this is not a corpus differential.** Every finding above is a
synthetic minimal-fixture reproduction, not a real-world package. Per
D-12, a zero real-world differential is not evidence of safety, and
these findings do not move one — they are evidence about the analyzer's
own semantic model, independent of what the current 17-case validation
corpus happens to contain. `AUD-01`'s callback mechanism and `PRM-105`'s
capability-receiver mechanism are exactly the kind of gap D-12 says the
corpus is not shaped to surface.

**What this does to § 3.** See the addendum appended to criterion 3,
below. Read plainly: the soundness contract does not hold on `main`
today, in far more places than `RWF-047`/D-16 alone.

**Not fixed here, deliberately.** This task is documentation only, per
its own boundaries. A remediation design is understood to be in
progress in a separate, not-yet-merged effort; this entry does not name
it by path, because it is not on `main` yet and `check-docs.mjs` would
fail a reference to a file that does not exist here.

**Not acted on.** Neither of the two unnumbered mechanisms in round 1
§ 5 (tagged templates; implicit protocol invocations) nor RWF-026's
inherited MAY-execute conditional-operand gap (now `RWF-050`,
UNCLASSIFIED) is counted in the table above as a *settled* finding in
the same sense as the numbered `AUD`/`PRM` entries: the first two are
newly-numbered (`PRM-37`, `PRM-38`) but otherwise measured exactly like
their siblings, so they ARE counted; `RWF-050` is not, because it was
not independently reproduced by any of the three audits and is recorded
UNCLASSIFIED rather than FALSE.

**Pointer, added by task `remediation-reconciliation` (2026-09-26).** The
remediation design this entry declined to name by path when it was
written is now on `main`: `docs/REMEDIATION-PLAN.md` maps every finding
counted above to the invariant or point-fix task that closes it, and
`docs/adr/0008`-`0011` design the four structural invariants (lanes A, E,
C, V). `REMEDIATION-PLAN.md` § 6.1 records the project owner's 12 policy
decisions for the design, and § 5a its single sequential implementation
schedule. None of it is implemented yet; this entry's "the soundness
contract does not hold on `main` today" therefore still stands.

**Updated counts, added by task `A-0` (2026-09-27).** Task A-0
(`docs/tasks/A-0-adr0008-coverage-reproduction.md`) registered three
more findings in `tests/validation/FINDINGS.md`: `PRM-117` (false
`NOT_AFFECTED`), `PRM-118` (false `AFFECTED`) and `RWF-051` (tooling).
Its eleven other false-`NOT_AFFECTED` reproductions are attached to
`AUD-01` and add no finding. Counted the same way as the table above,
from the **Failure class** field of each `AUD`, `PRM` and `RWF-051`
section in the register (70 findings; a finding with more than one
class is counted in each of its rows):

| Failure class | Count | IDs |
| --- | --- | --- |
| false `NOT_AFFECTED` | 47 | `AUD-01,02,03,04`; `PRM-12..33,37,38,60,61,62,63,101..109,112..117` |
| silent drop | 11 | unchanged |
| false `AFFECTED` | 7 | `AUD-05,13,14`; `PRM-25,61,107,118` |
| false reason | 4 | unchanged |
| scan abort | 2 | unchanged |
| disclosure | 2 | unchanged |
| tooling | 1 | `RWF-051` |

`PRM-118` is a fabricated call edge, and a false `AFFECTED`, not a false
`NOT_AFFECTED`. It is counted because AGENTS.md § E makes a fabricated
edge a soundness defect. `RWF-051` is a gate gap, not a verdict defect:
the type-level half of a test guard under `tests/` is enforced by no
gate. The table above is left as it was measured. The project owner
accepted ADR 0008's Amendment A-0 on 2026-09-27; `PRM-117` and `PRM-118`
are mapped in `docs/REMEDIATION-PLAN.md` § 2.5, and `RWF-051` is § 5a
order 1b. None of it is implemented, so this entry still stands.

**Progress, added by task `A-1` (2026-09-28).** The first lane-A task
(`docs/tasks/A-1-invocation-account.md`) fixed three of the 47 false
`NOT_AFFECTED` findings above: `PRM-19` (implicit `super`), `PRM-37`
(tagged templates) and `PRM-115` (decorators), each reproduced against
real Node and failing on the base commit first. It also found and fixed
`RWF-057`, a false `NOT_AFFECTED` through family A that none of the three
audits reported (a `vm` loader used as a tagged template's tag). Its
independent audit found two more false `NOT_AFFECTED` findings that
predate it and are not fixed here: `RWF-060` (an implicit constructor
forwarding a callback into an ambient or builtin base, routed to A-3) and
`RWF-061` (a `vm.Script` reached through a subclass or factory, family A,
backlog `BL-037`) and `RWF-062` (`new A()` resolved to a constructor
overload signature, backlog `BL-038`). The tables above are left as measured; 44 of their 47
false `NOT_AFFECTED` findings remain open, plus these three. The no-edge branches the call graph still takes
without a proof are now named in code (`UNPROVEN_NO_EDGE_LEDGER`,
`src/domain/graph.ts`), each with the open findings it carries (`AUD-01`,
`AUD-02`, `PRM-12`, `PRM-14`, `PRM-15`, `PRM-117`, `RWF-060`) and the
lane-A task
that removes it. This entry still stands.

**Progress, added by task `A-3a` (2026-10-01).** Task A-3a
(`docs/tasks/A-3a-escaped-values.md`; backlog `A-3` split into A-3a and
A-3b by the project owner) fixed `AUD-01`, `PRM-12`, `PRM-114`,
`PRM-117` and `RWF-060`: ADR 0008 § 2's escape row, § 3's fail-closed
default and § 4's documented invoking builtins, with the non-invoking
allowlist admitted mechanically by a real-Node test run in CI. 26 new
real-Node reproductions fail on the base; the A-0 records for `S1`, the
enumerable descriptor and `S3` are closed. Two unproven no-edge reasons
are gone (`builtin_module_callee`, and `ambient_global_callee` for every
root but the CommonJS module-scope bindings, now `module_scope_callee`,
task A-3b); the builtin no-edge accounts are backed by proofs. It found
`RWF-063` (a builtin object monkeypatched through a parameter or a
container, predating it; the `const`-alias form fixed here, the rest
backlog `BL-039`) and `RWF-064` (the builtin probe could not see a
deferred hook; fixed in part: a hook only a structured argument reaches
is still beyond it, so admission also rests on reading the
implementation). Its independent audit blocked the first version on four
findings (builtin names outside the escape row's list, operator operands
given resolved edges, a destructured builtin name, an admitted position
with a structured-argument path), all fixed in the same task. Its
precision cost before A-4 is measured in its
report: one validation case, `RWB-07`, `NOT_AFFECTED` → `UNKNOWN` (D-09).
This entry still stands.

**Progress, added by task `A-3b` (2026-10-02).** Task A-3b
(`docs/tasks/A-3b-own-exports-jsx.md`, the second half of `A-3`) fixed
`AUD-02` (a module calling its own export) and `PRM-116` (a JSX element
calling its factory), both through the fail-closed default by the
project owner's decisions of 2026-10-02: an own-export call gets an
unknown `own_export_call` edge until lane E's write set can resolve it
(backlog `BL-042`), and a JSX site its factory's unknown edge plus
possible edges to the component and the functions it hands over, the
factory unresolved (backlog `BL-041`). The last unproven no-edge reason
on the builtin side, `module_scope_callee`, is gone;
`UNPROVEN_NO_EDGE_LEDGER` names only task A-5's two. It found and fixed
`RWF-066` (the automatic JSX runtime's implicit `require` of
`jsx-runtime`, a family-A false `NOT_AFFECTED`), and found `RWF-065`
(`module.parent.require`, a family-A false `NOT_AFFECTED` predating it;
families B and C now fail closed, family A is backlog `BL-040`). Its
independent audit blocked four times, each time on a JSX-runtime or
classic-factory rule that let family A certify a module load away (all
fixed in the task), and found `RWF-067` (a loader capability escaping
through a for-of destructuring assignment, family A, predating it;
backlog `BL-043`). 20 real-Node reproductions, each a false
`NOT_AFFECTED` on the base or on the version the audit found it on. The corpora measure none of
it: the graph, proof and verdict differentials are zero over all 139
cases, because no corpus file contains JSX and no corpus site reached
`module_scope_callee` (`debug`, the one corpus package calling its own
exports, reassigns `exports`, so its calls already had unknown edges).
This entry still stands.

**Progress, added by task `A-4` (2026-10-04).** Task A-4
(`docs/tasks/A-4-protocol-members.md`) fixed `PRM-38`, `PRM-112` and
`PRM-113` (protocol members the runtime invokes implicitly: coercion,
thenables, iterators, `instanceof`, `for await`) through ADR 0008 § 2's
protocol-member row, and `PRM-118` (an accessor body attributed to its
enclosing owner, a fabricated path) through Amendment A-0 part B: an
accessor is its own node, reached by a possible edge. It found and fixed
`RWF-068` (the iterator's own `next` / `return` / `throw`, which the ADR's
list omitted), by the project owner's decision of 2026-10-04; and, by the
second decision, an unattributable value stored under a key the analyzer
cannot read fails closed. The census has no `pending` kind left. It
re-probed the builtin positions a protocol hook had kept off the
allowlist and admitted those the mechanical admission test passes, which
restored `RWB-07`'s correct `NOT_AFFECTED` (D-09 now has five known
failures). 42 real-Node reproductions, each wrong on the base (36 false
`NOT_AFFECTED`, 6 `AFFECTED` through an accessor body or name). Its
independent audit blocked on an `EventEmitter` admission, a by-name root
binding an accessor and module-namespace exports (three times: then
exports written after their declaration, then a `var` redeclaration),
all fixed, and found `RWF-069` (an
admission path the builtin probe cannot build, backlog `BL-045`) and
`RWF-070` (`await` constructs a promise's `constructor` /
`Symbol.species`, a family-C false `NOT_AFFECTED` outside the protocol
list, backlog `BL-046`). Over the 139
corpus cases: verdict differential 1 (`RWB-07` `UNKNOWN` → `NOT_AFFECTED`,
its expected verdict), proof 2, graph 21. This entry still stands.

**Progress, added by task `A-5a` (2026-10-05).** Task A-5a
(`docs/tasks/A-5a-resolution-authority.md`; backlog `A-5` split into A-5a
and A-5b by the project owner) applied ADR 0008's resolution authority
(A2) on the call-graph side. It fixed:

- `PRM-13`: VT-213's resolved edge to an inline callback is deleted.
- `PRM-14`: loose equality is folded only for same-type literals.
- `PRM-15`: a static `require` gets no edge only for the lexically proven
  ambient `require` of a proven CommonJS module, and the import
  extraction binds a name only through it.
- `PRM-16` / `PRM-17`: VT-210 refuses an escaping function, a written
  parameter, `arguments` / `eval` / `with` and a JSX file.
- `PRM-104`: a reassigned function declaration is no longer its
  declaration.

It found and fixed `RWF-071` (a spread before a VT-210 parameter),
`RWF-072` (a member written as a destructuring or `for…of` target) and
`RWF-073` (a TypeScript `this` parameter).

`UNPROVEN_NO_EDGE_LEDGER` is deleted: every no-edge account now carries
one of ADR 0008 § 2's four proofs.

By the project owner's decision, ADR 0008 § 4's receiver-bound invoking
builtins (array iteration methods on an array literal, `then` / `catch` /
`finally` on `Promise.resolve()` / `Promise.reject()`) give a resolved
edge on a proven receiver. That keeps ADV2-018 and ADV2-024 `AFFECTED`
without VT-213, whose zero cost in ADR 0008 § 5 was measured on a
prototype that kept its fabricated edge.

45 real-Node reproductions: 34 were unsound on the base (27 false
`NOT_AFFECTED`, 7 fabricated `AFFECTED`). Its independent audit blocked
three times, on wrapped writes, the CommonJS wrapper's `arguments`, ES
modules (by syntax, by a top-level `await`, by a redeclared wrapper
parameter) and a TypeScript `this` parameter, all fixed.

Over the 139 corpus cases: verdict differential 0, proof 2 (reasons
added, verdicts unchanged), graph 13. This entry still stands; PRM-18
(VT-208) is A-5b's.

**Progress, added by task `A-5b` (2026-10-05).** Task A-5b
(`docs/tasks/A-5b-receiver-member-writes.md`) closed `PRM-18`: VT-208's
checker-typed receiver is replaced by the receiver authority of the
project owner's decision of 2026-10-04 -- a stable class for a static
call, a `const` bound to `new C()` for an instance call, over a chain of
plain class declarations -- and a resolved method edge is withdrawn to
`receiver_member_written` when any prepared file may write the member (an
assignment, a dynamic key, `__proto__`, `with`, a reflective mutator).
29 real-Node reproductions: 12 false `NOT_AFFECTED` on the base, all
`UNKNOWN` on the branch. 45 mutations, each caught by a named test. Its
independent audit blocked once, on a `__proto__` key copied by
`Object.assign` and on a written class export slot (a regression the
branch had introduced); both fixed.
Over the 139 corpus cases: verdict differential 0, proof 0, graph 3 (134
resolved edges withdrawn, most of them `this` receivers in RWB-03 and
RWB-09a/b). It found `RWF-074` (VT-214's object-literal member check
misses `with` and writes from other files, a family-C false
`NOT_AFFECTED`; backlog `BL-048`). This entry still stands.

**Progress, added by task `A-6` (2026-10-05).** Task A-6
(`docs/tasks/A-6-binder-resolution-authority.md`), the last of lane A,
closed `PRM-20`: `bindCallee` binds a callee only when the binding and the
chain's leading members name one export and no member is read after it,
at every site that resolves a callee through the binder (a call, a tag, a
decorator, a `new`, an `extends` base, a VT-214 alias). ADR 0008's single
trailing `.call` / `.apply` is kept for a function export only, and
withdrawn by task A-5b's whole-graph member-write check; read literally,
the exception was itself a false `NOT_AFFECTED` (`RWF-075`, found and
fixed here). It fixed `PRM-108`'s origin: a destructured require is named
by its key's exact text (identifier, string, computed string literal); an
unreadable computed key keeps the base's local-name row until task C-4
fails closed on it, because dropping it was a regression (two base
`UNKNOWN`s turned false `NOT_AFFECTED`; the independent audit's finding 1,
fixed before review). 32 real-Node reproductions: 18 false `NOT_AFFECTED`
and one fabricated `AFFECTED` on the base are `UNKNOWN` on the branch; two
remain false `NOT_AFFECTED`, as on the base, as open-soundness-defect
records (`{ [k]: f }`, PRM-108's consumer; RWF-077). The audit also found
`RWF-076` (an ES module's default import read as CommonJS interop) and
`RWF-077` (a destructured loader through `.call`), both pre-existing
(backlog `BL-050`, `BL-051`). Eight mutations, each caught by a named
test.
Over the 139 corpus cases: verdict differential 0, proof 0, graph 0 --
the corpora hold no trailing chain past a package export, so the oracle
cases are this task's measurement (a zero corpus differential is not
evidence of soundness, D-12). This entry still stands.

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

   > **This criterion is NOT satisfied on `main` as of RWF-047's
   > classification.** D-16 records a known, reproduced path to a false
   > `NOT_AFFECTED`: a member write on a require-bound module object keeps
   > the stale attribution, which displaces the honest `unknown` blocker and
   > lets a complete Family C proof certify a subgraph the program really
   > leaves. It is on `main`, it is covered by committed tests, and it is
   > not fixed. Stated plainly rather than qualified: the criterion is
   > false, not merely at risk. It has now been wrong twice — see D-15 for
   > the first occasion, where the defects were real but unknown and the
   > criterion could still be read as holding as written. That reading is
   > not available here.
   >
   > **Addendum, added by task `record-soundness-audits`.** Three
   > read-only audits (D-17) reproduced a further 46 false `NOT_AFFECTED`
   > findings, 11 silent drops, 6 false `AFFECTED`, 4 false reasons, 2
   > scan aborts and 2 disclosure defects, end to end against real Node
   > — none of them `RWF-047`/D-16, and none of them a corpus
   > differential. Stated plainly: **criterion 3 is false on `main`, and
   > has been in far more places than D-16 alone recorded.** The
   > false-`NOT_AFFECTED` and silent-drop families are the ones
   > criterion 3 names by name; see D-17 and
   > `tests/validation/FINDINGS.md` for the full register.
4. **A benchmark baseline is recorded** — the real-world corpus has a
   measured, reproducible state that a later change can be compared against.
5. **The open debts are explicitly bounded** — every one named, with why it
   is not a blocker. That is this document.

## 4. P1-B initial direction

**Strategy, not implementation. Nothing below is built.**

> **Blocked, added by task `record-soundness-audits`.** Criterion 3
> above is false on `main` (D-16, D-17): call-graph edges (`AUD-01/02`,
> `PRM-12..24,37,38,60,101,104..116`), export attribution
> (`PRM-26..32,61,62,63,103`) and receiver/capability resolution
> (`PRM-18,20,21,22,33,105..109`) are exactly the areas this section's
> feature work would touch. Building callback modeling, builtin
> modeling, framework support, or any receiver-modeling work here on top
> of a call graph and export model with dozens of known, reproduced
> fabrication/omission paths would build coverage on a foundation the
> soundness contract does not hold for. **This section's feature work is
> blocked until the soundness remediation that D-17's findings motivate
> has closed.** The taxonomy-split step (`unsupported_construct`, D-07)
> is not itself blocked — it changes no analyzer behavior — but taking
> its ranking's top rows into implementation is.

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
