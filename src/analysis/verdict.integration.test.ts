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

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

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

describe("buildFinding regression: conditional exports resolved via the real import context (VT-204)", () => {
  // Before VT-204, checkReachability resolved a rule's target module once,
  // from the scanned project's own package.json as the "importer" -- which
  // resolves conditional exports through a DIFFERENT branch than the
  // app's own real ESM import context does. The call graph itself always
  // resolved this correctly (a real edge to the esm/ file existed); only
  // the separate, independent re-resolution disagreed with it, landing on
  // cjs/index.js -- a file the graph never visited -- and reporting a
  // false NOT_AFFECTED.
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("finds AFFECTED via the graph-discovered ESM branch, not the require branch package.json-context resolution would pick", async () => {
    tmpDir = mkdtempSync(
      path.join(tmpdir(), "vulntrace-verdict-conditional-exports-"),
    );
    write(
      tmpDir,
      "node_modules/vuln-lib/package.json",
      JSON.stringify({
        name: "vuln-lib",
        version: "1.0.0",
        exports: {
          ".": { import: "./esm/index.js", require: "./cjs/index.js" },
        },
      }),
    );
    write(
      tmpDir,
      "node_modules/vuln-lib/esm/index.js",
      "export function vulnerable() {\n  return 'vuln';\n}\n",
    );
    write(
      tmpDir,
      "node_modules/vuln-lib/cjs/index.js",
      "function vulnerable() {\n  return 'vuln';\n}\n\nmodule.exports = { vulnerable };\n",
    );
    write(tmpDir, "package.json", JSON.stringify({ type: "module" }));
    const entry = write(
      tmpDir,
      "src/index.ts",
      'import { vulnerable } from "vuln-lib";\n\nexport function main() {\n  return vulnerable();\n}\n',
    );

    const resolver = createModuleResolver(loadTsProject(tmpDir));
    const [graph, entrypointsResult] = await Promise.all([
      buildCallGraph({ entryFiles: [entry], resolver }),
      discoverEntrypoints({
        projectRoot: tmpDir,
        resolver,
        configuredEntrypoints: ["src/index.ts"],
      }),
    ]);

    const rule: VulnerableSymbolRule = {
      id: "GHSA-test-conditional-exports",
      package: { name: "vuln-lib" },
      targets: [{ module: "vuln-lib", export: "vulnerable", kind: "function" }],
    };

    const finding = await buildFinding({
      vulnerability: {
        id: "GHSA-test-conditional-exports",
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
    expect(finding?.evidence?.path.at(-1)).toContain("esm/index.js");
  });
});

describe("buildFinding regression: non-hoisted multiple installed versions (VT-204)", () => {
  // Before VT-204, checkReachability resolved a rule's target module from
  // the project root's own context, which always finds the TOP-LEVEL
  // installed instance -- even for a Finding about a different, nested,
  // non-hoisted instance the call graph actually traversed to. The call
  // graph traversal itself was always correct; only the separate
  // re-resolution used for the reachability check disagreed with it.
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("finds AFFECTED for the actually-installed nested instance, not the unrelated top-level one", async () => {
    tmpDir = mkdtempSync(
      path.join(tmpdir(), "vulntrace-verdict-multi-version-"),
    );
    write(
      tmpDir,
      "node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "2.0.0", type: "module" }),
    );
    write(
      tmpDir,
      "node_modules/vuln-lib/index.js",
      "export function vulnerable() {\n  return 'vuln';\n}\n",
    );
    write(
      tmpDir,
      "node_modules/consumer/node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "1.0.0", type: "module" }),
    );
    write(
      tmpDir,
      "node_modules/consumer/node_modules/vuln-lib/index.js",
      "export function vulnerable() {\n  return 'vuln';\n}\n",
    );
    write(
      tmpDir,
      "node_modules/consumer/package.json",
      JSON.stringify({ name: "consumer", version: "1.0.0", type: "module" }),
    );
    write(
      tmpDir,
      "node_modules/consumer/index.js",
      'import { vulnerable } from "vuln-lib";\n\nexport function useIt() {\n  return vulnerable();\n}\n',
    );
    write(tmpDir, "package.json", JSON.stringify({ type: "module" }));
    const entry = write(
      tmpDir,
      "src/index.ts",
      'import { useIt } from "consumer";\n\nexport function main() {\n  return useIt();\n}\n',
    );

    const resolver = createModuleResolver(loadTsProject(tmpDir));
    const [graph, entrypointsResult] = await Promise.all([
      buildCallGraph({ entryFiles: [entry], resolver }),
      discoverEntrypoints({
        projectRoot: tmpDir,
        resolver,
        configuredEntrypoints: ["src/index.ts"],
      }),
    ]);

    const rule: VulnerableSymbolRule = {
      id: "GHSA-test-multi-version",
      package: { name: "vuln-lib" },
      targets: [{ module: "vuln-lib", export: "vulnerable", kind: "function" }],
    };

    const finding = await buildFinding({
      vulnerability: {
        id: "GHSA-test-multi-version",
        aliases: [],
        package: "vuln-lib",
        ecosystem: "npm",
        affectedVersions: [{ introduced: "0", fixed: "2.0.0" }],
        fixedVersions: ["2.0.0"],
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
    expect(finding?.evidence?.path.at(-1)).toContain(
      "consumer/node_modules/vuln-lib",
    );
  });

  it("does not let one installed instance's reachability contaminate a Finding about a different instance", async () => {
    tmpDir = mkdtempSync(
      path.join(tmpdir(), "vulntrace-verdict-version-isolation-"),
    );
    // Top-level vuln-lib@2.0.0: only its safe() is ever called -- its own
    // vulnerable() is genuinely unreachable.
    write(
      tmpDir,
      "node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "2.0.0", type: "module" }),
    );
    write(
      tmpDir,
      "node_modules/vuln-lib/index.js",
      "export function vulnerable() {\n  return 'vuln';\n}\nexport function safe() {\n  return 'safe';\n}\n",
    );
    // Nested vuln-lib@1.0.0 (under consumer): its vulnerable() IS called.
    write(
      tmpDir,
      "node_modules/consumer/node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "1.0.0", type: "module" }),
    );
    write(
      tmpDir,
      "node_modules/consumer/node_modules/vuln-lib/index.js",
      "export function vulnerable() {\n  return 'vuln';\n}\nexport function safe() {\n  return 'safe';\n}\n",
    );
    write(
      tmpDir,
      "node_modules/consumer/package.json",
      JSON.stringify({ name: "consumer", version: "1.0.0", type: "module" }),
    );
    write(
      tmpDir,
      "node_modules/consumer/index.js",
      'import { vulnerable } from "vuln-lib";\n\nexport function useIt() {\n  return vulnerable();\n}\n',
    );
    write(tmpDir, "package.json", JSON.stringify({ type: "module" }));
    const entry = write(
      tmpDir,
      "src/index.ts",
      'import { safe } from "vuln-lib";\n' +
        'import { useIt } from "consumer";\n\n' +
        "export function main() {\n  safe();\n  return useIt();\n}\n",
    );

    const resolver = createModuleResolver(loadTsProject(tmpDir));
    const [graph, entrypointsResult] = await Promise.all([
      buildCallGraph({ entryFiles: [entry], resolver }),
      discoverEntrypoints({
        projectRoot: tmpDir,
        resolver,
        configuredEntrypoints: ["src/index.ts"],
      }),
    ]);

    const rule: VulnerableSymbolRule = {
      id: "GHSA-test-version-isolation",
      package: { name: "vuln-lib" },
      targets: [{ module: "vuln-lib", export: "vulnerable", kind: "function" }],
    };
    const vulnerability: Vulnerability = {
      id: "GHSA-test-version-isolation",
      aliases: [],
      package: "vuln-lib",
      ecosystem: "npm",
      affectedVersions: [{ introduced: "0" }],
      fixedVersions: [],
      references: [],
    };

    const topLevelFinding = await buildFinding({
      vulnerability,
      packageName: "vuln-lib",
      packageVersion: "2.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: entrypointsResult.entrypoints,
      resolver,
      projectRoot: tmpDir,
    });
    const nestedFinding = await buildFinding({
      vulnerability,
      packageName: "vuln-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: entrypointsResult.entrypoints,
      resolver,
      projectRoot: tmpDir,
    });

    // The top-level instance's OWN vulnerable() is never called -- must
    // not be reported AFFECTED merely because the unrelated nested
    // instance's vulnerable() is reachable.
    expect(topLevelFinding?.verdict).toBe("NOT_AFFECTED");
    // The nested instance's own vulnerable() genuinely is reachable.
    expect(nestedFinding?.verdict).toBe("AFFECTED");
  });
});

describe("buildFinding regression: {file, symbol} entrypoints, real files end to end (VT-205)", () => {
  // SDD-v0.2.md § 6's own example, driven through real files and the real
  // call graph: main() calls safe(); a sibling export, unused(), calls
  // vulnerable() but main() never calls it.
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function buildProject(): { tmp: string; entry: string } {
    const tmp = mkdtempSync(
      path.join(tmpdir(), "vulntrace-verdict-entrypoint-symbol-"),
    );
    write(
      tmp,
      "node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "1.0.0", type: "module" }),
    );
    write(
      tmp,
      "node_modules/vuln-lib/index.js",
      "export function vulnerable() {\n  return 'vuln';\n}\nexport function safe() {\n  return 'safe';\n}\n",
    );
    write(tmp, "package.json", JSON.stringify({ type: "module" }));
    const entry = write(
      tmp,
      "src/index.ts",
      'import { safe, vulnerable } from "vuln-lib";\n\n' +
        "export function main() {\n  return safe();\n}\n\n" +
        "export function unused() {\n  return vulnerable();\n}\n",
    );
    return { tmp, entry };
  }

  async function findVulnerable(
    tmp: string,
    entry: string,
    configuredEntrypoints: Parameters<
      typeof discoverEntrypoints
    >[0]["configuredEntrypoints"],
  ) {
    const resolver = createModuleResolver(loadTsProject(tmp));
    const [graph, entrypointsResult] = await Promise.all([
      buildCallGraph({ entryFiles: [entry], resolver }),
      discoverEntrypoints({
        projectRoot: tmp,
        resolver,
        configuredEntrypoints,
      }),
    ]);

    const rule: VulnerableSymbolRule = {
      id: "GHSA-test-entrypoint-symbol",
      package: { name: "vuln-lib" },
      targets: [{ module: "vuln-lib", export: "vulnerable", kind: "function" }],
    };

    return buildFinding({
      vulnerability: {
        id: "GHSA-test-entrypoint-symbol",
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
      projectRoot: tmp,
    });
  }

  it('does not become AFFECTED via unused() when configured as {file: "src/index.ts", symbol: "main"}', async () => {
    const { tmp, entry } = buildProject();
    tmpDir = tmp;

    const finding = await findVulnerable(tmp, entry, [
      { file: "src/index.ts", symbol: "main" },
    ]);

    expect(finding?.verdict).toBe("NOT_AFFECTED");
  });

  it("still becomes AFFECTED via unused() when no symbol is configured (unchanged default)", async () => {
    const { tmp, entry } = buildProject();
    tmpDir = tmp;

    const finding = await findVulnerable(tmp, entry, ["src/index.ts"]);

    expect(finding?.verdict).toBe("AFFECTED");
  });
});
