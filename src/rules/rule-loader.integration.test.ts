import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { indexRulesByVulnerabilityId, loadRuleFile } from "./rule-loader.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

describe("loadRuleFile against the repository's real rule files", () => {
  it("loads rules/vulntrace-rules.yml", () => {
    const rules = loadRuleFile(path.join(repoRoot, "rules", "vulntrace-rules.yml"));

    expect(rules).toEqual([
      {
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
      },
    ]);

    const index = indexRulesByVulnerabilityId(rules);
    expect(index.get("GHSA-fixture-0001")?.targets[0]?.export).toBe(
      "vulnerable",
    );
  });

  it("loads config/vulntrace-rules.example.yml", () => {
    const rules = loadRuleFile(
      path.join(repoRoot, "config", "vulntrace-rules.example.yml"),
    );

    expect(rules).toHaveLength(1);
    expect(rules[0]?.id).toBe("GHSA-fixture-0001");
  });
});
