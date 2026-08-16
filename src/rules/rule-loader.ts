import { readFileSync } from "node:fs";
import { parse as parseYamlText } from "yaml";
import { z } from "zod";
import type {
  TargetKind,
  VulnerableSymbolRule,
  VulnerableSymbolTarget,
} from "../domain/target.js";
import {
  DuplicateRuleIdError,
  RuleFileNotFoundError,
  RuleShapeError,
  RuleValidationError,
  RuleYamlSyntaxError,
} from "./rule-errors.js";
import { validateAgainstSymbolRuleSchema } from "./schema-validator.js";

const RulesFileShapeSchema = z.object({
  rules: z.array(z.unknown()),
});

const TARGET_KINDS: readonly TargetKind[] = [
  "function",
  "method",
  "constructor",
  "module",
];

function isTargetKind(value: string): value is TargetKind {
  return (TARGET_KINDS as readonly string[]).includes(value);
}

interface RawSymbolRuleTarget {
  readonly module: string;
  readonly export: string;
  readonly kind?: string;
  readonly confidence?: number;
}

interface RawSymbolRule {
  readonly id: string;
  readonly package: { readonly name: string };
  readonly targets: readonly RawSymbolRuleTarget[];
}

/**
 * Narrows a schema-valid raw rule into the strict domain type. The checked-in
 * JSON schema deliberately allows `kind` to be any string (forward
 * compatibility, see docs/SDD.md § 13); {@link TargetKind} is stricter
 * (see src/domain/target.ts), so an unrecognized `kind` is rejected here
 * rather than silently passed through.
 */
function toVulnerableSymbolRule(
  raw: RawSymbolRule,
  ruleIndex: number,
): VulnerableSymbolRule {
  const targets: VulnerableSymbolTarget[] = raw.targets.map(
    (target, targetIndex) => {
      if (target.kind !== undefined && !isTargetKind(target.kind)) {
        throw new RuleValidationError(ruleIndex, [
          {
            path: `targets[${targetIndex}].kind`,
            message: `Unsupported target kind "${target.kind}"; expected one of ${TARGET_KINDS.join(", ")}`,
          },
        ]);
      }

      return {
        module: target.module,
        export: target.export,
        kind: target.kind as TargetKind | undefined,
        confidence: target.confidence,
      };
    },
  );

  return {
    id: raw.id,
    package: { name: raw.package.name },
    targets,
  };
}

/**
 * Validates and parses an already-parsed rules-file value: a top-level
 * `{ rules: [...] }` object whose entries each match
 * schemas/symbol-rule.schema.json (see docs/SDD.md § 13-14).
 */
export function parseRules(raw: unknown): VulnerableSymbolRule[] {
  const shapeResult = RulesFileShapeSchema.safeParse(raw);

  if (!shapeResult.success) {
    throw new RuleShapeError(
      "Rules file must have a top-level 'rules' array",
    );
  }

  const rules: VulnerableSymbolRule[] = [];
  const seenIds = new Set<string>();

  shapeResult.data.rules.forEach((rawRule, index) => {
    const issues = validateAgainstSymbolRuleSchema(rawRule);
    if (issues.length > 0) {
      throw new RuleValidationError(index, issues);
    }

    const rule = toVulnerableSymbolRule(rawRule as RawSymbolRule, index);

    if (seenIds.has(rule.id)) {
      throw new DuplicateRuleIdError(rule.id);
    }
    seenIds.add(rule.id);

    rules.push(rule);
  });

  return rules;
}

/** Parses rules-file YAML text and validates it. */
export function parseRulesFromYaml(
  yamlText: string,
  source = "<rules>",
): VulnerableSymbolRule[] {
  let raw: unknown;

  try {
    raw = parseYamlText(yamlText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RuleYamlSyntaxError(source, message, error);
  }

  return parseRules(raw);
}

/**
 * Reads a rules YAML file from disk and validates it.
 *
 * Reading a static rules file is permitted under the project's security
 * constraints (see docs/SDD.md § 29): it is parsed as data and never
 * executed.
 */
export function loadRuleFile(filePath: string): VulnerableSymbolRule[] {
  let text: string;

  try {
    text = readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new RuleFileNotFoundError(filePath, error);
  }

  return parseRulesFromYaml(text, filePath);
}

/**
 * Maps vulnerability IDs to their manually authored rule (see TASK-012
 * acceptance criteria: "Rules map vulnerability IDs to package symbols").
 * Accepts rules merged from one or more files (docs/SDD.md § 26's
 * `rules.files` config is a list); throws on a cross-file id collision
 * rather than silently letting one rule shadow another.
 */
export function indexRulesByVulnerabilityId(
  rules: readonly VulnerableSymbolRule[],
): ReadonlyMap<string, VulnerableSymbolRule> {
  const index = new Map<string, VulnerableSymbolRule>();

  for (const rule of rules) {
    if (index.has(rule.id)) {
      throw new DuplicateRuleIdError(rule.id);
    }
    index.set(rule.id, rule);
  }

  return index;
}
