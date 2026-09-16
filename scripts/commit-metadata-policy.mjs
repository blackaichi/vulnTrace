/**
 * FOUNDATION F6 — THE COMMIT METADATA POLICY.
 *
 * A pure function over ONE commit's metadata, separated from the git walk
 * in `validate-commit-metadata.mjs` for a single reason: a policy that can
 * only be exercised by making real commits cannot be unit-tested, and an
 * untested policy is how the gap this file closes came to exist. Every
 * rule below is driven directly from synthetic fixtures by
 * `src/testing/commit-metadata-policy.test.ts`, with no repository, no
 * remote and no commits involved.
 *
 * WHY THIS EXISTS (RWF-039 § history validator).
 *
 * `scripts/validate-history.mjs` is named `validate:history`, and the
 * repository's task convention forbids model names in commit metadata, so
 * it was reasonable to assume the two were connected. They were not. That
 * script validates the *bootstrap-kit archive* — that `docs/history/tasks/`
 * still holds 30 task files and that nine kit files exist. It reads no
 * commit, opens no git object and has no concept of a trailer. Three
 * commits carrying forbidden metadata reached `main` without it failing,
 * because there was never a check to fail: the gap was total, not partial.
 *
 * WHAT IS FORBIDDEN, AND THE SCOPE OF EACH RULE.
 *
 * The scoping is the delicate part. "Reject model names" applied naively
 * to whole commit messages would reject a legitimate message describing,
 * say, work on a GPT-5 integration — and this repository's prose discusses
 * analyzers, providers and models constantly. So the rules divide by where
 * a token can appear *legitimately*:
 *
 * - **Identity trailers** (`Co-Authored-By`, `Signed-off-by`, and the
 *   author/committer name fields) name a PERSON OR AGENT. A model name
 *   there is never prose; it is exactly the violation. Model identifiers
 *   are rejected in these positions only.
 * - **Telemetry markers** — `claude.ai/` URLs, `session_...` identifiers,
 *   `*-Session:` trailers, `Generated-by:`-style model trailers — have no
 *   legitimate prose use anywhere in a commit message, so they are
 *   rejected wherever they appear in it.
 * - **Everything else**, including ordinary prose that happens to mention
 *   a model, and the contents of every file in the tree, is NOT the
 *   business of this policy. It reads commit metadata and nothing else.
 *
 * The allowed attribution form is exactly:
 *
 *     Co-Authored-By: Claude <noreply@anthropic.com>
 */

/**
 * Model identifiers, matched only inside identity trailers.
 *
 * Deliberately anchored on the VENDOR-plus-FAMILY shape (`Claude Opus`,
 * `GPT-5`) rather than on bare family words. A bare `Opus` or `Haiku` is a
 * real English word and a real person could be called neither, but the
 * cost of a false positive in an identity trailer is a blocked commit with
 * a confusing message, and the observed violations all carry the vendor
 * prefix. `Claude` alone is the ALLOWED form and must never match.
 */
const MODEL_IDENTIFIER_PATTERNS = [
  {
    id: "claude_model_family",
    // `Claude Opus 5`, `Claude-Sonnet-4.5`, `Claude 3 Haiku`, `Claude Fable 5.1`.
    pattern: /\bClaude[\s-]+(?:\d+(?:\.\d+)*[\s-]+)?(?:Opus|Sonnet|Haiku|Fable|Instant)\b/i,
    describe: "a Claude model family name",
  },
  {
    id: "claude_bare_version",
    // `Claude 5`, `Claude-4.5` — a version without a family word.
    pattern: /\bClaude[\s-]+\d+(?:\.\d+)*\b/i,
    describe: "a Claude version number",
  },
  {
    id: "claude_model_slug",
    // `claude-opus-5`, `claude-3-5-sonnet-20241022`, `us.anthropic.claude-...`.
    pattern: /\bclaude-[a-z0-9.-]*(?:opus|sonnet|haiku|fable|instant)[a-z0-9.-]*\b/i,
    describe: "a Claude model slug",
  },
  {
    id: "foreign_model",
    // Other vendors' models, so the rule is about model identifiers and
    // not about one vendor: `GPT-5.6`, `Gemini 2.5 Pro`, `Llama 3`.
    // Each requires vendor AND version, for the same false-positive
    // reason the Claude patterns do.
    pattern:
      /\b(?:GPT[\s-]*\d+(?:\.\d+)*|Gemini[\s-]+\d+(?:\.\d+)*|Llama[\s-]+\d+(?:\.\d+)*|Mistral[\s-]+\d+(?:\.\d+)*)\b/i,
    describe: "a non-Anthropic model identifier",
  },
];

/**
 * Telemetry markers, matched anywhere in the commit message.
 *
 * None of these can appear in legitimate prose: they are machine-emitted
 * session bookkeeping, and the whole point of forbidding them is that a
 * commit message is a permanent public record of the change, not of the
 * tooling run that produced it.
 */
const TELEMETRY_PATTERNS = [
  {
    id: "session_trailer",
    // `Claude-Session:`, `X-Session-Id:`, `Session-ID:` — any trailer whose
    // key is session bookkeeping.
    pattern: /^[ \t]*[A-Za-z][A-Za-z0-9-]*-?Session(?:-Id)?[ \t]*:/im,
    describe: "a session-telemetry trailer",
  },
  {
    id: "claude_ai_url",
    pattern: /\bclaude\.ai\b/i,
    describe: "a claude.ai URL",
  },
  {
    id: "session_id",
    // `session_01AjffHEwryzPwMM8L8wSqGo` and similar opaque run handles.
    pattern: /\bsession[_-][A-Za-z0-9]{8,}\b/i,
    describe: "an opaque session identifier",
  },
  {
    id: "generated_by_model",
    // `Generated-by: <model>` / `Generated-With: <model>` as a TRAILER.
    // Prose such as "the report generated by the scan" is untouched,
    // because this only matches a trailer key at the start of a line.
    pattern: /^[ \t]*Generated[-_]?(?:by|with)[ \t]*:/im,
    describe: "a generated-by model trailer",
  },
];

/** Trailer keys whose value names a person or agent identity. */
const IDENTITY_TRAILER_KEYS = new Set([
  "co-authored-by",
  "signed-off-by",
  "author",
  "committer",
  "on-behalf-of",
  "reviewed-by",
  "acked-by",
]);

/**
 * Identity trailer lines in a commit message, as `{ key, value, line }`.
 *
 * Scans the WHOLE message rather than only the final trailer block: a
 * forbidden identity line is a violation wherever it sits, and git itself
 * will not reliably parse a trailer block that prose has interrupted.
 */
function identityTrailers(message) {
  const found = [];
  const lines = message.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = /^[ \t]*([A-Za-z][A-Za-z0-9-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    if (IDENTITY_TRAILER_KEYS.has(key.toLowerCase())) {
      found.push({ key, value, line: index + 1 });
    }
  }
  return found;
}

/**
 * Checks one commit's metadata against the policy.
 *
 * @param {{
 *   sha?: string,
 *   subject?: string,
 *   message: string,
 *   authorName?: string,
 *   committerName?: string,
 * }} commit
 * @returns {Array<{ rule: string, scope: string, detail: string, evidence: string }>}
 *   Every violation found, empty when the commit is compliant.
 */
export function checkCommitMetadata(commit) {
  const violations = [];
  const message = commit.message ?? "";

  // RULE 1 — model identifiers inside identity trailers.
  for (const trailer of identityTrailers(message)) {
    for (const rule of MODEL_IDENTIFIER_PATTERNS) {
      const match = rule.pattern.exec(trailer.value);
      if (match) {
        violations.push({
          rule: rule.id,
          scope: `${trailer.key} trailer (message line ${trailer.line})`,
          detail: `identity trailer names ${rule.describe}`,
          evidence: `${trailer.key}: ${trailer.value}`,
        });
      }
    }
  }

  // RULE 2 — model identifiers in the author/committer identity itself.
  for (const [field, name] of [
    ["author", commit.authorName],
    ["committer", commit.committerName],
  ]) {
    if (!name) {
      continue;
    }
    for (const rule of MODEL_IDENTIFIER_PATTERNS) {
      if (rule.pattern.test(name)) {
        violations.push({
          rule: rule.id,
          scope: `${field} name`,
          detail: `${field} identity names ${rule.describe}`,
          evidence: name,
        });
      }
    }
  }

  // RULE 3 — telemetry anywhere in the message.
  for (const rule of TELEMETRY_PATTERNS) {
    const match = rule.pattern.exec(message);
    if (match) {
      violations.push({
        rule: rule.id,
        scope: "commit message",
        detail: `commit message contains ${rule.describe}`,
        evidence: match[0].trim(),
      });
    }
  }

  return violations;
}

/**
 * Renders violations the way F6 § 27 requires a gate failure to read:
 * the invariant, the case, what was expected and what was actually found.
 */
export function formatViolations(commit, violations) {
  const identity = commit.sha
    ? `${commit.sha.slice(0, 10)} ${commit.subject ?? ""}`.trim()
    : (commit.subject ?? "(commit)");
  const lines = [`commit ${identity}`];
  for (const violation of violations) {
    lines.push(
      `  invariant: commit metadata carries no model name or session telemetry`,
      `  rule:      ${violation.rule}`,
      `  where:     ${violation.scope}`,
      `  expected:  ${violation.detail.replace(/^.*?names /, "no ").replace(/^commit message contains /, "no ")}`,
      `  actual:    ${violation.evidence}`,
      "",
    );
  }
  lines.push(
    "  allowed attribution: Co-Authored-By: Claude <noreply@anthropic.com>",
  );
  return lines.join("\n");
}

export const POLICY_RULE_IDS = [
  ...MODEL_IDENTIFIER_PATTERNS.map((rule) => rule.id),
  ...TELEMETRY_PATTERNS.map((rule) => rule.id),
];
