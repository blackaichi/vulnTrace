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

/** Like {@link graphFor}, but also supplies the loaded project so VT-208's type-checker-based resolution is enabled. */
async function graphForWithTypeChecking(
  root: string,
  entryFiles: string[],
): Promise<CallGraph> {
  const project = loadTsProject(root);
  const resolver = createModuleResolver(project);
  return buildCallGraph({ entryFiles, resolver, project });
}

/** A chain file0 -> file1 -> ... -> file{count-1}, each calling the next. */
function buildChain(root: string, count: number): string {
  for (let i = 0; i < count; i++) {
    const body =
      i + 1 < count
        ? `import { fn${i + 1} } from "./file${i + 1}.js";\n` +
          `export function fn${i}() { return fn${i + 1}(); }\n`
        : `export function fn${i}() { return ${i}; }\n`;
    write(root, `file${i}.js`, body);
  }
  return path.join(root, "file0.js");
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

describe("buildCallGraph: completeness invariant (VT-201)", () => {
  it("marks a call through a locally-bound parameter as uncertain instead of vanishing", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function vulnerable() {}\n" +
        "function invoke(fn) {\n  fn();\n}\n" +
        "function main() {\n  invoke(vulnerable);\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const invokeNode = findNode(graph, (n) => n.name === "invoke");
    expect(invokeNode).toBeDefined();

    // invoke() calling its own parameter fn() must not silently disappear.
    const fnCallEdge = graph.edges.find((e) => e.from === invokeNode?.id);
    expect(fnCallEdge).toMatchObject({
      resolution: { kind: "unknown", reason: "unsupported_construct" },
    });
  });

  it("marks a method call on a locally-constructed instance as uncertain instead of vanishing", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "class Lib {\n  vulnerableMethod() {}\n}\n" +
        "function main() {\n  const instance = new Lib();\n  instance.vulnerableMethod();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    expect(mainNode).toBeDefined();

    // main() also constructs `new Lib()`, which VT-201 likewise no longer
    // drops silently (a locally-declared class isn't attributable by name
    // today -- see classifyNew's own doc comment; full resolution is
    // VT-207) -- filter specifically to the `instance.vulnerableMethod()`
    // edge by its `method` type, not just "any unknown edge from main".
    const methodCallEdge = graph.edges.find(
      (e) => e.from === mainNode?.id && e.type === "method",
    );
    expect(methodCallEdge).toMatchObject({
      resolution: { kind: "unknown", reason: "unsupported_construct" },
    });
  });

  it("creates a resolved constructor edge for `new` on an imported class (VT-207)", async () => {
    const root = tempProject();
    write(
      root,
      "src/lib.ts",
      "export class Vulnerable {\n  constructor() {}\n}\n",
    );
    const entry = write(
      root,
      "src/index.ts",
      'import { Vulnerable } from "./lib.js";\n' +
        "function main() {\n  new Vulnerable();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const constructorNode = findNode(
      graph,
      (n) => n.kind === "constructor" && n.name === "Vulnerable",
    );
    expect(mainNode).toBeDefined();
    expect(constructorNode).toBeDefined();

    // Before VT-201 this produced zero edges at all. Before VT-207 it
    // produced an honest but imprecise `unknown(unresolved_target)` edge
    // (mapExportsToFunctions couldn't attribute the "Vulnerable" export to
    // a constructor with no name of its own). It must now resolve fully.
    const constructorEdge = graph.edges.find(
      (e) => e.from === mainNode?.id && e.type === "constructor",
    );
    expect(constructorEdge).toMatchObject({
      resolution: { kind: "resolved", target: constructorNode?.id },
    });
  });

  it("creates a resolved constructor edge for `new` on a locally-declared (non-imported) class", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "class Vulnerable {\n  constructor() {}\n}\n" +
        "function main() {\n  new Vulnerable();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const constructorNode = findNode(
      graph,
      (n) => n.kind === "constructor" && n.name === "Vulnerable",
    );
    expect(mainNode).toBeDefined();
    expect(constructorNode).toBeDefined();

    const constructorEdge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(constructorEdge).toMatchObject({
      type: "constructor",
      resolution: { kind: "resolved", target: constructorNode?.id },
    });
  });

  it("creates an unknown constructor edge for `new` on an unresolvable local reference", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function main(Ctor) {\n  new Ctor();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    expect(mainNode).toBeDefined();

    const constructorEdge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(constructorEdge).toMatchObject({
      type: "constructor",
      resolution: { kind: "unknown", reason: "unsupported_construct" },
    });
  });

  it("still creates no edge for `new` on a known global constructor", async () => {
    const root = tempProject();
    const entry = write(root, "src/index.ts", "new Map();\nnew Date();\n");

    const graph = await graphFor(root, [entry]);

    expect(graph.edges).toHaveLength(0);
  });

  it("still creates no edge for a call to a known global/builtin method", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function main() {\n  console.log(Math.max(1, 2));\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const edgesFromMain = graph.edges.filter((e) => e.from === mainNode?.id);
    expect(edgesFromMain).toHaveLength(0);
  });
});

describe("buildCallGraph: instance method resolution via the type checker (VT-208)", () => {
  it("resolves a method call on a locally-constructed instance when a project is supplied", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "class Lib {\n  vulnerableMethod() {}\n  safeMethod() {}\n}\n" +
        "function main() {\n  const instance = new Lib();\n  instance.vulnerableMethod();\n}\n",
    );

    const graph = await graphForWithTypeChecking(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const methodNode = findNode(
      graph,
      (n) => n.kind === "method" && n.name === "vulnerableMethod",
    );
    expect(mainNode).toBeDefined();
    expect(methodNode).toBeDefined();

    const methodEdge = graph.edges.find(
      (e) => e.from === mainNode?.id && e.type === "method",
    );
    expect(methodEdge).toMatchObject({
      resolution: { kind: "resolved", target: methodNode?.id },
    });
  });

  it("resolves a method call on an instance of an imported class", async () => {
    const root = tempProject();
    write(
      root,
      "src/lib.ts",
      "export class Lib {\n  vulnerableMethod() {}\n}\n",
    );
    const entry = write(
      root,
      "src/index.ts",
      'import { Lib } from "./lib.js";\n' +
        "function main() {\n  const instance = new Lib();\n  instance.vulnerableMethod();\n}\n",
    );

    const graph = await graphForWithTypeChecking(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const methodNode = findNode(
      graph,
      (n) => n.kind === "method" && n.name === "vulnerableMethod",
    );
    expect(mainNode).toBeDefined();
    expect(methodNode).toBeDefined();

    const methodEdge = graph.edges.find(
      (e) => e.from === mainNode?.id && e.type === "method",
    );
    expect(methodEdge).toMatchObject({
      resolution: { kind: "resolved", target: methodNode?.id },
    });
  });

  it("still falls back to unsupported_construct when the receiver's type can't be resolved to a class", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function main(instance) {\n  instance.vulnerableMethod();\n}\n",
    );

    const graph = await graphForWithTypeChecking(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const methodEdge = graph.edges.find(
      (e) => e.from === mainNode?.id && e.type === "method",
    );
    expect(methodEdge).toMatchObject({
      resolution: { kind: "unknown", reason: "unsupported_construct" },
    });
  });

  it("still produces the pre-VT-208 unsupported_construct edge when no project is supplied", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "class Lib {\n  vulnerableMethod() {}\n}\n" +
        "function main() {\n  const instance = new Lib();\n  instance.vulnerableMethod();\n}\n",
    );

    // graphFor (not graphForWithTypeChecking) -- no `project` passed.
    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const methodEdge = graph.edges.find(
      (e) => e.from === mainNode?.id && e.type === "method",
    );
    expect(methodEdge).toMatchObject({
      resolution: { kind: "unknown", reason: "unsupported_construct" },
    });
  });
});

describe("buildCallGraph: resource limits (TASK-028 security hardening)", () => {
  // docs/SDD.md § 26's analysis.limits / § 28-29's hardening requirement:
  // a pathological or adversarial target project (e.g. an enormous or
  // deeply/circularly interlinked codebase) must not be able to make
  // on-demand file discovery consume unbounded time/memory.

  it("discovers the full chain when no limit is configured", async () => {
    const root = tempProject();
    const entry = buildChain(root, 20);

    const graph = await graphFor(root, [entry]);

    const files = new Set(graph.nodes.map((n) => n.module));
    expect(files.size).toBe(20);
  });

  it("stops discovering new files once maxFiles is reached", async () => {
    const root = tempProject();
    const entry = buildChain(root, 20);
    const resolver = createModuleResolver(loadTsProject(root));

    const graph = await buildCallGraph({
      entryFiles: [entry],
      resolver,
      maxFiles: 5,
    });

    const files = new Set(graph.nodes.map((n) => n.module));
    expect(files.size).toBeLessThanOrEqual(5);
    expect(files.size).toBeGreaterThan(0);
  });

  it("stops discovering new files once maxGraphNodes is reached", async () => {
    const root = tempProject();
    const entry = buildChain(root, 20);
    const resolver = createModuleResolver(loadTsProject(root));

    const graph = await buildCallGraph({
      entryFiles: [entry],
      resolver,
      maxGraphNodes: 5,
    });

    // Unbounded, this chain produces 40 nodes (a <module> + one function
    // per file, 20 files) -- well below that confirms enforcement, not
    // coincidence.
    expect(graph.nodes.length).toBeLessThan(40);
  });

  it("discovers nothing once maxAnalysisSeconds has already elapsed", async () => {
    const root = tempProject();
    const entry = buildChain(root, 20);
    const resolver = createModuleResolver(loadTsProject(root));

    // 0 bypasses config-schema validation (which requires a positive
    // number) deliberately, to test the raw enforcement mechanism in
    // isolation from what values end users are allowed to configure.
    const graph = await buildCallGraph({
      entryFiles: [entry],
      resolver,
      maxAnalysisSeconds: 0,
    });

    expect(graph.nodes).toEqual([]);
  });
});
