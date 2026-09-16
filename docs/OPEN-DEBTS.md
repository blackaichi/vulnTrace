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

### D-07 — `unsupported_construct` is too coarse

**What.** `unsupported_construct` is the call graph's undifferentiated
catch-all for "a callee expression shape I have no rule for". It is the
whole of the corpus's top unmodeled-construct ranking.

**Why it matters.** Knowing there are 42 occurrences of it does not tell
anyone which syntax to implement. The measurement F3 exists to produce is
currently blocked on this one token, which is why decomposing it is P1-B's
first step (§ 4).

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

**What.** A file named REAL-WORLD-BENCHMARK-AUDIT-V0.1.md, under `docs/`,
is cited as a source by
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

### D-11 — Frontend/modeling uncertainty is where the remaining pressure is

**What.** After excluding benchmark target-intelligence and configuration
artifacts, the analyzer-attributable `UNKNOWN` pressure in the real-world
corpus is concentrated in **frontend and modeling uncertainty**, and is
dominated by the single coarse token in D-07.

**This is a strategic signal, not a defect.** It is the evidence P1-B is
prioritized from. See [`SCORECARD.md` § 7](SCORECARD.md) for the
measurement, and § 2 below for the distinction it rests on.

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
