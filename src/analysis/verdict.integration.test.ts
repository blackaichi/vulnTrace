import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
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

describe("buildFinding regression: CommonJS 'module.exports = someNamedFunction' target resolution", () => {
  // Discovered via a real-world demo against the actual lodash package
  // (whose per-method files, e.g. zipObjectDeep.js, use exactly this
  // idiom): findOrPhantomTarget() previously matched a rule's `export`
  // field against a GraphNode's own declared function name, but the
  // canonical export name for this idiom is "default" while the node's
  // name is the function's own name ("vulnerable" below) -- so a rule
  // written the natural way (export: "default") always fell through to an
  // unreachable phantom node and reported NOT_AFFECTED even when the
  // function genuinely was called from the entrypoint.
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("resolves a rule targeting the canonical 'default' export, not just the underlying function's own name", async () => {
    tmpDir = mkdtempSync(
      path.join(tmpdir(), "vulntrace-verdict-cjs-default-export-"),
    );
    const libDir = path.join(tmpDir, "node_modules", "vuln-lib");
    mkdirSync(libDir, { recursive: true });
    writeFileSync(
      path.join(libDir, "package.json"),
      JSON.stringify({ name: "vuln-lib", version: "1.0.0", main: "index.js" }),
    );
    writeFileSync(
      path.join(libDir, "index.js"),
      "function vulnerable() {\n  return 'vulnerable';\n}\n\nmodule.exports = vulnerable;\n",
    );
    const entry = path.join(tmpDir, "index.js");
    writeFileSync(
      entry,
      'const vulnerable = require("vuln-lib");\n\n' +
        "function main() {\n  return vulnerable();\n}\n\n" +
        "module.exports = { main };\n",
    );

    const resolver = createModuleResolver(loadTsProject(tmpDir));
    const [graph, entrypointsResult] = await Promise.all([
      buildCallGraph({ entryFiles: [entry], resolver }),
      discoverEntrypoints({
        projectRoot: tmpDir,
        resolver,
        explicitFiles: ["index.js"],
      }),
    ]);

    const rule: VulnerableSymbolRule = {
      id: "GHSA-test-cjs-default",
      package: { name: "vuln-lib" },
      targets: [{ module: "vuln-lib", export: "default", kind: "function" }],
    };

    const finding = await buildFinding({
      vulnerability: {
        id: "GHSA-test-cjs-default",
        aliases: [],
        package: "vuln-lib",
        ecosystem: "npm",
        affectedVersions: [{ introduced: "0" }],
        fixedVersions: [],
        references: [],
      },
      packageName: "vuln-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: entrypointsResult.entrypoints,
      resolver,
      projectRoot: tmpDir,
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(finding?.evidence?.path.length).toBeGreaterThan(0);
    expect(finding?.evidence?.path.at(-1)).toContain("vuln-lib");
  });
});
