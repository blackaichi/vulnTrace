import type { ZodIssueSummary } from "../shared/zod-issues.js";

export type PackageJsonIssue = ZodIssueSummary;

function formatIssues(issues: readonly PackageJsonIssue[]): string {
  return issues
    .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
    .join("\n");
}

/** Base class for all package.json loading/validation errors. */
export abstract class PackageJsonError extends Error {}

/** The package.json file could not be read from disk. */
export class PackageJsonFileNotFoundError extends PackageJsonError {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    super(`package.json not found or unreadable: ${filePath}`, { cause });
    this.name = "PackageJsonFileNotFoundError";
    this.filePath = filePath;
  }
}

/** The package.json text is not valid JSON. */
export class PackageJsonSyntaxError extends PackageJsonError {
  readonly source: string;

  constructor(source: string, message: string, cause: unknown) {
    super(`Invalid JSON in ${source}: ${message}`, { cause });
    this.name = "PackageJsonSyntaxError";
    this.source = source;
  }
}

/** The package.json does not match the expected shape for a field VulnTrace reads. */
export class PackageJsonValidationError extends PackageJsonError {
  readonly issues: readonly PackageJsonIssue[];

  constructor(issues: readonly PackageJsonIssue[]) {
    super(`Invalid package.json:\n${formatIssues(issues)}`);
    this.name = "PackageJsonValidationError";
    this.issues = issues;
  }
}
