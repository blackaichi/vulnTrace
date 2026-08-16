import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type AnySchemaObject } from "ajv/dist/2020.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const schemaPath = path.join(repoRoot, "schemas", "symbol-rule.schema.json");

// This is VulnTrace's own checked-in schema file, not untrusted external
// data, so asserting its shape here (rather than validating it) is safe.
const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as AnySchemaObject;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

export interface SchemaValidationIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Validates a raw value against the checked-in
 * `schemas/symbol-rule.schema.json` — the single source of truth for rule
 * shape (see docs/SDD.md § 13-14). Deliberately validates against the real
 * schema file rather than a parallel Zod re-definition, so the two can
 * never drift apart.
 *
 * Returns issues rather than throwing, so callers can attribute them to a
 * specific rule's position within a larger rules file.
 */
export function validateAgainstSymbolRuleSchema(
  raw: unknown,
): SchemaValidationIssue[] {
  const valid = validate(raw);

  if (valid) {
    return [];
  }

  return (validate.errors ?? []).map((error) => ({
    path: error.instancePath || "<root>",
    message: error.message ?? "invalid",
  }));
}
