import { describe, expect, it } from "vitest";
import type { VulnerableSymbolRule } from "./target.js";

describe("VulnerableSymbolRule", () => {
  it("matches the shape of the repository's real fixture rule (rules/vulntrace-rules.yml)", () => {
    const rule: VulnerableSymbolRule = {
      id: "GHSA-fixture-0001",
      package: { name: "fixture-lib" },
      targets: [
        {
          module: "fixture-lib",
          export: "vulnerable",
          kind: "function",
          confidence: 1.0,
        },
      ],
    };

    expect(rule.package.name).toBe("fixture-lib");
    expect(rule.targets[0]?.export).toBe("vulnerable");
    expect(rule.targets[0]?.kind).toBe("function");
  });

  it("allows a target without kind/confidence, both being optional", () => {
    const rule: VulnerableSymbolRule = {
      id: "GHSA-fixture-0002",
      package: { name: "other-lib" },
      targets: [{ module: "other-lib", export: "danger" }],
    };

    expect(rule.targets[0]?.kind).toBeUndefined();
  });
});
