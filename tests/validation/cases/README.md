# Real-world CVE validation cases

`cases.json` holds one entry per real, previously-published CVE/GHSA
validation case, in the same spirit as an oracle entry in
`tests/adversarial/v1/expected.json` / `v2/expected.json`:

- the real advisory id (`vulnerability`) and its known aliases
  (`aliases`) — real OSV data can carry multiple, mutually-aliased
  advisory ids for the same underlying vulnerability (confirmed live for
  VAL-001's own GHSA-35jh-r3h4-6jhm / GHSA-r5fr-rjxr-66jc pair), so
  `findingSelector` keys on `vulnerability` too, not just package+version;
- the real package name and version installed in the matching
  `../fixtures/<dir>/`;
- `vulnerableTarget` — a human-readable description of the real vulnerable
  symbol (the actual `rules.yml` in the fixture directory is the real
  `VulnerableSymbolRule`, the same format `rules/vulntrace-rules.yml` uses
  for production);
- `expected` — the verdict a human security analyst would independently
  derive by reading the real advisory and the real vulnerable code path,
  never by running VulnTrace first and copying its output;
- `knownFailure` — `true` when the current analyzer disagrees with
  `expected` for a tracked, documented reason (see `../FINDINGS.md`);
  `false` when it's expected to pass. Either way, the test always asserts
  `actual === expected` and fails visibly if it doesn't — `knownFailure`
  only affects the report's own bookkeeping, never whether the test itself
  is allowed to silently pass.
- `reason` — the rationale, written independently of VulnTrace's output.

`docs/VALIDATION-STRATEGY.md § 7` proposes additional fields
(`advisoryFetchedAt`, `ecosystem`, `author`, `addedDate`, `evidencePath`)
for when case count grows past what these three need — not yet added here,
since there's no real information to put in them today.

## Current cases

- `VAL-001` — `lodash.template@4.5.0`, GHSA-35jh-r3h4-6jhm. Expected and
  actual: `AFFECTED`.
- `VAL-002` — `lodash@4.17.15`, GHSA-29mw-wpgm-hmr9, genuinely-reachable
  `trim()` call. Expected `AFFECTED`, actual `UNKNOWN` (known, see
  `../FINDINGS.md` RWF-001).
- `VAL-003` — same vulnerability, genuinely-unreachable call site.
  Expected `NOT_AFFECTED`, actual `UNKNOWN` (known, see `../FINDINGS.md`
  RWF-001).

### RWB-01..RWB-10 — the v0.1 real-world reachability benchmark

Design: `docs/REAL-WORLD-BENCHMARK-V0.1.md`. Ten cases (`RWB-09` split into
two independent findings, `RWB-09a`/`RWB-09b`, sharing one fixture),
selected to each isolate one distinct reachability-analysis capability —
see the design doc's coverage matrix (§ 4) for the full rationale. Actual
results (pass/fail per case, and whether any is a tracked `knownFailure`)
are in `../REPORT.md` and, for any failure, root-caused in `../FINDINGS.md`.

| ID | Package | Pattern | Expected | Actual | Result |
|---|---|---|---|---|---|
| RWB-01 | trim-newlines@3.0.0 | DIRECT | AFFECTED | UNKNOWN | known (RWF-005) |
| RWB-02 | minimist@1.2.5 | WRAPPER | AFFECTED | UNKNOWN | known (RWF-003) |
| RWB-03 | fast-xml-parser@5.3.3 | METHOD | AFFECTED | UNKNOWN | known (RWF-006) |
| RWB-04 | url-parse@1.4.4 | CONSTRUCTOR | AFFECTED | AFFECTED | **pass** |
| RWB-05 | qs@6.10.1 | UNUSED_API | NOT_AFFECTED | UNKNOWN | known (RWF-004) |
| RWB-06 | node-forge@1.3.3 | UNREACHED_DEPENDENCY | NOT_AFFECTED | UNKNOWN | known (RWF-002) |
| RWB-07 | ini@1.3.5 | OTHER (entrypoint-unreached) | NOT_AFFECTED | NOT_AFFECTED | **pass** |
| RWB-08 | ms@0.6.2 (via debug@2.0.0) | OTHER (nested dependency) | AFFECTED | UNKNOWN | known (RWF-004) |
| RWB-09a | semver@7.5.1 (aliased) | MULTI_INSTANCE | AFFECTED | UNKNOWN | known (RWF-004) |
| RWB-09b | semver@7.5.2 | MULTI_INSTANCE | NOT_AFFECTED | NO_FINDING | known — benchmark design issue, not a defect; see `../FINDINGS.md` |
| RWB-10 | handlebars@4.7.6 | UNKNOWN | UNKNOWN | UNKNOWN | **pass** |

4/10 pass; the other 6 each expose a distinct, real analyzer gap (5 new
findings, `RWF-002`–`RWF-006`, plus `RWB-09b`'s own benchmark-design note)
— none is a soundness violation (no false `AFFECTED`/`NOT_AFFECTED`
anywhere in this run), all degrade safely to `UNKNOWN` or, for `RWB-09b`,
to no finding at all. See `../FINDINGS.md` for full root-cause writeups.
