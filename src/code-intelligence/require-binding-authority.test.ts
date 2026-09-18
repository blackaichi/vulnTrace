import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallEdge, CallGraph, GraphNode } from "../domain/graph.js";
import { buildCallGraph } from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";

/**
 * RWF-046 -- REQUIRE BINDING AUTHORITY.
 *
 * `bindCallee` used to answer "which module does this name denote?" by
 * searching `ModuleModel.imports` for the FIRST entry whose `localName`
 * matched the callee's text. That table is file-wide and name-keyed, so
 * it carried no declaration identity at all: a function-local
 * `const source = require("inner")` and a file-scope
 * `const source = require("outer")` are two rows spelled the same, and
 * the first one written won every reference in the file.
 *
 * The invariant these tests pin: a reference may inherit require/import
 * provenance only from the exact lexical binding declaration that
 * currently owns that reference. Never
 * `identifier text -> import table entry -> module source`.
 *
 * Every negative case here asserts the call stayed UNKNOWN rather than
 * merely "did not resolve to the wrong module" -- a vanished edge is its
 * own defect and must not pass as a refusal.
 */

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-require-binding-"));
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

function edgesFrom(graph: CallGraph, functionName: string): CallEdge[] {
  const from = findNode(graph, (n) => n.name === functionName);
  return graph.edges.filter((e) => e.from === from?.id);
}

/** The single edge leaving `functionName`, asserted to be the only one. */
function soleEdgeFrom(graph: CallGraph, functionName: string): CallEdge {
  const edges = edgesFrom(graph, functionName);
  expect(edges).toHaveLength(1);
  const [edge] = edges;
  expect(edge).toBeDefined();
  return edge as CallEdge;
}

/**
 * The file a resolved edge lands in. Asserting on the MODULE rather than
 * the node name is the whole point here: both twins export a function
 * called `run`, so a name assertion would pass under the very collapse
 * these tests exist to catch.
 */
function resolvedModuleOf(graph: CallGraph, edge: CallEdge): string {
  expect(edge.resolution.kind).toBe("resolved");
  const targetId =
    edge.resolution.kind === "resolved" ? edge.resolution.target : undefined;
  const target = graph.nodes.find((n) => n.id === targetId);
  expect(target).toBeDefined();
  return target?.module ?? "";
}

/** The NAME of a resolved edge's target, for same-file controls. */
function resolvedNameOf(graph: CallGraph, edge: CallEdge): string | undefined {
  expect(edge.resolution.kind).toBe("resolved");
  const targetId =
    edge.resolution.kind === "resolved" ? edge.resolution.target : undefined;
  return graph.nodes.find((n) => n.id === targetId)?.name;
}

function expectUnknown(graph: CallGraph, functionName: string): void {
  const edge = soleEdgeFrom(graph, functionName);
  expect(edge.resolution.kind).toBe("unknown");
}

/** A project with two distinct packages, each exporting `run`. */
function twoPackageProject(): string {
  const root = tempProject();
  for (const name of ["outer", "inner", "pkg-a", "pkg-b", "safe", "pkg"]) {
    write(
      root,
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
    );
    write(
      root,
      `node_modules/${name}/index.js`,
      "function run() {}\nmodule.exports = { run };\n",
    );
  }
  return root;
}

describe("RWF-046 § A: a function-local require must not borrow the outer one", () => {
  it("resolves the INNER module for a local require that shadows a file-scope one", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        'const source = require("outer");',
        "function f() {",
        '  const source = require("inner");',
        "  source.run();",
        "}",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    const module = resolvedModuleOf(graph, soleEdgeFrom(graph, "f"));
    expect(module).toContain(path.join("node_modules", "inner"));
    expect(module).not.toContain(path.join("node_modules", "outer"));
  });

  it("keeps the OUTER reference on the outer module (no cross-contamination)", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        'const source = require("outer");',
        "function outerCall() { source.run(); }",
        "function f() {",
        '  const source = require("inner");',
        "  source.run();",
        "}",
        "module.exports = { outerCall, f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "outerCall"))).toContain(
      path.join("node_modules", "outer"),
    );
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "f"))).toContain(
      path.join("node_modules", "inner"),
    );
  });
});

describe("RWF-046 § B: sibling functions with the same local require name", () => {
  it("resolves each sibling to its OWN binding", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        "function a() {",
        '  const source = require("pkg-a");',
        "  source.run();",
        "}",
        "function b() {",
        '  const source = require("pkg-b");',
        "  source.run();",
        "}",
        "module.exports = { a, b };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "a"))).toContain(
      path.join("node_modules", "pkg-a"),
    );
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "b"))).toContain(
      path.join("node_modules", "pkg-b"),
    );
  });
});

describe("RWF-046 § C: a reassigned require-bound source keeps no stale provenance", () => {
  it("REFUSES a require binding that is reassigned in its own scope", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        "function other() {}",
        "function f() {",
        '  let source = require("safe");',
        "  source = { run: other };",
        "  source.run();",
        "}",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expectUnknown(graph, "f");
  });

  it("REFUSES a require binding reassigned to a DIFFERENT require", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        "function f() {",
        '  let source = require("pkg-a");',
        '  source = require("pkg-b");',
        "  source.run();",
        "}",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expectUnknown(graph, "f");
  });
});

describe("RWF-046 § D: controls -- the same shapes WITHOUT require provenance", () => {
  it("already refuses a shadowed local binding with no import involved", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "index.js",
      [
        "function danger() {}",
        "function safe() {}",
        "const fn = danger;",
        "function f() {",
        "  const fn = safe;",
        "  fn();",
        "}",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expect(resolvedNameOf(graph, soleEdgeFrom(graph, "f"))).toBe("safe");
  });
});

describe("RWF-046 § E: positive controls -- CommonJS provenance is not disabled", () => {
  it("still resolves a plain file-scope require", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        'const source = require("pkg");',
        "function f() { source.run(); }",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "f"))).toContain(
      path.join("node_modules", "pkg"),
    );
  });

  it("still resolves a require bound INSIDE the calling function", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        "function f() {",
        '  const source = require("pkg");',
        "  source.run();",
        "}",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "f"))).toContain(
      path.join("node_modules", "pkg"),
    );
  });

  it("still resolves a BLOCK-scoped require under ordinary lexical rules", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        "function f() {",
        "  {",
        '    const source = require("pkg");',
        "    source.run();",
        "  }",
        "}",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "f"))).toContain(
      path.join("node_modules", "pkg"),
    );
  });

  it("does NOT hoist a block-scoped require's provenance out of its block", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        "function f() {",
        "  {",
        '    const source = require("inner");',
        "  }",
        "  source.run();",
        "}",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expectUnknown(graph, "f");
  });

  it("still resolves a destructured require", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        'const { run } = require("pkg");',
        "function f() { run(); }",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "f"))).toContain(
      path.join("node_modules", "pkg"),
    );
  });
});

describe("RWF-046 § F: shadowing forms that must NOT borrow require provenance", () => {
  it("REFUSES a PARAMETER that shadows an outer require binding", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        'const source = require("pkg");',
        "function f(source) { source.run(); }",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expectUnknown(graph, "f");
  });

  it("REFUSES a CATCH binding that shadows an outer require binding", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        'const source = require("pkg");',
        "function f() {",
        "  try { danger(); } catch (source) { source.run(); }",
        "}",
        "function danger() {}",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    const unknown = edgesFrom(graph, "f").filter(
      (e) => e.resolution.kind === "unknown",
    );
    // The `danger()` call in the `try` resolves; the `source.run()` in the
    // catch must not, and must not vanish either.
    expect(unknown).toHaveLength(1);
  });

  it("REFUSES a plain local binding that shadows an outer require binding", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        'const source = require("pkg");',
        "function f(input) {",
        "  const source = input;",
        "  source.run();",
        "}",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expectUnknown(graph, "f");
  });
});

describe("RWF-046 § G: writes and non-literal specifiers fail closed", () => {
  for (const [label, statement] of [
    ["||=", "source ||= other;"],
    ["??=", "source ??= other;"],
    ["plain =", "source = other;"],
  ] as const) {
    it(`REFUSES a require binding after a ${label} write`, async () => {
      const root = twoPackageProject();
      const entry = write(
        root,
        "index.js",
        [
          "const other = { run() {} };",
          "function f() {",
          '  let source = require("pkg");',
          `  ${statement}`,
          "  source.run();",
          "}",
          "module.exports = { f };",
        ].join("\n"),
      );
      const graph = await graphFor(root, entry);
      expectUnknown(graph, "f");
    });
  }

  it("REFUSES a require bound to a CONDITIONAL expression", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        "function f(cond) {",
        '  const source = cond ? require("pkg-a") : require("pkg-b");',
        "  source.run();",
        "}",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expectUnknown(graph, "f");
  });

  it("REFUSES an alias of a reassigned require binding", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        "function f() {",
        '  let a = require("pkg-a");',
        '  a = require("pkg-b");',
        "  const b = a;",
        "  b.run();",
        "}",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expectUnknown(graph, "f");
  });

  it("still resolves a STABLE require alias (alias support is not broadened or withdrawn)", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        "function f() {",
        '  const a = require("pkg");',
        "  const b = a;",
        "  b.run();",
        "}",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "f"))).toContain(
      path.join("node_modules", "pkg"),
    );
  });

  it("REFUSES a reassigned source feeding a destructuring", async () => {
    const root = twoPackageProject();
    const entry = write(
      root,
      "index.js",
      [
        "function f() {",
        '  let source = require("pkg-a");',
        '  source = require("pkg-b");',
        "  const { run } = source;",
        "  run();",
        "}",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expectUnknown(graph, "f");
  });
});

/**
 * RWF-046 § 22-23. Two installs of the SAME package name at the SAME
 * version, one nested. Both publish a `parse`, so the ONLY thing that
 * distinguishes the right answer from the wrong one is the install path
 * -- which is exactly what a name-keyed import table throws away.
 *
 * These go beyond P1-B3 § 18's controls in the one dimension RWF-046 is
 * about: the require is FUNCTION-LOCAL, and the local name is the same
 * in both functions.
 */
describe("RWF-046 § H: exact PackageInstance under local require bindings", () => {
  function pkgJson(name: string): string {
    return JSON.stringify({ name, version: "1.0.0", main: "index.js" });
  }

  function writeTwin(root: string, dir: string): void {
    write(root, `${dir}/package.json`, pkgJson("vuln-pkg"));
    write(
      root,
      `${dir}/index.js`,
      "function parse(x) { return x; }\nexports.parse = parse;\n",
    );
  }

  function twinProject(): string {
    const root = tempProject();
    writeTwin(root, "node_modules/vuln-pkg");
    writeTwin(root, "node_modules/wrapper/node_modules/vuln-pkg");
    write(root, "node_modules/wrapper/package.json", pkgJson("wrapper"));
    return root;
  }

  /** Every install path a resolved `parse` edge was attributed to. */
  function attributedParseModules(graph: CallGraph): string[] {
    return graph.edges
      .filter((e) => e.resolution.kind === "resolved")
      .map((e) =>
        graph.nodes.find(
          (n) =>
            e.resolution.kind === "resolved" && n.id === e.resolution.target,
        ),
      )
      .filter((n): n is GraphNode => n?.name === "parse")
      .map((n) => n.module);
  }

  it("a FUNCTION-LOCAL require resolves to the wrapper's own nested install", async () => {
    const root = twinProject();
    write(
      root,
      "node_modules/wrapper/index.js",
      [
        "function run(x) {",
        '  const dep = require("vuln-pkg");',
        "  return dep.parse(x);",
        "}",
        "exports.run = run;",
      ].join("\n"),
    );
    const entry = write(
      root,
      "src/app.js",
      [
        'const wrapper = require("wrapper");',
        "function main(input) { return wrapper.run(input); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    const nestedDir =
      path.join(root, "node_modules", "wrapper", "node_modules", "vuln-pkg") +
      path.sep;
    const topDir = path.join(root, "node_modules", "vuln-pkg") + path.sep;
    const attributed = attributedParseModules(graph);

    // Borrow check first: a collapsed instance identity names the sibling.
    expect(attributed.filter((m) => m.startsWith(topDir))).toEqual([]);
    expect(
      attributed.filter((m) => m.startsWith(nestedDir)).length,
    ).toBeGreaterThan(0);
  });

  it("the SAME local name in two functions keeps two different installs apart", async () => {
    const root = twinProject();
    write(root, "node_modules/wrapper/index.js", "exports.unused = 1;\n");
    const nestedSpecifier =
      "./node_modules/wrapper/node_modules/vuln-pkg/index.js";
    const entry = write(
      root,
      "app.js",
      [
        "function usesTop() {",
        '  const dep = require("vuln-pkg");',
        "  return dep.parse(1);",
        "}",
        "function usesNested() {",
        `  const dep = require(${JSON.stringify(nestedSpecifier)});`,
        "  return dep.parse(1);",
        "}",
        "module.exports = { usesTop, usesNested };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    const nestedDir =
      path.join(root, "node_modules", "wrapper", "node_modules", "vuln-pkg") +
      path.sep;
    const topDir = path.join(root, "node_modules", "vuln-pkg") + path.sep;

    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "usesTop"))).toContain(
      topDir,
    );
    expect(
      resolvedModuleOf(graph, soleEdgeFrom(graph, "usesNested")),
    ).toContain(nestedDir);
  });
});

/**
 * RWF-046 § 28-29. The two verdict-facing directions of the same
 * collapse, at the call-graph level where the target is decided.
 *
 * The import table's first-match rule is direction-blind: whichever
 * require was written first wins. So the same defect fabricates a path
 * into a vulnerable module in one arrangement and hides one in the
 * other, and a fix demonstrated on only one of them has not been shown
 * to be a fix at all.
 */
describe("RWF-046 § I: false-AFFECTED and false-NOT_AFFECTED oracles", () => {
  function twoModuleProject(): string {
    const root = tempProject();
    for (const name of ["vulnerable-mod", "safe-mod"]) {
      write(
        root,
        `node_modules/${name}/package.json`,
        JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
      );
      write(
        root,
        `node_modules/${name}/index.js`,
        "function run() {}\nmodule.exports = { run };\n",
      );
    }
    return root;
  }

  it("FALSE AFFECTED: an outer vulnerable require must not be attributed to an inner safe call", async () => {
    const root = twoModuleProject();
    const entry = write(
      root,
      "index.js",
      [
        'const source = require("vulnerable-mod");',
        "function f() {",
        '  const source = require("safe-mod");',
        "  source.run();",
        "}",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    const module = resolvedModuleOf(graph, soleEdgeFrom(graph, "f"));
    expect(module).toContain(path.join("node_modules", "safe-mod"));
    expect(module).not.toContain(path.join("node_modules", "vulnerable-mod"));
  });

  it("FALSE NOT_AFFECTED: an outer safe require must not hide an inner vulnerable call", async () => {
    const root = twoModuleProject();
    const entry = write(
      root,
      "index.js",
      [
        'const source = require("safe-mod");',
        "function f() {",
        '  const source = require("vulnerable-mod");',
        "  source.run();",
        "}",
        "module.exports = { f };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    const module = resolvedModuleOf(graph, soleEdgeFrom(graph, "f"));
    // Fully authoritative here -- exact declaration, exact literal
    // specifier -- so the honest answer is the vulnerable target, not an
    // UNKNOWN and certainly not the safe one.
    expect(module).toContain(path.join("node_modules", "vulnerable-mod"));
    expect(module).not.toContain(path.join("node_modules", "safe-mod"));
  });
});
