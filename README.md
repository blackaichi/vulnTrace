# VulnTrace

Vulnerability **reachability** analysis for JavaScript and TypeScript —
technically, a **proof-producing vulnerability triage engine**.

## What it is, and what it is not

VulnTrace is **not another vulnerability scanner**. It does not go looking
for advisories about your dependencies; something else already did that,
and the resulting list is the problem rather than the product.

VulnTrace takes one candidate vulnerability and one **exact installed
package instance** and answers a narrower question, with evidence
attached:

> Given this advisory, and *this specific copy of the package at this
> specific location on disk*, can the vulnerable behavior actually be
> reached from this application's configured entrypoints?

```text
    your SCA tool / scanner / SBOM feed
                 │  candidate vulnerability
                 ▼
    VulnTrace — per exact PackageInstance:
      resolve the authoritative vulnerable target
      module-load closure + call-graph reachability
                 │
                 ▼
     AFFECTED  │  NOT_AFFECTED  │  UNKNOWN
     + path     │  + positive    │  + structured
                │    proof       │    reasons
```

The candidate provider is currently OSV, and the package names used
throughout this repository's fixtures are illustrative. Neither is part of
the product definition.

Its central model:

```text
CVE/GHSA
   |
   v
Vulnerability Behavior
   |
   v
Vulnerable Symbol(s)
   |
   v
JavaScript/TypeScript Code Model
   |
   v
Call Graph / Module-Load Closure
   |
   v
Reachability
   |
   v
Evidence / Proof
   |
   v
AFFECTED / NOT_AFFECTED / UNKNOWN
```

The initial MVP uses manually authored vulnerable-symbol rules. A future
phase will infer candidate vulnerable symbols from security-fix commits
and diffs.

## Priority order

When two of these conflict, the earlier one wins:

**soundness → explainability → precision → coverage → performance**

Never a false `NOT_AFFECTED`, never a silently dropped finding. Everything
else is negotiable. When an analysis cannot establish something it **fails
closed** to `UNKNOWN`, which is a first-class result — not an error, and
not a soft `NOT_AFFECTED`.

## Documentation

| Document | Owns |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | architecture, `PackageInstance` identity, metadata uncertainty, the `UNKNOWN` taxonomy, caches and indexes, testing tiers, history policy, user and contributor workflows |
| [`docs/SOUNDNESS-CONTRACT.md`](docs/SOUNDNESS-CONTRACT.md) | the verdict contract, the three negative-proof families, VT-CONTRACT-01/02/03, `ModuleLoadClosure`, `AnalysisProofContext`, worked CLI examples |
| [`docs/SCORECARD.md`](docs/SCORECARD.md) | the measured state of the project, generated from its sources |
| [`docs/OPEN-DEBTS.md`](docs/OPEN-DEBTS.md) | every known debt, and the entry criteria for P1-B |
| [`docs/SDD.md`](docs/SDD.md) | the original design document (historical; the four above are current where they disagree) |
| [`tests/validation/FINDINGS.md`](tests/validation/FINDINGS.md) | the RWF register — every gap found by scanning real packages |

## Status

MVP complete (all 30 tasks), followed by the **Foundation block (F1-F7)**,
which made the soundness guarantees explicit, owned and measurable rather
than adding features. Foundation is closed; see
[`docs/SCORECARD.md`](docs/SCORECARD.md) for the measured state and
[`docs/OPEN-DEBTS.md`](docs/OPEN-DEBTS.md) for what is knowingly
unfinished. `docs/adr/0007-mvp-known-limitations.md` covers what was
deliberately out of scope for the MVP release.

## Example command

```bash
vulntrace scan .
vulntrace scan . --cve CVE-XXXX
vulntrace scan . --format json
vulntrace scan . --format html --output report.html
vulntrace scan . --config vulntrace.yml --pretty
vulntrace scan . --no-cache
vulntrace rules validate rules/vulntrace-rules.yml
vulntrace version
```

Exit codes: `0` no AFFECTED findings, `1` at least one AFFECTED finding,
`2` configuration/usage error, `3` analysis failure, `4` vulnerability
provider/network failure (see `docs/SDD.md § 25` and `src/cli/scan.ts`).

### HTML report

```bash
vulntrace scan . --format html --output report.html
```

Writes a single self-contained HTML file you can open directly from disk —
no server, no CDN, no external stylesheet, font or image, and no network
request of any kind. It is a presentation of the same scan result
`--format json` prints, so the two never disagree about a verdict.

It shows, per finding: the verdict, advisory, package and installed
version; the vulnerable symbol; the reachability path for an `AFFECTED`;
the concrete blockers behind an `UNKNOWN` (`UNKNOWN` is a first-class
result, not an error); and, for a `NOT_AFFECTED`, which positive
negative-proof family justified it, with the exact canonical package
instance and entrypoint roots that proof is relative to. A prominent
"Analysis scope / supported model" section states what those proofs are
relative to and what the model does not cover.

`--format html` requires `--output` (there is no safe stdout behavior for a
whole HTML document); `--output` also works with `--format json` to write
the JSON result to a file instead of stdout. `--output` overwrites an
existing file.

### What a scan actually needs to find something

A bare `vulntrace scan <path>` only discovers entrypoints from
`analysis.entrypoints` in that project's own `vulntrace.yml`, or its
`package.json` `main`/`bin` fields. A project with neither produces an
all-zero, but fully explained, result:

```bash
$ vulntrace scan fixtures/direct-esm
```
```json
{
  "...": "...",
  "coverage": { "files": 0, "...": 0 },
  "diagnostics": [
    {
      "source": "entrypoints",
      "message": "no entrypoints were discovered (no analysis.entrypoints configured, and no resolvable package.json main/bin field); nothing could be analyzed"
    }
  ]
}
```

Similarly, `findings` only ever contains something for a package OSV
actually has vulnerability data for *and* a rule exists for (rules are
manually authored — see `rules/vulntrace-rules.yml`, an MVP design
choice, ADR-0003). The bundled `fixtures/` projects use a synthetic
`fixture-lib` dependency that has no real OSV data, so scanning them
against the live network always returns `findings: []` — this is
expected, not a bug. To see genuine `AFFECTED`/`NOT_AFFECTED`/`UNKNOWN`
results end to end:

- `npm test` — specifically `src/cli/e2e-vertical-slice.test.ts`, which
  drives the full pipeline through the real `vulntrace scan` code path
  against real fixtures, injecting only the OSV network response (since
  `fixture-lib` has none for real).
- Or scan a real project with a real, still-vulnerable dependency (e.g.
  an old `lodash`) and author a matching rule in `vulntrace.yml`'s
  `rules.files` — see `docs/SDD.md § 13-14` for the rule format.

## Development

Requires Node.js >= 20.

```bash
npm install         # install dependencies
npm run build        # compile TypeScript (strict) to dist/
npm run typecheck    # type-check without emitting
npm test              # run the full test suite (vitest)
npm run lint           # lint with eslint
npm run format          # check formatting with prettier
```

The CLI command surface described above (`scan`, `rules validate`, `version`)
is implemented in `src/cli/`; `src/cli.ts` is the thin process entrypoint.

### Testing

- **Unit tests**: co-located `src/**/*.test.ts` files. Pure and fast; no
  filesystem/network access unless the unit under test's job is I/O (e.g.
  config loading).
- **Integration tests**: `src/**/*.integration.test.ts`. Exercise real
  filesystem access, typically against `fixtures/`.
- **Fixture tests**: integration tests that use the `src/testing/fixtures.ts`
  helpers to point at a `fixtures/<name>` project. Every fixture category
  required by `docs/SDD.md § 31` is asserted to exist
  (`src/testing/fixtures.integration.test.ts`); the 7 required by
  TASK-024's own acceptance criteria are each proven to produce their
  expected verdict (`src/analysis/fixture-suite.integration.test.ts`).
- **End-to-end**: `src/cli/e2e-vertical-slice.test.ts` drives the full
  pipeline through the real `vulntrace scan` code path for all three
  verdicts (AFFECTED/NOT_AFFECTED/UNKNOWN).
- **Contract/schema**: `src/cli/output.test.ts` validates generated output
  against the checked-in `schemas/result.schema.json`.
- **Performance smoke**: `src/cli/scan-performance.test.ts` — see
  "Performance and caching" below.
- **Security**: `src/cli/scan-security.test.ts`,
  `src/analysis/entrypoints.test.ts`'s path-traversal cases,
  `src/code-intelligence/call-graph.test.ts`'s resource-limit cases.
- **Adversarial**: `tests/adversarial/v1/` (the original 34-scenario suite)
  and `tests/adversarial/v2/` (an independent 45-scenario suite built to
  detect overfitting to v1). Both deliberately keep scenarios that
  disagree with the analyzer's current output rather than fixing the
  analyzer to pass them — see each suite's own `REPORT.md`. Excluded from
  `npm test`; run separately and gated in CI.
- **Real-world CVE validation**: `tests/validation/` scans real,
  npm-installed vulnerable packages (e.g. `lodash`) against real
  advisories, rather than the synthetic `fixture-lib` used elsewhere —
  see `tests/validation/cases/cases.json` and `docs/VALIDATION-STRATEGY.md`
  for the full strategy (case lifecycle, oracle authorship, required
  metrics). Excluded from `npm test`; not yet gated in CI (it has
  documented known failures by design — see `tests/validation/FINDINGS.md`).

```bash
npm test                # run everything above (unit/integration/fixture/e2e/contract/perf)
npm run test:foundation  # FAST deterministic Foundation gate (subset of npm test)
npm run test:unit        # unit tests only
npm run test:integration  # integration tests only
npm run test:coverage      # run everything with V8 coverage reporting
npm run test:adversarial   # adversarial suites (v1 + v2); also run in CI
npm run test:validation    # real-world CVE validation suite
npm run validate:history   # bootstrap-kit archive + commit metadata policy
```

### Documentation checks

The authoritative documents are checked rather than trusted. Both run
inside `npm test` (`src/testing/docs-contract.test.ts`), and can be run
directly:

```bash
node scripts/generate-scorecard.mjs          # rewrite docs/SCORECARD.md
node scripts/generate-scorecard.mjs --check  # fail if the scorecard is stale
node scripts/check-docs.mjs                  # every documented npm script and repo path resolves
```

The worked `AFFECTED`/`NOT_AFFECTED`/`UNKNOWN` examples in
[`docs/SOUNDNESS-CONTRACT.md`](docs/SOUNDNESS-CONTRACT.md) are likewise
generated by scanning a real project with the real analyzer and validated
against `schemas/result.schema.json`, so they cannot drift from what the
tool emits. Regenerate them with:

```bash
UPDATE_DOCS=1 npx vitest run src/testing/docs-contract.test.ts
```

### The Foundation gate

`npm run test:foundation` runs the subset of `npm test` that owns a
**Foundation invariant** — the soundness properties established by F1–F6.
It is a *subset*, not a second suite: every file it runs is also run by
`npm test`, so the two can never disagree, and CI does not execute the full
suite twice.

The authoritative list of invariants and their owning tests is
`src/testing/foundation-invariants.ts`. It is data rather than prose so it
cannot drift: `src/testing/foundation-invariants.test.ts` fails if the map
names a test that does not exist, names a test the gate does not execute,
or if the gate runs a file the map does not account for.

| | fast (`test:foundation`, ~50s) | full (CI) |
| --- | --- | --- |
| proof contracts (VT-CONTRACT-01/02/03) | ✓ | ✓ |
| F4 proof-mutation harness (`unsafe_survival === 0`) | ✓ | ✓ |
| F2 fail-closed guards | ✓ | ✓ |
| F3 output/uncertainty contract | ✓ | ✓ |
| `PackageInstance` exact isolation | ✓ | ✓ |
| F5 caches, graph-index refusal, multiplier | ✓ | ✓ |
| offline semantic differential | ✓ | ✓ |
| schema + fixture integrity + commit metadata | ✓ | ✓ |
| everything else in `npm test` | | ✓ |
| adversarial suites | | ✓ |
| wall-clock performance smoke | | ✓ |
| build / typecheck / lint / prettier / history | | ✓ |

**Deterministic vs. live.** The Foundation gate is entirely deterministic
and offline. Two signals are deliberately *not* part of it and are reported
separately:

- `npm run test:validation` hits the **real OSV API over the network**. It
  is integration evidence and a provider-movement detector, not a
  correctness oracle — advisory-database movement must not be able to make
  core CI flaky.
- **`npm test` is not itself fully offline.** One suite inside it,
  `src/vulnerabilities/osv-provider.integration.test.ts`, queries the live
  OSV API unconditionally, so a provider or network outage can turn the
  full run — and therefore CI — red for reasons unrelated to any change.
  This predates the Foundation gate and is recorded rather than fixed
  here; isolating or stubbing it is a follow-up. `test:foundation`
  contains no network access at all (verified by running it with the
  network disabled), which is why it, and not `npm test`, is the
  deterministic oracle.
- `npm run test:performance` measures **wall-clock time**. Its thresholds
  are coarse catastrophic-regression ceilings that answer "did something
  explode", never "is the complexity contract intact". The complexity
  contract is an exact **operation-count** gate
  (`src/analysis/scan-caches.f5-multiplier.test.ts`), which has no
  threshold to tune.

**Threshold-ratchet policy.** Performance thresholds must not simply be
raised to make CI green. The three wall-clock ceilings are pinned in
`src/testing/foundation-invariants.test.ts` as well as in the guard file, so
changing one is a deliberate two-file edit; the failure message names the
record (`tests/validation/FINDINGS.md`) where the measurement and
justification must go.

**Commit metadata.** `npm run validate:history` checks both the
bootstrap-kit archive and the commit-metadata policy
(`scripts/commit-metadata-policy.mjs`): commits added after the F6 base
carry no model name in an identity trailer and no session telemetry. The
allowed attribution is `Co-Authored-By: Claude <noreply@anthropic.com>`.
Three commits merged before F6 violate the policy and are documented
exceptions rather than history rewrites — see
`scripts/validate-commit-metadata.mjs`.

Coverage reports are written to `coverage/` (text summary printed to stdout,
plus `coverage/lcov.info` and an HTML report).

## Performance and caching

Every scan reports per-phase timing (`timings` in the JSON output —
parsing, resolution, graph construction, reachability, provider,
cache hit/miss; see `docs/SDD.md § 30`). OSV responses are cached by
default at `<project>/.vulntrace-cache/osv/` (gitignored), keyed by
`{tool version, ecosystem, package name, version}` so a cache entry
from a different VulnTrace build is never reused; disable with
`--no-cache` or `vulnerabilities.cache.enabled: false` in
`vulntrace.yml`. `src/cli/scan-performance.test.ts` is the regression
guard: a synthetic ~300-file project must scan in under 5 seconds.

## Known limitations

[`docs/OPEN-DEBTS.md`](docs/OPEN-DEBTS.md) is the current, authoritative
register of what the project knows it has not finished — including the
`AnalysisProofContext` mutability debt, the live-OSV leakage in `npm test`,
and RWF-002. It also states the entry criteria for the next phase.

See `docs/adr/0007-mvp-known-limitations.md` for the MVP-era list
(deferred fixture categories, non-hoisted multi-version dependency
resolution, path-traversal hardening scope, and more). None of these
allow a false `NOT_AFFECTED` or a silently dropped finding — each one
narrows what can be *analyzed*, never what can be *concluded*.

## License

MIT — see [LICENSE](LICENSE).
