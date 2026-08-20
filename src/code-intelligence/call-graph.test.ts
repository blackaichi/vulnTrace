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

  it("marks a declaration-only package as uncertain, never as a resolved zero-edge module (VT-304, RWF-005)", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/types-only-package/package.json",
      JSON.stringify({ name: "types-only-package", version: "1.0.0" }),
    );
    const declFile = write(
      root,
      "node_modules/types-only-package/index.d.ts",
      "export declare function vulnerable(input: string): string;\n",
    );
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable } from "types-only-package";\nvulnerable("x");\n',
    );

    const graph = await graphFor(root, [entry]);

    const edge = graph.edges.find((e) => e.type === "import");
    expect(edge).toMatchObject({
      resolution: {
        kind: "unknown",
        reason: "declaration_only_resolution",
        potentialTargets: [],
      },
    });
    // The declaration file must never be indexed as an analyzable module --
    // no graph node should ever claim to represent its (nonexistent)
    // runtime body.
    expect(findNode(graph, (node) => node.module === declFile)).toBeUndefined();
  });
});

describe("buildCallGraph: Node builtin modules (VT-305, RWF-007)", () => {
  it.each([
    ["fs", "require", 'const fs = require("fs");\nfs.readFileSync("x");\n'],
    ["path", "require", 'const path = require("path");\npath.basename("x");\n'],
    [
      "crypto",
      "require",
      'const crypto = require("crypto");\ncrypto.randomBytes(8);\n',
    ],
    ["http", "require", 'const http = require("http");\nhttp.get("x");\n'],
    [
      "node:fs",
      "require",
      'const fs = require("node:fs");\nfs.readFileSync("x");\n',
    ],
    [
      "node:path",
      "require",
      'const path = require("node:path");\npath.basename("x");\n',
    ],
  ])(
    "creates no unresolved_module or any other blocker for %s (%s)",
    async (_specifier, _form, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const graph = await graphFor(root, [entry]);

      // No edge at all for a plain builtin call with no callback argument
      // -- never unresolved_module, never unsupported_construct, never any
      // other fabricated blocker (VT-305 Parts 4/6).
      expect(graph.edges).toHaveLength(0);
    },
  );

  it('classifies an ESM default import of a builtin the same way (import fs from "node:fs")', async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.mjs",
      'import fs from "node:fs";\nfs.readFileSync("x");\n',
    );

    const graph = await graphFor(root, [entry]);

    expect(graph.edges).toHaveLength(0);
  });

  it('classifies an ESM named import of a builtin the same way (import { readFileSync } from "fs")', async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.mjs",
      'import { readFileSync } from "fs";\nreadFileSync("x");\n',
    );

    const graph = await graphFor(root, [entry]);

    expect(graph.edges).toHaveLength(0);
  });

  it('still classifies require("fs") as builtin even when a local node_modules package is named fs', async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/fs/package.json",
      JSON.stringify({ name: "fs", version: "1.0.0", main: "index.js" }),
    );
    write(
      root,
      "node_modules/fs/index.js",
      "module.exports = { readFileSync() { return 'FAKE'; } };\n",
    );
    const entry = write(
      root,
      "src/index.js",
      'const fs = require("fs");\nfs.readFileSync("x");\n',
    );

    const graph = await graphFor(root, [entry]);

    // Real Node.js semantics: a builtin always shadows a same-named
    // node_modules package. No edge, and definitely no edge into the fake
    // local package's own module node.
    expect(graph.edges).toHaveLength(0);
    expect(
      findNode(graph, (node) => node.module.includes("node_modules/fs")),
    ).toBeUndefined();
  });

  it("retains existing unresolved_module behavior for a specifier that merely resembles a builtin name", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      'const lib = require("not-a-real-builtin");\nlib.doThing();\n',
    );

    const graph = await graphFor(root, [entry]);

    const edge = graph.edges.find((e) => e.type === "import");
    expect(edge).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_module" },
    });
  });

  it("preserves VT-213 callback-flow modeling for a builtin call that takes a real callback (fs.readFile(file, callback))", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable } from "./lib.js";\n' +
        'import fs from "node:fs";\n' +
        "function main() {\n" +
        '  fs.readFile("x", (err, data) => vulnerable());\n' +
        "}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const vulnerableNode = findNode(graph, (n) => n.name === "vulnerable");
    expect(mainNode).toBeDefined();
    expect(vulnerableNode).toBeDefined();

    // The builtin call site itself must still connect to its inline
    // callback argument -- classifying `fs` as a builtin must never
    // suppress VT-213's higher-order callback modeling.
    const mainEdge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(mainEdge).toMatchObject({
      type: "callback",
      resolution: { kind: "resolved" },
    });
    const callbackNodeId =
      mainEdge?.resolution.kind === "resolved"
        ? mainEdge.resolution.target
        : undefined;
    expect(callbackNodeId).toBeDefined();

    const callbackEdge = graph.edges.find((e) => e.from === callbackNodeId);
    expect(callbackEdge).toMatchObject({
      resolution: { kind: "resolved", target: vulnerableNode?.id },
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
  it("resolves a call through a locally-bound parameter to the real function passed at the call site (VT-210)", async () => {
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
    const vulnerableNode = findNode(graph, (n) => n.name === "vulnerable");
    expect(invokeNode).toBeDefined();
    expect(vulnerableNode).toBeDefined();

    // Before VT-201, invoke() calling its own parameter fn() silently
    // disappeared entirely. Before VT-210, it produced an honest but
    // imprecise unknown(unsupported_construct) edge. It must now resolve
    // fully, since main()'s own call site (invoke(vulnerable)) makes the
    // real target determinable.
    const fnCallEdge = graph.edges.find((e) => e.from === invokeNode?.id);
    expect(fnCallEdge).toMatchObject({
      type: "callback",
      resolution: { kind: "resolved", target: vulnerableNode?.id },
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

describe("buildCallGraph: inherited method resolution (VT-216)", () => {
  it("resolves a method inherited from a base class in a different file, never overridden locally", async () => {
    const root = tempProject();
    write(
      root,
      "src/lib.ts",
      "export class Base {\n  vulnerableMethod() {}\n}\n",
    );
    const entry = write(
      root,
      "src/index.ts",
      'import { Base } from "./lib.js";\n' +
        "class MySub extends Base {}\n" +
        "function main() {\n  const instance = new MySub();\n  instance.vulnerableMethod();\n}\n",
    );

    const graph = await graphForWithTypeChecking(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const methodNode = findNode(
      graph,
      (n) => n.kind === "method" && n.name === "vulnerableMethod",
    );
    expect(methodNode).toBeDefined();

    const methodEdge = graph.edges.find(
      (e) => e.from === mainNode?.id && e.type === "method",
    );
    expect(methodEdge).toMatchObject({
      resolution: { kind: "resolved", target: methodNode?.id },
    });
  });

  it("resolves the subclass's own override, not the base class's method, when one exists", async () => {
    const root = tempProject();
    write(
      root,
      "src/lib.ts",
      "export class Base {\n  vulnerableMethod() {\n    return 'base';\n  }\n}\n",
    );
    const entry = write(
      root,
      "src/index.ts",
      'import { Base } from "./lib.js";\n' +
        "class MySub extends Base {\n  vulnerableMethod() {\n    return 'sub';\n  }\n}\n" +
        "function main() {\n  const instance = new MySub();\n  instance.vulnerableMethod();\n}\n",
    );

    const graph = await graphForWithTypeChecking(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const subMethodNode = findNode(
      graph,
      (n) =>
        n.kind === "method" &&
        n.name === "vulnerableMethod" &&
        n.module === entry,
    );
    expect(subMethodNode).toBeDefined();
    // Base's own vulnerableMethod is fully shadowed by the override --
    // nothing ever resolves to it, so lib.ts is correctly never even
    // discovered/walked (no phantom/unused node for it either).
    expect(
      findNode(
        graph,
        (n) =>
          n.kind === "method" &&
          n.name === "vulnerableMethod" &&
          n.module !== entry,
      ),
    ).toBeUndefined();

    const methodEdge = graph.edges.find(
      (e) => e.from === mainNode?.id && e.type === "method",
    );
    expect(methodEdge).toMatchObject({
      resolution: { kind: "resolved", target: subMethodNode?.id },
    });
  });

  it("still falls back to unsupported_construct for a receiver whose type is a union of classes", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "class A {\n  vulnerableMethod() {}\n}\n" +
        "class B {\n  vulnerableMethod() {}\n}\n" +
        "function main(pick) {\n" +
        "  const instance = pick ? new A() : new B();\n" +
        "  instance.vulnerableMethod();\n" +
        "}\n",
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
});

describe("buildCallGraph: re-export chains (VT-209)", () => {
  it("resolves a call reached only through a one-hop re-export", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    write(root, "src/a.ts", 'export { vulnerable } from "./lib.js";\n');
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable } from "./a.js";\n' +
        "function main() {\n  vulnerable();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const targetNode = findNode(graph, (n) => n.name === "vulnerable");
    expect(mainNode).toBeDefined();
    expect(targetNode).toBeDefined();

    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: targetNode?.id },
    });
  });

  it("resolves a call reached through a two-hop re-export chain", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    write(root, "src/c.ts", 'export { vulnerable } from "./lib.js";\n');
    write(root, "src/b.ts", 'export { vulnerable } from "./c.js";\n');
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable } from "./b.js";\n' +
        "function main() {\n  vulnerable();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const targetNode = findNode(graph, (n) => n.name === "vulnerable");
    expect(mainNode).toBeDefined();
    expect(targetNode).toBeDefined();

    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: targetNode?.id },
    });
  });

  it("resolves an aliased re-export (export { x as y } from ...) to the real underlying name", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    write(root, "src/a.ts", 'export { vulnerable as v } from "./lib.js";\n');
    const entry = write(
      root,
      "src/index.ts",
      'import { v } from "./a.js";\n' + "function main() {\n  v();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const targetNode = findNode(graph, (n) => n.name === "vulnerable");
    expect(mainNode).toBeDefined();
    expect(targetNode).toBeDefined();

    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: targetNode?.id },
    });
  });

  it("gracefully reports unresolved_target, not an infinite loop, for a re-export cycle", async () => {
    const root = tempProject();
    write(root, "src/a.ts", 'export { vulnerable } from "./b.js";\n');
    write(root, "src/b.ts", 'export { vulnerable } from "./a.js";\n');
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable } from "./a.js";\n' +
        "function main() {\n  vulnerable();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("resolves `new` on a class reached only through a one-hop re-export", async () => {
    const root = tempProject();
    write(
      root,
      "src/lib.ts",
      "export class Vulnerable {\n  constructor() {}\n}\n",
    );
    write(root, "src/a.ts", 'export { Vulnerable } from "./lib.js";\n');
    const entry = write(
      root,
      "src/index.ts",
      'import { Vulnerable } from "./a.js";\n' +
        "function main() {\n  new Vulnerable();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const targetNode = findNode(
      graph,
      (n) => n.kind === "constructor" && n.name === "Vulnerable",
    );
    expect(mainNode).toBeDefined();
    expect(targetNode).toBeDefined();

    const edge = graph.edges.find(
      (e) => e.from === mainNode?.id && e.type === "constructor",
    );
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: targetNode?.id },
    });
  });
});

describe("buildCallGraph: higher-order call value flow (VT-210)", () => {
  it("resolves a parameter call through an imported function passed at the call site", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable } from "./lib.js";\n' +
        "function invoke(fn) {\n  fn();\n}\n" +
        "function main() {\n  invoke(vulnerable);\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const invokeNode = findNode(graph, (n) => n.name === "invoke");
    const targetNode = findNode(graph, (n) => n.name === "vulnerable");
    expect(invokeNode).toBeDefined();
    expect(targetNode).toBeDefined();

    const edge = graph.edges.find((e) => e.from === invokeNode?.id);
    expect(edge).toMatchObject({
      type: "callback",
      resolution: { kind: "resolved", target: targetNode?.id },
    });
  });

  it("resolves to the first call site's argument when the function is called more than once", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function vulnerable() {}\n" +
        "function safe() {}\n" +
        "function invoke(fn) {\n  fn();\n}\n" +
        "function main() {\n  invoke(vulnerable);\n  invoke(safe);\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const invokeNode = findNode(graph, (n) => n.name === "invoke");
    const vulnerableNode = findNode(graph, (n) => n.name === "vulnerable");
    expect(invokeNode).toBeDefined();

    const edge = graph.edges.find((e) => e.from === invokeNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: vulnerableNode?.id },
    });
  });

  it("still falls back to unsupported_construct when the enclosing function is never called with a resolvable argument", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function invoke(fn) {\n  fn();\n}\n" +
        "function main(dynamicFn) {\n  invoke(dynamicFn);\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const invokeNode = findNode(graph, (n) => n.name === "invoke");
    const edge = graph.edges.find((e) => e.from === invokeNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "unknown", reason: "unsupported_construct" },
    });
  });

  it("still falls back to unsupported_construct when the enclosing function is anonymous", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function vulnerable() {}\n" +
        "const invoke = (fn) => {\n  fn();\n};\n" +
        "invoke(vulnerable);\n",
    );

    const graph = await graphFor(root, [entry]);

    const invokeNode = findNode(graph, (n) => n.name === "invoke");
    expect(invokeNode).toBeDefined();

    const edge = graph.edges.find((e) => e.from === invokeNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "unknown", reason: "unsupported_construct" },
    });
  });
});

describe("buildCallGraph: static branch folding (VT-211)", () => {
  it("still creates an edge for a call behind a provably-true condition", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function vulnerable() {}\n" +
        "function main() {\n  if (1 === 1) {\n    vulnerable();\n  }\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const targetNode = findNode(graph, (n) => n.name === "vulnerable");
    expect(mainNode).toBeDefined();
    expect(targetNode).toBeDefined();

    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: targetNode?.id },
    });
  });

  it("creates no edge at all for a call behind a provably-false condition", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function vulnerable() {}\n" +
        "function main() {\n  if (false) {\n    vulnerable();\n  }\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    expect(mainNode).toBeDefined();

    const edgesFromMain = graph.edges.filter((e) => e.from === mainNode?.id);
    expect(edgesFromMain).toHaveLength(0);
  });

  it("resolves the else branch when the condition is provably false", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function vulnerable() {}\n" +
        "function safe() {}\n" +
        "function main() {\n  if (false) {\n    safe();\n  } else {\n    vulnerable();\n  }\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const vulnerableNode = findNode(graph, (n) => n.name === "vulnerable");
    const safeNode = findNode(graph, (n) => n.name === "safe");
    expect(vulnerableNode).toBeDefined();

    const edges = graph.edges.filter((e) => e.from === mainNode?.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      resolution: { kind: "resolved", target: vulnerableNode?.id },
    });
    // The dead then-branch's call to safe() must not have produced a node
    // reachable from main -- safe()'s own node still exists (it's still a
    // real declaration in the file), just never wired up as an edge target.
    void safeNode;
  });

  it("resolves a negated constant condition (!true)", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function vulnerable() {}\n" +
        "function main() {\n  if (!true) {\n    vulnerable();\n  }\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const edgesFromMain = graph.edges.filter((e) => e.from === mainNode?.id);
    expect(edgesFromMain).toHaveLength(0);
  });

  it("still visits both branches when the condition is not statically determinable", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function vulnerable() {}\n" +
        "function safe() {}\n" +
        "function main(flag) {\n  if (flag) {\n    vulnerable();\n  } else {\n    safe();\n  }\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const vulnerableNode = findNode(graph, (n) => n.name === "vulnerable");
    const safeNode = findNode(graph, (n) => n.name === "safe");

    const edges = graph.edges.filter((e) => e.from === mainNode?.id);
    const targets = edges
      .filter((e) => e.resolution.kind === "resolved")
      .map((e) => (e.resolution as { target: string }).target);
    expect(targets).toContain(vulnerableNode?.id);
    expect(targets).toContain(safeNode?.id);
  });

  it("still visits a call inside the condition expression itself", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function check() {\n  return false;\n}\n" +
        "function main() {\n  if (check()) {\n  }\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const checkNode = findNode(graph, (n) => n.name === "check");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: checkNode?.id },
    });
  });
});

describe("buildCallGraph: inline callback-argument invocation (VT-213)", () => {
  it("connects a call site to the exactly-one inline arrow-function argument it passes", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable } from "./lib.js";\n' +
        "function main() {\n  return [1, 2, 3].map(() => vulnerable());\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const vulnerableNode = findNode(graph, (n) => n.name === "vulnerable");
    expect(mainNode).toBeDefined();
    expect(vulnerableNode).toBeDefined();

    const mainEdge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(mainEdge).toMatchObject({
      type: "callback",
      resolution: { kind: "resolved" },
    });
    const callbackNodeId =
      mainEdge?.resolution.kind === "resolved"
        ? mainEdge.resolution.target
        : undefined;
    expect(callbackNodeId).toBeDefined();

    // The callback's own body (walked separately, unaffected by this task)
    // must itself resolve to vulnerable() -- confirming the full two-hop
    // path main -> callback -> vulnerable is now connected end to end.
    const callbackEdge = graph.edges.find((e) => e.from === callbackNodeId);
    expect(callbackEdge).toMatchObject({
      resolution: { kind: "resolved", target: vulnerableNode?.id },
    });
  });

  it("connects a call site to an inline callback regardless of the method name (no special-casing)", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable } from "./lib.js";\n' +
        "function main(obj) {\n  return obj.someUtterlyArbitraryMethodName(() => vulnerable());\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const vulnerableNode = findNode(graph, (n) => n.name === "vulnerable");
    const mainEdge = graph.edges.find((e) => e.from === mainNode?.id);
    const callbackNodeId =
      mainEdge?.resolution.kind === "resolved"
        ? mainEdge.resolution.target
        : undefined;
    expect(callbackNodeId).toBeDefined();
    const callbackEdge = graph.edges.find((e) => e.from === callbackNodeId);
    expect(callbackEdge).toMatchObject({
      resolution: { kind: "resolved", target: vulnerableNode?.id },
    });
  });

  it("connects a call site to an inline function-expression argument, not just arrow functions", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable } from "./lib.js";\n' +
        "function main() {\n" +
        "  return [1, 2, 3].map(function () {\n    return vulnerable();\n  });\n" +
        "}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const vulnerableNode = findNode(graph, (n) => n.name === "vulnerable");
    const mainEdge = graph.edges.find((e) => e.from === mainNode?.id);
    const callbackNodeId =
      mainEdge?.resolution.kind === "resolved"
        ? mainEdge.resolution.target
        : undefined;
    expect(callbackNodeId).toBeDefined();
    const callbackEdge = graph.edges.find((e) => e.from === callbackNodeId);
    expect(callbackEdge).toMatchObject({
      resolution: { kind: "resolved", target: vulnerableNode?.id },
    });
  });

  it("still falls back to unsupported_construct for a NAMED callback reference (not an inline literal)", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable } from "./lib.js";\n' +
        "function main() {\n  return [1, 2, 3].map(vulnerable);\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "unknown", reason: "unsupported_construct" },
    });
  });

  it("still falls back to unsupported_construct when more than one inline callback argument is present", async () => {
    const root = tempProject();
    write(
      root,
      "src/lib.ts",
      "export function vulnerable() {}\nexport function safe() {}\n",
    );
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable, safe } from "./lib.js";\n' +
        "function main(p) {\n" +
        "  return p.then(\n" +
        "    () => vulnerable(),\n" +
        "    () => safe(),\n" +
        "  );\n" +
        "}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "unknown", reason: "unsupported_construct" },
    });
  });
});

describe("buildCallGraph: local reference aliasing (VT-214)", () => {
  it("resolves a call through a plain const variable alias", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable } from "./lib.js";\n' +
        "function main() {\n  const doIt = vulnerable;\n  return doIt();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const vulnerableNode = findNode(graph, (n) => n.name === "vulnerable");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      type: "direct",
      resolution: { kind: "resolved", target: vulnerableNode?.id },
    });
  });

  it("resolves a call through an object-literal property alias", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable } from "./lib.js";\n' +
        "function main() {\n" +
        "  const obj = { run: vulnerable };\n" +
        "  return obj.run();\n" +
        "}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const vulnerableNode = findNode(graph, (n) => n.name === "vulnerable");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      type: "method",
      resolution: { kind: "resolved", target: vulnerableNode?.id },
    });
  });

  it("resolves a call through a destructured, renamed binding off a namespace import", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import * as lib from "./lib.js";\n' +
        "function main() {\n" +
        "  const { vulnerable: doIt } = lib;\n" +
        "  return doIt();\n" +
        "}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const vulnerableNode = findNode(graph, (n) => n.name === "vulnerable");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: vulnerableNode?.id },
    });
  });

  it("resolves a call through a destructured shorthand binding off a namespace import", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import * as lib from "./lib.js";\n' +
        "function main() {\n" +
        "  const { vulnerable } = lib;\n" +
        "  return vulnerable();\n" +
        "}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const vulnerableNode = findNode(graph, (n) => n.name === "vulnerable");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: vulnerableNode?.id },
    });
  });

  it("still falls back to unsupported_construct when the alias is declared with let (reassignment not tracked)", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import { vulnerable } from "./lib.js";\n' +
        "function main() {\n" +
        "  let doIt = vulnerable;\n" +
        "  return doIt();\n" +
        "}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "unknown", reason: "unsupported_construct" },
    });
  });

  it("still falls back to unsupported_construct when the alias value is itself unresolvable", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "function main(dynamicFn) {\n" +
        "  const doIt = dynamicFn;\n" +
        "  return doIt();\n" +
        "}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "unknown", reason: "unsupported_construct" },
    });
  });
});

describe("buildCallGraph: implicit constructor resolution (VT-215)", () => {
  it("resolves new X() for a class with no explicit constructor of its own", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export class Lib {\n  runSafe() {}\n}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import { Lib } from "./lib.js";\n' +
        "function main() {\n  return new Lib();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const constructorNode = findNode(
      graph,
      (n) => n.kind === "constructor" && n.name === "Lib",
    );
    expect(constructorNode).toBeDefined();

    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      type: "constructor",
      resolution: { kind: "resolved", target: constructorNode?.id },
    });
  });

  it("gives the synthesized constructor node no outgoing edges of its own", async () => {
    const root = tempProject();
    write(
      root,
      "src/lib.ts",
      "export function vulnerable() {}\n" +
        "export class Lib {\n  runSafe() {}\n}\n",
    );
    const entry = write(
      root,
      "src/index.ts",
      'import { Lib } from "./lib.js";\n' +
        "function main() {\n  return new Lib();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const constructorNode = findNode(
      graph,
      (n) => n.kind === "constructor" && n.name === "Lib",
    );
    expect(constructorNode).toBeDefined();
    expect(
      graph.edges.filter((e) => e.from === constructorNode?.id),
    ).toHaveLength(0);
  });

  it("still resolves the real constructor node when one is explicitly declared (no regression)", async () => {
    const root = tempProject();
    write(
      root,
      "src/lib.ts",
      "export class Lib {\n  constructor() {\n    this.ran = true;\n  }\n}\n",
    );
    const entry = write(
      root,
      "src/index.ts",
      'import { Lib } from "./lib.js";\n' +
        "function main() {\n  return new Lib();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const constructorNodes = graph.nodes.filter(
      (n) => n.kind === "constructor" && n.name === "Lib",
    );
    expect(constructorNodes).toHaveLength(1);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: constructorNodes[0]?.id },
    });
  });

  it("never attributes ClassName.staticMember() to ClassName's own constructor (safety guard)", async () => {
    // Regression test for a real bug this task's own synthesis exposed:
    // bindCallee's named-import handling ignores a trailing property
    // chain (`Lib.staticDangerous()` binds to "Lib" itself, per its own
    // doc comment), which -- once "Lib" started resolving to this task's
    // new synthetic constructor node -- silently produced a *resolved*
    // edge to an unrelated, edge-less node instead of an honest
    // unresolved one, letting a reachability search conclude a
    // confidently WRONG unreachable/NOT_AFFECTED. This must never happen,
    // with or without type-checking enabled.
    const root = tempProject();
    write(
      root,
      "src/lib.ts",
      "export class Lib {\n  static staticDangerous() {}\n}\n",
    );
    const entry = write(
      root,
      "src/index.ts",
      'import { Lib } from "./lib.js";\n' +
        "function main() {\n  return Lib.staticDangerous();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const constructorNode = findNode(
      graph,
      (n) => n.kind === "constructor" && n.name === "Lib",
    );
    expect(constructorNode).toBeDefined();

    const mainNode = findNode(graph, (n) => n.name === "main");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    // Never resolved to the constructor node -- either genuinely unknown
    // (no type-checking available, as here), or resolved to the real
    // staticDangerous node, but never the wrong target.
    if (edge?.resolution.kind === "resolved") {
      expect(edge.resolution.target).not.toBe(constructorNode?.id);
    } else {
      expect(edge).toMatchObject({
        resolution: { kind: "unknown", reason: "unsupported_construct" },
      });
    }
  });

  it("resolves ClassName.staticMember() to the real static method when type-checking is available (VT-208 unblocked)", async () => {
    const root = tempProject();
    write(
      root,
      "src/lib.ts",
      "export class Lib {\n  static staticDangerous() {}\n}\n",
    );
    const entry = write(
      root,
      "src/index.ts",
      'import { Lib } from "./lib.js";\n' +
        "function main() {\n  return Lib.staticDangerous();\n}\n",
    );

    const graph = await graphForWithTypeChecking(root, [entry]);

    const staticMethodNode = findNode(
      graph,
      (n) => n.kind === "method" && n.name === "staticDangerous",
    );
    expect(staticMethodNode).toBeDefined();

    const mainNode = findNode(graph, (n) => n.name === "main");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: staticMethodNode?.id },
    });
  });
});

describe("buildCallGraph: constant computed-key evaluation (VT-217)", () => {
  it("resolves a call through an aliased element access whose key is a same-file const literal", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import * as lib from "./lib.js";\n' +
        'const KEY = "vulnerable";\n' +
        "function main() {\n" +
        "  const fns = lib;\n" +
        "  const fn = fns[KEY];\n" +
        "  return fn();\n" +
        "}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const vulnerableNode = findNode(graph, (n) => n.name === "vulnerable");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: vulnerableNode?.id },
    });
  });

  it("resolves through a receiver wrapped in a double type assertion (real ADV2-042 shape)", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import * as lib from "./lib.js";\n' +
        'const KEY = "vulnerable";\n' +
        "function main() {\n" +
        "  const fns = lib as unknown as Record<string, () => unknown>;\n" +
        "  const fn = fns[KEY];\n" +
        "  return fn();\n" +
        "}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const vulnerableNode = findNode(graph, (n) => n.name === "vulnerable");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: vulnerableNode?.id },
    });
  });

  it("resolves a call through an element access with a direct string-literal key", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import * as lib from "./lib.js";\n' +
        "function main() {\n" +
        '  const fn = lib["vulnerable"];\n' +
        "  return fn();\n" +
        "}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const vulnerableNode = findNode(graph, (n) => n.name === "vulnerable");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "resolved", target: vulnerableNode?.id },
    });
  });

  it("still falls back to unsupported_construct when the element access key is not statically resolvable", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import * as lib from "./lib.js";\n' +
        "function main(key) {\n" +
        "  const fn = lib[key];\n" +
        "  return fn();\n" +
        "}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
      resolution: { kind: "unknown", reason: "unsupported_construct" },
    });
  });

  it("still falls back to unsupported_construct when the key is a let (reassignment not tracked)", async () => {
    const root = tempProject();
    write(root, "src/lib.ts", "export function vulnerable() {}\n");
    const entry = write(
      root,
      "src/index.ts",
      'import * as lib from "./lib.js";\n' +
        'let KEY = "vulnerable";\n' +
        "function main() {\n" +
        "  const fn = lib[KEY];\n" +
        "  return fn();\n" +
        "}\n",
    );

    const graph = await graphFor(root, [entry]);

    const mainNode = findNode(graph, (n) => n.name === "main");
    const edge = graph.edges.find((e) => e.from === mainNode?.id);
    expect(edge).toMatchObject({
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
