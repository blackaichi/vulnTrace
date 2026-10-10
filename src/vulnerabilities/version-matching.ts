import semver from "semver";
import type { Vulnerability, VersionRange } from "../domain/vulnerability.js";

/**
 * The outcome of comparing one installed version against one
 * vulnerability's affected ranges (see docs/SDD.md § 11-14, § 23):
 *
 * - `"affected"`: the installed version falls within a known affected range.
 * - `"not_affected"`: every affected range was resolved and confidently
 *   excludes the installed version.
 * - `"indeterminate"`: the installed version or a range boundary is not a
 *   SemVer version, a range cannot be ordered against one, or there is no
 *   range at all, so no confident conclusion is possible. Never collapsed
 *   into `"not_affected"` (see AGENTS.md: never infer NOT_AFFECTED merely
 *   because the analyzer failed to resolve something).
 */
export type VersionMatchResult = "affected" | "not_affected" | "indeterminate";

/**
 * A SemVer 2.0 parse (node-semver's `semver.parse`, which also tolerates a
 * leading `v` and surrounding whitespace), never `semver.coerce` (task
 * B-2, AUD-05): coercion stripped prerelease identifiers (`2.0.0-rc.1`
 * read as `2.0.0`, outside `fixed: 2.0.0`) and turned non-versions into
 * versions (a commit hash `3f2a9c1b0d` read as `3.0.0`). A value that is
 * not a SemVer version is `null`, and whatever it bounds is indeterminate.
 * Comparison is SemVer precedence (§ 11), which OSV's `SEMVER` range type
 * names: prereleases included, build metadata ignored.
 *
 * One more shape is `null`: a numeric prerelease identifier at or above
 * `Number.MAX_SAFE_INTEGER`. node-semver keeps it as a string and compares
 * it as a JavaScript number, so `1.0.0-9007199254740992` and
 * `1.0.0-9007199254740993` compare equal, while SemVer's precedence is
 * exact (B-2's independent audit, finding 1). Refused rather than
 * misordered.
 */
export function parseSemVer(raw: string): semver.SemVer | null {
  const parsed = semver.parse(raw);
  if (
    parsed?.prerelease.some(
      (identifier) =>
        typeof identifier === "string" && /^\d+$/.test(identifier),
    )
  ) {
    return null;
  }
  return parsed;
}

const parse = parseSemVer;

/** OSV's `introduced: "0"`, or no `introduced` at all: below every version. */
const BEGINNING = "0";

/**
 * Determines whether `version` falls within one affected interval: `fixed`
 * is exclusive (the first safe version), `lastAffected` is inclusive (the
 * last known-affected version), and an interval with neither is
 * open-ended (still affected, with no known fix). A range the provider
 * declared but that cannot be ordered against a SemVer version is
 * indeterminate (task B-2, AUD-09).
 */
function matchesRange(
  installed: semver.SemVer,
  range: VersionRange,
): VersionMatchResult {
  if (range.uninterpretable !== undefined) {
    return "indeterminate";
  }

  const introducedRaw = range.introduced ?? BEGINNING;
  if (introducedRaw !== BEGINNING) {
    const introduced = parse(introducedRaw);
    if (!introduced) {
      return "indeterminate";
    }
    if (semver.lt(installed, introduced)) {
      return "not_affected";
    }
  }

  if (range.fixed !== undefined) {
    const fixed = parse(range.fixed);
    if (!fixed) {
      return "indeterminate";
    }
    return semver.lt(installed, fixed) ? "affected" : "not_affected";
  }

  if (range.lastAffected !== undefined) {
    const lastAffected = parse(range.lastAffected);
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
 *
 * Any range that covers the version decides `"affected"`. Otherwise one
 * range that cannot be decided makes the answer `"indeterminate"`: it may
 * cover the version, so the others excluding it proves nothing. An empty
 * list is `"indeterminate"` too (task B-2, AUD-09): an advisory that
 * declares no range at all for the package says nothing about which
 * versions it affects, and is never read as "none".
 */
export function matchVersion(
  version: string,
  affectedVersions: readonly VersionRange[],
): VersionMatchResult {
  const installed = parse(version);
  if (!installed) {
    return "indeterminate";
  }

  if (affectedVersions.length === 0) {
    return "indeterminate";
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
