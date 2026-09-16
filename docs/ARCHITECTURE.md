# VulnTrace Architecture

**Authoritative.** This document is the single home for how VulnTrace is
put together and which identity, uncertainty and performance rules the
rest of the system is built on. Where it disagrees with an older document,
this one wins.

| Document | Owns |
| --- | --- |
| **this file** | architecture, `PackageInstance` identity, metadata uncertainty, the `UNKNOWN` taxonomy, `unreportedCandidates`, the provider boundary, target authority, cache/index contracts, the testing tiers, the history policy, the contributor and user workflows |
| [`SOUNDNESS-CONTRACT.md`](SOUNDNESS-CONTRACT.md) | verdicts, the three negative-proof families, VT-CONTRACT-01/02/03, `ModuleLoadClosure`, `AnalysisProofContext`, how to add a proof family, worked CLI examples |
| [`SCORECARD.md`](SCORECARD.md) | the measured state of the project, generated from its sources |
| [`OPEN-DEBTS.md`](OPEN-DEBTS.md) | every known debt, RWF-002, and the P1-B entry criteria |
| [`SDD.md`](SDD.md) | the original design document. Historical: where it and this file disagree about a Foundation-era rule, this file is current. |
| [`adr/`](adr/) | the decisions, with the reasoning that produced them. Historical by nature. |
| [`../tests/validation/FINDINGS.md`](../tests/validation/FINDINGS.md) | the RWF register — every gap found by scanning real packages, recorded before it was fixed and kept after. Append-only history, never rewritten. |

---

## 1. What VulnTrace is

VulnTrace is a **vulnerability reachability analyzer** for JavaScript and
TypeScript. Technically, it is a **proof-producing vulnerability triage
engine**.

It is not a scanner. It does not discover your dependencies' advisories
and hand you a list; something else already did that, and the list is the
problem rather than the product. VulnTrace takes one candidate
vulnerability and one exact installed package instance and answers a
narrower question with evidence attached:

> Given this advisory, and *this specific copy of the package at this
> specific location on disk*, can the vulnerable behavior actually be
> reached from this application's configured entrypoints?

```text
    your SCA tool / scanner / SBOM feed
                 │
                 │  candidate vulnerability
                 ▼
    ┌────────────────────────────────┐
    │  VulnTrace                     │
    │                                │
    │  per exact PackageInstance:    │
    │    • resolve the authoritative │
    │      vulnerable target         │
    │    • module-load closure       │
    │    • call-graph reachability   │
    └────────────────────────────────┘
                 │
                 ▼
     AFFECTED  │  NOT_AFFECTED  │  UNKNOWN
     + evidence │  + proof       │  + structured reasons
```

The candidate provider is currently OSV, and the packages named throughout
this repository's fixtures (`lodash`, `qs`, `semver`, …) are illustrative.
Neither is part of the product definition.

## 2. Priority order

When two of these conflict, the earlier one wins. This ordering is the
single most load-bearing convention in the codebase, and a change that
inverts it is a change to what VulnTrace is.

1. **Soundness** — never a false `NOT_AFFECTED`, never a silently dropped
   finding. Everything else is negotiable; this is not.
2. **Explainability** — a verdict a user cannot check is worth little. Every
   answer carries machine-readable evidence for *why*.
3. **Precision** — fewer `UNKNOWN`s, as long as 1 and 2 hold.
4. **Coverage** — more constructs, languages and shapes understood.
5. **Performance** — fast enough not to be avoided. Performance state may
   never become proof authority (§ 9).

The practical consequence: when an analysis cannot establish something, it
**fails closed** to `UNKNOWN`. `UNKNOWN` is a first-class result
([ADR-0002](adr/0002-unknown-first-class.md)), not an error and not a
degraded `NOT_AFFECTED`.

## 3. Pipeline

```text
  vulntrace.yml ─────┐
                     ▼
  project ──▶ dependency intelligence ──▶ PackageInstance registry
                     │                       (canonical physical roots)
                     ▼
              vulnerability intelligence (provider boundary, § 8)
                     │  candidate advisories per instance
                     ▼
              vulnerable-symbol rules ──▶ target authority (§ 7)
                     │  {module, export} → exact node in an exact instance
                     ▼
              code intelligence  ──▶  ModuleLoadClosure   (what is LOADED)
                     │           └──▶  CallGraph          (what is CALLED)
                     ▼
              AnalysisProofContext   (binds the proof inputs; see
                     │                SOUNDNESS-CONTRACT.md § 5)
                     ▼
              verdict engine ──▶ finding (+ evidence/proof)
                                 or unreportedCandidate (§ 6)
```

Two facts about this diagram are easy to miss and matter a great deal:

- **`ModuleLoadClosure` and `CallGraph` are independent.** The closure
  answers "could this file be *loaded*"; the graph answers "is this symbol
  *called*". Neither is derived from the other, and the negative-proof
  families depend on that independence
  ([`SOUNDNESS-CONTRACT.md` § 3](SOUNDNESS-CONTRACT.md)).
- **Everything downstream of the registry is per-instance.** There is no
  point in the pipeline where two installed copies of a package are
  treated as one thing.

## 4. `PackageInstance` identity

The rules below are normative. They are owned by
`src/domain/resolved-target.ts` (the canonicalizer) and by the differential
oracle `src/dependencies/package-instances.differential-oracle.test.ts`,
which checks them against what real Node actually loads.

### 4.1 The identity is a canonical physical root

A `PackageInstanceId` is the **canonical physical directory** an installed
package lives in, produced by `canonicalizePackageInstancePath` (which is
`realpath` plus a normalized-absolute fallback) and by nothing else. It is
never a name, never a version, and never a `name@version` pair.

This mirrors Node's own loader, which resolves and caches by realpath: two
logical references that realpath to the same physical directory really are
the same loaded code at runtime.

### 4.2 The rules

| Rule | Consequence |
| --- | --- |
| **Same name and version at two roots are two instances.** | `node_modules/foo` and `node_modules/bar/node_modules/foo` get independent verdicts. One may be `AFFECTED` while the other is `NOT_AFFECTED`. |
| **Symlink aliases converge only if the physical root converges.** | A pnpm store link and its `node_modules` entry are one instance. Two separate physical installs are never merged because a link exists. |
| **Scoped and unscoped names stay distinct.** | `@acme/foo` is never `foo`. |
| **npm aliases are resolved by the installed manifest, not the directory name.** | `"semver-vulnerable": "npm:semver@7.5.1"` installs at `node_modules/semver-vulnerable` but declares `"name": "semver"`. Identity follows the manifest. Deriving it from the directory name was RWF-009 — a real false `NOT_AFFECTED`. |
| **Workspace members are instances too.** | A repository's own packages have identity, established from authoritative repository metadata, and advisories about them are answered per member rather than from project-root resolution. Not having identity was RWF-032. |
| **A version that cannot be established stays unresolved.** | No instance is given a guessed version in order to make a query answerable. See § 5. |
| **No `name@version` collapse, anywhere.** | Not in a cache key, not in a report, not in a proof. Collapsing instances is precisely how a reached instance's code gets declared unloadable. |

### 4.3 Worked examples

```text
node_modules/url-parse                 ← instance 1 (v1.5.9, vulnerable)
node_modules/wrapper/node_modules/url-parse
                                       ← instance 2 (v1.5.10, patched)
```
Two instances, two findings, potentially two different verdicts. This is
the real `RWB-11a`/`RWB-11b` pair.

```text
node_modules/semver-vulnerable/package.json → {"name": "semver", ...}
```
One instance whose package name is `semver`, at a root whose basename is
`semver-vulnerable`. `graphPackageInstances(graph, "semver")` must find it.

```text
packages/api          ← workspace member, a real instance
packages/api/node_modules/lodash
                      ← an install belonging to that member
node_modules/lodash   ← a different install, hoisted to the root
```
Three instances. An advisory about `lodash` produces a finding per
`lodash` instance, each bound to its own root.

### 4.4 Presentation is not identity

A finding's rendered `packageInstance` is emitted relative to the project
root for readability. That string is presentation; the canonical absolute
root is the identity. Nothing may compare instances by the rendered form.

## 5. Package metadata uncertainty (F1)

Three sources say something about which version an instance is:
declared dependency metadata, the **installed package's own manifest**,
and workspace metadata. They are **evidence**, not authority, and they can
disagree.

| Situation | Behavior |
| --- | --- |
| Sources agree | The version is established. |
| Sources give **conflicting concrete versions** | The version is **unresolved**. No arbitrary provider query is made, no version is picked, and no confident finding or verdict is produced for a fabricated version. The instance is recorded as an `undetermined` candidate (§ 6). |
| Manifest **absent** | Distinct from malformed. Recorded as such. |
| Manifest **malformed or unreadable** | Distinct from absent. Recorded as such, and never memoized as a success (§ 9). |
| Workspace enumeration **truncated** | Reported structurally, not as silence — a machine can see that discovery did not complete. |
| Workspace declaration **uninterpretable** (e.g. a pnpm-only layout) | Reported structurally, with its own reason. |

The distinction between *absent* and *malformed* is preserved wherever the
implementation draws it, because collapsing them is a soundness bug in one
direction: "this package declares no version" and "something is wrong with
this package's manifest" license different conclusions.

Owned by `src/dependencies/workspaces.truncation.test.ts`,
`src/cli/scan.workspace-uncertainty.test.ts` and
`src/cli/scan.metadata-uncertainty.test.ts`.

## 6. Uncertainty, and the two things that are not findings

### 6.1 The six-category taxonomy (F3)

Every `UNKNOWN` carries structured, categorised reasons from a closed
vocabulary — never prose alone. The categories are defined in
`src/domain/uncertainty.ts`:

| Category | What it means | What closes it |
| --- | --- | --- |
| `unmodeled_construct` | the analyzer saw the construct and has not implemented it | frontend work — **the class P1-B is prioritized from** |
| `value_uncertainty` | the construct IS modeled; the value or destination is not statically unique | value/alias analysis, never syntax support |
| `capability_escape` | the runtime can reach outside bounded static reasoning (`eval`, `vm`, a worker) | largely nothing — a property of the language, not of this analyzer |
| `identity_unresolved` | a package/instance/version/entry/target identity fact was never established | metadata and resolution work |
| `analysis_precondition_unmet` | something the decision DEPENDS ON was never established at all — the source would not parse, no runtime implementation was obtained, no rule exists, a required artifact was unavailable | varies; never a syntax gap |
| `budget_exceeded` | a CONFIGURED bound stopped the work | changing a limit, and nothing else |

Each names a **different kind of work**. That is the only property that
makes a taxonomy worth having, and it is why `capability_escape` is split
out: filing `eval` as a coverage gap would put permanent, unfixable work
at the top of a roadmap.

**The taxonomy is observational.** Nothing in it is read by any branch that
decides `AFFECTED`, `NOT_AFFECTED` or `UNKNOWN`. It explains a decision the
proof rules already made, using the same evidence those rules saw. **It
authorizes no proof.** Removing the classification would change no verdict
anywhere.

It is also **orthogonal to closure widening**.
`isClosureWideningReason` answers a different question — "could this
construct load a module the graph never discovered?" — and is a soundness
boundary the proof rules do consume. A reason can be widening and
`capability_escape` (`eval`), widening and `identity_unresolved`
(`unresolved_module`), or non-widening and `unmodeled_construct` (the
`unsupported_*` family). Neither classification may ever be derived from
the other.

**Within `unmodeled_construct`, the frontend gap is named specifically.**
P1-B1 split the call graph's old `unsupported_construct` catch-all into
eight subtypes describing *where the value being called came from* — an
unattributable name in callee or receiver position, a `this` receiver, an
indexed receiver, a call result, an inline-constructed value, an operator
expression, or a callee that is not a name at all — keeping
`unsupported_construct` itself as the runtime floor for anything
unmeasured or newly invented by the parser. This is **detail, not a
seventh category**: all nine share `unmodeled_construct`, all nine are
non-widening, and swapping one for another changes an explanation and
nothing else. The measured distribution is in
[`SCORECARD.md` § 7.1](SCORECARD.md).

### 6.2 `unreportedCandidates` — a candidate that produced no finding

Two completely different states used to reach a consumer as identical
bytes: *"this advisory confidently does not apply to this instance"* and
*"nobody could determine whether this advisory applies"*.
`ScanOutput.unreportedCandidates` separates them. It is **not findings**:
no `verdict`, no `evidence`, no `confidence`, its own top-level array, and
no code path converts one into a finding.

| Disposition | Meaning |
| --- | --- |
| `not_applicable` | The installed version is outside every affected range. Real information, arrived at with certainty. Carries **no category at all**, structurally, so a consumer summing categories cannot count patched packages as analysis gaps. |
| `undetermined` | Applicability could not be established. Carries a category. |

**Neither is a `NOT_AFFECTED`.** A `not_applicable` entry is a statement
about version ranges and nothing else: no reachability analysis ran, so no
negative proof exists and nothing may promote it to one.

Two consequences worth stating plainly:

- **Out-of-range is not an `UNKNOWN` finding.** A patched package is not
  uncertainty; it is a confident, uninteresting answer, and it belongs in
  this array rather than in `findings`.
- **No synthetic finding is ever created** merely to represent an inability
  to query or resolve metadata. There is no advisory to name, so naming one
  would be fabrication.

Owned by `src/cli/scan.f3-no-finding.test.ts`.

## 7. Target authority (P1-A)

Which function an advisory actually names is its own hard problem, and
getting it wrong produces false verdicts in **both** directions. The rules
established by P1-A:

| Rule | Why |
| --- | --- |
| **The package's PUBLIC entry answers, not any member file.** | `pkg/other.js` exporting `vulnerable` is not evidence about what `require("pkg").vulnerable` is. Package membership is necessary, never sufficient. Treating it as sufficient was RWF-030 — reproduced as both a false `AFFECTED` and a false `NOT_AFFECTED`. |
| **A forwarded export is chased to its real declaration.** | Real `qs/lib/index.js` forwards `parse` to `lib/parse.js`, which publishes it anonymously — so *no file in `qs` exports anything called `parse`*. Per-file attribution could not answer at all (RWF-029). |
| **`exports` supersedes `main` where it applies, and a path request does not consult `exports`.** | Probing an instance's absolute install path admitted files no importer can reach through the package name (RWF-031). |
| **Aliases, scopes and subpaths are all honored.** | An advisory may name `qs/lib/parse` or `@scope/pkg/api`, not only a package root. |
| **Workspace members resolve as packages.** | Not through project-root resolution (RWF-032). |
| **One advisory, many instances → many findings.** | Each bound to its own instance, each independently answered. |

**Target attribution binds to an exact `PackageInstance`.** A target
resolved against "the package named `foo`" is not a target; a concrete path
to the *wrong* instance was enough to produce an `AFFECTED` once, and that
is recorded as RWF-032 CORRECTION 2.

Per-fixture edge cases live in `fixtures/target-side-reexport/`,
`fixtures/authoritative-public-entry/`, `fixtures/package-entry/` and
`fixtures/workspaces/`, each with its own README, and are not restated
here.

## 8. The provider boundary

**Current state.** OSV supplies candidate vulnerability intelligence.
`src/vulnerabilities/` normalizes the raw advisory shape into the domain's
own `Vulnerability`, and everything downstream — target resolution,
reachability, verdict — sees only the normalized form.

**The architectural contract.** A candidate provider supplies *candidates*.
It must be normalized **before** any target or reachability analysis
begins, and nothing downstream may reach back to a provider to make a
decision. That boundary is what makes a second provider possible later
without touching the analyzer.

Two things that follow, and are worth stating because they are the
tempting shortcuts:

- **No provider query is made for a version the analyzer could not
  establish** (§ 5). Asking about a plausible version in order to get an
  answer is fabrication, and the stubbed provider's query log is asserted
  in tests precisely so that this stays visible.
- **A provider outage is not a verdict.** It is exit code 4 and a
  diagnostic.

F7 does **not** redesign the provider interface. The contract above
describes what is already true; generalizing it is future work with no
current consumer.

## 9. Per-scan caches and indexes (F5)

Every cache in the analysis path exists for one scan and is thrown away
with it. The one persistent cache in the tree is the OSV advisory cache
(`<project>/.vulntrace-cache/osv/`), which is provider I/O and not analysis
state.

| Cache / index | Owner | Lifetime | Key | Failure policy | Stability assumption |
| --- | --- | --- | --- | --- | --- |
| module identity memo | `ScanModuleIdentityCache` (`domain/resolved-target.ts`), created in `runScanCommand` | one scan | the whole `resolvedFile` string, bound to one `KnownPackageRoots` **by reference** | memoize nothing on failure | `knownPackageRoots` is final before the memo is built |
| realpath memo | the same cache | one scan | `path.resolve(rawPath)` | **only successes are stored**; a throw falls back and re-attempts next time | the filesystem does not move under a running scan |
| manifest-name memo | the same cache | one scan | canonical package root | stored **only when present and valid**; `ENOENT` memoizes nothing | as above |
| graph `PackageInstance` index | `GraphPackageInstanceIndex` (`analysis/scan-caches.ts`), created by `createAnalysisProofContext` | one scan | package name → instances, built in one forward pass over `graph.nodes` | **refuses** (§ 9.1) | `graph.nodes` is final once `buildCallGraph` returns |
| public-entry memo | `ScanAnalysisCaches`, same factory | one scan | `packageInstance` + `requestedModuleSpecifier`, NUL-joined | ordinary recompute | resolver, entrypoints and project root are fields of the owning context |

**Two properties hold across all of them:**

- **No proof outcome is memoized.** There is no cached `NOT_AFFECTED`, no
  cached `UNKNOWN`, no cached proof family and no cached reachability
  result. Reachability caching was deliberately *not* attempted, because a
  reachability key would have to include the closure, the graph and the
  entrypoint objects by value, and those are still live references (§ 10).
- **Performance state is never proof authority.** A cache may make the
  analyzer slower when it misses. It may never make the analyzer more
  confident.

### 9.1 Refusal is not absence

This is the single most dangerous failure mode a performance layer can
introduce, and it is worth being blunt about:

> An index that cannot answer must say **"I cannot answer"**, never
> **"there are none"**.

`graphPackageInstancesByName` returns `undefined` — meaning *scan the graph
yourself* — whenever the caller's inputs are not provably the ones the
index was derived from: no caches supplied, a different graph by reference,
a different registry by reference, or a `graph.nodes.length` that no longer
matches the indexed count. An absent package name, by contrast, returns a
**defined, empty map**.

The distinction is load-bearing in **two different directions**, and F6's
mutation study measured them separately. They are different defects with
opposite risk profiles, and collapsing them into one warning is how a
reader ends up believing the safe failure was the dangerous one.

**Mutation C — a refusal read as absence. A precision regression.**
Replacing the fallback with `return indexed ?? new Map()` makes *"the
index cannot answer"* mean *"this package has no instances"*. An empty map
fails `resolveTargetNodes`'s `instances.size > 0` test, so the analyzer
skips **Site A** — the only site that knows "the graph holds other
instances of this name but never traversed THIS one", which is the entire
premise of a family-B proof — and falls through to **Site B**, an
instance-blind re-resolution that cannot conclude family B at all.

Measured on the discriminating fixture (same-name/same-version twins, a
finding about the unreached twin, the index forced to refuse):

| source | verdict | proof |
| --- | --- | --- |
| clean | `NOT_AFFECTED` | family B, naming the unreached twin |
| refusal read as absence | **`UNKNOWN`** | **none** |

F6 classifies this as a **conservative precision regression**. It claims
*less*, which is the safe direction, and it does **not** fabricate a
negative proof. It is still a real defect — semantically observable in
production output, silently costing correct `NOT_AFFECTED` answers — which
is why it is deterministically gated rather than argued away. It was first
recorded as an equivalent mutant; an independent audit disproved that.

**Mutation C′ — a stale index treated as authoritative. The unsafe one.**
This is where the fabrication warning belongs. If the staleness guard stops
firing, an index that no longer describes the graph is consulted *as
authority* instead of refusing. A stale but **non-empty** answer passes
`instances.size > 0` and can omit the very instance the graph really did
traverse — so Site A concludes `confirmedAbsentInstance` for an instance
that was in fact reached, and that **is** positive evidence. A performance
accelerator would then be manufacturing a family-B proof it has no
standing to make. That is the cached-absence defect a performance layer
must never introduce, and it is why a refusal must fall back to the
authoritative walk or fail closed, and must never present a derived set as
an authoritative one.

Both are owned by `src/analysis/scan-caches.f5-graph-index.test.ts`, and
both assert that the refusal actually occurred before asserting anything
about its consequences, so neither can pass vacuously.

### 9.2 Staleness: what the node-count guard does and does not catch

The indexes assume the graph and the registry are **stable after
construction**. The guard is a node-count comparison, and its limits are
exact:

- it **detects** growth or shrinkage of the node list;
- it **does not detect** a node mutated in place, and nothing in this
  codebase does.

Current production types and lifetimes make such a mutation unreachable
without a cast, but that is a lifetime argument, not a structural one.
`readonly` is erased at runtime and `Object.freeze` is shallow. The indexes
are **not** magically immutable; this is carried as a hardening debt
([`OPEN-DEBTS.md`](OPEN-DEBTS.md)), and it is the same debt that
`AnalysisProofContext` carries
([`SOUNDNESS-CONTRACT.md` § 5](SOUNDNESS-CONTRACT.md)).

## 10. Testing tiers

Five commands, four different kinds of evidence. Confusing them is how a
project talks itself into believing a live integration run is a
correctness oracle.

| Command | Deterministic? | Network? | What it is |
| --- | --- | --- | --- |
| `npm run test:foundation` | **yes** | **no** | The deterministic Foundation gate. The subset of `npm test` that owns a named Foundation invariant. The project's oracle. |
| `npm test` | **no** | **yes** | The full unit/integration/e2e suite. One suite inside it, `src/vulnerabilities/osv-provider.integration.test.ts`, queries the live OSV API unconditionally, so this run is **not** fully offline. Recorded as a debt, not fixed. |
| `npm run test:adversarial` | yes | no | Two independent suites (v1: 34 scenarios, v2: 45, built to detect overfitting to v1). A research and coverage signal, **not a contract owner**: both deliberately keep scenarios that disagree with the analyzer rather than fixing the analyzer to pass them. |
| `npm run test:performance` | shape yes, value environmental | no | Wall-clock catastrophic-regression smoke against generous ceilings. Answers "did something explode", never "is the complexity contract intact". |
| `npm run test:validation` | **no** | **yes** | Real npm-installed packages against real advisories over the real OSV API. Integration evidence and a provider-movement detector, never a correctness oracle. |

The **complexity contract** is a separate, exact operation-count gate
(`src/analysis/scan-caches.f5-multiplier.test.ts`) with no threshold to
tune. It is in the Foundation gate; the stopwatch is not.

### 10.1 The invariant ownership map

`src/testing/foundation-invariants.ts` is the authoritative list of
Foundation invariants and the deterministic test files that own each one.
It is **data rather than prose** so that it cannot drift silently:
`src/testing/foundation-invariants.test.ts` fails if the map names a test
that does not exist, names a test the gate does not execute, or if the gate
runs a file the map does not account for.

Current counts are in [`SCORECARD.md` § 1](SCORECARD.md), generated from
the map itself rather than copied here.

**What the map protects:** that every Foundation soundness property has a
named, executed owner, so a regression produces an unambiguous failure
rather than a diffuse one.

**What it does not prove:** that each owner's assertions are semantically
*adequate*. The check is membership — the owner exists and runs — not
sufficiency. A weakened assertion inside a listed owner would still pass
the map. That limitation is recorded in
[`OPEN-DEBTS.md`](OPEN-DEBTS.md).

### 10.2 Threshold-ratchet policy

Performance thresholds must not be raised to make CI green. The three
wall-clock ceilings are pinned in `src/testing/foundation-invariants.test.ts`
as well as in the guard file, so changing one is a deliberate two-file edit,
and the failure message names the record where the measurement and its
justification must go.

## 11. Repository history and commit metadata

`npm run validate:history` enforces both halves of the policy: the
bootstrap-kit archive, and commit metadata
(`scripts/commit-metadata-policy.mjs`).

**Allowed attribution:**

```text
Co-Authored-By: Claude <noreply@anthropic.com>
```

**Forbidden, prospectively** — in any commit added after the F6 base:

- a model name in an identity trailer;
- `Claude-Session` or any session identifier;
- a `claude.ai` telemetry URL;
- any `Generated-by`/model-telemetry trailer.

**Historical violations are grandfathered by exact SHA.** Three commits
merged before F6 violate the policy and are listed as documented exceptions
in `scripts/validate-commit-metadata.mjs`. **`main`'s history is not
rewritten** to satisfy a policy adopted after those commits landed —
rewriting shared history to tidy metadata costs more than the tidiness is
worth, and an exception list is auditable in a way a rewrite is not.

Owned by `src/testing/commit-metadata-policy.test.ts` (both directions:
forbidden forms rejected, ordinary prose accepted).

## 12. Using VulnTrace

For someone who does not know the internals:

1. **Your scanner identifies a candidate.** An SCA tool, an SBOM feed or a
   GitHub alert says "this project depends on something with an advisory".
2. **VulnTrace resolves the exact instance.** Not "the project uses
   `lodash`" but "this canonical directory contains this installed copy".
   If several copies exist, each is answered separately.
3. **It resolves the authoritative target.** Which function the advisory
   actually names, as the package genuinely publishes it.
4. **It analyzes loading and reachability.** Can this instance be loaded at
   all from your entrypoints? If it is loaded, is the vulnerable symbol
   reachable from them?
5. **You get a verdict with evidence.** `AFFECTED` carries a concrete call
   path. `NOT_AFFECTED` carries a positive proof naming its family, the
   exact instance and the entrypoint roots it is relative to.
6. **`UNKNOWN` is retained where the proof is insufficient** — with
   structured reasons saying exactly what was missing. It is never rounded
   down to "probably fine".

What a scan needs from you: entrypoints (`analysis.entrypoints` in
`vulntrace.yml`, or a resolvable `package.json` `main`/`bin`), and a rule
naming the vulnerable symbol. Rules are manually authored in this release
([ADR-0003](adr/0003-manual-symbol-rules-first.md)); a project with no
entrypoints produces an all-zero but fully explained result rather than a
silent one.

Worked `AFFECTED` / `NOT_AFFECTED` / `UNKNOWN` output is in
[`SOUNDNESS-CONTRACT.md` § 7](SOUNDNESS-CONTRACT.md).

## 13. Contributing an analyzer capability

The rules below are what keeps the priority order in § 2 from eroding one
convenient exception at a time.

1. **Positive path before negative proof.** Teach the analyzer to *see* the
   construct before you let any proof rule rely on its absence. A negative
   proof built on a half-modeled construct is a false `NOT_AFFECTED`
   waiting for the right input.
2. **Fail closed.** A state you have not modeled must produce `UNKNOWN`, not
   a default. If you add a case to a classifier, the `default` branch must
   still be the conservative one.
3. **Add a deterministic fixture.** Under `fixtures/`, with a README saying
   what it isolates and, where the behavior is about real runtime
   semantics, what real `node` does with it.
4. **Add an adversarial or differential case where relevant.** Especially
   when the change touches identity, loading or export attribution.
5. **Preserve `PackageInstance` exactness.** No new code path may compare,
   key or report by `name@version`.
6. **Add an uncertainty reason for the unsupported state.** A new
   unsupported construct that produces an unclassified `UNKNOWN` is
   invisible to the measurement P1-B is prioritized from. The compile-time
   exhaustiveness checks in `src/domain/uncertainty.ts` will force this.
7. **Mutation-check anything soundness-critical.** If your change adds a
   guard, prove the guard is load-bearing by removing it in a test and
   showing the verdict moves.
8. **Update the invariant owner map** if you introduce a new invariant —
   `src/testing/foundation-invariants.ts`, plus the gate config. The map's
   own test will tell you if you half-did it.

Adding a *negative proof family* is a different and much heavier
proposition; see
[`SOUNDNESS-CONTRACT.md` § 6](SOUNDNESS-CONTRACT.md).

## 14. Future language expansion

**Current implementation is JavaScript/TypeScript only**
([ADR-0006](adr/0006-stay-typescript-defer-multi-language.md)), and nothing
below is implemented.

A future Go frontend should be a **separate frontend**, not a
generalization of this one. What should be shared is the small set of
concepts that are genuinely language-neutral:

- `PackageInstanceId` — a canonical physical install identity;
- the target model — advisory to exact symbol in an exact instance;
- the uncertainty vocabulary — the six categories;
- the proof-context and result contracts.

What should **not** be built now is a general language-neutral IR. There is
one frontend; an IR abstracting over a set of size one abstracts over
nothing, and would be designed against guesses about the second language
rather than against it.

A **per-file JavaScript module fact record** — caching the facts already
derived per file, at file granularity — is the direction architecture
review has supported, because it is a change to *this* frontend's
internals with a measurable cost today. It is planned direction only. It is
not implemented, not scheduled, and nothing in the current code depends on
it.
