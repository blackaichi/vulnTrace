import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallGraph, GraphNode } from "../domain/graph.js";
import { buildCallGraph } from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-call-graph-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

async function graphFor(
  root: string,
  entryFiles: string[],
): Promise<CallGraph> {
  const resolver = createModuleResolver(loadTsProject(root));
  return buildCallGraph({ entryFiles, resolver });
}

function findNode(
  graph: CallGraph,
  predicate: (node: GraphNode) => boolean,
): GraphNode | undefined {
  return graph.nodes.find(predicate);
}

describe("buildCallGraph: direct calls", () => {
  it("produces a resolved direct edge for a same-file call", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function a() {\n  b();\n}\nfunction b() {}\n",
    );

    const graph = await graphFor(root, [entry]);

    const nodeA = findNode(graph, (n) => n.name === "a");
    const nodeB = findNode(graph, (n) => n.name === "b");
    expect(nodeA).toBeDefined();
    expect(nodeB).toBeDefined();

    const edge = graph.edges.find((e) => e.from === nodeA?.id);
    expect(edge).toMatchObject({
      type: "direct",
      resolution: { kind: "resolved", target: nodeB?.id },
    });
  });

  it("attributes a top-level call to a synthetic module node", async () => {
    const root = tempProject();
    const entry = write(root, "src/index.ts", "function a() {}\na();\n");

    const graph = await graphFor(root, [entry]);

    const moduleNode = findNode(graph, (n) => n.kind === "module");
    const nodeA = findNode(graph, (n) => n.name === "a");
    expect(moduleNode).toBeDefined();

    const edge = graph.edges.find((e) => e.from === moduleNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: nodeA?.id },
    });
  });

  it("attributes a call inside a callback to the callback's own node", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function target() {}\n[1].forEach(function () {\n  target();\n});\n",
    );

    const graph = await graphFor(root, [entry]);

    const callbackNode = findNode(graph, (n) => n.kind === "callback");
    const targetNode = findNode(graph, (n) => n.name === "target");
    expect(callbackNode).toBeDefined();

    const edge = graph.edges.find((e) => e.from === callbackNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: targetNode?.id },
    });
  });

  it("does not create an edge for a call to an unknown global/builtin", async () => {
    const root = tempProject();
    const entry = write(root, "src/index.ts", "console.log('hi');\n");

    const graph = await graphFor(root, [entry]);

    expect(graph.edges).toHaveLength(0);
  });
});

describe("buildCallGraph: imported calls", () => {
  it("resolves a named ESM import to the target file's function node", async () => {
    const root = tempProject();
    const targetFile = write(
      root,
      "src/lib.ts",
      "export function vulnerable() {}\n",
    );
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable } from "./lib.js";\nvulnerable();\n',
    );

    const graph = await graphFor(root, [entry]);

    const targetNode = findNode(
      graph,
      (n) => n.name === "vulnerable" && n.module === targetFile,
    );
    expect(targetNode).toBeDefined();

    const edge = graph.edges.find((e) => e.type === "import");
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: targetNode?.id },
    });
  });

  it("resolves a whole-module require() with member access to the target's function node", async () => {
    const root = tempProject();
    const targetFile = write(
      root,
      "src/lib.js",
      "exports.vulnerable = function () {};\n",
    );
    const entry = write(
      root,
      "src/index.js",
      'const lib = require("./lib.js");\nlib.vulnerable();\n',
    );

    const graph = await graphFor(root, [entry]);

    const targetNode = findNode(
      graph,
      (n) => n.name === "vulnerable" && n.module === targetFile,
    );
    expect(targetNode).toBeDefined();

    const edge = graph.edges.find((e) => e.type === "import");
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: targetNode?.id },
    });
  });

  it("resolves a named function expression assigned via module.exports", async () => {
    const root = tempProject();
    const targetFile = write(
      root,
      "src/lib.js",
      "module.exports = function vulnerable() {};\n",
    );
    const entry = write(
      root,
      "src/index.js",
      'const lib = require("./lib.js");\nlib();\n',
    );

    const graph = await graphFor(root, [entry]);

    const targetNode = findNode(
      graph,
      (n) => n.name === "vulnerable" && n.module === targetFile,
    );
    expect(targetNode).toBeDefined();

    const edge = graph.edges.find((e) => e.type === "import");
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: targetNode?.id },
    });
  });

  it("marks an unresolved module specifier as uncertain, not silently dropped", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable } from "missing-package";\nvulnerable();\n',
    );

    const graph = await graphFor(root, [entry]);

    const edge = graph.edges.find((e) => e.type === "import");
    expect(edge).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_module" },
    });
  });
});

describe("buildCallGraph: dynamic calls are marked uncertain", () => {
  it("marks eval() as uncertain", async () => {
    const root = tempProject();
    const entry = write(root, "src/index.ts", 'eval("danger()");\n');

    const graph = await graphFor(root, [entry]);

    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        resolution: { kind: "unknown", reason: "eval", potentialTargets: [] },
      }),
    );
  });

  it("marks a dynamic require() as uncertain", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      'const name = "lib";\nrequire(name);\n',
    );

    const graph = await graphFor(root, [entry]);

    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        resolution: {
          kind: "unknown",
          reason: "dynamic_require",
          potentialTargets: [],
        },
      }),
    );
  });

  it("does not create an edge for a static require() call itself", async () => {
    const root = tempProject();
    write(root, "src/lib.js", "module.exports = {};\n");
    const entry = write(root, "src/index.js", 'require("./lib.js");\n');

    const graph = await graphFor(root, [entry]);

    // The require() call site itself produces no edge (it's import setup,
    // not a meaningful "call into" target).
    expect(graph.edges).toHaveLength(0);
  });

  it("marks a dynamic import() as uncertain", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      'const name = "./lib.js";\nimport(name);\n',
    );

    const graph = await graphFor(root, [entry]);

    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        type: "import",
        resolution: {
          kind: "unknown",
          reason: "dynamic_import",
          potentialTargets: [],
        },
      }),
    );
  });

  it("marks dynamic member access on a known import as uncertain", async () => {
    const root = tempProject();
    write(root, "src/lib.js", "module.exports = {};\n");
    const entry = write(
      root,
      "src/index.js",
      'const lib = require("./lib.js");\nconst method = "vulnerable";\nlib[method]();\n',
    );

    const graph = await graphFor(root, [entry]);

    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        resolution: {
          kind: "unknown",
          reason: "dynamic_member_access",
          potentialTargets: [],
        },
      }),
    );
  });
});
