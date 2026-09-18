import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallGraph, GraphNode, GraphNodeId } from "../domain/graph.js";
import { buildCallGraph } from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";

/**
 * RWF-045 -- DESTRUCTURED BINDING SOURCE AUTHORITY.
 *
 * One rule, asserted from every direction this file can reach it: a
 * destructured binding resolves to a source ONLY through the exact
 * `BindingElement` the reference denotes and the exact initializer of the
 * declaration that owns it. Anything less is UNKNOWN.
 *
 * WHAT WAS WRONG. `resolveNamedCalleeBinding` asks the binding model about
 * a callee, and one refusal -- `destructuring` -- is deliberately routed
 * onward rather than treated as final, because the call graph has its own
 * machinery for that shape. But that machinery selected the pattern by
 * NAME:
 *
 *     findDestructuredBindingSource(callee.text, prepared.index.sourceFile)
 *
 * which walked the whole file and took the FIRST
 * `const { <name> } = src` it met, at any depth, in any scope. The gate in
 * front of it does not save it: `resolveNamedBinding` proves the reference
 * binds to *a* destructuring in its innermost declaring scope, but says
 * nothing about WHICH pattern, and the name-keyed search that answered
 * that question crossed scopes freely. Declaration authority stopped one
 * step short of the answer.
 *
 * WHY A FABRICATED EDGE IS A SOUNDNESS DEFECT, not merely noise. Same
 * mechanism RWF-043 corrected: the borrowed edge does not sit BESIDE the
 * honest one, it REPLACES it. A call the analyzer genuinely cannot
 * attribute is an `unknown` edge, and an `unknown` edge inside the
 * reachable subgraph is exactly what withholds `reachableSubgraphComplete`.
 * Resolving that same call to a borrowed source displaces the blocker. The
 * end-to-end reproduction of that consequence lives in
 * `src/analysis/verdict.destructured-binding-source-authority.integration.test.ts`;
 * this file pins the graph-level fabrications that feed it.
 *
 * Every test under "fabricated" fails on the merged base `b9bb81b`.
 *
 * SCOPE. This file is about pattern SELECTION, not about broadening what
 * the destructuring bridge supports. Array patterns, nested patterns and
 * defaulted elements were unsupported before and are asserted UNKNOWN here
 * for exactly that reason -- the assertions pin the refusal, they do not
 * request the feature (RWF-045 § 16-17).
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-rwf045-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

/**
 * A project whose `src/index.js` is `source`, beside a `safe.js` and a
 * `danger.js` that each export a function named `run`. The two same-named
 * callables in two modules are the whole point: an assertion that only
 * checked "something resolved" would pass just as happily against the
 * wrong one.
 */
async function graphForIndex(source: string): Promise<CallGraph> {
  const root = tempProject();
  write(
    root,
    "src/safe.js",
    `function run() {\n  return "safe";\n}\nmodule.exports = { run };\n`,
  );
  write(
    root,
    "src/danger.js",
    `function run() {\n  return "danger";\n}\nmodule.exports = { run };\n`,
  );
  const entry = write(root, "src/index.js", source);
  const resolver = createModuleResolver(loadTsProject(root));
  return buildCallGraph({ entryFiles: [entry], resolver });
}

/** Every node id anything in the graph resolves a call TO. */
function resolvedTargets(graph: CallGraph): Set<GraphNodeId> {
  const targets = new Set<GraphNodeId>();
  for (const edge of graph.edges) {
    if (edge.resolution.kind === "resolved") {
      targets.add(edge.resolution.target);
    }
  }
  return targets;
}

/** The node for the function named `name` declared in module file `file`. */
function nodeIn(graph: CallGraph, file: string, name: string): GraphNode {
  const found = graph.nodes.filter(
    (node) => node.name === name && node.module.endsWith(file),
  );
  expect(
    found,
    `expected exactly one node named ${name} in ${file}, found ${found.length}`,
  ).toHaveLength(1);
  return found[0] as GraphNode;
}

/** The node named `name` in index.js, declared on 1-based line `line`. */
function indexNodeAtLine(
  graph: CallGraph,
  name: string,
  line: number,
): GraphNode {
  const found = graph.nodes.filter(
    (node) =>
      node.name === name &&
      node.module.endsWith("index.js") &&
      node.location?.line === line,
  );
  expect(
    found,
    `expected exactly one node named ${name} at index.js:${line}`,
  ).toHaveLength(1);
  return found[0] as GraphNode;
}

/** Nothing anywhere in the graph resolves a call into this node. */
function expectNeverResolvedTo(graph: CallGraph, node: GraphNode): void {
  expect(
    resolvedTargets(graph).has(node.id),
    `no call should resolve to ${node.name} (${node.module})`,
  ).toBe(false);
}

/** The single call edge leaving the function node `from`. */
function soleEdgeFrom(graph: CallGraph, from: GraphNode) {
  const edges = graph.edges.filter(
    (edge) => edge.from === from.id && edge.type !== "module_load",
  );
  expect(
    edges,
    `expected exactly one call edge from ${from.name}`,
  ).toHaveLength(1);
  return edges[0];
}

/** The call in `from` resolves to exactly `target`. */
function expectResolvesTo(
  graph: CallGraph,
  from: GraphNode,
  target: GraphNode,
): void {
  const edge = soleEdgeFrom(graph, from);
  expect(edge?.resolution.kind).toBe("resolved");
  if (edge?.resolution.kind === "resolved") {
    expect(edge.resolution.target).toBe(target.id);
  }
}

/** The call in `from` stays unresolved -- the fail-closed outcome. */
function expectUnresolved(graph: CallGraph, from: GraphNode): void {
  const edge = soleEdgeFrom(graph, from);
  expect(edge?.resolution.kind).toBe("unknown");
}

// ====================================================================
// 1. THE FABRICATION -- the RWF-045 reproduction itself
// ====================================================================

describe("fabricated: a destructuring pattern selected by name", () => {
  /**
   * THE RECORDED AUDIT SHAPE, reproduced verbatim from the RWF-045 record.
   *
   * `main` destructures `run` from `safeMod` and calls it. `outer`
   * destructures `run` from `dangerMod` and merely returns it -- it is
   * written FIRST, so it is what a whole-file first-match search finds.
   * On the base, `main`'s edge lands on `danger.js#run`.
   */
  it("does not borrow an earlier same-named pattern from a sibling scope", async () => {
    const graph = await graphForIndex(
      [
        `const dangerMod = require("./danger.js");`,
        `const safeMod = require("./safe.js");`,
        ``,
        `function outer() {`,
        `  const { run } = dangerMod;`,
        `  return run;`,
        `}`,
        ``,
        `function main() {`,
        `  const { run } = safeMod;`,
        `  return run();`,
        `}`,
        ``,
        `module.exports = { main, outer };`,
      ].join("\n"),
    );

    const main = nodeIn(graph, "index.js", "main");
    const safeRun = nodeIn(graph, "safe.js", "run");
    const dangerRun = nodeIn(graph, "danger.js", "run");

    // The fabricated edge, pinned exactly.
    expectNeverResolvedTo(graph, dangerRun);
    // The honest one, which the fabrication had REPLACED.
    expectResolvesTo(graph, main, safeRun);
  });

  /**
   * The same fabrication with the file order reversed, so that a fix which
   * merely reordered the scan (rather than binding to the declaration)
   * still fails one of the two.
   */
  it("does not borrow a later same-named pattern either", async () => {
    const graph = await graphForIndex(
      [
        `const dangerMod = require("./danger.js");`,
        `const safeMod = require("./safe.js");`,
        ``,
        `function main() {`,
        `  const { run } = safeMod;`,
        `  return run();`,
        `}`,
        ``,
        `function outer() {`,
        `  const { run } = dangerMod;`,
        `  return run;`,
        `}`,
        ``,
        `module.exports = { main, outer };`,
      ].join("\n"),
    );

    expectNeverResolvedTo(graph, nodeIn(graph, "danger.js", "run"));
    expectResolvesTo(
      graph,
      nodeIn(graph, "index.js", "main"),
      nodeIn(graph, "safe.js", "run"),
    );
  });
});

// ====================================================================
// 2. SCOPE AND SHADOWING -- declaration identity decides
// ====================================================================

describe("scope: the exact declaration owns the reference", () => {
  it("resolves object destructuring to its own source", async () => {
    const graph = await graphForIndex(
      [
        `const safe = require("./safe.js");`,
        ``,
        `function main() {`,
        `  const { run } = safe;`,
        `  return run();`,
        `}`,
        ``,
        `module.exports = { main };`,
      ].join("\n"),
    );

    expectResolvesTo(
      graph,
      nodeIn(graph, "index.js", "main"),
      nodeIn(graph, "safe.js", "run"),
    );
  });

  /**
   * NESTED SCOPES. The inner `run` shadows the outer one; the inner call
   * belongs to the inner declaration, and the outer source must not be
   * borrowed for it.
   */
  it("gives an inner destructuring precedence over an outer same-named one", async () => {
    const graph = await graphForIndex(
      [
        `const safeA = require("./safe.js");`,
        `const safeB = require("./danger.js");`,
        ``,
        `const { run } = safeA;`,
        ``,
        `function f() {`,
        `  const { run } = safeB;`,
        `  return run();`,
        `}`,
        ``,
        `function g() {`,
        `  return run();`,
        `}`,
        ``,
        `module.exports = { f, g };`,
      ].join("\n"),
    );

    // Inner reference -> inner source (danger.js, here playing "safeB").
    expectResolvesTo(
      graph,
      nodeIn(graph, "index.js", "f"),
      nodeIn(graph, "danger.js", "run"),
    );
    // Outer reference -> outer source.
    expectResolvesTo(
      graph,
      nodeIn(graph, "index.js", "g"),
      nodeIn(graph, "safe.js", "run"),
    );
  });

  /**
   * SIBLING SCOPES. Neither function encloses the other, so neither
   * declaration is in scope at the other's call -- no contamination in
   * either direction, whichever is written first.
   */
  it("keeps sibling scopes' same-named destructurings apart", async () => {
    const graph = await graphForIndex(
      [
        `const sourceA = require("./safe.js");`,
        `const sourceB = require("./danger.js");`,
        ``,
        `function a() {`,
        `  const { run } = sourceA;`,
        `  return run();`,
        `}`,
        ``,
        `function b() {`,
        `  const { run } = sourceB;`,
        `  return run();`,
        `}`,
        ``,
        `module.exports = { a, b };`,
      ].join("\n"),
    );

    expectResolvesTo(
      graph,
      nodeIn(graph, "index.js", "a"),
      nodeIn(graph, "safe.js", "run"),
    );
    expectResolvesTo(
      graph,
      nodeIn(graph, "index.js", "b"),
      nodeIn(graph, "danger.js", "run"),
    );
  });

  /**
   * PARAMETER SHADOWING. The call belongs to the parameter, whose value is
   * a caller's argument -- never to the outer destructured binding. The
   * outer source must not be borrowed; what the parameter itself resolves
   * to is VT-210's question, not this one, so this asserts only that
   * `safe.js#run` is not reached through the shadowed name.
   */
  it("lets a parameter shadow an outer destructured binding", async () => {
    const graph = await graphForIndex(
      [
        `const safe = require("./safe.js");`,
        ``,
        `const { run } = safe;`,
        ``,
        `function f(run) {`,
        `  return run();`,
        `}`,
        ``,
        `module.exports = { f };`,
      ].join("\n"),
    );

    expectNeverResolvedTo(graph, nodeIn(graph, "safe.js", "run"));
  });

  /**
   * BLOCK SHADOWING. A block-scoped `const` owns the reference inside its
   * block. `other` is not a resolvable callable here, so the honest answer
   * is UNKNOWN -- and specifically NOT the outer destructured source.
   */
  it("lets a block const shadow an outer destructured binding", async () => {
    const graph = await graphForIndex(
      [
        `const safe = require("./safe.js");`,
        `const other = require("./danger.js");`,
        ``,
        `const { run } = safe;`,
        ``,
        `function f() {`,
        `  {`,
        `    const run = other;`,
        `    return run();`,
        `  }`,
        `}`,
        ``,
        `module.exports = { f };`,
      ].join("\n"),
    );

    expectNeverResolvedTo(graph, nodeIn(graph, "safe.js", "run"));
  });
});

// ====================================================================
// 3. PROPERTY KEY vs LOCAL BINDING NAME
// ====================================================================

describe("renaming: the property key is not the local name", () => {
  /**
   * `{ run: execute }` binds `execute` and reads the property `run`. Both
   * halves are asserted, because confusing them in either direction is a
   * distinct defect: taking `run` as the local name would resolve a call
   * that the program never makes, and taking `execute` as the property key
   * would look up a member that does not exist.
   */
  it("resolves a renamed binding through its property key", async () => {
    const graph = await graphForIndex(
      [
        `const safe = require("./safe.js");`,
        ``,
        `function main() {`,
        `  const { run: execute } = safe;`,
        `  return execute();`,
        `}`,
        ``,
        `module.exports = { main };`,
      ].join("\n"),
    );

    expectResolvesTo(
      graph,
      nodeIn(graph, "index.js", "main"),
      nodeIn(graph, "safe.js", "run"),
    );
  });

  /**
   * The mirror image: after `const { run: execute } = safe`, the name
   * `run` is NOT bound at all. A call to it must not resolve merely
   * because `run` appears as a property key in the pattern.
   */
  it("does not bind the property key as a local name", async () => {
    const graph = await graphForIndex(
      [
        `const safe = require("./safe.js");`,
        ``,
        `function main() {`,
        `  const { run: execute } = safe;`,
        `  execute;`,
        `  return run();`,
        `}`,
        ``,
        `module.exports = { main };`,
      ].join("\n"),
    );

    expectNeverResolvedTo(graph, nodeIn(graph, "safe.js", "run"));
  });

  /**
   * SAME FILE, SEPARATE SOURCES -- the minimal adversarial control. Two
   * renamed bindings off the same property name, in one scope, from two
   * different modules. Each must resolve independently.
   */
  it("keeps two renamed bindings off the same key independent", async () => {
    const graph = await graphForIndex(
      [
        `const sourceA = require("./safe.js");`,
        `const sourceB = require("./danger.js");`,
        ``,
        `const { run: runA } = sourceA;`,
        `const { run: runB } = sourceB;`,
        ``,
        `function a() {`,
        `  return runA();`,
        `}`,
        ``,
        `function b() {`,
        `  return runB();`,
        `}`,
        ``,
        `module.exports = { a, b };`,
      ].join("\n"),
    );

    expectResolvesTo(
      graph,
      nodeIn(graph, "index.js", "a"),
      nodeIn(graph, "safe.js", "run"),
    );
    expectResolvesTo(
      graph,
      nodeIn(graph, "index.js", "b"),
      nodeIn(graph, "danger.js", "run"),
    );
  });
});

// ====================================================================
// 4. DECLARATION KIND AND STABILITY -- fail closed
// ====================================================================

describe("stability: a rebindable destructured name resolves to nothing", () => {
  /**
   * `let` is not `const`. The binding can be reassigned between the
   * destructuring and the call, and this module cannot prove it was not,
   * so the destructured provenance must not survive. Asserted with an
   * actual intervening assignment, which is the shape that makes the stale
   * provenance wrong rather than merely unproven.
   */
  it("withholds provenance from a reassigned let destructuring", async () => {
    const graph = await graphForIndex(
      [
        `const safe = require("./safe.js");`,
        `const other = require("./danger.js");`,
        ``,
        `function main() {`,
        `  let { run } = safe;`,
        `  run = other.run;`,
        `  return run();`,
        `}`,
        ``,
        `module.exports = { main };`,
      ].join("\n"),
    );

    expectNeverResolvedTo(graph, nodeIn(graph, "safe.js", "run"));
    expectUnresolved(graph, nodeIn(graph, "index.js", "main"));
  });

  /** `var` carries the same rebindability, and the same refusal. */
  it("withholds provenance from a var destructuring", async () => {
    const graph = await graphForIndex(
      [
        `const safe = require("./safe.js");`,
        ``,
        `function main() {`,
        `  var { run } = safe;`,
        `  return run();`,
        `}`,
        ``,
        `module.exports = { main };`,
      ].join("\n"),
    );

    expectUnresolved(graph, nodeIn(graph, "index.js", "main"));
  });
});

// ====================================================================
// 5. PATTERN SHAPES THE BRIDGE DOES NOT MODEL -- UNKNOWN, never wrong
// ====================================================================

describe("boundaries: unmodeled pattern shapes stay UNKNOWN", () => {
  /**
   * A DEFAULTED element has two possible runtime values -- the source's
   * property, or the default -- and nothing here proves which one runs.
   * Mapping it unconditionally to `safe.run` would be a guess.
   */
  it("withholds provenance from a defaulted binding element", async () => {
    const graph = await graphForIndex(
      [
        `const safe = require("./safe.js");`,
        `const fallback = require("./danger.js").run;`,
        ``,
        `function main() {`,
        `  const { run = fallback } = safe;`,
        `  return run();`,
        `}`,
        ``,
        `module.exports = { main };`,
      ].join("\n"),
    );

    expectUnresolved(graph, nodeIn(graph, "index.js", "main"));
    expectNeverResolvedTo(graph, nodeIn(graph, "safe.js", "run"));
    expectNeverResolvedTo(graph, nodeIn(graph, "danger.js", "run"));
  });

  /**
   * A NESTED pattern's member path (`source.api.run`) is not modeled here,
   * and RWF-045 does not add it. The requirement is only that the
   * un-modeled shape yields UNKNOWN rather than a same-name attribution.
   */
  it("withholds provenance from a nested object pattern", async () => {
    const graph = await graphForIndex(
      [
        `const safe = require("./safe.js");`,
        ``,
        `function main() {`,
        `  const { api: { run } } = safe;`,
        `  return run();`,
        `}`,
        ``,
        `module.exports = { main };`,
      ].join("\n"),
    );

    expectUnresolved(graph, nodeIn(graph, "index.js", "main"));
    expectNeverResolvedTo(graph, nodeIn(graph, "safe.js", "run"));
  });

  /** An ARRAY pattern binds by position, which this bridge never modeled. */
  it("withholds provenance from an array pattern", async () => {
    const graph = await graphForIndex(
      [
        `const safe = require("./safe.js");`,
        ``,
        `function main() {`,
        `  const [run] = safe;`,
        `  return run();`,
        `}`,
        ``,
        `module.exports = { main };`,
      ].join("\n"),
    );

    expectUnresolved(graph, nodeIn(graph, "index.js", "main"));
    expectNeverResolvedTo(graph, nodeIn(graph, "safe.js", "run"));
  });

  /** A REST element holds the remaining properties, never one callable. */
  it("withholds provenance from a rest element", async () => {
    const graph = await graphForIndex(
      [
        `const safe = require("./safe.js");`,
        ``,
        `function main() {`,
        `  const { other, ...run } = safe;`,
        `  other;`,
        `  return run();`,
        `}`,
        ``,
        `module.exports = { main };`,
      ].join("\n"),
    );

    expectUnresolved(graph, nodeIn(graph, "index.js", "main"));
    expectNeverResolvedTo(graph, nodeIn(graph, "safe.js", "run"));
  });

  /**
   * A non-identifier SOURCE is NOT this bridge's shape at all.
   * `const { run } = require("./safe.js")` is a destructured REQUIRE,
   * which `source-index.ts` indexes as a first-class CommonJS import
   * binding long before the destructuring bridge is consulted -- so the
   * binding model reports `import_binding`, not `destructuring`, and the
   * existing import machinery resolves it.
   *
   * Pinned here as a boundary, not as a feature request: RWF-045 must
   * leave this honest edge exactly where it was. A remediation that
   * treated the `destructuring` refusal as final, or that broadened this
   * bridge to chase call-expression initializers, would be visible as a
   * change to THIS assertion.
   *
   * The separate, pre-existing defect in that import path -- two
   * FUNCTION-LOCAL requires binding the same local name to different
   * specifiers collapse onto the first, because the import table is keyed
   * by local name at file scope -- is recorded as RWF-046. It is not
   * destructuring-specific (the non-destructured `const mod = require(...)`
   * form collapses identically), so it is deliberately out of scope here
   * and is NOT fixed by this change.
   */
  it("leaves a destructured require to the import machinery", async () => {
    const graph = await graphForIndex(
      [
        `function main() {`,
        `  const { run } = require("./safe.js");`,
        `  return run();`,
        `}`,
        ``,
        `module.exports = { main };`,
      ].join("\n"),
    );

    expectResolvesTo(
      graph,
      nodeIn(graph, "index.js", "main"),
      nodeIn(graph, "safe.js", "run"),
    );
  });
});

// ====================================================================
// 6. THE SAME LOCAL NAME AT TWO POSITIONS IN ONE SCOPE CHAIN
// ====================================================================

describe("position: same name, two declarations, two sources", () => {
  /**
   * Two nested blocks in ONE function, each destructuring `run` from a
   * different module. Neither is in scope at the other's call, and source
   * order is not what decides -- declaration identity is.
   */
  it("resolves each block's binding to its own source", async () => {
    const graph = await graphForIndex(
      [
        `const sourceA = require("./safe.js");`,
        `const sourceB = require("./danger.js");`,
        ``,
        `function a() {`,
        `  {`,
        `    const { run } = sourceA;`,
        `    return run();`,
        `  }`,
        `}`,
        ``,
        `function b() {`,
        `  {`,
        `    const { run } = sourceB;`,
        `    return run();`,
        `  }`,
        `}`,
        ``,
        `module.exports = { a, b };`,
      ].join("\n"),
    );

    expectResolvesTo(
      graph,
      nodeIn(graph, "index.js", "a"),
      nodeIn(graph, "safe.js", "run"),
    );
    expectResolvesTo(
      graph,
      nodeIn(graph, "index.js", "b"),
      nodeIn(graph, "danger.js", "run"),
    );
  });

  /**
   * The line-level control for the fabrication: two `main`-like functions
   * whose nodes are distinguished by LINE, so the assertion cannot be
   * satisfied by the wrong twin.
   */
  it("attributes by declaration, not by source order", async () => {
    const graph = await graphForIndex(
      [
        `const sourceA = require("./danger.js");`,
        `const sourceB = require("./safe.js");`,
        ``,
        `function first() {`,
        `  const { run } = sourceA;`,
        `  return run;`,
        `}`,
        ``,
        `function second() {`,
        `  const { run } = sourceB;`,
        `  return run();`,
        `}`,
        ``,
        `module.exports = { first, second };`,
      ].join("\n"),
    );

    const second = indexNodeAtLine(graph, "second", 9);
    expectResolvesTo(graph, second, nodeIn(graph, "safe.js", "run"));
    expectNeverResolvedTo(graph, nodeIn(graph, "danger.js", "run"));
  });
});

// ====================================================================
// 7. PACKAGE INSTANCE IDENTITY
// ====================================================================

/**
 * Two INSTALLED INSTANCES of the same package name at the same version --
 * one top-level, one nested inside `wrapper` -- both exporting a function
 * named `run`.
 *
 * Every textual key a name-based lookup could use is identical here: the
 * local binding name, the property key, the package name, the version,
 * the exported member. The ONLY thing distinguishing the two targets is
 * which install the destructuring's source resolves to. An assertion that
 * merely checked "something named `run` resolved" would pass just as
 * happily against the wrong instance, which is the exact failure
 * SDD-v0.2.md § 4.2 exists to prevent.
 *
 * The destructuring lives inside `wrapper`, so the honest answer is
 * wrapper's OWN nested install.
 */
describe("instances: the source's exact install decides", () => {
  async function twinGraph(): Promise<CallGraph> {
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ name: "app" }));

    const libSource = (which: string): string =>
      `function run() {\n  return "${which}";\n}\nmodule.exports = { run };\n`;
    const libManifest = JSON.stringify({
      name: "lib",
      version: "1.0.0",
      main: "index.js",
    });

    // The TOP-LEVEL install -- the decoy.
    const topLib = ["node_modules", "lib"].join(path.sep);
    write(root, path.join(topLib, "package.json"), libManifest);
    write(root, path.join(topLib, "index.js"), libSource("outer"));

    // The NESTED install -- same name, same version, same export.
    const wrapper = ["node_modules", "wrapper"].join(path.sep);
    const nestedLib = [wrapper, "node_modules", "lib"].join(path.sep);
    write(root, path.join(nestedLib, "package.json"), libManifest);
    write(root, path.join(nestedLib, "index.js"), libSource("nested"));

    write(
      root,
      path.join(wrapper, "package.json"),
      JSON.stringify({ name: "wrapper", version: "1.0.0", main: "index.js" }),
    );
    write(
      root,
      path.join(wrapper, "index.js"),
      [
        `const lib = require("lib");`,
        `const { run } = lib;`,
        `function callIt() {`,
        `  return run();`,
        `}`,
        `module.exports = { callIt };`,
      ].join("\n"),
    );

    const entry = write(
      root,
      path.join("src", "index.js"),
      [
        `const wrapper = require("wrapper");`,
        `function main() {`,
        `  return wrapper.callIt();`,
        `}`,
        `module.exports = { main };`,
      ].join("\n"),
    );

    const resolver = createModuleResolver(loadTsProject(root));
    return buildCallGraph({ entryFiles: [entry], resolver });
  }

  it("resolves a destructuring to its own nested install, not the twin", async () => {
    const graph = await twinGraph();

    const callIt = graph.nodes.find(
      (node) => node.name === "callIt" && node.module.includes("wrapper"),
    );
    expect(callIt, "wrapper's callIt should be in the graph").toBeDefined();

    const edge = soleEdgeFrom(graph, callIt as GraphNode);
    expect(edge?.resolution.kind).toBe("resolved");
    if (edge?.resolution.kind !== "resolved") {
      return;
    }

    const targetId = edge.resolution.target;
    const target = graph.nodes.find((node) => node.id === targetId);
    expect(target?.name).toBe("run");
    expect(
      target?.module,
      "must be wrapper's OWN nested lib install, never the top-level twin",
    ).toContain(["wrapper", "node_modules", "lib"].join(path.sep));
  });
});
