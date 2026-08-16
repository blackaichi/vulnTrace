import type { ZodIssueSummary } from "../shared/zod-issues.js";

export type ConfigIssue = ZodIssueSummary;

function formatIssues(issues: readonly ConfigIssue[]): string {
  return issues
    .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
    .join("\n");
}

/** Base class for all configuration loading/validation errors. */
export abstract class ConfigError extends Error {}

/** The configuration file could not be read from disk. */
export class ConfigFileNotFoundError extends ConfigError {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    super(`Configuration file not found or unreadable: ${filePath}`, {
      cause,
    });
    this.name = "ConfigFileNotFoundError";
    this.filePath = filePath;
  }
}

/** The configuration text is not valid YAML. */
export class ConfigYamlSyntaxError extends ConfigError {
  readonly source: string;

  constructor(source: string, message: string, cause: unknown) {
    super(`Invalid YAML in ${source}: ${message}`, { cause });
    this.name = "ConfigYamlSyntaxError";
    this.source = source;
  }
}

/** The configuration does not match the expected schema. */
export class ConfigValidationError extends ConfigError {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`Invalid configuration:\n${formatIssues(issues)}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}
