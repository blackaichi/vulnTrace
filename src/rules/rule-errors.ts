import type { SchemaValidationIssue } from "./schema-validator.js";

/** Base class for all rule loading/validation errors. */
export abstract class RuleError extends Error {}

/** The rules file could not be read from disk. */
export class RuleFileNotFoundError extends RuleError {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    super(`Rules file not found or unreadable: ${filePath}`, { cause });
    this.name = "RuleFileNotFoundError";
    this.filePath = filePath;
  }
}

/** The rules file text is not valid YAML. */
export class RuleYamlSyntaxError extends RuleError {
  readonly source: string;

  constructor(source: string, message: string, cause: unknown) {
    super(`Invalid YAML in ${source}: ${message}`, { cause });
    this.name = "RuleYamlSyntaxError";
    this.source = source;
  }
}

/** The rules file does not have the expected top-level `rules: [...]` shape. */
export class RuleShapeError extends RuleError {
  constructor(message: string) {
    super(message);
    this.name = "RuleShapeError";
  }
}

/** One rule within the file does not match schemas/symbol-rule.schema.json. */
export class RuleValidationError extends RuleError {
  readonly ruleIndex: number;
  readonly issues: readonly SchemaValidationIssue[];

  constructor(ruleIndex: number, issues: readonly SchemaValidationIssue[]) {
    super(
      `Invalid rule at rules[${ruleIndex}]:\n${issues
        .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
        .join("\n")}`,
    );
    this.name = "RuleValidationError";
    this.ruleIndex = ruleIndex;
    this.issues = issues;
  }
}

/** Two rules (within one file, or across merged files) declare the same vulnerability id. */
export class DuplicateRuleIdError extends RuleError {
  readonly id: string;

  constructor(id: string) {
    super(`Duplicate rule id: ${id}`);
    this.name = "DuplicateRuleIdError";
    this.id = id;
  }
}
