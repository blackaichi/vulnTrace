# Real-World CVE Validation (scaffold)

This suite is the next phase after the two adversarial validation suites
(`tests/adversarial/v1/`, `tests/adversarial/v2/`, both 100% passing).
Where the adversarial suites test *synthetic* scenarios designed to probe
specific analyzer mechanisms, this suite will test VulnTrace against
*real*, previously-published CVEs/GHSAs in real open-source packages.

**This directory is currently an empty scaffold.** No cases exist yet —
this commit only reserves the shape so the next phase has an obvious,
reproducible home from day one. Nothing here changes analyzer behavior.

## Layout

- `fixtures/` — one subdirectory per validation case: either a minimal,
  real reproduction project (a real `package.json`/`package-lock.json`
  pinning the real vulnerable package version, plus the minimum
  application code needed to exercise — or deliberately not exercise —
  the vulnerable symbol), or a pointer/instructions for fetching a real
  upstream project too large to vendor directly. See
  `fixtures/README.md`.
- `cases/` — one case definition per real CVE/GHSA, in the same spirit as
  `tests/adversarial/v1/expected.json` / `v2/expected.json`: an
  independently-researched expected verdict (AFFECTED/NOT_AFFECTED/
  UNKNOWN), written by reading the real CVE advisory and the real
  vulnerable code path, never by running VulnTrace first and copying its
  output. See `cases/README.md`.

## Principles carried over from the adversarial suites

- The oracle (expected verdict + rationale) MUST be authored
  independently of VulnTrace's own output.
- A disagreement between VulnTrace and the oracle is kept as a *failing*
  test and investigated — never silently adjusted to make the suite pass.
- `UNKNOWN` is a legitimate, correct answer when a real project's code
  genuinely can't be statically resolved (e.g. deep dynamic dispatch) —
  it is not automatically a suite failure the way a wrong AFFECTED/
  NOT_AFFECTED is.

## Running

Not yet wired to real cases. `npm run test:validation` currently runs
against zero cases and passes trivially (`vitest.validation.config.ts`
uses `passWithNoTests: true`) — this will start exercising real fixtures
once the next phase adds them.
