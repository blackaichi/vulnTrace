import { describe, expect, it } from "vitest";
import { fixturePath } from "../testing/fixtures.js";
import { buildDependencyGraph } from "./dependency-graph.js";
import { loadPackageJsonFile } from "./package-json.js";
import { loadPackageLockFile } from "./package-lock.js";

describe("buildDependencyGraph against a real fixture", () => {
  it("builds the graph for fixtures/direct-esm", () => {
    const packageJson = loadPackageJsonFile(
      fixturePath("direct-esm", "package.json"),
    );
    const packageLock = loadPackageLockFile(
      fixturePath("direct-esm", "package-lock.json"),
    );

    const graph = buildDependencyGraph(packageJson, packageLock);

    expect(graph).toHaveLength(1);
    expect(graph[0]).toMatchObject({
      name: "fixture-lib",
      version: "1.0.0",
      ecosystem: "npm",
      direct: true,
      locations: ["node_modules/fixture-lib"],
      dependencyPaths: [["fixture-lib"]],
      purl: "pkg:npm/fixture-lib@1.0.0",
    });
  });
});
