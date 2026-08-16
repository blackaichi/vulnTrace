import type { ZodIssueSummary } from "../shared/zod-issues.js";

export type PackageLockIssue = ZodIssueSummary;

function formatIssues(issues: readonly PackageLockIssue[]): string {
  return issues
    .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
    .join("\n");
}

/** Base class for all package-lock.json loading/validation errors. */
export abstract class PackageLockError extends Error {}

/** The package-lock.json file could not be read from disk. */
export class PackageLockFileNotFoundError extends PackageLockError {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    super(`package-lock.json not found or unreadable: ${filePath}`, {
      cause,
    });
    this.name = "PackageLockFileNotFoundError";
    this.filePath = filePath;
  }
}

/** The package-lock.json text is not valid JSON. */
export class PackageLockSyntaxError extends PackageLockError {
  readonly source: string;

  constructor(source: string, message: string, cause: unknown) {
    super(`Invalid JSON in ${source}: ${message}`, { cause });
    this.name = "PackageLockSyntaxError";
    this.source = source;
  }
}

/** The package-lock.json does not match the expected shape. */
export class PackageLockValidationError extends PackageLockError {
  readonly issues: readonly PackageLockIssue[];

  constructor(issues: readonly PackageLockIssue[]) {
    super(`Invalid package-lock.json:\n${formatIssues(issues)}`);
    this.name = "PackageLockValidationError";
    this.issues = issues;
  }
}

/**
 * The lockfile uses a legacy format (npm lockfileVersion 1, pre-npm-7,
 * nested "dependencies" tree with no "packages" map). Out of MVP scope —
 * see docs/SDD.md § 11 ("The graph must support multiple installed
 * versions of the same package"), which the flat "packages" map makes
 * straightforward and the legacy nested tree does not.
 */
export class PackageLockUnsupportedVersionError extends PackageLockError {
  readonly lockfileVersion: number;

  constructor(lockfileVersion: number) {
    super(
      `Unsupported package-lock.json lockfileVersion ${lockfileVersion}. ` +
        `VulnTrace requires npm lockfileVersion >= 2 (npm >= 7, which writes ` +
        `the "packages" map). Legacy v1 lockfiles are out of MVP scope.`,
    );
    this.name = "PackageLockUnsupportedVersionError";
    this.lockfileVersion = lockfileVersion;
  }
}
