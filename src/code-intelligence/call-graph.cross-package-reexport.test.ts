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
import type { CallGraph, GraphNode } from "../domain/graph.js";

/**
 * RWF-004b: the CommonJS re-export chase across a PACKAGE boundary --
 * `wrapper/index.js`'s `exports.parse = require("vuln-pkg").parse`, where
 * the export is spelled inside `wrapper` but the runtime callable is
 * `vuln-pkg`'s (RWB-08's real `debug`/`ms` shape).
 *
 * The companion RWF-004a suite (call-graph.commonjs-reexport.test.ts)
 * covers the same relation inside one installed package, and
 * commonjs-reexports.test.ts covers the ORIGIN syntax in isolation --
 * neither of which RWF-004b changes. What is exercised here is the part
 * that only exists once a hop can leave its own package: which INSTALLED
 * INSTANCE the chase lands on. Every positive case therefore asserts the
 * target's own `module` path, not merely that something resolved: an
 * assertion that only checks the exported name would pass just as happily
 * against the wrong same-name/same-version install, which is the exact
 * failure this task exists to prevent (SDD-v0.2.md § 4.2).
 */

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-xpkg-reexport-"));
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

async function graphFor(root: string, entry: string): Promise<CallGraph> {
  const resolver = createModuleResolver(loadTsProject(root));
  return buildCallGraph({ entryFiles: [entry], resolver });
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

function pkgJson(name: string, main = "index.js", version = "1.0.0"): string {
  return JSON.stringify({ name, version, main });
}

/** The application: `require("wrapper").parse(input)` and nothing else. */
function appCallingWrapper(root: string): string {
  return write(
    root,
    "src/app.js",
    `const wrapper = require("wrapper");\nfunction main(input) {\n  return wrapper.parse(input);\n}\nmodule.exports = { main };\n`,
  );
}

/**
 * A `vuln-pkg` install whose `parse` is a real, named local function.
 * `dir` names the INSTALL PATH, so two calls can create two distinct
 * instances of the same name and version.
 */
function writeVulnPkg(
  root: string,
  dir = "node_modules/vuln-pkg",
  options?: { readonly name?: string; readonly body?: string },
): void {
  const name = options?.name ?? "vuln-pkg";
  write(root, `${dir}/package.json`, pkgJson(name));
  write(
    root,
    `${dir}/index.js`,
    options?.body ??
      "function parse(x) { return x; }\nfunction safe(x) { return x; }\nexports.parse = parse;\nexports.safe = safe;\n",
  );
}

function writeWrapper(
  root: string,
  body: string,
  dir = "node_modules/wrapper",
): void {
  write(root, `${dir}/package.json`, pkgJson("wrapper"));
  write(root, `${dir}/index.js`, body);
}

/** The `parse` node inside the install rooted at `installDir`, if the graph has one. */
function parseNodeIn(graph: CallGraph, root: string, installDir: string) {
  const prefix = path.join(root, installDir) + path.sep;
  return findNode(
    graph,
    (n) => n.name === "parse" && n.module.startsWith(prefix),
  );
}

function hasResolvedEdgeTo(graph: CallGraph, node: GraphNode | undefined) {
  return (
    node !== undefined &&
    graph.edges.some(
      (e) =>
        e.resolution.kind === "resolved" && e.resolution.target === node.id,
    )
  );
}

describe("buildCallGraph: cross-package CommonJS re-export chase (RWF-004b)", () => {
  it('A: `exports.foo = require("pkg").foo` binds the foreign package\'s implementation', async () => {
    const root = tempProject();
    writeWrapper(root, `exports.parse = require("vuln-pkg").parse;\n`);
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const target = parseNodeIn(graph, root, "node_modules/vuln-pkg");
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it('B: `module.exports.foo = require("pkg").foo` binds the same target', async () => {
    const root = tempProject();
    writeWrapper(root, `module.exports.parse = require("vuln-pkg").parse;\n`);
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const target = parseNodeIn(graph, root, "node_modules/vuln-pkg");
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it('C: `module.exports = require("pkg")` forwards the whole namespace across the boundary', async () => {
    const root = tempProject();
    writeWrapper(root, `module.exports = require("vuln-pkg");\n`);
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const target = parseNodeIn(graph, root, "node_modules/vuln-pkg");
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it('E: `const { foo } = require("pkg"); exports.foo = foo` binds the same target', async () => {
    const root = tempProject();
    writeWrapper(
      root,
      `const { parse } = require("vuln-pkg");\nexports.parse = parse;\n`,
    );
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const target = parseNodeIn(graph, root, "node_modules/vuln-pkg");
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("F: a constant string element access selects the same foreign name", async () => {
    const root = tempProject();
    writeWrapper(root, `exports.parse = require("vuln-pkg")["parse"];\n`);
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const target = parseNodeIn(graph, root, "node_modules/vuln-pkg");
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("selects the foreign name the re-export actually named, not the name it republishes it under", async () => {
    const root = tempProject();
    writeWrapper(root, `exports.parse = require("vuln-pkg").safe;\n`);
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const safeTarget = findNode(
      graph,
      (n) => n.name === "safe" && n.module.includes("vuln-pkg"),
    );
    const parseTarget = parseNodeIn(graph, root, "node_modules/vuln-pkg");
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: safeTarget?.id },
    });
    expect(parseTarget).toBeDefined();
    expect(hasResolvedEdgeTo(graph, parseTarget)).toBe(false);
  });

  it("resolves a scoped package specifier to that package's own instance", async () => {
    const root = tempProject();
    writeWrapper(root, `exports.parse = require("@scope/vuln-pkg").parse;\n`);
    writeVulnPkg(root, "node_modules/@scope/vuln-pkg", {
      name: "@scope/vuln-pkg",
    });
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const target = parseNodeIn(graph, root, "node_modules/@scope/vuln-pkg");
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("resolves a package SUBPATH specifier to the file that subpath names", async () => {
    const root = tempProject();
    writeWrapper(
      root,
      `exports.parse = require("vuln-pkg/lib/parse.js").parse;\n`,
    );
    write(root, "node_modules/vuln-pkg/package.json", pkgJson("vuln-pkg"));
    write(root, "node_modules/vuln-pkg/index.js", "module.exports = {};\n");
    write(
      root,
      "node_modules/vuln-pkg/lib/parse.js",
      "function parse(x) { return x; }\nexports.parse = parse;\n",
    );
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const target = findNode(
      graph,
      (n) =>
        n.name === "parse" && n.module.endsWith(path.join("lib", "parse.js")),
    );
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("resolves a `../` specifier into a sibling install as that SIBLING's instance", async () => {
    // Node really does resolve this, and it really does leave `wrapper`.
    // The point of the assertion is the attribution: the node belongs to
    // sibling-lib, so a finding for `wrapper` can never inherit it.
    const root = tempProject();
    writeWrapper(
      root,
      `exports.parse = require("../sibling-lib/impl.js").parse;\n`,
    );
    write(
      root,
      "node_modules/sibling-lib/package.json",
      pkgJson("sibling-lib"),
    );
    write(
      root,
      "node_modules/sibling-lib/impl.js",
      "function parse(x) { return x; }\nexports.parse = parse;\n",
    );
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const target = parseNodeIn(graph, root, "node_modules/sibling-lib");
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("chases a façade that is the scanned project's OWN source, not an installed package", async () => {
    const root = tempProject();
    write(
      root,
      "src/facade.js",
      `exports.parse = require("vuln-pkg").parse;\n`,
    );
    writeVulnPkg(root);
    const entry = write(
      root,
      "src/app.js",
      `const facade = require("./facade");\nfunction main(input) {\n  return facade.parse(input);\n}\nmodule.exports = { main };\n`,
    );

    const graph = await graphFor(root, entry);

    const target = parseNodeIn(graph, root, "node_modules/vuln-pkg");
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("composes a multi-hop CROSS-PACKAGE chain: app -> facade-a -> facade-b -> vuln-pkg", async () => {
    const root = tempProject();
    writeWrapper(root, `exports.parse = require("facade-b").parse;\n`);
    write(root, "node_modules/facade-b/package.json", pkgJson("facade-b"));
    write(
      root,
      "node_modules/facade-b/index.js",
      `exports.parse = require("vuln-pkg").parse;\n`,
    );
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const target = parseNodeIn(graph, root, "node_modules/vuln-pkg");
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("composes a MIXED chain: cross-package hop, then a same-package sibling hop", async () => {
    const root = tempProject();
    writeWrapper(root, `module.exports = require("vuln-pkg");\n`);
    write(root, "node_modules/vuln-pkg/package.json", pkgJson("vuln-pkg"));
    write(
      root,
      "node_modules/vuln-pkg/index.js",
      `exports.parse = require("./lib/parse.js").parse;\n`,
    );
    write(
      root,
      "node_modules/vuln-pkg/lib/parse.js",
      "function parse(x) { return x; }\nexports.parse = parse;\n",
    );
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const target = parseNodeIn(graph, root, "node_modules/vuln-pkg");
    expect(target?.module).toContain(path.join("vuln-pkg", "lib", "parse.js"));
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("composes a MIXED chain: same-package hop, then a cross-package hop", async () => {
    const root = tempProject();
    writeWrapper(root, `module.exports = require("./inner.js");\n`);
    write(
      root,
      "node_modules/wrapper/inner.js",
      `exports.parse = require("vuln-pkg").parse;\n`,
    );
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const target = parseNodeIn(graph, root, "node_modules/vuln-pkg");
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("preserves canonical identity across a pnpm-style symlinked foreign install", async () => {
    const root = tempProject();
    writeWrapper(root, `exports.parse = require("vuln-pkg").parse;\n`);
    writeVulnPkg(root, "store/vuln-pkg@1.0.0/node_modules/vuln-pkg");
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(root, "store", "vuln-pkg@1.0.0", "node_modules", "vuln-pkg"),
      path.join(root, "node_modules", "vuln-pkg"),
      "dir",
    );
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const target = findNode(
      graph,
      (n) => n.name === "parse" && n.module.includes("vuln-pkg"),
    );
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });
});

describe("buildCallGraph: RWF-004b never collapses a PackageInstance to name+version", () => {
  it("binds the NESTED install the wrapper actually resolves, never its same-name, same-version twin", async () => {
    const root = tempProject();
    // Two installs, identical name AND version, identical vulnerable export
    // name. Only the nested one is what `require("vuln-pkg")` inside
    // `wrapper` resolves to.
    writeVulnPkg(root, "node_modules/vuln-pkg");
    writeVulnPkg(root, "node_modules/wrapper/node_modules/vuln-pkg");
    writeWrapper(root, `exports.parse = require("vuln-pkg").parse;\n`);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const nested = parseNodeIn(
      graph,
      root,
      path.join("node_modules", "wrapper", "node_modules", "vuln-pkg"),
    );
    expect(nested).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: nested?.id },
    });

    // The unrelated twin must receive no resolved edge at all: if it is in
    // the graph, nothing points at it.
    const topLevel = findNode(
      graph,
      (n) =>
        n.name === "parse" &&
        n.module.startsWith(
          path.join(root, "node_modules", "vuln-pkg") + path.sep,
        ),
    );
    expect(hasResolvedEdgeTo(graph, topLevel)).toBe(false);
  });

  it("RWF-012: a multi-hop alias chain still binds the NESTED twin, never the top-level one", async () => {
    const root = tempProject();
    // Identical name, identical version, identical vulnerable export name,
    // two install paths. The wrapper reaches its own nested install through
    // a THREE-hop local alias chain -- the exact combination RWF-012 could
    // get wrong: truncate the chain (unresolved), or resolve it and then
    // borrow the wrong instance because both twins answer to "vuln-pkg@1.0.0".
    // The instance must come from the resolver's answer for the wrapper's
    // own `require`, never from the alias's name.
    writeVulnPkg(root, "node_modules/vuln-pkg");
    writeVulnPkg(root, "node_modules/wrapper/node_modules/vuln-pkg");
    writeWrapper(
      root,
      `const dep = require("vuln-pkg");\nconst a = dep;\nconst b = a;\nmodule.exports = b;\n`,
    );
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const nested = parseNodeIn(
      graph,
      root,
      path.join("node_modules", "wrapper", "node_modules", "vuln-pkg"),
    );
    expect(nested).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: nested?.id },
    });

    const topLevel = findNode(
      graph,
      (n) =>
        n.name === "parse" &&
        n.module.startsWith(
          path.join(root, "node_modules", "vuln-pkg") + path.sep,
        ),
    );
    expect(hasResolvedEdgeTo(graph, topLevel)).toBe(false);
  });

  it("inverse: the TOP-LEVEL twin holding the dangerous body is never substituted for the nested one", async () => {
    const root = tempProject();
    // The top-level instance's `parse` calls a distinctive sink; the nested
    // instance's does not. The wrapper resolves the NESTED one, so the sink
    // must never become reachable.
    writeVulnPkg(root, "node_modules/vuln-pkg", {
      body: "function topLevelOnlySink(x) { return x; }\nfunction parse(x) { return topLevelOnlySink(x); }\nexports.parse = parse;\n",
    });
    writeVulnPkg(root, "node_modules/wrapper/node_modules/vuln-pkg", {
      body: "function parse(x) { return x; }\nexports.parse = parse;\n",
    });
    writeWrapper(root, `exports.parse = require("vuln-pkg").parse;\n`);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const nested = parseNodeIn(
      graph,
      root,
      path.join("node_modules", "wrapper", "node_modules", "vuln-pkg"),
    );
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: nested?.id },
    });

    const sink = findNode(graph, (n) => n.name === "topLevelOnlySink");
    expect(hasResolvedEdgeTo(graph, sink)).toBe(false);
  });
});

describe("buildCallGraph: RWF-004b keeps every existing refusal closed", () => {
  it("RWF-011: a wrapper-local function of the same name is never the target", async () => {
    const root = tempProject();
    writeWrapper(
      root,
      `function parse(x) { return x; }\nexports.parse = require("vuln-pkg").parse;\nexports.localParse = parse;\n`,
    );
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const foreign = parseNodeIn(graph, root, "node_modules/vuln-pkg");
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: foreign?.id },
    });

    const decoy = parseNodeIn(graph, root, "node_modules/wrapper");
    expect(decoy).toBeDefined();
    expect(mainEdge(graph)?.resolution).not.toMatchObject({
      target: decoy?.id,
    });
  });

  it("a dynamic require specifier is never chased across a package boundary", async () => {
    const root = tempProject();
    writeWrapper(
      root,
      `var name = process.env.LIB;\nexports.parse = require(name).parse;\n`,
    );
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("a conditional whole-module re-export is never chased across a package boundary", async () => {
    const root = tempProject();
    writeWrapper(
      root,
      `module.exports = process.env.X ? require("vuln-pkg") : require("other-pkg");\n`,
    );
    writeVulnPkg(root);
    write(root, "node_modules/other-pkg/package.json", pkgJson("other-pkg"));
    write(root, "node_modules/other-pkg/index.js", "exports.parse = null;\n");
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("a BRANCH-LOCAL named re-export is never chased, whichever branch came last", async () => {
    // The provenance map is last-write-wins by source order, which is
    // Node's semantics for straight-line code and nothing else. Chasing it
    // here would forward `parse` to pkg-b and silently deny that pkg-a's
    // function is ever what the export holds -- see module-model.ts's
    // `isUnconditionalExportAssignment`.
    const root = tempProject();
    writeWrapper(
      root,
      `if (process.env.X) {\n  exports.parse = require("pkg-a").parse;\n} else {\n  exports.parse = require("pkg-b").parse;\n}\n`,
    );
    for (const name of ["pkg-a", "pkg-b"]) {
      write(root, `node_modules/${name}/package.json`, pkgJson(name));
      write(
        root,
        `node_modules/${name}/index.js`,
        "function parse(x) { return x; }\nexports.parse = parse;\n",
      );
    }
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
    for (const name of ["pkg-a", "pkg-b"]) {
      expect(
        hasResolvedEdgeTo(
          graph,
          parseNodeIn(graph, root, `node_modules/${name}`),
        ),
      ).toBe(false);
    }
  });

  it("a single-branch conditional named re-export is not chased either", async () => {
    const root = tempProject();
    writeWrapper(
      root,
      `if (process.env.X) {\n  exports.parse = require("vuln-pkg").parse;\n}\n`,
    );
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("a try/catch whole-module re-export is not chased", async () => {
    const root = tempProject();
    writeWrapper(
      root,
      `try {\n  module.exports = require("vuln-pkg");\n} catch (e) {\n  module.exports = {};\n}\n`,
    );
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("but the CHAINED unconditional form (`exports = module.exports = require(...)`) still resolves", async () => {
    // real debug@2.0.0's node.js, and RWB-08's first hop.
    const root = tempProject();
    writeWrapper(root, `exports = module.exports = require("vuln-pkg");\n`);
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const target = parseNodeIn(graph, root, "node_modules/vuln-pkg");
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("RWF-013: a reassigned alias is still refused when the require crosses a package", async () => {
    const root = tempProject();
    writeWrapper(
      root,
      `let dep = require("vuln-pkg");\ndep = { parse: null };\nmodule.exports = dep;\n`,
    );
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("RWF-013b: a name declared twice is still refused when the require crosses a package", async () => {
    const root = tempProject();
    writeWrapper(
      root,
      `var dep = require("vuln-pkg");\nvar dep = { parse: null };\nmodule.exports = dep;\n`,
    );
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("RWF-012: a second alias hop IS followed across a package boundary", async () => {
    const root = tempProject();
    writeWrapper(
      root,
      `const a = require("vuln-pkg");\nconst b = a;\nmodule.exports = b;\n`,
    );
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    const target = parseNodeIn(graph, root, "node_modules/vuln-pkg");
    expect(target).toBeDefined();
    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "resolved", target: target?.id },
    });
  });

  it("RWF-012: a chain with ONE mutated hop stays unresolved across a package boundary", async () => {
    const root = tempProject();
    writeWrapper(
      root,
      `const a = require("vuln-pkg");\nlet b = a;\nb = somethingElse;\nconst c = b;\nmodule.exports = c;\n`,
    );
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("RWF-012: a cyclic wrapper alias chain terminates and stays unresolved", async () => {
    const root = tempProject();
    writeWrapper(root, `const a = b;\nconst b = a;\nmodule.exports = a;\n`);
    writeVulnPkg(root);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("terminates on a CROSS-PACKAGE re-export cycle and stays unresolved", async () => {
    const root = tempProject();
    write(root, "node_modules/pkg-a/package.json", pkgJson("pkg-a"));
    write(
      root,
      "node_modules/pkg-a/index.js",
      `exports.parse = require("pkg-b").parse;\n`,
    );
    write(root, "node_modules/pkg-b/package.json", pkgJson("pkg-b"));
    write(
      root,
      "node_modules/pkg-b/index.js",
      `exports.parse = require("pkg-a").parse;\n`,
    );
    writeWrapper(root, `exports.parse = require("pkg-a").parse;\n`);
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });

  it("a foreign package that does not export the requested name resolves nothing", async () => {
    const root = tempProject();
    writeWrapper(root, `exports.parse = require("vuln-pkg").parse;\n`);
    write(root, "node_modules/vuln-pkg/package.json", pkgJson("vuln-pkg"));
    write(
      root,
      "node_modules/vuln-pkg/index.js",
      "function parse(x) { return x; }\n",
    );
    const entry = appCallingWrapper(root);

    const graph = await graphFor(root, entry);

    expect(mainEdge(graph)).toMatchObject({
      resolution: { kind: "unknown", reason: "unresolved_target" },
    });
  });
});
