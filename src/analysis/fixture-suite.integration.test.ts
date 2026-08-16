import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { fixturePath } from "../testing/fixtures.js";
import { discoverEntrypoints } from "./entrypoints.js";
import { buildFinding } from "./verdict.js";

/**
 * Runs the real vertical slice (module resolution -> call graph ->
 * entrypoint discovery -> reachability -> verdict) against one fixture on
 * disk (see docs/SDD.md § 31, TASK-024's acceptance criteria: "Fixtures
 * contain expected results"). Every fixture here targets `fixture-lib`'s
 * `vulnerable` export with a rule authored inline — the rule itself is not
 * what each fixture demonstrates, only the JS/TS resolution/call-graph
 * behavior leading up to it is.
 */
async function scanFixture(options: {
  readonly fixture: string;
  readonly entrypoint: string;
  readonly target: string;
}) {
  const root = fixturePath(options.fixture);
  const entry = path.join(root, ...options.entrypoint.split("/"));
  const resolver = createModuleResolver(loadTsProject(root));

  const [graph, entrypointsResult] = await Promise.all([
    buildCallGraph({ entryFiles: [entry], resolver }),
    discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: [options.entrypoint],
    }),
  ]);

  const vulnerability: Vulnerability = {
    id: "GHSA-fixture-suite",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-fixture-suite",
    package: { name: "fixture-lib" },
    targets: [
      { module: "fixture-lib", export: options.target, kind: "function" },
    ],
  };

  return buildFinding({
    vulnerability,
    packageName: "fixture-lib",
    packageVersion: "1.0.0",
    matchResult: "affected",
    rule,
    graph,
    entrypoints: entrypointsResult.entrypoints,
    resolver,
    projectRoot: root,
  });
}

describe("fixture suite: each required fixture (docs/SDD.md § 31) demonstrates its own expected verdict", () => {
  it("direct-esm: a direct ESM import, called -> AFFECTED", async () => {
    const finding = await scanFixture({
      fixture: "direct-esm",
      entrypoint: "src/index.ts",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(finding?.evidence?.path.at(-1)).toContain("fixture-lib");
  });

  it("commonjs: require() + whole-module property access, called -> AFFECTED", async () => {
    const finding = await scanFixture({
      fixture: "commonjs",
      entrypoint: "src/index.cjs",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(finding?.evidence?.path.at(-1)).toContain("fixture-lib");
  });

  it("alias: an aliased named import ('vulnerable as v'), called -> AFFECTED", async () => {
    const finding = await scanFixture({
      fixture: "alias",
      entrypoint: "src/index.ts",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(finding?.evidence?.path.at(-1)).toContain("fixture-lib");
  });

  it("destructuring: a destructured require() binding, called -> AFFECTED", async () => {
    const finding = await scanFixture({
      fixture: "destructuring",
      entrypoint: "src/index.cjs",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(finding?.evidence?.path.at(-1)).toContain("fixture-lib");
  });

  it("transitive: reached through an intermediate package (main -> run -> vulnerable) -> AFFECTED", async () => {
    const finding = await scanFixture({
      fixture: "transitive",
      entrypoint: "src/index.ts",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(finding?.evidence?.path).toHaveLength(3);
    expect(finding?.evidence?.path.at(-1)).toContain("fixture-lib");
  });

  it("not-reachable: only an unrelated export ('safe') is ever called -> NOT_AFFECTED", async () => {
    const finding = await scanFixture({
      fixture: "not-reachable",
      entrypoint: "src/index.ts",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
  });

  it("dynamic: the call target is chosen via a computed property access -> UNKNOWN, never NOT_AFFECTED", async () => {
    const finding = await scanFixture({
      fixture: "dynamic",
      entrypoint: "src/index.ts",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });
});
