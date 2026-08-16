import { describe, expect, it } from "vitest";
import type { Finding, Verdict } from "./verdict.js";

describe("Finding", () => {
  it("matches the AFFECTED example from docs/SDD.md § 24 / schemas/result.schema.json", () => {
    const finding: Finding = {
      vulnerability: "GHSA-fixture-0001",
      package: "fixture-lib",
      version: "1.0.0",
      verdict: "AFFECTED",
      confidence: 1,
      target: { module: "fixture-lib", export: "vulnerable" },
      evidence: {
        path: ["src/index.ts:4", "node_modules/fixture-lib/index.js:10"],
      },
    };

    expect(finding.verdict).toBe("AFFECTED");
    expect(finding.evidence?.path).toHaveLength(2);
  });

  it("allows UNKNOWN findings with no resolved target or evidence yet", () => {
    const finding: Finding = {
      vulnerability: "GHSA-fixture-0002",
      package: "other-lib",
      version: "3.1.0",
      verdict: "UNKNOWN",
    };

    expect(finding.target).toBeUndefined();
    expect(finding.evidence).toBeUndefined();
  });

  it("only allows the three documented verdicts", () => {
    const verdicts: readonly Verdict[] = [
      "AFFECTED",
      "NOT_AFFECTED",
      "UNKNOWN",
    ];
    expect(verdicts).toHaveLength(3);
  });
});
