import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkCommitMetadata,
  formatViolations,
} from "./commit-metadata-policy.mjs";

/**
 * FOUNDATION F6 — THE COMMIT METADATA GATE (the git walk).
 *
 * Applies `commit-metadata-policy.mjs` to every commit this branch ADDED,
 * and to nothing else. The policy itself is unit-tested without git; this
 * file's only job is deciding WHICH commits the policy is asked about, and
 * that decision is the whole reason F6 needed a baseline.
 *
 * WHY A BASELINE AT ALL.
 *
 * Three commits already on `main` carry forbidden metadata:
 *
 *   86c8669  ci: run on push and PR to main, and stop the perf guard flaking
 *            -> `Co-Authored-By: Claude Opus 5`, plus a `Claude-Session:`
 *               trailer carrying a claude.ai session URL
 *   26cb448  test: make the F5 multiplier gate deterministic
 *            -> `Co-Authored-By: Claude Opus 5`
 *   3286394  docs: record the CI gate remediation, and correct three
 *            audit findings
 *            -> `Co-Authored-By: Claude Opus 5`
 *
 * They are merged, published, and referenced by RWF-038. Rewriting `main`
 * to erase them would invalidate every SHA the remediation records cite,
 * for a metadata defect that changes no code — a far worse trade than
 * carrying three documented exceptions. So they are GRANDFATHERED, and the
 * policy applies strictly from the F6 base forward.
 *
 * HOW THE CUTOFF WORKS, AND WHY THERE ARE TWO MECHANISMS.
 *
 * The primary mechanism is the SHA cutoff: only commits in
 * `F6_BASE_SHA..HEAD` are checked, so everything merged up to and
 * including the F6 base is historical and everything added after it is
 * strictly current. That is the smallest possible grandfathering — it
 * names one commit, not a list of exceptions, and it needs no maintenance
 * as history grows.
 *
 * The secondary mechanism is the explicit list above, restated in
 * {@link GRANDFATHERED} below with its reason. It exists because the
 * cutoff alone silently degrades in two real situations: a SHALLOW clone
 * (`actions/checkout@v4` fetches depth 1 by default) has no base commit to
 * compute a range from, and a rebase would move these commits to new SHAs
 * on the far side of the cutoff. In both cases the range is unusable and
 * the walk falls back to what it can see, where an explicit list is what
 * stops a known-historical commit being re-reported as a new violation.
 *
 * Neither mechanism can hide a NEW violation: a new commit is not in the
 * list, and is in the range.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * The Foundation F6 base: `main` as it stood when F6 began.
 *
 * Everything reachable from this commit is the historical baseline.
 * Changing this value forward is a policy decision that grandfathers more
 * history, and must be justified in `tests/validation/FINDINGS.md` exactly
 * as a performance-threshold change must be (F6 § 11).
 */
export const F6_BASE_SHA = "32863945c2527b1f85fdebfaa12fd854683dd794";

/**
 * Commits known to violate the policy and deliberately exempted, each with
 * the reason it is exempt rather than fixed.
 *
 * This is NOT a general escape hatch. Every entry predates
 * {@link F6_BASE_SHA} and is already covered by the range cutoff; the list
 * exists only so a shallow clone or a rebase cannot turn merged history
 * into a failing gate. Adding an entry for a commit created AFTER the base
 * is not a use of this mechanism — it is a violation of the policy the
 * mechanism protects.
 */
export const GRANDFATHERED = new Map([
  [
    "86c86690814e438f0a529cb50ad6321e5c31b9aa",
    "merged before F6; carries a model name and a Claude-Session claude.ai URL",
  ],
  [
    "26cb44816994003ba9e3bda24c9fb910a339098b",
    "merged before F6 (F5); carries a model name in Co-Authored-By",
  ],
  [
    "32863945c2527b1f85fdebfaa12fd854683dd794",
    "merged before F6 (F5, and is the F6 base itself); carries a model name in Co-Authored-By",
  ],
]);

const RECORD = "";
const FIELD = "";

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function hasCommit(sha) {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The commits to check, and a human-readable description of the range.
 *
 * Returns the FULL reachable set when the base is unavailable, relying on
 * {@link GRANDFATHERED} to keep known history quiet — a noisier but never
 * a weaker choice, since the alternative (checking nothing) is how the
 * original gap behaved.
 */
function selectCommits() {
  if (hasCommit(F6_BASE_SHA)) {
    return {
      range: [`${F6_BASE_SHA}..HEAD`],
      description: `commits after the F6 base ${F6_BASE_SHA.slice(0, 10)}`,
    };
  }
  return {
    range: ["HEAD"],
    description:
      `every reachable commit (the F6 base ${F6_BASE_SHA.slice(0, 10)} is not ` +
      `present -- shallow clone?), minus ${GRANDFATHERED.size} documented historical exceptions`,
  };
}

function readCommits(range) {
  const format = ["%H", "%s", "%an", "%cn", "%B"].join(FIELD) + RECORD;
  const raw = git(["log", `--format=${format}`, ...range]);
  return raw
    .split(RECORD)
    .map((entry) => entry.replace(/^\n/, ""))
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => {
      const [sha, subject, authorName, committerName, message] =
        entry.split(FIELD);
      return { sha, subject, authorName, committerName, message };
    });
}

function main() {
  const { range, description } = selectCommits();
  let commits;
  try {
    commits = readCommits(range);
  } catch (error) {
    console.error(
      `Commit metadata gate could not read git history (${range.join(" ")}): ${error.message}`,
    );
    process.exit(1);
  }

  const failures = [];
  let skipped = 0;
  for (const commit of commits) {
    if (GRANDFATHERED.has(commit.sha)) {
      skipped += 1;
      continue;
    }
    const violations = checkCommitMetadata(commit);
    if (violations.length > 0) {
      failures.push(formatViolations(commit, violations));
    }
  }

  if (failures.length > 0) {
    console.error(
      `Commit metadata policy violated by ${failures.length} of ${commits.length} ` +
        `checked ${description}:\n\n${failures.join("\n")}\n\n` +
        `Amend the offending commit messages. Forbidden: model names in identity\n` +
        `trailers, session trailers, claude.ai URLs, opaque session ids, and\n` +
        `Generated-by model trailers. Allowed attribution:\n` +
        `  Co-Authored-By: Claude <noreply@anthropic.com>`,
    );
    process.exit(1);
  }

  const grandfathered =
    skipped > 0 ? `, ${skipped} documented historical exception(s) skipped` : "";
  console.log(
    `Commit metadata OK: ${commits.length - skipped} ${description} carry no ` +
      `model names or session telemetry${grandfathered}.`,
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
