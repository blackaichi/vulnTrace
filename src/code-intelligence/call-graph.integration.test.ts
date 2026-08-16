import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixturePath } from "../testing/fixtures.js";
import { buildCallGraph } from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";

describe("buildCallGraph against real fixtures", () => {
  it("builds a resolved edge from fixtures/direct-esm's main() into fixture-lib's vulnerable()", async () => {
    const root = fixturePath("direct-esm");
    const entry = path.join(root, "src", "index.ts");
    const resolver = createModuleResolver(loadTsProject(root));

    const graph = await buildCallGraph({ entryFiles: [entry], resolver });

    const mainNode = graph.nodes.find(
      (n) => n.name === "main" && n.module === entry,
    );
    const vulnerableNode = graph.nodes.find(
      (n) =>
        n.name === "vulnerable" &&
        n.module === path.join(root, "node_modules", "fixture-lib", "index.js"),
    );

    expect(mainNode).toBeDefined();
    expect(vulnerableNode).toBeDefined();

    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      type: "import",
      resolution: { kind: "resolved", target: vulnerableNode?.id },
    });
  });

  it("marks fixtures/commonjs's require of fixture-lib as an unresolved import (no node_modules present)", async () => {
    const root = fixturePath("commonjs");
    const entry = path.join(root, "src", "index.cjs");
    const resolver = createModuleResolver(loadTsProject(root));

    const graph = await buildCallGraph({ entryFiles: [entry], resolver });

    const edge = graph.edges.find((e) => e.type === "import");
    expect(edge).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_module" },
    });
  });
});
