import { describe, expect, it } from "vitest";
import type { Finding } from "../domain/verdict.js";
import {
  SCHEMA_VERSION,
  findingToJson,
  formatScanOutput,
  validateScanOutput,
  type ScanOutput,
} from "./output.js";

describe("findingToJson", () => {
  it("renames the domain target's 'export' field to 'symbol', per docs/SDD.md § 24's documented output shape", () => {
    const finding: Finding = {
      vulnerability: "GHSA-fixture-0001",
      package: "fixture-lib",
      version: "1.0.0",
      verdict: "AFFECTED",
      confidence: 1,
      target: { module: "fixture-lib", export: "vulnerable", kind: "function" },
      evidence: {
        path: ["src/index.ts:4", "node_modules/fixture-lib/index.js:10"],
        reasons: ["vulnerable symbol resolved"],
      },
    };

    expect(findingToJson(finding)).toEqual({
      vulnerability: "GHSA-fixture-0001",
      package: "fixture-lib",
      version: "1.0.0",
      verdict: "AFFECTED",
      confidence: 1,
      target: { module: "fixture-lib", symbol: "vulnerable", kind: "function" },
      evidence: {
        path: ["src/index.ts:4", "node_modules/fixture-lib/index.js:10"],
        reasons: ["vulnerable symbol resolved"],
      },
    });
  });

  it("omits confidence/target/evidence when absent, without fabricating placeholders", () => {
    const finding: Finding = {
      vulnerability: "GHSA-fixture-0002",
      package: "fixture-lib",
      version: "1.0.0",
      verdict: "UNKNOWN",
    };

    expect(findingToJson(finding)).toEqual({
      vulnerability: "GHSA-fixture-0002",
      package: "fixture-lib",
      version: "1.0.0",
      verdict: "UNKNOWN",
    });
  });
});

describe("validateScanOutput", () => {
  const validOutput: ScanOutput = {
    schemaVersion: SCHEMA_VERSION,
    scan: { id: "scan-123", project: "." },
    findings: [
      {
        vulnerability: "GHSA-fixture-0001",
        package: "fixture-lib",
        version: "1.0.0",
        verdict: "AFFECTED",
        confidence: 1,
      },
    ],
    coverage: {
      files: 1,
      modulesResolved: 1,
      modulesUnresolved: 0,
      functions: 1,
      callsResolved: 1,
      callsDynamic: 0,
    },
  };

  it("accepts a well-formed scan result against the real schemas/result.schema.json", () => {
    expect(validateScanOutput(validOutput)).toEqual([]);
  });

  it("reports a missing required top-level field", () => {
    const withoutCoverage = {
      schemaVersion: validOutput.schemaVersion,
      scan: validOutput.scan,
      findings: validOutput.findings,
    };

    const issues = validateScanOutput(withoutCoverage);

    expect(issues.length).toBeGreaterThan(0);
  });

  it("reports an invalid verdict value", () => {
    const invalid = {
      ...validOutput,
      findings: [{ ...validOutput.findings[0], verdict: "MAYBE" }],
    };

    const issues = validateScanOutput(invalid);

    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("formatScanOutput", () => {
  const output: ScanOutput = {
    schemaVersion: SCHEMA_VERSION,
    scan: { id: "scan-1", project: "." },
    findings: [],
    coverage: {
      files: 0,
      modulesResolved: 0,
      modulesUnresolved: 0,
      functions: 0,
      callsResolved: 0,
      callsDynamic: 0,
    },
  };

  it("produces compact single-line JSON by default", () => {
    const text = formatScanOutput(output, false);

    expect(text).not.toContain("\n");
    expect(JSON.parse(text)).toEqual(output);
  });

  it("produces indented JSON when pretty is true", () => {
    const text = formatScanOutput(output, true);

    expect(text).toContain("\n");
    expect(JSON.parse(text)).toEqual(output);
  });
});
