import { describe, expect, it } from "vitest";
import type { DependencyNode } from "./dependency.js";

describe("DependencyNode", () => {
  it("supports multiple installed versions of the same package", () => {
    const nodeA: DependencyNode = {
      id: "npm:fixture-lib@1.0.0",
      name: "fixture-lib",
      version: "1.0.0",
      ecosystem: "npm",
      direct: true,
      locations: ["node_modules/fixture-lib"],
      dependencyPaths: [["fixture-lib"]],
    };

    const nodeB: DependencyNode = {
      id: "npm:fixture-lib@2.0.0",
      name: "fixture-lib",
      version: "2.0.0",
      ecosystem: "npm",
      direct: false,
      locations: ["node_modules/other-pkg/node_modules/fixture-lib"],
      dependencyPaths: [["other-pkg", "fixture-lib"]],
      purl: "pkg:npm/fixture-lib@2.0.0",
    };

    expect(nodeA.name).toBe(nodeB.name);
    expect(nodeA.version).not.toBe(nodeB.version);
    expect(nodeB.purl).toBe("pkg:npm/fixture-lib@2.0.0");
  });
});
