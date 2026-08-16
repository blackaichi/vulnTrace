import type { ZodIssueSummary } from "../shared/zod-issues.js";

export type CycloneDxIssue = ZodIssueSummary;

function formatIssues(issues: readonly CycloneDxIssue[]): string {
  return issues
    .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
    .join("\n");
}

/** Base class for all CycloneDX SBOM loading/validation errors. */
export abstract class CycloneDxError extends Error {}

/** The CycloneDX SBOM file could not be read from disk. */
export class CycloneDxFileNotFoundError extends CycloneDxError {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    super(`CycloneDX SBOM file not found or unreadable: ${filePath}`, {
      cause,
    });
    this.name = "CycloneDxFileNotFoundError";
    this.filePath = filePath;
  }
}

/** The CycloneDX SBOM text is not valid JSON. */
export class CycloneDxSyntaxError extends CycloneDxError {
  readonly source: string;

  constructor(source: string, message: string, cause: unknown) {
    super(`Invalid JSON in ${source}: ${message}`, { cause });
    this.name = "CycloneDxSyntaxError";
    this.source = source;
  }
}

/** The document is not a valid CycloneDX SBOM (wrong bomFormat, missing required fields, etc.). */
export class CycloneDxValidationError extends CycloneDxError {
  readonly issues: readonly CycloneDxIssue[];

  constructor(issues: readonly CycloneDxIssue[]) {
    super(`Invalid CycloneDX SBOM:\n${formatIssues(issues)}`);
    this.name = "CycloneDxValidationError";
    this.issues = issues;
  }
}
