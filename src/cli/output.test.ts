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
        target: {
          module: "fixture-lib",
          symbol: "vulnerable",
          kind: "function",
        },
        evidence: {
          path: ["src/index.ts:4", "node_modules/fixture-lib/index.js:10"],
          reasons: ["vulnerable symbol resolved"],
        },
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
    diagnostics: [],
    timings: {
      parsingMs: 5,
      resolutionMs: 2,
      graphConstructionMs: 7,
      reachabilityMs: 1,
      providerMs: 10,
      cacheHits: 0,
      cacheMisses: 1,
      totalMs: 20,
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

  it("accepts an UNKNOWN finding with no target/evidence at all (e.g. no rule known for the vulnerability)", () => {
    const output: ScanOutput = {
      ...validOutput,
      findings: [
        {
          vulnerability: "GHSA-fixture-0002",
          package: "fixture-lib",
          version: "1.0.0",
          verdict: "UNKNOWN",
        },
      ],
    };

    expect(validateScanOutput(output)).toEqual([]);
  });

  // Updated by VT-CONTRACT-01. This case previously carried reasons ONLY,
  // which the schema accepted before the negative-proof invariant was
  // enforced -- an unproven NOT_AFFECTED. That shape predates VT-307e's
  // `confirmedUnreachableTarget` evidence object, and production has not
  // emitted it since; the finding now carries its family-C proof, which is
  // what `buildFinding` actually produces for this reason string. The
  // full exactly-one matrix lives in result-schema.negative-proof.test.ts.
  it("accepts a NOT_AFFECTED finding with evidence and its negative proof", () => {
    const output: ScanOutput = {
      ...validOutput,
      findings: [
        {
          vulnerability: "GHSA-fixture-0001",
          package: "fixture-lib",
          version: "1.0.0",
          verdict: "NOT_AFFECTED",
          target: { module: "fixture-lib", symbol: "vulnerable" },
          evidence: {
            path: [],
            reasons: [
              "vulnerable symbol confirmed unreachable from all analyzed entrypoints",
            ],
            confirmedUnreachableTarget: {
              target: { module: "fixture-lib", export: "vulnerable" },
              entrypointRoots: ["src/index.ts"],
              callGraphComplete: true,
            },
          },
        },
      ],
    };

    expect(validateScanOutput(output)).toEqual([]);
  });

  // Regression: verdict.ts's buildFinding() always attaches evidence for
  // AFFECTED and NOT_AFFECTED (see docs/SDD.md § 23's verdict logic) —
  // an AFFECTED/NOT_AFFECTED finding with no evidence at all would be a
  // real bug upstream, not a legitimate output shape. The schema must
  // reject it so such a regression fails schema validation rather than
  // silently shipping (see docs/SDD.md § 24, "Evidence and coverage are
  // included").
  it("rejects an AFFECTED finding missing evidence", () => {
    const output: ScanOutput = {
      ...validOutput,
      findings: [
        {
          vulnerability: "GHSA-fixture-0001",
          package: "fixture-lib",
          version: "1.0.0",
          verdict: "AFFECTED",
        },
      ],
    };

    const issues = validateScanOutput(output);

    expect(issues.length).toBeGreaterThan(0);
  });

  it("rejects a NOT_AFFECTED finding missing evidence", () => {
    const output: ScanOutput = {
      ...validOutput,
      findings: [
        {
          vulnerability: "GHSA-fixture-0001",
          package: "fixture-lib",
          version: "1.0.0",
          verdict: "NOT_AFFECTED",
        },
      ],
    };

    const issues = validateScanOutput(output);

    expect(issues.length).toBeGreaterThan(0);
  });

  it("rejects a finding whose target uses the domain field name 'export' instead of the documented 'symbol'", () => {
    const output = {
      ...validOutput,
      findings: [
        {
          ...validOutput.findings[0],
          target: { module: "fixture-lib", export: "vulnerable" },
        },
      ],
    };

    const issues = validateScanOutput(output);

    expect(issues.length).toBeGreaterThan(0);
  });

  it("rejects a coverage object with a negative field", () => {
    const output = {
      ...validOutput,
      coverage: { ...validOutput.coverage, callsDynamic: -1 },
    };

    const issues = validateScanOutput(output);

    expect(issues.length).toBeGreaterThan(0);
  });

  it("accepts non-empty diagnostics explaining blockers", () => {
    const output: ScanOutput = {
      ...validOutput,
      diagnostics: [
        { source: "call-graph", message: "eval at src/index.ts#main@3:1" },
        {
          source: "entrypoints:configured",
          message: "analysis.entrypoints[0] does not exist: src/typo.ts",
        },
      ],
    };

    expect(validateScanOutput(output)).toEqual([]);
  });

  it("rejects a missing diagnostics field", () => {
    const withoutDiagnostics = {
      schemaVersion: validOutput.schemaVersion,
      scan: validOutput.scan,
      findings: validOutput.findings,
      coverage: validOutput.coverage,
    };

    const issues = validateScanOutput(withoutDiagnostics);

    expect(issues.length).toBeGreaterThan(0);
  });

  it("rejects a diagnostic entry missing a message", () => {
    const output = {
      ...validOutput,
      diagnostics: [{ source: "call-graph" }],
    };

    const issues = validateScanOutput(output);

    expect(issues.length).toBeGreaterThan(0);
  });

  it("rejects a missing timings field", () => {
    const withoutTimings = {
      schemaVersion: validOutput.schemaVersion,
      scan: validOutput.scan,
      findings: validOutput.findings,
      coverage: validOutput.coverage,
      diagnostics: validOutput.diagnostics,
    };

    const issues = validateScanOutput(withoutTimings);

    expect(issues.length).toBeGreaterThan(0);
  });

  it("rejects a negative timings field", () => {
    const output = {
      ...validOutput,
      timings: { ...validOutput.timings, providerMs: -1 },
    };

    const issues = validateScanOutput(output);

    expect(issues.length).toBeGreaterThan(0);
  });

  it("rejects a scan result missing scan.id", () => {
    const output = {
      ...validOutput,
      scan: { project: "." },
    };

    const issues = validateScanOutput(output);

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
    diagnostics: [],
    timings: {
      parsingMs: 0,
      resolutionMs: 0,
      graphConstructionMs: 0,
      reachabilityMs: 0,
      providerMs: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalMs: 0,
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
