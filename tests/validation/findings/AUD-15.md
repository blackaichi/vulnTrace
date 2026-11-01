| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-15 | `vuln-lib` (synthetic fixture) | An UNKNOWN's reason text falsely claims a package "was never traversed" when the true cause is that no rule names it | false reason — see below | **Fixed** (B-6) — see below |

## AUD-15 — An UNKNOWN's reason text falsely claims a package "was never traversed" when the true cause is that no rule names it

**Status:** Open
**Failure class:** false reason
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** Low
**Fix lane:** B — intake, cache, output

When one advisory affects two packages but the rule only targets one of them, the untargeted package's finding is UNKNOWN — the verdict is sound — but its reason text (`package_instance_absence`, "was never traversed") is false: the package was traversed; no rule names it. A rule's `package.name` is never compared against the resolved target, so this mismatch is silent.

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-15"`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task B-6, 2026-10-12): Fixed.** Measured first: the
recorded reason no longer exists on `main`. At B-6's base (`6707a00`) the
untargeted package's `UNKNOWN` carried `vulnerable_target_unresolved` and
the prose `could not resolve module "vuln-lib": … the authoritative public
entry of package instance …/other-lib could not be resolved`, not
`package_instance_absence_*` / "never traversed". The defect stood in a new
form: the rule's targets were resolved against an instance of a package the
rule does not name, and the cause was never stated. The second half of the
finding was also true and had a worse shape than "silent": a rule's
`package.name` was never read, so a rule whose `package.name` named the
wrong package (a typo, a case difference) was applied anyway and the
finding could be `AFFECTED` (measured: `Vuln-Lib` against `vuln-lib`).

**Fix (B-6):** `buildFinding` compares the rule's `package.name` with the
finding's `packageName` (exact, the name the advisory selected the instance
by, so an npm alias is the package it is) after the no-rule branch and
before any reachability or instance matching. A mismatch is `UNKNOWN` with
the new reason subtype `rule_package_mismatch` (category
`analysis_precondition_unmet`, still six categories) and prose naming both
packages. It withdraws toward `UNKNOWN` only. Tests failing on the base,
passing now: `src/cli/scan.rule-package-mismatch.test.ts`. Over the 139
corpus cases: verdict, proof and graph differentials all 0.

**Known limitations (B-6, from its independent audit, `CERTIFIED`).** (1) A
package the app never loads, which the base proved absent from the
module-load closure (family A, `NOT_AFFECTED`), is now `UNKNOWN`
(`rule_package_mismatch`), because the mismatch is decided before instance
matching, as the no-rule branch is: a precision loss, fail closed, asserted
in the "never loads" case. (2) A rule's `package.name` is binding: a rule
naming an npm alias instead of the real package, or differing by case,
was applied silently on the base (it could be `AFFECTED`) and is `UNKNOWN`
now. (3) One rule per advisory id (`DuplicateRuleIdError`, pre-existing)
means the second package of a multi-package advisory can never be
`AFFECTED`: backlog `BL-061`. (4) An alias lock entry with no `name` and an
advisory listing both names reports one instance twice (pre-existing):
backlog `BL-062`.

---

