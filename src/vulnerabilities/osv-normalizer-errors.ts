import type { ZodIssueSummary } from "../shared/zod-issues.js";

export type OsvNormalizationIssue = ZodIssueSummary;

function formatIssues(issues: readonly OsvNormalizationIssue[]): string {
  return issues
    .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
    .join("\n");
}

/**
 * A raw OSV record could not be normalized: either its shape doesn't match
 * the subset of the OSV schema this normalizer understands, or it has no
 * `affected` entry confirming it actually describes the target
 * package/ecosystem. Thrown explicitly rather than producing a
 * `Vulnerability` with an empty `affectedVersions` that downstream
 * matching could misread as "confirmed not affected"
 * (see AGENTS.md: never infer NOT_AFFECTED merely because the analyzer
 * failed to resolve something).
 */
export class OsvNormalizationError extends Error {
  readonly issues: readonly OsvNormalizationIssue[];

  constructor(message: string, issues: readonly OsvNormalizationIssue[] = []) {
    super(issues.length > 0 ? `${message}:\n${formatIssues(issues)}` : message);
    this.name = "OsvNormalizationError";
    this.issues = issues;
  }
}
