import semver from "semver";
import type { Vulnerability, VersionRange } from "../domain/vulnerability.js";

/**
 * The outcome of comparing one installed version against one
 * vulnerability's affected ranges (see docs/SDD.md § 11-14, § 23):
 *
 * - `"affected"`: the installed version falls within a known affected range.
 * - `"not_affected"`: every affected range was resolved and confidently
 *   excludes the installed version.
 * - `"indeterminate"`: the installed version or a range boundary could not
 *   be parsed as a version, so no confident conclusion is possible. Never
 *   collapsed into `"not_affected"` (see AGENTS.md: never infer NOT_AFFECTED
 *   merely because the analyzer failed to resolve something).
 */
export type VersionMatchResult = "affected" | "not_affected" | "indeterminate";

/**
 * Matching assumes every {@link VersionRange} boundary is a semver (or
 * semver-coercible, e.g. OSV's `"0"` sentinel) string. This holds for the
 * npm ecosystem, where OSV always uses `SEMVER`-type ranges — but
 * {@link VersionRange} itself (see src/domain/vulnerability.ts) does not
 * carry OSV's `ranges[].type` field, so a hypothetical non-SEMVER range
 * (e.g. a `GIT`-type range using commit hashes) would be silently
 * miscompared rather than rejected. See TASK-011 completion report.
 */
function coerce(raw: string): semver.SemVer | null {
  return semver.coerce(raw);
}

/**
 * Determines whether `version` falls within one affected range, following
 * the same semantics as OSV's event model: `fixed` is exclusive (the first
 * safe version), `lastAffected` is inclusive (the last known-affected
 * version), and a range with neither is open-ended (still affected, with
 * no known fix).
 */
function matchesRange(
  installed: semver.SemVer,
  range: VersionRange,
): VersionMatchResult {
  // OSV's own convention for "affected since the beginning" is the
  // sentinel "0", which sorts before every real version.
  const introduced = coerce(range.introduced ?? "0");
  if (!introduced) {
    return "indeterminate";
  }

  if (semver.lt(installed, introduced)) {
    return "not_affected";
  }

  if (range.fixed) {
    const fixed = coerce(range.fixed);
    if (!fixed) {
      return "indeterminate";
    }
    return semver.lt(installed, fixed) ? "affected" : "not_affected";
  }

  if (range.lastAffected) {
    const lastAffected = coerce(range.lastAffected);
    if (!lastAffected) {
      return "indeterminate";
    }
    return semver.lte(installed, lastAffected) ? "affected" : "not_affected";
  }

  return "affected";
}

/**
 * Determines whether an installed version is affected by a vulnerability's
 * ranges. Deterministic: the same `version`/`affectedVersions` always
 * produce the same result (see TASK-011 acceptance criteria).
 */
export function matchVersion(
  version: string,
  affectedVersions: readonly VersionRange[],
): VersionMatchResult {
  const installed = coerce(version);
  if (!installed) {
    return "indeterminate";
  }

  if (affectedVersions.length === 0) {
    return "not_affected";
  }

  let sawIndeterminate = false;

  for (const range of affectedVersions) {
    const result = matchesRange(installed, range);
    if (result === "affected") {
      return "affected";
    }
    if (result === "indeterminate") {
      sawIndeterminate = true;
    }
  }

  return sawIndeterminate ? "indeterminate" : "not_affected";
}

export interface VulnerabilityMatch {
  readonly vulnerability: Vulnerability;
  readonly result: VersionMatchResult;
}

/**
 * Filters a set of already-normalized vulnerabilities down to those whose
 * affected ranges include (or cannot confidently exclude) an installed
 * version. Only vulnerabilities affecting the installed version produce
 * candidates (see TASK-011 acceptance criteria) — a confidently
 * `"not_affected"` vulnerability is excluded; an `"indeterminate"` one is
 * still returned rather than silently dropped.
 */
export function matchVulnerabilities(
  installedVersion: string,
  vulnerabilities: readonly Vulnerability[],
): readonly VulnerabilityMatch[] {
  const matches: VulnerabilityMatch[] = [];

  for (const vulnerability of vulnerabilities) {
    const result = matchVersion(
      installedVersion,
      vulnerability.affectedVersions,
    );
    if (result !== "not_affected") {
      matches.push({ vulnerability, result });
    }
  }

  return matches;
}
