import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { indexRulesByVulnerabilityId, loadRuleFile } from "../rules/index.js";
import { fixturePath } from "../testing/fixtures.js";
import { discoverEntrypoints } from "./entrypoints.js";
import { buildFinding } from "./verdict.js";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);

function fixtureVulnerability(id: string): Vulnerability {
  return {
    id,
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0", fixed: "1.0.1" }],
    fixedVersions: ["1.0.1"],
    references: [],
  };
}

describe("buildFinding end-to-end: real fixture, real rule, real call graph", () => {
  it("produces AFFECTED for fixtures/direct-esm against the real GHSA-fixture-0001 rule", async () => {
    const root = fixturePath("direct-esm");
    const entry = path.join(root, "src", "index.ts");
    const resolver = createModuleResolver(loadTsProject(root));

    const [graph, entrypointsResult, rules] = await Promise.all([
      buildCallGraph({ entryFiles: [entry], resolver }),
      discoverEntrypoints({
        projectRoot: root,
        resolver,
        configuredEntrypoints: ["src/index.ts"],
      }),
      Promise.resolve(
        loadRuleFile(path.join(repoRoot, "rules", "vulntrace-rules.yml")),
      ),
    ]);

    const rulesById = indexRulesByVulnerabilityId(rules);
    const rule = rulesById.get("GHSA-fixture-0001");
    expect(rule).toBeDefined();

    const finding = await buildFinding({
      vulnerability: fixtureVulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: entrypointsResult.entrypoints,
      resolver,
      projectRoot: root,
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(finding?.target).toEqual({
      module: "fixture-lib",
      export: "vulnerable",
      kind: "function",
      confidence: 1,
    });
    expect(finding?.confidence).toBe(1);
    expect(finding?.evidence?.path.length).toBeGreaterThan(0);
    expect(finding?.evidence?.path.at(-1)).toContain("fixture-lib");
  });

  it("produces NOT_AFFECTED for a rule targeting an export main() never calls", async () => {
    const root = fixturePath("direct-esm");
    const entry = path.join(root, "src", "index.ts");
    const resolver = createModuleResolver(loadTsProject(root));

    const graph = await buildCallGraph({ entryFiles: [entry], resolver });
    const entrypointsResult = await discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: ["src/index.ts"],
    });

    const finding = await buildFinding({
      vulnerability: fixtureVulnerability("GHSA-fixture-unused"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule: {
        id: "GHSA-fixture-unused",
        package: { name: "fixture-lib" },
        targets: [{ module: "fixture-lib", export: "safe", kind: "function" }],
      },
      graph,
      entrypoints: entrypointsResult.entrypoints,
      resolver,
      projectRoot: root,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
  });
});
