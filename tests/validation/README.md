# Real-World CVE Validation

See `docs/VALIDATION-STRATEGY.md` for the full strategy this suite
implements (purpose, case lifecycle, oracle authorship, required metrics,
and why false `NOT_AFFECTED` is treated as a critical security failure).
This README covers layout and how to run it.

This suite is the next phase after the two adversarial validation suites
(`tests/adversarial/v1/`, `tests/adversarial/v2/`, both 100% passing).
Where the adversarial suites test *synthetic* scenarios designed to probe
specific analyzer mechanisms, this suite tests VulnTrace against *real*,
previously-published CVEs/GHSAs in real, npm-installed open-source
packages — including hitting the real, live OSV API (not stubbed).

## Layout

- `fixtures/` — one subdirectory per validation case: a real reproduction
  project (a real `package.json`/`package-lock.json` pinning the real
  vulnerable package version, the real installed package vendored under
  `node_modules/`, plus the minimum application code needed to exercise —
  or deliberately not exercise — the vulnerable symbol). See
  `fixtures/README.md`.
- `cases/cases.json` — one case definition per real CVE/GHSA, in the same
  spirit as `tests/adversarial/v1/expected.json` / `v2/expected.json`: an
  independently-researched expected verdict (AFFECTED/NOT_AFFECTED/
  UNKNOWN), written by reading the real CVE advisory and the real
  vulnerable code path, never by running VulnTrace first and copying its
  output. See `cases/README.md`.
- `validation.test.ts` — the runner. Prints an
  `ID EXPECTED ACTUAL RESULT` table and writes `REPORT.md`, same shape as
  both adversarial runners.
- `FINDINGS.md` — a running log of every gap discovered this way, kept
  up to date after each run. See its own header for the tracking
  discipline.

## Principles carried over from the adversarial suites

- The oracle (expected verdict + rationale) MUST be authored
  independently of VulnTrace's own output.
- A disagreement between VulnTrace and the oracle is kept as a *failing*
  test and investigated — never silently adjusted to make the suite pass,
  and the analyzer is never modified just to make a case pass. It's
  recorded in `FINDINGS.md` and the case is marked `knownFailure: true` in
  `cases.json` instead.
- `UNKNOWN` is a legitimate, correct answer when a real project's code
  genuinely can't be statically resolved — it is not automatically a
  suite failure the way a wrong AFFECTED/NOT_AFFECTED is. A `knownFailure`
  case that resolves to UNKNOWN instead of a definite AFFECTED/
  NOT_AFFECTED is tracked precisely because UNKNOWN is the *safe* wrong
  answer, never a false one — see `FINDINGS.md`.

## Running

```bash
npm run test:validation
```

Requires network access — the OSV query in every case is live, not
stubbed (the point is validating the real integration, not just the
call-graph/verdict logic already covered by the adversarial suites).
Fixtures themselves are fully vendored (real `node_modules/` committed),
so no `npm install` step is needed at run time.

Currently exits non-zero: 4 of 14 cases pass; the other 10 are known,
tracked failures (see `FINDINGS.md` RWF-001 through RWF-006) — this is
expected and not a regression. `REPORT.md`'s own "Unexpected failures"
count is the actual regression signal to watch, and is currently `0`. Not
part of `npm test`/CI's default gate, and not yet added to CI at all
(unlike `test:adversarial`, which is 100% clean) — there'd be nothing
meaningful for a red/green CI gate to report while known failures are
expected.
