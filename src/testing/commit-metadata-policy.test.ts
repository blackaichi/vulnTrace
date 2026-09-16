import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Plain ESM policy modules, deliberately not TypeScript: they are loaded
// by bare `node` during `validate:history`, with no build step available.
// Their types live in the matching `.d.mts` files.
import {
  type CommitRecord,
  checkCommitMetadata,
  formatViolations,
  POLICY_RULE_IDS,
} from "../../scripts/commit-metadata-policy.mjs";
import {
  F6_BASE_SHA,
  GRANDFATHERED,
} from "../../scripts/validate-commit-metadata.mjs";

/**
 * FOUNDATION F6 — the commit metadata gate, mutation-checked.
 *
 * The gap this closes was not a weak rule, it was a MISSING one:
 * `validate:history` never read a commit at all (see
 * `scripts/commit-metadata-policy.mjs`). So the risk a new rule carries is
 * the mirror image — a policy that looks strict and matches nothing. Every
 * forbidden form below is therefore asserted to be REJECTED, every allowed
 * form to be ACCEPTED, and both directions run on synthetic commit records
 * rather than on repository history, so the suite is hermetic and creates
 * no commits (F6 § 24).
 */

const check = checkCommitMetadata;
const format = formatViolations;

/** A realistic commit message with `trailers` appended, as git stores it. */
function commitMessage(trailers: readonly string[]): string {
  return [
    "test: consolidate the deterministic foundation gates",
    "",
    "A body paragraph of the kind this repository actually writes, long",
    "enough that a rule matching anywhere in the message has somewhere to",
    "produce a false positive.",
    "",
    ...trailers,
  ].join("\n");
}

const ALLOWED_ATTRIBUTION = "Co-Authored-By: Claude <noreply@anthropic.com>";

describe("commit metadata policy: the allowed attribution form", () => {
  it("accepts the exact allowed trailer", () => {
    const violations = check({
      subject: "test: consolidate the deterministic foundation gates",
      message: commitMessage([ALLOWED_ATTRIBUTION]),
      authorName: "blackaichi",
      committerName: "blackaichi",
    });
    expect(
      violations,
      `the ALLOWED attribution form was rejected: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });

  it("accepts a commit with no trailers at all", () => {
    expect(check({ message: commitMessage([]) })).toEqual([]);
  });

  it("accepts ordinary human co-authors alongside it", () => {
    expect(
      check({
        message: commitMessage([
          "Co-Authored-By: A Teammate <teammate@example.com>",
          ALLOWED_ATTRIBUTION,
          "Signed-off-by: A Maintainer <maintainer@example.com>",
        ]),
      }),
    ).toEqual([]);
  });
});

/**
 * The forbidden forms. Each row is asserted to produce at least one
 * violation AND to name the rule that caught it, so a rule that stops
 * matching cannot be masked by a different rule happening to fire.
 */
const FORBIDDEN: ReadonlyArray<{
  readonly label: string;
  readonly commit: CommitRecord;
  readonly rule: string;
}> = [
  {
    label: "Claude Opus 5 in Co-Authored-By (the form that reached main)",
    commit: {
      message: commitMessage([
        "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>",
      ]),
    },
    rule: "claude_model_family",
  },
  {
    label: "Claude Sonnet 5 in Co-Authored-By",
    commit: {
      message: commitMessage([
        "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
      ]),
    },
    rule: "claude_model_family",
  },
  {
    label: "Claude 3 Haiku, family word after the version",
    commit: {
      message: commitMessage([
        "Co-Authored-By: Claude 3 Haiku <noreply@anthropic.com>",
      ]),
    },
    rule: "claude_model_family",
  },
  {
    label: "Claude-Opus-5, hyphenated",
    commit: {
      message: commitMessage([
        "Co-Authored-By: Claude-Opus-5 <noreply@anthropic.com>",
      ]),
    },
    rule: "claude_model_family",
  },
  {
    label: "a bare version with no family word",
    commit: {
      message: commitMessage([
        "Co-Authored-By: Claude 5 <noreply@anthropic.com>",
      ]),
    },
    rule: "claude_bare_version",
  },
  {
    label: "a model slug",
    commit: {
      message: commitMessage([
        "Co-Authored-By: claude-opus-5 <noreply@anthropic.com>",
      ]),
    },
    rule: "claude_model_slug",
  },
  {
    label: "a dated model slug",
    commit: {
      message: commitMessage([
        "Co-Authored-By: claude-3-5-sonnet-20241022 <noreply@anthropic.com>",
      ]),
    },
    rule: "claude_model_slug",
  },
  {
    label: "GPT-5.6, so the rule is about models and not one vendor",
    commit: {
      message: commitMessage(["Co-Authored-By: GPT-5.6 <noreply@openai.com>"]),
    },
    rule: "foreign_model",
  },
  {
    label: "Gemini 2.5 in Co-Authored-By",
    commit: {
      message: commitMessage([
        "Co-Authored-By: Gemini 2.5 Pro <noreply@google.com>",
      ]),
    },
    rule: "foreign_model",
  },
  {
    label: "a Claude-Session trailer (the second defect in 86c8669)",
    commit: {
      message: commitMessage([
        ALLOWED_ATTRIBUTION,
        "Claude-Session: https://claude.ai/code/session_01AjffHEwryzPwMM8L8wSqGo",
      ]),
    },
    rule: "session_trailer",
  },
  {
    label: "a claude.ai URL anywhere in the message",
    commit: {
      message: commitMessage([
        "See https://claude.ai/code/abc for the run that produced this.",
        ALLOWED_ATTRIBUTION,
      ]),
    },
    rule: "claude_ai_url",
  },
  {
    label: "an opaque session identifier in the body",
    commit: {
      message: commitMessage([
        "Run session_01AjffHEwryzPwMM8L8wSqGo produced this change.",
        ALLOWED_ATTRIBUTION,
      ]),
    },
    rule: "session_id",
  },
  {
    label: "a Generated-by model trailer",
    commit: {
      message: commitMessage([
        "Generated-by: claude-opus-5",
        ALLOWED_ATTRIBUTION,
      ]),
    },
    rule: "generated_by_model",
  },
  {
    label: "a Generated-With trailer",
    commit: {
      message: commitMessage(["Generated-With: Claude Code"]),
    },
    rule: "generated_by_model",
  },
  {
    label: "a model name in the AUTHOR identity rather than a trailer",
    commit: {
      message: commitMessage([ALLOWED_ATTRIBUTION]),
      authorName: "Claude Opus 5",
    },
    rule: "claude_model_family",
  },
  {
    label: "a model name in the COMMITTER identity",
    commit: {
      message: commitMessage([ALLOWED_ATTRIBUTION]),
      committerName: "claude-sonnet-5",
    },
    rule: "claude_model_slug",
  },
  {
    label: "a model name in Signed-off-by rather than Co-Authored-By",
    commit: {
      message: commitMessage(["Signed-off-by: Claude Opus 5 <x@y.z>"]),
    },
    rule: "claude_model_family",
  },
];

describe("commit metadata policy: forbidden forms are rejected", () => {
  it.each(FORBIDDEN)("rejects $label", ({ commit, rule }) => {
    const violations = check(commit);
    expect(
      violations.length,
      `forbidden metadata was ACCEPTED:\n${commit.message}\nauthor=${commit.authorName ?? "-"} committer=${commit.committerName ?? "-"}`,
    ).toBeGreaterThan(0);
    expect(
      violations.map((violation) => violation.rule),
      `caught, but not by the rule that owns this case`,
    ).toContain(rule);
  });

  it("every declared rule is exercised by at least one case", () => {
    // Guards the guard: a rule nothing tests is a rule that can silently
    // stop matching.
    const exercised = new Set(FORBIDDEN.map((row) => row.rule));
    expect(new Set(POLICY_RULE_IDS as readonly string[])).toEqual(exercised);
  });
});

/**
 * The false-positive direction. F6 § 22 is explicit that ordinary prose
 * and source files mentioning model names must NOT be rejected, and this
 * is the half of the policy that a stricter-looking regex would break.
 */
describe("commit metadata policy: prose and source are not in scope", () => {
  const PROSE: ReadonlyArray<{
    readonly label: string;
    readonly body: string;
  }> = [
    {
      label: "a subject describing work on a model integration",
      body: "feat: add a GPT-5 provider adapter behind the existing interface",
    },
    {
      label: "a body discussing model families in prose",
      body: [
        "docs: record the provider comparison",
        "",
        "Compares Claude Opus 5 and GPT-5.6 latency against the current",
        "provider, because the adapter has to work for both.",
      ].join("\n"),
    },
    {
      label: "a body mentioning a session in ordinary English",
      body: [
        "fix: reuse the resolver across the scan session",
        "",
        "One session per scan, not one per finding.",
      ].join("\n"),
    },
    {
      label: "a body mentioning claude.com, which is not the telemetry host",
      body: "docs: link the CLI docs at https://claude.com/claude-code",
    },
    {
      label: "prose using the word generated",
      body: [
        "test: compare the generated report against the fixture",
        "",
        "The HTML generated by the reporter is compared field by field.",
      ].join("\n"),
    },
  ];

  it.each(PROSE)("accepts $label", ({ body }) => {
    const violations = check({
      message: `${body}\n\n${ALLOWED_ATTRIBUTION}`,
    });
    expect(
      violations,
      `ordinary prose was rejected, which F6 forbids: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });

  it("reads commit metadata only -- never the tree", () => {
    // This very repository contains files that name models in prose (this
    // test file among them). The policy takes a commit record and has no
    // filesystem access at all, which is the structural reason a source
    // file can never trip it.
    const source = checkCommitMetadata as unknown as { length: number };
    expect(source.length).toBe(1);
  });
});

describe("commit metadata policy: failure messages name the invariant", () => {
  it("reports invariant, case, expected and actual", () => {
    const commit: CommitRecord = {
      sha: "0123456789abcdef0123456789abcdef01234567",
      subject: "test: a commit that violates the policy",
      message: commitMessage([
        "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>",
      ]),
    };
    const rendered = format(commit, check(commit));
    expect(rendered).toContain("invariant:");
    expect(rendered).toContain("expected:");
    expect(rendered).toContain("actual:");
    expect(rendered).toContain("Claude Opus 5");
    expect(rendered).toContain("0123456789");
    expect(rendered).toContain(ALLOWED_ATTRIBUTION);
  });
});

/**
 * The historical baseline. These assertions are about the GRANDFATHERING
 * being real, minimal and honest -- not about the policy's rules.
 */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

describe("historical baseline: merged history is grandfathered, not rewritten", () => {
  const grandfathered = GRANDFATHERED;

  it("every grandfathered commit really does violate the policy", () => {
    // An exemption for a compliant commit would be noise pretending to be
    // policy. Each entry must be an actual violation, read from real
    // history.
    for (const sha of grandfathered.keys()) {
      const message = execFileSync("git", ["log", "-1", "--format=%B", sha], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      const violations = check({ sha, message });
      expect(
        violations.length,
        `${sha} is grandfathered but does not violate the policy`,
      ).toBeGreaterThan(0);
    }
  });

  it("every grandfathered commit is an ancestor of the F6 base", () => {
    // The exemption list may only ever contain MERGED history. A commit
    // created after the base is a violation to fix, never an entry to add.
    for (const sha of grandfathered.keys()) {
      const merged = execFileSync(
        "git",
        ["merge-base", "--is-ancestor", sha, F6_BASE_SHA],
        { cwd: REPO_ROOT, encoding: "utf-8" },
      );
      expect(merged).toBe("");
    }
  });

  it("every grandfathered commit carries a documented reason", () => {
    for (const [sha, reason] of grandfathered) {
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(
        reason.length,
        `${sha} is exempted with no stated reason`,
      ).toBeGreaterThan(20);
    }
  });

  it("the exemption list is exactly the violations merged history contains", () => {
    // The strongest form of "minimal": walk ALL of merged history and
    // require the offenders found to be precisely the exempted set. A new
    // violation merged to main would fail here even if someone forgot to
    // run the gate, and an exemption that is no longer needed shows up as
    // a surplus entry.
    const RECORD = "";
    const FIELD = "";
    const raw = execFileSync(
      "git",
      [
        "log",
        `--format=%H${FIELD}%an${FIELD}%cn${FIELD}%B${RECORD}`,
        F6_BASE_SHA,
      ],
      { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
    );
    const offenders = raw
      .split(RECORD)
      .map((entry) => entry.replace(/^\n/, ""))
      .filter((entry) => entry.trim().length > 0)
      .map((entry): CommitRecord & { readonly sha: string } => {
        const [sha, authorName, committerName, message] = entry.split(FIELD);
        return {
          sha: sha ?? "",
          authorName: authorName ?? "",
          committerName: committerName ?? "",
          message: message ?? "",
        };
      })
      .filter((commit) => check(commit).length > 0)
      .map((commit) => commit.sha);

    expect(new Set(offenders)).toEqual(new Set(grandfathered.keys()));
  });
});
