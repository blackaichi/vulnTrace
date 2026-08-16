import { describe, expect, it } from "vitest";
import { validateAgainstSymbolRuleSchema } from "./schema-validator.js";

describe("validateAgainstSymbolRuleSchema", () => {
  it("accepts a valid rule", () => {
    const issues = validateAgainstSymbolRuleSchema({
      id: "GHSA-fixture-0001",
      package: { name: "fixture-lib" },
      targets: [
        { module: "fixture-lib", export: "vulnerable", kind: "function", confidence: 1.0 },
      ],
    });

    expect(issues).toEqual([]);
  });

  it("accepts a target without kind/confidence (both optional)", () => {
    const issues = validateAgainstSymbolRuleSchema({
      id: "GHSA-fixture-0001",
      package: { name: "fixture-lib" },
      targets: [{ module: "fixture-lib", export: "vulnerable" }],
    });

    expect(issues).toEqual([]);
  });

  it("reports a missing required top-level field", () => {
    const issues = validateAgainstSymbolRuleSchema({
      package: { name: "fixture-lib" },
      targets: [],
    });

    expect(issues.length).toBeGreaterThan(0);
  });

  it("reports a missing required field within package", () => {
    const issues = validateAgainstSymbolRuleSchema({
      id: "GHSA-fixture-0001",
      package: {},
      targets: [],
    });

    expect(issues.length).toBeGreaterThan(0);
  });

  it("reports a missing required field within a target", () => {
    const issues = validateAgainstSymbolRuleSchema({
      id: "GHSA-fixture-0001",
      package: { name: "fixture-lib" },
      targets: [{ module: "fixture-lib" }],
    });

    expect(issues.length).toBeGreaterThan(0);
  });

  it("reports confidence outside the 0-1 range", () => {
    const issues = validateAgainstSymbolRuleSchema({
      id: "GHSA-fixture-0001",
      package: { name: "fixture-lib" },
      targets: [
        { module: "fixture-lib", export: "vulnerable", confidence: 1.5 },
      ],
    });

    expect(issues.length).toBeGreaterThan(0);
  });
});
