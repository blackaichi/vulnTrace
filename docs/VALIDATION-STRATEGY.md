# VulnTrace Validation Strategy

This document defines `tests/validation/` as VulnTrace's real-world CVE
benchmark: what it is for, how a case is authored and maintained, and the
metrics used to judge the analyzer against it. It complements, and does not
replace, `docs/SDD.md § 31` (Testing Strategy) and `docs/COMPETITIVE-ANALYSIS.md`
(which anticipates this exact benchmark under "Competitive validation
requirement").

## 1. Purpose

Every other test suite in this repository (unit, integration, fixture,
end-to-end, and the two adversarial suites) exercises **synthetic** code
against a **stubbed** vulnerability provider. That is deliberate: it isolates
the analyzer's own mechanisms (module resolution, call graph construction,
reachability, verdict assignment) from the unpredictability of real-world
code and a live network dependency.

`tests/validation/` exists to answer a different question: **does VulnTrace
produce correct verdicts on real, previously-published CVEs/GHSAs, in real,
unmodified, npm-installed open-source packages, using the real, live OSV
API?** Synthetic fixtures are authored to be resolvable; real packages are
not authored with VulnTrace in mind at all. Real-world export idioms (UMD
boilerplate, deep property assignment, re-export chains, build-tool output)
are exactly the class of gap the adversarial suites cannot find by
construction, because nobody wrote an adversarial fixture for an idiom they
didn't know to think of. This suite exists to find those gaps before a real
user does.

## 2. Adversarial validation vs. real-world validation

| | Adversarial (`tests/adversarial/v1`, `v2`) | Real-world (`tests/validation/`) |
|---|---|---|
| Code under test | Synthetic, hand-authored fixtures | Real, unmodified npm packages |
| Vulnerability provider | Stubbed (`VulnerabilityProvider` fake) | Real, live OSV API |
| Purpose | Probe specific analyzer mechanisms; catch regressions | Find real-world gaps the analyzer's own authors didn't anticipate |
| Coverage strategy | Deliberately broad — every named category/mechanism gets a scenario | Deliberately narrow and slow-growing — one case per confirmed real CVE reproduction |
| Expected pass rate | 100% is the standing bar; any regression is a bug | Not expected to be 100%; `knownFailure` cases are tracked, not hidden |
| Network access | None | Required (live OSV query per case) |
| CI gate | Yes (`npm run test:adversarial`, wired into CI) | Not yet (see § 8) |

Both suites share the same non-negotiable discipline (carried over directly
from the adversarial suites, see `tests/adversarial/v1/README.md` /
`v2/README.md`): the oracle is authored independently of the tool's own
output, and a disagreement is recorded as a failing, tracked case — never
silently adjusted to make the suite pass, and the analyzer is never changed
just to make a case pass.

## 3. Case lifecycle

1. **Select a real CVE/GHSA** with a package version still installable from
   npm (or vendorable from the npm registry tarball) and a clear, specific
   vulnerable symbol named in the advisory (a function, method, or export —
   not just "the package").
2. **Build a minimal reproduction fixture** under `tests/validation/fixtures/`:
   the real package (pruned to the files resolution actually needs — see
   § 6), a real `package.json`/`package-lock.json` pinning the exact
   vulnerable version, and the minimum application source needed to either
   exercise or deliberately not exercise the vulnerable symbol.
3. **Author the expected verdict independently** (§ 4) — by reading the
   advisory and the real vulnerable code path, before ever running
   VulnTrace against the fixture.
4. **Run the suite.** If VulnTrace agrees with the oracle, the case is added
   with `knownFailure: false`. If it disagrees, the case is still added —
   with `knownFailure: true` — and a root-cause entry is added to
   `tests/validation/FINDINGS.md` (§ 7) in the same run, not deferred.
5. **A case is never deleted to make the suite look better.** A case only
   leaves `cases.json` if the underlying advisory is retracted or the
   fixture is proven non-reproducible (e.g. the vulnerable version becomes
   unavailable from the registry).
6. **A `knownFailure` case is only flipped to `false`** once a real fix
   lands and the case is re-verified to pass — never by editing the
   expected verdict.

## 4. Expected verdict authorship

The `expected` field in `cases.json` and the `reason` behind it MUST be
derived by:

1. Reading the real advisory text (GHSA/CVE) to identify the named
   vulnerable behavior.
2. Reading the real vulnerable package's source to confirm which exported
   symbol(s) implement that behavior.
3. Reading the fixture's own application source to determine, as a human
   security analyst would, whether that symbol is genuinely reachable.

Never derive `expected` by running VulnTrace first and copying its output.
This is the same rule the adversarial suites' `expected.json` follow, and
for the same reason: an oracle that echoes the tool under test cannot
detect the tool's own mistakes.

## 5. Advisory evidence

Each case records:

- `vulnerability` — the primary advisory id used to query OSV and match
  findings (`findingSelector.vulnerability`).
- `aliases` — other ids (CVE, other GHSA ids) known to refer to the same
  advisory. Real OSV data can carry multiple, mutually-aliased ids for one
  vulnerability (confirmed live for VAL-001's GHSA-35jh-r3h4-6jhm /
  GHSA-r5fr-rjxr-66jc pair) — `aliases` documents this for a human reader;
  `findingSelector` still keys on the one primary id actually used.
- `advisoryUrl` — a direct link to the OSV record, so the advisory text
  cited in `reason` can be independently re-checked at any time.

## 6. Vulnerable-code-path evidence

Each case records `vulnerableTarget` — a human-readable description of the
real exported symbol the advisory names as vulnerable — and ships a real
`rules.yml` in its fixture directory, in the same `VulnerableSymbolRule`
format `rules/vulntrace-rules.yml` uses for production. This keeps the case
reproducible as actual analyzer input, not just prose: the rule that drives
the real scan is committed, not reconstructed from the description at
review time.

## 7. Package/version information and reproducibility requirements

A case is only reproducible if a future run — on a different machine, at a
different time — produces the same scan, independent of npm registry or
OSV database drift. Current cases achieve this via:

- a real, committed `package.json` + `package-lock.json` pinning the exact
  vulnerable version;
- the real installed package **vendored under `node_modules/` in the
  fixture directory itself**, so no `npm install` is required (and no
  future registry change can alter what's scanned) — pruned to only the
  files scan resolution actually touches, with pruning verified beforehand
  to produce byte-identical scan behavior to the full install;
- `findingSelector` keyed on package + version + advisory id, disambiguating
  the case where OSV returns multiple findings for the same package/version
  (§ 5).

The one deliberately *non*-pinned input is the OSV query itself
(`tests/validation/validation.test.ts` uses the real `OsvProvider`, no
stub) — this is intentional (§ 2), but it does mean a case's outcome can
theoretically shift if the advisory's own OSV record is edited after the
fact. This risk is accepted, not yet mitigated; see the proposed
`advisoryFetchedAt` field below.

### Proposed case metadata fields (not yet implemented)

The three current cases (`VAL-001`..`VAL-003`) do not yet need these, but a
larger benchmark will. These are documented here as the agreed shape for
when case count grows, not implemented now — adding them to the existing
three cases with no new information to put in them would be a paper change,
not a real one:

- `advisoryFetchedAt` — ISO date the advisory was last read while authoring
  `expected`/`reason`, so a later divergence between the oracle and a
  revised advisory is detectable instead of silently assumed stale.
- `ecosystem` — currently implicit (npm); needed once/if a case is ever
  added for a non-npm ecosystem OSV also covers.
- `author` — who wrote the independent oracle for this case (accountability
  for the "never copy the tool's own output" rule as case count grows
  beyond what one person tracks from memory).
- `addedDate` — when the case was added, converted to absolute dates the
  same way project memory is (see `AGENTS.md`'s general dating discipline).
- `evidencePath` — the expected evidence chain (file:line hops) a passing
  case should produce, letting a future check assert evidence *quality*
  (§ 9), not just the top-level verdict.

## 8. Handling of known failures

A `knownFailure: true` case:

- still asserts `actual === expected` in `validation.test.ts` and fails
  the test visibly when they differ — `knownFailure` never suppresses the
  assertion, it only changes how the runner's own summary/`REPORT.md`
  bookkeeping presents the result (a labeled "(known)" row instead of an
  unlabeled failure).
- MUST have a corresponding root-cause entry in `tests/validation/FINDINGS.md`,
  written with the same rigor as a bug report: discovery context, symptom,
  confirmed root cause (read from the real source, not guessed), why it
  matters, and a proposed (not necessarily implemented) fix direction.
- is a candidate for a future remediation task, not an obligation to fix
  immediately. Recording it is the deliverable; scoping the fix is a
  separate, explicit decision.

Because `knownFailure` cases exist by design, `npm run test:validation`
exiting non-zero is not itself a signal of regression — the signal to watch
for is the **unexpected-failure count** the runner reports separately (a
case failing that is *not* marked `knownFailure`), which must be zero. This
is why the suite is not (yet) wired into CI as a pass/fail gate: there is no
meaningful red/green state to report while known failures are expected by
design. It can still be run manually, and its `REPORT.md`/`FINDINGS.md`
output reviewed, at any time (see `README.md`'s `npm run test:validation`
line under Testing).

## 9. UNKNOWN semantics

`UNKNOWN` is VulnTrace's explicit, first-class safe fallback (`docs/SDD.md
§ 3.4`, `§ 5`) — it is what the analyzer returns when it cannot prove
reachability *or* unreachability, and it is a correct answer, not a failure
mode, whenever that's genuinely true of the code.

In this suite specifically:

- A case whose fixture is genuinely ambiguous or unresolvable and expects
  `UNKNOWN` — passing means VulnTrace correctly recognized its own limit.
- A `knownFailure` case that resolves to `UNKNOWN` instead of a definite
  `AFFECTED`/`NOT_AFFECTED` (the current shape of `RWF-001`, affecting
  `VAL-002`/`VAL-003`) is tracked as a **precision** gap, not a
  **soundness** violation: the analyzer under-informed the user, but it
  never told them something false. This distinction is why such a case is
  logged in `FINDINGS.md` and scoped for future work rather than treated as
  an emergency regression.
- The one outcome this suite treats as categorically worse than any
  `UNKNOWN` gap is a **false `NOT_AFFECTED`** — see § 10.

## 10. Required metrics

A benchmark run over `cases.json` reports:

- **AFFECTED precision** — of the cases VulnTrace calls `AFFECTED`, the
  fraction actually `AFFECTED` per the oracle.
- **AFFECTED recall** — of the cases the oracle calls `AFFECTED`, the
  fraction VulnTrace also calls `AFFECTED`.
- **NOT_AFFECTED precision** — of the cases VulnTrace calls `NOT_AFFECTED`,
  the fraction actually `NOT_AFFECTED` per the oracle.
- **NOT_AFFECTED recall** — of the cases the oracle calls `NOT_AFFECTED`,
  the fraction VulnTrace also calls `NOT_AFFECTED`.
- **UNKNOWN rate** — fraction of all cases VulnTrace resolves to `UNKNOWN`,
  regardless of what the oracle expected.
- **False AFFECTED** — count of cases where VulnTrace says `AFFECTED` but
  the oracle says `NOT_AFFECTED`.
- **False NOT_AFFECTED** — count of cases where VulnTrace says
  `NOT_AFFECTED` but the oracle says `AFFECTED`.
- **Analysis coverage** — fraction of cases where the dependency, the
  advisory, and a matching rule were all successfully resolved far enough
  to reach a verdict engine decision at all (as opposed to failing earlier
  in the pipeline).
- **Resolution coverage** — fraction of cases where the vulnerable target
  symbol itself was resolved in the module/symbol graph (`resolveTargetNodes`
  succeeded), independent of what the final verdict was.
- **Evidence quality** — for `AFFECTED` cases, whether the produced evidence
  chain corresponds to a real, human-verifiable call path (not merely
  present, but correct) — see the proposed `evidencePath` field (§ 7) for
  how this becomes machine-checkable as case count grows.
- **Analysis time** — wall-clock duration of the scan phase per case (the
  same `timings` data every scan already reports — `docs/SDD.md § 30`).

### FALSE NOT_AFFECTED is the critical security failure

Of everything this benchmark measures, **a false `NOT_AFFECTED` is the one
outcome this project treats as a critical security failure, not a precision
statistic.** `AGENTS.md`'s core verdict rule — never infer `NOT_AFFECTED`
merely because resolution failed — exists specifically to make this outcome
structurally rare; a false `NOT_AFFECTED` slipping through in this
benchmark means that rule was violated somewhere in the pipeline and tells a
real user their code is safe when it is not. Contrast with `UNKNOWN`: an
under-informative but honest answer that costs a user follow-up
investigation, never false confidence. A false `AFFECTED` is also a real
defect (it costs a user's trust and time), but it fails safe — it does not
cost them a missed vulnerability.

Any run producing a false `NOT_AFFECTED` should be treated with the same
urgency as a correctness regression in the adversarial suites, regardless
of how many other metrics look healthy.
