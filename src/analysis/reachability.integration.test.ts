import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import { fixturePath } from "../testing/fixtures.js";
import { analyzeReachability } from "./reachability.js";

describe("analyzeReachability against a real call graph (fixtures/direct-esm)", () => {
  it("finds main() genuinely reachable to fixture-lib's vulnerable(), with the real path", async () => {
    const root = fixturePath("direct-esm");
    const entry = path.join(root, "src", "index.ts");
    const resolver = createModuleResolver(loadTsProject(root));
    const graph = await buildCallGraph({ entryFiles: [entry], resolver });

    const mainNode = graph.nodes.find(
      (n) => n.name === "main" && n.module === entry,
    );
    const vulnerableNode = graph.nodes.find((n) => n.name === "vulnerable");
    expect(mainNode).toBeDefined();
    expect(vulnerableNode).toBeDefined();
    if (!mainNode || !vulnerableNode) {
      return;
    }

    const result = analyzeReachability(graph, mainNode, vulnerableNode);

    expect(result).toMatchObject({
      state: "reachable",
      path: [mainNode.id, vulnerableNode.id],
    });
  });

  it("finds fixture-lib's unrelated safe() genuinely unreachable from main(), not merely 'no edge found'", async () => {
    const root = fixturePath("direct-esm");
    const entry = path.join(root, "src", "index.ts");
    const resolver = createModuleResolver(loadTsProject(root));
    const graph = await buildCallGraph({ entryFiles: [entry], resolver });

    const mainNode = graph.nodes.find(
      (n) => n.name === "main" && n.module === entry,
    );
    // safe() is never called by main() in this fixture, but its node still
    // exists in the graph: discovering vulnerable() in fixture-lib/index.js
    // indexes that whole file, registering every function it declares.
    const safeNode = graph.nodes.find((n) => n.name === "safe");
    expect(mainNode).toBeDefined();
    expect(safeNode).toBeDefined();
    if (!mainNode || !safeNode) {
      return;
    }

    const result = analyzeReachability(graph, mainNode, safeNode);

    expect(result.state).toBe("unreachable");
    if (result.state === "unreachable") {
      expect(result.blockers.length).toBeGreaterThan(0);
    }
  });
});
