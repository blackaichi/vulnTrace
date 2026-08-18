# VulnTrace

Vulnerability-specific reachability and impact analysis for JavaScript and TypeScript.

## What makes it different?

VulnTrace is not intended to be another generic SCA scanner.

Its central model is:

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
Call Graph / Data Flow
   |
   v
Reachability
   |
   v
Evidence
   |
   v
AFFECTED / NOT_AFFECTED / UNKNOWN
```

The initial MVP uses manually authored vulnerable-symbol rules. A future phase
will infer candidate vulnerable symbols from security-fix commits and diffs.

## Status

MVP complete (all 30 tasks). See `docs/adr/0007-mvp-known-limitations.md`
for what's deliberately out of scope for this release.

## Example command

```bash
vulntrace scan .
vulntrace scan . --cve CVE-XXXX
vulntrace scan . --format json
vulntrace scan . --config vulntrace.yml --pretty
vulntrace scan . --no-cache
vulntrace rules validate rules/vulntrace-rules.yml
vulntrace version
```

Exit codes: `0` no AFFECTED findings, `1` at least one AFFECTED finding,
`2` configuration/usage error, `3` analysis failure, `4` vulnerability
provider/network failure (see `docs/SDD.md § 25` and `src/cli/scan.ts`).

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
  see `tests/validation/cases/cases.json`. Excluded from `npm test`; not
  yet gated in CI.

```bash
npm test                # run everything
npm run test:unit        # unit tests only
npm run test:integration  # integration tests only
npm run test:coverage      # run everything with V8 coverage reporting
npm run test:adversarial   # adversarial suites (v1 + v2); also run in CI
npm run test:validation    # real-world CVE validation suite
```

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

See `docs/adr/0007-mvp-known-limitations.md` for the consolidated list
(deferred fixture categories, non-hoisted multi-version dependency
resolution, path-traversal hardening scope, and more). None of these
allow a false `NOT_AFFECTED` or a silently dropped finding — each one
narrows what can be *analyzed*, never what can be *concluded*.

## License

MIT — see [LICENSE](LICENSE).
