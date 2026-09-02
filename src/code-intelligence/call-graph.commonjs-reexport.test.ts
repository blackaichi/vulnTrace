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
 * RWF-004a: the same-package CommonJS re-export chase, at the layer that
 * actually resolves it -- specifier resolution, the
 * same-canonical-PackageInstance rule, and graph binding.
 *
 * The companion unit suite (commonjs-reexports.test.ts) covers the ORIGIN
 * relation in isolation; everything here needs real files, real module
 * resolution and real package identity, so it builds real temp projects.
 */

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-cjs-reexport-"));
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

/** Writes a `vuln-lib` package whose facade re-exports from a sibling `lib.js`. */
function writePackage(
  root: string,
  facade: string,
  options?: { readonly packageDir?: string; readonly libBody?: string },
): void {
  const dir = options?.packageDir ?? "node_modules/vuln-lib";
  write(
    root,
    `${dir}/package.json`,
    JSON.stringify({ name: "vuln-lib", version: "1.0.0", main: "index.js" }),
  );
  write(root, `${dir}/index.js`, facade);
  write(
    root,
    `${dir}/lib.js`,
    options?.libBody ??
      "function vulnerable(x) { return x; }\nfunction safe(x) { return x; }\nexports.vulnerable = vulnerable;\nexports.safe = safe;\n",
  );
}

function appCalling(expression: string): string {
  return `const pkg = require("vuln-lib");\nfunction main(input) {\n  return ${expression};\n}\nmodule.exports = { main };\n`;
}

describe("buildCallGraph: same-package CommonJS re-export chase (RWF-004a)", () => {
  it("binds a direct named re-export to the real implementation in the sibling file", async () => {
    const root = tempProject();
    writePackage(root, `exports.vulnerable = require("./lib").vulnerable;\n`);
    const entry = write(
      root,
      "src/app.js",
      appCalling("pkg.vulnerable(input)"),
    );

    const graph = await graphFor(root, [entry]);

    const target = findNode(
      graph,
      (n) => n.name === "vulnerable" && n.module.endsWith("lib.js"),
    );
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("binds through a whole-module re-export (module.exports = require('./lib'))", async () => {
    const root = tempProject();
    writePackage(root, `module.exports = require("./lib");\n`);
    const entry = write(
      root,
      "src/app.js",
      appCalling("pkg.vulnerable(input)"),
    );

    const graph = await graphFor(root, [entry]);

    const target = findNode(
      graph,
      (n) => n.name === "vulnerable" && n.module.endsWith("lib.js"),
    );
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("binds a named export holding a whole required module to that module's default export", async () => {
    // The real qs/semver shape: `exports.stringify = require('./stringify')`
    // where ./stringify is `module.exports = function named() {}`.
    const root = tempProject();
    write(
      root,
      "node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "1.0.0", main: "index.js" }),
    );
    write(
      root,
      "node_modules/vuln-lib/index.js",
      `var vulnerable = require("./vulnerable");\nmodule.exports = { vulnerable };\n`,
    );
    write(
      root,
      "node_modules/vuln-lib/vulnerable.js",
      "module.exports = function reallyVulnerable(x) { return x; };\n",
    );
    const entry = write(
      root,
      "src/app.js",
      appCalling("pkg.vulnerable(input)"),
    );

    const graph = await graphFor(root, [entry]);

    const target = findNode(
      graph,
      (n) =>
        n.name === "reallyVulnerable" && n.module.endsWith("vulnerable.js"),
    );
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("composes a multi-hop chain: index -> middle -> lib", async () => {
    const root = tempProject();
    writePackage(
      root,
      `exports.vulnerable = require("./middle").vulnerable;\n`,
    );
    write(
      root,
      "node_modules/vuln-lib/middle.js",
      `module.exports = require("./lib");\n`,
    );
    const entry = write(
      root,
      "src/app.js",
      appCalling("pkg.vulnerable(input)"),
    );

    const graph = await graphFor(root, [entry]);

    const target = findNode(
      graph,
      (n) => n.name === "vulnerable" && n.module.endsWith("lib.js"),
    );
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("composes across syntaxes: a CommonJS hop into an ESM re-export", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "1.0.0", main: "index.js" }),
    );
    write(
      root,
      "node_modules/vuln-lib/index.js",
      `exports.vulnerable = require("./middle").vulnerable;\n`,
    );
    write(
      root,
      "node_modules/vuln-lib/middle.js",
      `export { vulnerable } from "./lib.js";\n`,
    );
    write(
      root,
      "node_modules/vuln-lib/lib.js",
      "export function vulnerable(x) { return x; }\n",
    );
    const entry = write(
      root,
      "src/app.js",
      appCalling("pkg.vulnerable(input)"),
    );

    const graph = await graphFor(root, [entry]);

    const target = findNode(
      graph,
      (n) => n.name === "vulnerable" && n.module.endsWith("lib.js"),
    );
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("terminates on a re-export cycle and reports unresolved_target, never hanging", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "1.0.0", main: "index.js" }),
    );
    write(
      root,
      "node_modules/vuln-lib/index.js",
      `exports.vulnerable = require("./a").vulnerable;\n`,
    );
    write(
      root,
      "node_modules/vuln-lib/a.js",
      `exports.vulnerable = require("./b").vulnerable;\n`,
    );
    write(
      root,
      "node_modules/vuln-lib/b.js",
      `exports.vulnerable = require("./a").vulnerable;\n`,
    );
    const entry = write(
      root,
      "src/app.js",
      appCalling("pkg.vulnerable(input)"),
    );

    const graph = await graphFor(root, [entry]);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("terminates on a self-referential whole-module re-export", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "1.0.0", main: "index.js" }),
    );
    write(
      root,
      "node_modules/vuln-lib/index.js",
      `module.exports = require("./index.js");\n`,
    );
    const entry = write(
      root,
      "src/app.js",
      appCalling("pkg.vulnerable(input)"),
    );

    const graph = await graphFor(root, [entry]);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("resolves `new` through a same-package re-export, not just a call", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "1.0.0", main: "index.js" }),
    );
    write(
      root,
      "node_modules/vuln-lib/index.js",
      `var Range = require("./range");\nmodule.exports = { Range };\n`,
    );
    write(
      root,
      "node_modules/vuln-lib/range.js",
      "class Range {\n  constructor(spec) { this.spec = spec; }\n}\nmodule.exports = Range;\n",
    );
    const entry = write(
      root,
      "src/app.js",
      `const pkg = require("vuln-lib");\nfunction main(input) {\n  return new pkg.Range(input);\n}\nmodule.exports = { main };\n`,
    );

    const graph = await graphFor(root, [entry]);

    const target = findNode(
      graph,
      (n) => n.kind === "constructor" && n.module.endsWith("range.js"),
    );
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      type: "constructor",
      resolution: { kind: "resolved", target: target?.id },
    });
  });
});

describe("buildCallGraph: the CommonJS re-export chase never guesses (RWF-004a negative controls)", () => {
  it("does not chase a dynamic require specifier", async () => {
    const root = tempProject();
    writePackage(
      root,
      `var name = process.env.LIB;\nexports.vulnerable = require(name).vulnerable;\n`,
    );
    const entry = write(
      root,
      "src/app.js",
      appCalling("pkg.vulnerable(input)"),
    );

    const graph = await graphFor(root, [entry]);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("does not chase a conditional whole-module re-export", async () => {
    const root = tempProject();
    writePackage(
      root,
      `module.exports = process.env.X ? require("./lib") : require("./other");\n`,
    );
    write(
      root,
      "node_modules/vuln-lib/other.js",
      "exports.vulnerable = null;\n",
    );
    const entry = write(
      root,
      "src/app.js",
      appCalling("pkg.vulnerable(input)"),
    );

    const graph = await graphFor(root, [entry]);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("binds only within the finding's own instance when two same-name, same-version installs exist", async () => {
    const root = tempProject();
    // Top-level install: the facade re-exports the SAFE function under the
    // name `vulnerable`'s sibling, and never exposes a `vulnerable` at all.
    writePackage(root, `exports.safe = require("./lib").safe;\n`);
    // A nested install of the SAME name and SAME version at a different path.
    writePackage(root, `exports.vulnerable = require("./lib").vulnerable;\n`, {
      packageDir: "node_modules/host/node_modules/vuln-lib",
    });
    write(
      root,
      "node_modules/host/package.json",
      JSON.stringify({ name: "host", version: "1.0.0", main: "index.js" }),
    );
    write(
      root,
      "node_modules/host/index.js",
      `const nested = require("vuln-lib");\nfunction hostMain(input) {\n  return nested.vulnerable(input);\n}\nmodule.exports = { hostMain };\n`,
    );
    const entry = write(
      root,
      "src/app.js",
      `const host = require("host");\nfunction main(input) {\n  return host.hostMain(input);\n}\nmodule.exports = { main };\n`,
    );

    const graph = await graphFor(root, [entry]);

    const nestedTarget = findNode(
      graph,
      (n) =>
        n.name === "vulnerable" &&
        n.module.includes(path.join("host", "node_modules", "vuln-lib")),
    );
    expect(nestedTarget).toBeDefined();

    const hostNode = findNode(graph, (n) => n.name === "hostMain");
    const hostEdge = graph.edges.find((e) => e.from === hostNode?.id);
    expect(hostEdge).toMatchObject({
      resolution: { kind: "resolved", target: nestedTarget?.id },
    });

    // The top-level instance's own lib.js `vulnerable` is a DIFFERENT node
    // and must never have been the target of that edge.
    const topLevelTarget = findNode(
      graph,
      (n) =>
        n.name === "vulnerable" &&
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
    // The real physical install lives in a store; node_modules/vuln-lib is
    // only a symlink to it. Both sides of the re-export must still compare
    // as the same canonical instance.
    writePackage(root, `exports.vulnerable = require("./lib").vulnerable;\n`, {
      packageDir: "store/vuln-lib@1.0.0/node_modules/vuln-lib",
    });
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(root, "store", "vuln-lib@1.0.0", "node_modules", "vuln-lib"),
      path.join(root, "node_modules", "vuln-lib"),
      "dir",
    );
    const entry = write(
      root,
      "src/app.js",
      appCalling("pkg.vulnerable(input)"),
    );

    const graph = await graphFor(root, [entry]);

    const target = findNode(
      graph,
      (n) => n.name === "vulnerable" && n.module.endsWith("lib.js"),
    );
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("preserves canonical identity for a workspace/file-linked install via knownPackageRoots", async () => {
    const root = tempProject();
    // An in-tree workspace member with NO node_modules segment of its own,
    // reached through a node_modules symlink -- identifiable only through
    // the dependency graph's own provenance registry.
    writePackage(root, `exports.vulnerable = require("./lib").vulnerable;\n`, {
      packageDir: "packages/vuln-lib",
    });
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(root, "packages", "vuln-lib"),
      path.join(root, "node_modules", "vuln-lib"),
      "dir",
    );
    const entry = write(
      root,
      "src/app.js",
      appCalling("pkg.vulnerable(input)"),
    );

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

    const target = findNode(
      graph,
      (n) => n.name === "vulnerable" && n.module.endsWith("lib.js"),
    );
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("does not chase a re-export in a file that declares its own `exports` object", async () => {
    const root = tempProject();
    writePackage(
      root,
      `const exports = {};\nexports.vulnerable = require("./lib").vulnerable;\nmodule.exports = exports;\n`,
    );
    const entry = write(
      root,
      "src/app.js",
      appCalling("pkg.vulnerable(input)"),
    );

    const graph = await graphFor(root, [entry]);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("re-exporting the SAFE symbol never binds the vulnerable one of the same file", async () => {
    const root = tempProject();
    writePackage(root, `exports.safe = require("./lib").safe;\n`);
    const entry = write(root, "src/app.js", appCalling("pkg.safe(input)"));

    const graph = await graphFor(root, [entry]);

    const safeTarget = findNode(
      graph,
      (n) => n.name === "safe" && n.module.endsWith("lib.js"),
    );
    const vulnerableTarget = findNode(
      graph,
      (n) => n.name === "vulnerable" && n.module.endsWith("lib.js"),
    );
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: safeTarget?.id },
    });
    expect(vulnerableTarget).toBeDefined();
    expect(
      graph.edges.some(
        (e) =>
          e.resolution.kind === "resolved" &&
          e.resolution.target === vulnerableTarget?.id,
      ),
    ).toBe(false);
  });

  it("a property name matching a function in an UNRELATED sibling file establishes nothing", async () => {
    const root = tempProject();
    // The facade re-exports `vulnerable` from ./lib, which does NOT define
    // it; a same-named function exists only in an unrelated sibling.
    writePackage(root, `exports.vulnerable = require("./lib").vulnerable;\n`, {
      libBody: "function safe(x) { return x; }\nexports.safe = safe;\n",
    });
    write(
      root,
      "node_modules/vuln-lib/unrelated.js",
      "function vulnerable(x) { return x; }\nexports.vulnerable = vulnerable;\n",
    );
    const entry = write(
      root,
      "src/app.js",
      appCalling("pkg.vulnerable(input)"),
    );

    const graph = await graphFor(root, [entry]);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });
});
