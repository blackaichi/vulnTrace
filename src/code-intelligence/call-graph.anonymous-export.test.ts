import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph } from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";
import { buildKnownPackageRoots } from "../domain/resolved-target.js";
import type { CallGraph, GraphNode } from "../domain/graph.js";

/**
 * RWF-003 at the layer that binds a call to a real target: a package whose
 * entire public API is an ANONYMOUS function assigned to `module.exports`
 * (`minimist`, `qs/lib/parse.js`, `qs/lib/stringify.js` — see
 * tests/validation/FINDINGS.md RWF-003).
 *
 * The companion unit suite (module-model.anonymous-export.test.ts) covers
 * the export->function relation in isolation. Everything here needs real
 * files, real module resolution and real canonical PackageInstance
 * identity, so it builds real temp projects — the same discipline as
 * call-graph.commonjs-reexport.test.ts, whose RWF-004a chase this
 * deliberately composes with.
 */

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-anon-export-"));
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
  knownPackageRoots?: ReturnType<typeof buildKnownPackageRoots>,
): Promise<CallGraph> {
  const resolver = createModuleResolver(loadTsProject(root));
  return buildCallGraph({ entryFiles, resolver, knownPackageRoots });
}

function findNode(
  graph: CallGraph,
  predicate: (node: GraphNode) => boolean,
): GraphNode | undefined {
  return graph.nodes.find(predicate);
}

function mainEdge(graph: CallGraph) {
  const mainNode = findNode(graph, (n) => n.name === "main");
  return graph.edges.find((e) => e.from === mainNode?.id);
}

/**
 * The anonymous exported function in `fileName` — identified by having no
 * name at all, which is the whole point: nothing about this node can be
 * found by a name search.
 */
function anonymousFunctionIn(graph: CallGraph, fileName: string) {
  return findNode(
    graph,
    (n) =>
      n.kind === "function" &&
      n.name === undefined &&
      n.module.endsWith(fileName),
  );
}

function packageJson(name: string, main = "index.js"): string {
  return JSON.stringify({ name, version: "1.0.0", main });
}

/** An app whose `main` makes exactly one call. */
function appCalling(expression: string): string {
  return `const pkg = require("vuln-lib");\nfunction main(input) {\n  return ${expression};\n}\nmodule.exports = { main };\n`;
}

describe("buildCallGraph: anonymous module.exports function targets (RWF-003)", () => {
  it("binds a call to a package whose whole API is an anonymous function expression", async () => {
    // The exact `minimist` shape (RWB-02).
    const root = tempProject();
    write(root, "node_modules/vuln-lib/package.json", packageJson("vuln-lib"));
    write(
      root,
      "node_modules/vuln-lib/index.js",
      "module.exports = function (args) {\n  return args;\n};\n",
    );
    const entry = write(root, "src/app.js", appCalling("pkg(input)"));

    const graph = await graphFor(root, [entry]);

    const target = anonymousFunctionIn(graph, "index.js");
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("binds a call to an anonymous ARROW function export", async () => {
    const root = tempProject();
    write(root, "node_modules/vuln-lib/package.json", packageJson("vuln-lib"));
    write(
      root,
      "node_modules/vuln-lib/index.js",
      "module.exports = (args) => args;\n",
    );
    const entry = write(root, "src/app.js", appCalling("pkg(input)"));

    const graph = await graphFor(root, [entry]);

    const target = anonymousFunctionIn(graph, "index.js");
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("composes with RWF-004a: a same-package facade re-exporting an anonymous callable", async () => {
    // index.js declares nothing; impl.js is `module.exports = function () {}`.
    // Needs BOTH relations: the whole-module re-export chase (RWF-004a) to
    // reach impl.js, and RWF-003 to attribute its anonymous "default".
    const root = tempProject();
    write(root, "node_modules/vuln-lib/package.json", packageJson("vuln-lib"));
    write(
      root,
      "node_modules/vuln-lib/index.js",
      'module.exports = require("./impl");\n',
    );
    write(
      root,
      "node_modules/vuln-lib/impl.js",
      "module.exports = function (args) {\n  return args;\n};\n",
    );
    const entry = write(root, "src/app.js", appCalling("pkg(input)"));

    const graph = await graphFor(root, [entry]);

    const target = anonymousFunctionIn(graph, "impl.js");
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("composes across MULTIPLE same-package re-export hops", async () => {
    const root = tempProject();
    write(root, "node_modules/vuln-lib/package.json", packageJson("vuln-lib"));
    write(
      root,
      "node_modules/vuln-lib/index.js",
      'module.exports = require("./internal/ops");\n',
    );
    write(
      root,
      "node_modules/vuln-lib/internal/ops.js",
      'module.exports = require("../impl");\n',
    );
    write(
      root,
      "node_modules/vuln-lib/impl.js",
      "module.exports = function (args) {\n  return args;\n};\n",
    );
    const entry = write(root, "src/app.js", appCalling("pkg(input)"));

    const graph = await graphFor(root, [entry]);

    const target = anonymousFunctionIn(graph, "impl.js");
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("binds a named-export re-export of a sibling's anonymous callable", async () => {
    // The real `qs` shape: `module.exports = { parse: parse }` over
    // `var parse = require('./parse')`, where ./parse.js is
    // `module.exports = function (str, opts) { ... }`.
    const root = tempProject();
    write(root, "node_modules/vuln-lib/package.json", packageJson("vuln-lib"));
    write(
      root,
      "node_modules/vuln-lib/index.js",
      'var vulnerable = require("./vulnerable");\nmodule.exports = { vulnerable: vulnerable };\n',
    );
    write(
      root,
      "node_modules/vuln-lib/vulnerable.js",
      "module.exports = function (args) {\n  return args;\n};\n",
    );
    const entry = write(
      root,
      "src/app.js",
      appCalling("pkg.vulnerable(input)"),
    );

    const graph = await graphFor(root, [entry]);

    const target = anonymousFunctionIn(graph, "vulnerable.js");
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("binds within the finding's OWN instance when two same-name, same-version installs exist", async () => {
    // Both installs export an anonymous function through the identical
    // mechanism, so nothing but canonical PackageInstance identity can tell
    // the two implementations apart.
    const root = tempProject();
    const anonymous =
      "module.exports = function (args) {\n  return args;\n};\n";
    write(root, "node_modules/vuln-lib/package.json", packageJson("vuln-lib"));
    write(root, "node_modules/vuln-lib/index.js", anonymous);
    write(
      root,
      "node_modules/host/node_modules/vuln-lib/package.json",
      packageJson("vuln-lib"),
    );
    write(root, "node_modules/host/node_modules/vuln-lib/index.js", anonymous);
    write(root, "node_modules/host/package.json", packageJson("host"));
    write(
      root,
      "node_modules/host/index.js",
      'const nested = require("vuln-lib");\nfunction hostMain(input) {\n  return nested(input);\n}\nmodule.exports = { hostMain };\n',
    );
    const entry = write(
      root,
      "src/app.js",
      'const host = require("host");\nfunction main(input) {\n  return host.hostMain(input);\n}\nmodule.exports = { main };\n',
    );

    const graph = await graphFor(root, [entry]);

    const nestedTarget = findNode(
      graph,
      (n) =>
        n.kind === "function" &&
        n.name === undefined &&
        n.module.includes(path.join("host", "node_modules", "vuln-lib")),
    );
    expect(nestedTarget).toBeDefined();

    const hostNode = findNode(graph, (n) => n.name === "hostMain");
    const hostEdge = graph.edges.find((e) => e.from === hostNode?.id);
    expect(hostEdge).toMatchObject({
      resolution: { kind: "resolved", target: nestedTarget?.id },
    });

    const topLevelTarget = findNode(
      graph,
      (n) =>
        n.kind === "function" &&
        n.name === undefined &&
        n.module.includes(path.join("node_modules", "vuln-lib")) &&
        !n.module.includes("host"),
    );
    if (topLevelTarget) {
      expect(hostEdge?.resolution).not.toMatchObject({
        target: topLevelTarget.id,
      });
    }
  });

  it("preserves canonical identity across a pnpm-style symlinked install", async () => {
    const root = tempProject();
    write(
      root,
      "store/vuln-lib@1.0.0/node_modules/vuln-lib/package.json",
      packageJson("vuln-lib"),
    );
    write(
      root,
      "store/vuln-lib@1.0.0/node_modules/vuln-lib/index.js",
      'module.exports = require("./impl");\n',
    );
    write(
      root,
      "store/vuln-lib@1.0.0/node_modules/vuln-lib/impl.js",
      "module.exports = function (args) {\n  return args;\n};\n",
    );
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(root, "store", "vuln-lib@1.0.0", "node_modules", "vuln-lib"),
      path.join(root, "node_modules", "vuln-lib"),
      "dir",
    );
    const entry = write(root, "src/app.js", appCalling("pkg(input)"));

    const graph = await graphFor(root, [entry]);

    const target = anonymousFunctionIn(graph, "impl.js");
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("preserves canonical identity for a workspace/file-linked install", async () => {
    const root = tempProject();
    write(root, "packages/vuln-lib/package.json", packageJson("vuln-lib"));
    write(
      root,
      "packages/vuln-lib/index.js",
      'module.exports = require("./impl");\n',
    );
    write(
      root,
      "packages/vuln-lib/impl.js",
      "module.exports = function (args) {\n  return args;\n};\n",
    );
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(root, "packages", "vuln-lib"),
      path.join(root, "node_modules", "vuln-lib"),
      "dir",
    );
    const entry = write(root, "src/app.js", appCalling("pkg(input)"));

    const knownPackageRoots = buildKnownPackageRoots(
      [
        {
          id: "vuln-lib@1.0.0",
          name: "vuln-lib",
          version: "1.0.0",
          ecosystem: "npm",
          direct: true,
          locations: ["packages/vuln-lib"],
          dependencyPaths: [],
        },
      ],
      root,
    );

    const graph = await graphFor(root, [entry], knownPackageRoots);

    const target = anonymousFunctionIn(graph, "impl.js");
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });
});

describe("buildCallGraph: RWF-003 boundaries that must stay conservative", () => {
  it("does not cross a package boundary to reach another package's anonymous export (RWF-004b)", async () => {
    const root = tempProject();
    write(root, "node_modules/vuln-lib/package.json", packageJson("vuln-lib"));
    write(
      root,
      "node_modules/vuln-lib/index.js",
      'module.exports = require("other-lib");\n',
    );
    write(
      root,
      "node_modules/other-lib/package.json",
      packageJson("other-lib"),
    );
    write(
      root,
      "node_modules/other-lib/index.js",
      "module.exports = function (args) {\n  return args;\n};\n",
    );
    const entry = write(root, "src/app.js", appCalling("pkg(input)"));

    const graph = await graphFor(root, [entry]);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("does not bind an anonymous export in a file that shadows the CommonJS ambient names", async () => {
    const root = tempProject();
    write(root, "node_modules/vuln-lib/package.json", packageJson("vuln-lib"));
    write(
      root,
      "node_modules/vuln-lib/index.js",
      "const module = { exports: null };\nmodule.exports = function (args) {\n  return args;\n};\n",
    );
    const entry = write(root, "src/app.js", appCalling("pkg(input)"));

    const graph = await graphFor(root, [entry]);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("does not bind a conditionally-assigned anonymous export", async () => {
    const root = tempProject();
    write(root, "node_modules/vuln-lib/package.json", packageJson("vuln-lib"));
    write(
      root,
      "node_modules/vuln-lib/index.js",
      "if (process.env.FLAG) {\n  module.exports = function (a) { return a; };\n} else {\n  module.exports = function (b) { return b; };\n}\n",
    );
    const entry = write(root, "src/app.js", appCalling("pkg(input)"));

    const graph = await graphFor(root, [entry]);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("does not create a call edge to an anonymous export that is never called", async () => {
    // Attributing the export must not, by itself, invent reachability.
    const root = tempProject();
    write(root, "node_modules/vuln-lib/package.json", packageJson("vuln-lib"));
    write(
      root,
      "node_modules/vuln-lib/index.js",
      "module.exports = function (args) {\n  return args;\n};\n",
    );
    const entry = write(
      root,
      "src/app.js",
      'const pkg = require("vuln-lib");\nfunction main(input) {\n  return input;\n}\nmodule.exports = { main };\n',
    );

    const graph = await graphFor(root, [entry]);

    const target = anonymousFunctionIn(graph, "index.js");
    expect(
      graph.edges.some(
        (e) =>
          e.resolution.kind === "resolved" &&
          e.resolution.target === target?.id,
      ),
    ).toBe(false);
  });
});
