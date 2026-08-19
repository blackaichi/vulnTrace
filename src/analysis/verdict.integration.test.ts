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

describe("buildFinding regression: an installed instance never imported at all (VT-212)", () => {
  // Distinct from the VT-204 test above: there, the top-level instance's
  // safe() IS imported at the entrypoint, so the call graph discovers BOTH
  // instances and the pre-existing "instances.size > 1" version-matching
  // logic already disambiguates correctly. Here, the top-level instance is
  // not imported by ANYTHING -- the call graph discovers exactly ONE
  // instance (the nested one). Before VT-212, resolveTargetNodes only
  // cross-checked packageVersion against graph-discovered instances when
  // more than one was present; with exactly one, it was reused
  // unconditionally, so the top-level instance's own Finding silently
  // inherited the nested instance's AFFECTED verdict (see ADV2-045,
  // tests/adversarial-v2/).
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("does not let the sole graph-discovered instance's reachability leak into a Finding for a never-imported sibling instance", async () => {
    tmpDir = mkdtempSync(
      path.join(tmpdir(), "vulntrace-verdict-unreached-instance-"),
    );
    // Top-level vuln-lib@2.0.0: installed (declared as a direct dependency)
    // but not imported by any source file at all.
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
    // Nested vuln-lib@1.0.0 (under consumer): its vulnerable() IS called,
    // making this the ONLY instance the call graph ever traverses to.
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
      id: "GHSA-test-unreached-instance",
      package: { name: "vuln-lib" },
      targets: [{ module: "vuln-lib", export: "vulnerable", kind: "function" }],
    };
    const vulnerability: Vulnerability = {
      id: "GHSA-test-unreached-instance",
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
      packageInstance: path.join(tmpDir, "node_modules/vuln-lib"),
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
      packageInstance: path.join(
        tmpDir,
        "node_modules/consumer/node_modules/vuln-lib",
      ),
      matchResult: "affected",
      rule,
      graph,
      entrypoints: entrypointsResult.entrypoints,
      resolver,
      projectRoot: tmpDir,
    });

    // The top-level instance was never imported anywhere -- the call graph
    // never traversed it at all. Must be confirmed NOT_AFFECTED, never
    // AFFECTED merely because it's the same package name as the one
    // instance the graph did discover.
    expect(topLevelFinding?.verdict).toBe("NOT_AFFECTED");
    // The nested instance's own vulnerable() genuinely is reachable.
    expect(nestedFinding?.verdict).toBe("AFFECTED");
  });

  it("falls back to the pre-VT-212 version heuristic when no packageInstance is provided (backward compatibility)", async () => {
    tmpDir = mkdtempSync(
      path.join(tmpdir(), "vulntrace-verdict-no-instance-hint-"),
    );
    write(
      tmpDir,
      "node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "1.0.0", type: "module" }),
    );
    write(
      tmpDir,
      "node_modules/vuln-lib/index.js",
      "export function vulnerable() {\n  return 'vuln';\n}\n",
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
      id: "GHSA-test-no-instance-hint",
      package: { name: "vuln-lib" },
      targets: [{ module: "vuln-lib", export: "vulnerable", kind: "function" }],
    };

    const finding = await buildFinding({
      vulnerability: {
        id: "GHSA-test-no-instance-hint",
        aliases: [],
        package: "vuln-lib",
        ecosystem: "npm",
        affectedVersions: [{ introduced: "0" }],
        fixedVersions: [],
        references: [],
      },
      packageName: "vuln-lib",
      packageVersion: "1.0.0",
      // packageInstance intentionally omitted.
      matchResult: "affected",
      rule,
      graph,
      entrypoints: entrypointsResult.entrypoints,
      resolver,
      projectRoot: tmpDir,
    });

    expect(finding?.verdict).toBe("AFFECTED");
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

describe("buildFinding regression: structural class-member attribution, not bare-name search (VT-301A)", () => {
  // Proves findExportNodeInFile resolves a method-kind rule target via
  // real export -> class -> member provenance, NOT the pre-existing
  // same-file bare-name fallback -- by constructing a fixture where the
  // two mechanisms would disagree. A same-file, never-called decoy
  // function shares the rule's exact target name and is declared BEFORE
  // the real, exported class's own method (so Array.prototype.find's
  // first-match bare-name fallback would pick the decoy, not the real
  // target, if it were still in effect). Asserting only the final verdict
  // would not distinguish "structural attribution worked" from "the
  // fallback happened to still produce the right answer" -- so this
  // asserts the exact resolved location too.
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("resolves a method-kind target to the exported class's own method, ignoring a same-named decoy the bare-name fallback would have matched instead", async () => {
    tmpDir = mkdtempSync(
      path.join(tmpdir(), "vulntrace-verdict-class-member-attribution-"),
    );
    write(
      tmpDir,
      "node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "1.0.0", type: "module" }),
    );
    write(
      tmpDir,
      "node_modules/vuln-lib/index.js",
      // The decoy is declared FIRST and shares the rule's exact target
      // name ("runDangerous") -- graph.nodes.find(n => n.name ===
      // exportName) would match it before ever reaching Lib's own
      // method, if that fallback were still consulted. It is never
      // called by anything and has no outgoing edges, so binding to it
      // would make the search conclude a confident (WRONG) NOT_AFFECTED
      // even though Lib.runDangerous() genuinely IS called below.
      "function runDangerous() {\n" +
        "  return 'decoy -- unrelated, never called, not a class member';\n" +
        "}\n\n" +
        "export class Lib {\n" +
        "  runDangerous() {\n" +
        "    return 'the real vulnerable behavior';\n" +
        "  }\n" +
        "}\n",
    );
    write(tmpDir, "package.json", JSON.stringify({ type: "module" }));
    const entry = write(
      tmpDir,
      "src/index.ts",
      'import { Lib } from "vuln-lib";\n\n' +
        "export function main() {\n" +
        "  const instance = new Lib();\n" +
        "  return instance.runDangerous();\n" +
        "}\n",
    );

    const project = loadTsProject(tmpDir);
    const resolver = createModuleResolver(project);
    // instance.runDangerous() needs VT-208's real-type-checker instance-
    // method resolution to resolve at all (see call-graph.ts) -- `project`
    // must be passed through, unlike this file's other, simpler tests.
    const [graph, entrypointsResult] = await Promise.all([
      buildCallGraph({ entryFiles: [entry], resolver, project }),
      discoverEntrypoints({
        projectRoot: tmpDir,
        resolver,
        configuredEntrypoints: ["src/index.ts"],
      }),
    ]);

    const rule: VulnerableSymbolRule = {
      id: "GHSA-test-class-member-attribution",
      package: { name: "vuln-lib" },
      targets: [{ module: "vuln-lib", export: "runDangerous", kind: "method" }],
    };

    const finding = await buildFinding({
      vulnerability: {
        id: "GHSA-test-class-member-attribution",
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

    // If the bare-name fallback had matched the decoy instead, this would
    // be NOT_AFFECTED (the decoy is never called by anything) -- AFFECTED
    // here is only possible via structural export -> class -> member
    // attribution finding Lib's own method.
    expect(finding?.verdict).toBe("AFFECTED");
    // Lib.runDangerous() is declared on line 6 of the written file (the
    // decoy is on line 1) -- asserting the exact resolved line proves
    // which node was actually bound, not merely that SOME node was.
    expect(finding?.evidence?.path.at(-1)).toBe(
      `${path.join(tmpDir, "node_modules/vuln-lib/index.js")}:6`,
    );
  });

  it("still resolves a plain function target via the canonical export path, unaffected by the new class-member step", async () => {
    tmpDir = mkdtempSync(
      path.join(tmpdir(), "vulntrace-verdict-class-member-control-"),
    );
    write(
      tmpDir,
      "node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "1.0.0", type: "module" }),
    );
    write(
      tmpDir,
      "node_modules/vuln-lib/index.js",
      "export function runDangerous() {\n  return 'vuln';\n}\n",
    );
    write(tmpDir, "package.json", JSON.stringify({ type: "module" }));
    const entry = write(
      tmpDir,
      "src/index.ts",
      'import { runDangerous } from "vuln-lib";\n\n' +
        "export function main() {\n  return runDangerous();\n}\n",
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
      id: "GHSA-test-class-member-control",
      package: { name: "vuln-lib" },
      targets: [
        { module: "vuln-lib", export: "runDangerous", kind: "function" },
      ],
    };

    const finding = await buildFinding({
      vulnerability: {
        id: "GHSA-test-class-member-control",
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
  });
});

describe("buildFinding regression: RWF-011 -- production real file, attribution fails, coincidental same-name candidate exists (VT-301B)", () => {
  // The package's real "vulnerable" export is defined via
  // Object.defineProperty -- invisible to mapExportsToFunctions's export
  // indexing (only module.exports = x / exports.x = y /
  // module.exports.x = y assignment shapes are recognized), so it can
  // never be structurally attributed to a function declaration, and the
  // file exports no class at all (findExportedClassMembers has nothing to
  // work with either). This is the same structural gap RWF-006's webpack
  // getter-defined exports exhibit (see fast-xml-parser/fxp.cjs), hand-
  // reproduced without needing a real bundler.
  //
  // A same-named decoy function exists in the SAME file -- proving the
  // pre-VT-301B bare-name fallback WOULD have matched it (it is never
  // called by anything, so binding to it would make a clean reachability
  // search conclude a confident, WRONG NOT_AFFECTED). The application
  // itself never calls .vulnerable at all -- it only calls the
  // unrelated, properly-attributed .safe() export, which is what gets
  // this package discovered by the call graph in the first place.
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function buildFixture(): { tmp: string; entry: string; libFile: string } {
    const tmp = mkdtempSync(
      path.join(tmpdir(), "vulntrace-verdict-rwf-011-regression-"),
    );
    write(
      tmp,
      "node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "1.0.0", type: "module" }),
    );
    const libFile = write(
      tmp,
      "node_modules/vuln-lib/index.js",
      // Decoy: a real, indexed, never-called function whose name
      // coincidentally matches the rule's target export.
      "function vulnerable() {\n" +
        "  return 'decoy -- unrelated, never called, would have been matched by the old bare-name fallback';\n" +
        "}\n\n" +
        "module.exports.safe = function safe() {\n" +
        "  return 'ok';\n" +
        "};\n\n" +
        // The real export -- structurally unattributable.
        "Object.defineProperty(module.exports, 'vulnerable', {\n" +
        "  enumerable: true,\n" +
        "  get() {\n" +
        "    return function realImpl() {\n" +
        "      return 'the real vulnerable behavior, never reached here';\n" +
        "    };\n" +
        "  },\n" +
        "});\n",
    );
    write(tmp, "package.json", JSON.stringify({ type: "module" }));
    const entry = write(
      tmp,
      "src/index.ts",
      'import vulnLib from "vuln-lib";\n\n' +
        "export function main() {\n  return vulnLib.safe();\n}\n",
    );
    return { tmp, entry, libFile };
  }

  it("resolves to UNKNOWN, never a confident NOT_AFFECTED, when export attribution fails despite a same-named decoy existing in the file", async () => {
    const { tmp, entry, libFile } = buildFixture();
    tmpDir = tmp;

    const resolver = createModuleResolver(loadTsProject(tmpDir));
    const [graph, entrypointsResult] = await Promise.all([
      buildCallGraph({ entryFiles: [entry], resolver }),
      discoverEntrypoints({
        projectRoot: tmpDir,
        resolver,
        configuredEntrypoints: ["src/index.ts"],
      }),
    ]);

    // Prove the same-name candidate genuinely exists in the discovered
    // graph -- this is not "target missing entirely", it is "target
    // present under a name that must not be trusted as provenance".
    const decoyNode = graph.nodes.find(
      (n) => n.name === "vulnerable" && n.module === libFile,
    );
    expect(decoyNode).toBeDefined();
    expect(decoyNode?.kind).toBe("function");

    const rule: VulnerableSymbolRule = {
      id: "GHSA-test-rwf-011-regression",
      package: { name: "vuln-lib" },
      targets: [{ module: "vuln-lib", export: "vulnerable", kind: "function" }],
    };

    const finding = await buildFinding({
      vulnerability: {
        id: "GHSA-test-rwf-011-regression",
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
      // Deliberately omitted (production default: false) -- this is the
      // whole point of the regression.
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.reasons?.[0]).toContain(
      "could not be attributed to any function or class member",
    );
  });

  it("control: in the SAME file, the properly-attributed 'safe' export still resolves correctly and precisely (does not overcorrect into blanket UNKNOWN)", async () => {
    const { tmp, entry } = buildFixture();
    tmpDir = tmp;

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
      id: "GHSA-test-rwf-011-control",
      package: { name: "vuln-lib" },
      targets: [{ module: "vuln-lib", export: "safe", kind: "function" }],
    };

    const finding = await buildFinding({
      vulnerability: {
        id: "GHSA-test-rwf-011-control",
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
  });

  it("a real file that becomes unreadable does NOT silently enable name-only matching -- degrades to UNKNOWN, not to the pre-VT-301B fallback behavior", async () => {
    const { tmp, entry, libFile } = buildFixture();
    tmpDir = tmp;

    const resolver = createModuleResolver(loadTsProject(tmpDir));
    const [graph, entrypointsResult] = await Promise.all([
      buildCallGraph({ entryFiles: [entry], resolver }),
      discoverEntrypoints({
        projectRoot: tmpDir,
        resolver,
        configuredEntrypoints: ["src/index.ts"],
      }),
    ]);

    // The graph already discovered vuln-lib/index.js (via .safe()) and
    // registered its own "vulnerable" decoy node from it -- confirming
    // this scenario is NOT "the package was never touched" (Site B).
    // Deleting the file AFTER graph construction reproduces a real file
    // that becomes unreadable between graph build and verdict resolution
    // -- findExportNodeInFile's own re-read of it must throw.
    expect(
      graph.nodes.some((n) => n.name === "vulnerable" && n.module === libFile),
    ).toBe(true);
    rmSync(libFile, { force: true });

    const rule: VulnerableSymbolRule = {
      id: "GHSA-test-rwf-011-unreadable",
      package: { name: "vuln-lib" },
      targets: [{ module: "vuln-lib", export: "vulnerable", kind: "function" }],
    };

    const finding = await buildFinding({
      vulnerability: {
        id: "GHSA-test-rwf-011-unreadable",
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
      // Not set, and MUST NOT matter here: the file is unreadable, not
      // synthetic -- the point of this test is that even an explicit
      // opt-in would be irrelevant to a real, now-unreadable file, since
      // production code never sets it in the first place.
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });
});
