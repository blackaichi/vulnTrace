import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type AnySchemaObject } from "ajv/dist/2020.js";
import type { Coverage } from "../domain/coverage.js";
import type { Finding } from "../domain/verdict.js";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const schemaPath = path.join(repoRoot, "schemas", "result.schema.json");

// VulnTrace's own checked-in schema file, not untrusted external data (see
// src/rules/schema-validator.ts, which follows the same pattern).
const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as AnySchemaObject;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

/** docs/SDD.md § 24's example output; matches schemas/result.schema.json's `$id`. */
export const SCHEMA_VERSION = "0.6";

export interface JsonTarget {
  readonly module: string;
  readonly symbol: string;
  readonly kind?: string;
  readonly confidence?: number;
}

export interface JsonFinding {
  readonly vulnerability: string;
  readonly package: string;
  readonly version: string;
  readonly verdict: Finding["verdict"];
  readonly confidence?: number;
  readonly target?: JsonTarget;
  readonly evidence?: Finding["evidence"];
}

export interface ScanOutput {
  readonly schemaVersion: string;
  readonly scan: { readonly id: string; readonly project: string };
  readonly findings: readonly JsonFinding[];
  readonly coverage: Coverage;
}

/**
 * Maps a domain {@link Finding} onto the JSON shape documented in
 * docs/SDD.md § 24, which names the vulnerable-behavior target field
 * "symbol" — the domain model calls the same concept "export" (see
 * src/domain/target.ts, chosen there to match JS/TS's own `export`
 * terminology). This is the one place that reconciles the naming
 * difference: the domain type itself is left alone, since the CLI's output
 * shape is a presentation concern, not a domain one (AGENTS.md: "Keep
 * domain models independent from CLI and providers").
 */
export function findingToJson(finding: Finding): JsonFinding {
  const json: {
    vulnerability: string;
    package: string;
    version: string;
    verdict: Finding["verdict"];
    confidence?: number;
    target?: JsonTarget;
    evidence?: Finding["evidence"];
  } = {
    vulnerability: finding.vulnerability,
    package: finding.package,
    version: finding.version,
    verdict: finding.verdict,
  };

  if (finding.confidence !== undefined) {
    json.confidence = finding.confidence;
  }
  if (finding.target) {
    const target = finding.target;
    json.target = {
      module: target.module,
      symbol: target.export,
      ...(target.kind !== undefined ? { kind: target.kind } : {}),
      ...(target.confidence !== undefined
        ? { confidence: target.confidence }
        : {}),
    };
  }
  if (finding.evidence) {
    json.evidence = finding.evidence;
  }

  return json;
}

export interface SchemaValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Validates a scan result against the checked-in `schemas/result.schema.json`. */
export function validateScanOutput(output: unknown): SchemaValidationIssue[] {
  const valid = validate(output);

  if (valid) {
    return [];
  }

  return (validate.errors ?? []).map((error) => ({
    path: error.instancePath || "<root>",
    message: error.message ?? "invalid",
  }));
}

export function formatScanOutput(output: ScanOutput, pretty: boolean): string {
  return JSON.stringify(output, null, pretty ? 2 : undefined);
}
