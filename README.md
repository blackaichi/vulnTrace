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

Design/implementation handoff. The coding agent should build the MVP in task order.

## Example command

```bash
vulntrace scan .
vulntrace scan . --cve CVE-XXXX
vulntrace scan . --format json
vulntrace scan . --config vulntrace.yml --pretty
vulntrace rules validate rules/vulntrace-rules.yml
vulntrace version
```

Exit codes: `0` no AFFECTED findings, `1` at least one AFFECTED finding,
`2` configuration/usage error, `3` analysis failure, `4` vulnerability
provider/network failure (see `docs/SDD.md § 25` and `src/cli/scan.ts`).

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
  (`src/testing/fixtures.integration.test.ts`).
- End-to-end, contract/schema, and performance-smoke tests are introduced by
  later tasks (fixture suite / E2E vertical slice / JSON output / performance
  baseline) and will follow the same `*.test.ts` convention with a
  descriptive suffix.

```bash
npm test                # run everything
npm run test:unit        # unit tests only
npm run test:integration  # integration tests only
npm run test:coverage      # run everything with V8 coverage reporting
```

Coverage reports are written to `coverage/` (text summary printed to stdout,
plus `coverage/lcov.info` and an HTML report).
