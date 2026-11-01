| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-12 | `vuln-lib` (synthetic fixture) | An all-UNKNOWN scan exits 0, identical to a clean scan, with no machine-readable signal that nothing was decided | false reason / product — see below | **Fixed** (B-5) — see below |

## AUD-12 — An all-UNKNOWN scan exits 0, identical to a clean scan, with no machine-readable signal that nothing was decided

**Status:** Open
**Failure class:** false reason / product
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** Medium
**Fix lane:** B — intake, cache, output

Exit code 0 means only "no AFFECTED finding"; a scan where every candidate resolved to UNKNOWN exits identically to a genuinely clean one, so a CI gate cannot distinguish "nothing vulnerable" from "nothing was decided" without parsing `findings[].verdict` itself.

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-12"`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task B-5, 2026-10-11): Fixed** (decision 3,
REMEDIATION-PLAN § 6.1 item 3). A finished scan exits `1` when a finding is
`AFFECTED`; otherwise **`5`** when a finding is `UNKNOWN` or an
`unreportedCandidates` entry is `undetermined`; otherwise `0`.
`--lenient-exit` maps `5` to `0` and changes nothing else. The error codes
`2`, `3` and `4` keep their meaning. Every result carries a `summary`
(schema `0.8`, additive): counts by verdict and by disposition, and an
`outcome` (`affected`, `undecided` or `decided`). It is computed by
`summarizeScan` (`src/cli/scan-summary.ts`) from the very arrays emitted
next to it, and the exit code is computed from it by `exitCodeFor`, so the
three cannot disagree. A `withdrawn` entry counts as decided, as B-1 left
for B-5 to settle: decision 3 defines "undecided" exhaustively, and a
withdrawal is a certain statement with no uncertainty category, like
`not_applicable`. Reproduced end to end, failing on the base
(`src/cli/scan.b5-cli-output.test.ts`, "B-5 (AUD-12, decision 3)"): the
audit's case (two no-rule `UNKNOWN`s) exits 0 on the base and 5 now; a
scan with only an undetermined entry (B-1's malformed record, B-4's
versionless instance with no advisory) likewise. Over the 139 corpus cases
of `scripts/differential.mjs`, 35 cases that exited 0 now exit 5; no verdict
moved. Foundation invariant `VT-INV-B-exit-decision`.

---

