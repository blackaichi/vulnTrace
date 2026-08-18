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
