import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallGraph, GraphNode, GraphNodeId } from "../domain/graph.js";
import { buildCallGraph } from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";

/**
 * P1-B3b -- DIRECT-CALL BINDING AUTHORITY (RWF-043).
 *
 * One rule, asserted from every direction this file can reach it: a bare
 * identifier resolves to a local callable or constructable target ONLY
 * when the analyzer can name the exact lexical declaration the reference
 * denotes. Anything less is UNKNOWN.
 *
 * WHAT WAS WRONG. `findLocalFunctionNodeId` decided a call edge with
 *
 *     prepared.index.functions.find((fn) => fn.name === callee.text)
 *
 * -- identifier TEXT against a flat, whole-file, first-match-wins index of
 * every function-like node in the file. That index is not a scope. It
 * cannot see a parameter that shadows the name, a block `let` that
 * shadows it, a catch binding, a nested or sibling duplicate, a class
 * method that was never in scope at all, or a `let` that is reassigned
 * before the call runs. In each of those shapes the matcher returned a
 * function the program does not call, and the graph gained an edge that
 * does not exist.
 *
 * WHY A FABRICATED EDGE IS A SOUNDNESS DEFECT, not merely noise. The
 * inherited claim -- recorded in RWF-042/RWF-043 and corrected by this
 * block -- was that an invented edge can only ADD reachability and so
 * could never produce a false NOT_AFFECTED. That is false. The matcher
 * does not add an edge beside the honest one; it REPLACES it. A call the
 * analyzer genuinely cannot attribute is an `unknown` edge, and an
 * `unknown` edge inside the reachable subgraph is exactly what withholds
 * `reachableSubgraphComplete`. Resolving that same call to a borrowed
 * local function displaces the blocker: the subgraph now looks
 * exhaustively searched, Family C certifies it, and the verdict becomes
 * NOT_AFFECTED on a path the analyzer never actually followed. The
 * end-to-end reproduction of that mechanism lives in
 * `src/analysis/verdict.direct-call-binding-authority.integration.test.ts`;
 * this file pins the graph-level fabrications that feed it.
 *
 * Every test under "fabricated" fails on the P1-B3 base (779e219).
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

async function graphForSource(source: string): Promise<CallGraph> {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-b3b-"));
  tempDirs.push(root);
  const entry = path.join(root, "src/index.js");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, source);
  const resolver = createModuleResolver(loadTsProject(root));
  return buildCallGraph({ entryFiles: [entry], resolver });
}

/**
 * Every node id anything in the graph resolves a call TO. Deliberately
 * graph-wide and caller-agnostic: a fabricated edge that reappears under
 * a different `from` is still a fabricated edge, and an assertion scoped
 * to one caller could not see it.
 */
function resolvedTargets(graph: CallGraph): Set<GraphNodeId> {
  const targets = new Set<GraphNodeId>();
  for (const edge of graph.edges) {
    if (edge.resolution.kind === "resolved") {
      targets.add(edge.resolution.target);
    }
  }
  return targets;
}

function nodesNamed(graph: CallGraph, name: string): GraphNode[] {
  return graph.nodes.filter((node) => node.name === name);
}

/**
 * The one node named `name`, asserting there is exactly one so a test can
 * never silently assert about the wrong twin.
 */
function soleNodeNamed(graph: CallGraph, name: string): GraphNode {
  const found = nodesNamed(graph, name);
  expect(
    found,
    `expected exactly one graph node named ${name}, found ${found.length}`,
  ).toHaveLength(1);
  return found[0] as GraphNode;
}

/** The node named `name` that is declared on 1-based source line `line`. */
function nodeNamedAtLine(
  graph: CallGraph,
  name: string,
  line: number,
): GraphNode {
  const found = nodesNamed(graph, name).filter(
    (node) => node.location?.line === line,
  );
  expect(
    found,
    `expected exactly one node named ${name} at line ${line}`,
  ).toHaveLength(1);
  return found[0] as GraphNode;
}

/** Nothing anywhere in the graph calls into this node. */
function expectNeverResolvedTo(graph: CallGraph, node: GraphNode): void {
  expect(
    resolvedTargets(graph).has(node.id),
    `no call may resolve to ${node.name ?? node.id}`,
  ).toBe(false);
}

/** Something in the graph calls into this node. */
function expectResolvedTo(graph: CallGraph, node: GraphNode): void {
  expect(
    resolvedTargets(graph).has(node.id),
    `expected a call resolved to ${node.name ?? node.id}`,
  ).toBe(true);
}

describe("P1-B3b fabricated direct-call edges: lexical shadowing", () => {
  it("A. an object-destructured parameter is not the outer arrow", async () => {
    const graph = await graphForSource(
      ["const a = () => {};", "function f({ a }) {", "  a();", "}", ""].join(
        "\n",
      ),
    );
    // The arrow takes its name from the binding it initializes, so the
    // flat index holds a function literally named `a` for the matcher to
    // latch onto -- which is the whole shape.
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "a"));
  });

  it("B. an object-destructured parameter is not the outer function expression", async () => {
    const graph = await graphForSource(
      [
        "const a = function () {};",
        "function f({ a }) {",
        "  a();",
        "}",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "a"));
  });

  it("C. a plain parameter is not the outer arrow", async () => {
    // `f` is deliberately never called: VT-210 resolves a parameter call
    // from the enclosing function's own call sites, and this test is
    // about the matcher, not about VT-210's separate (and legitimate)
    // authority.
    const graph = await graphForSource(
      ["const a = () => {};", "function f(a) {", "  a();", "}", ""].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "a"));
  });

  it("D. a block `let` shadows the outer function declaration", async () => {
    const graph = await graphForSource(
      [
        "function a() {}",
        "function main(param) {",
        "  {",
        "    let a = param;",
        "    a();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "a"));
  });

  it("E. a named function expression's self-name does not exist outside its body", async () => {
    const graph = await graphForSource(
      [
        "const x = function inner() {};",
        "function main() {",
        "  inner();",
        "}",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "inner"));
  });

  it("F. a nested duplicate shadows the outer function of the same name", async () => {
    const graph = await graphForSource(
      [
        "function a() {}",
        "function main() {",
        "  function a() {}",
        "  a();",
        "}",
        "",
      ].join("\n"),
    );
    // Both the fabrication and its positive half: the OUTER `a` (line 1)
    // must never be called, and the INNER `a` (line 3) must be.
    expectNeverResolvedTo(graph, nodeNamedAtLine(graph, "a", 1));
    expectResolvedTo(graph, nodeNamedAtLine(graph, "a", 3));
  });

  it("G. a sibling scope's declaration is not in scope here", async () => {
    const graph = await graphForSource(
      [
        "function one() {",
        "  function a() {}",
        "  return a;",
        "}",
        "function two() {",
        "  a();",
        "}",
        "",
      ].join("\n"),
    );
    const inner = nodeNamedAtLine(graph, "a", 2);
    const two = soleNodeNamed(graph, "two");
    const fromTwo = graph.edges.filter((edge) => edge.from === two.id);
    expect(
      fromTwo.every(
        (edge) =>
          edge.resolution.kind !== "resolved" ||
          edge.resolution.target !== inner.id,
      ),
      "`two` cannot see a function declared inside `one`",
    ).toBe(true);
  });

  it("H. a catch-clause binding shadows the outer function", async () => {
    const graph = await graphForSource(
      [
        "function a() {}",
        "function main() {",
        "  try {",
        "  } catch (a) {",
        "    a();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "a"));
  });

  it("I. a class method was never in scope for a bare call", async () => {
    const graph = await graphForSource(
      [
        "class Thing {",
        "  helper() {}",
        "}",
        "function main() {",
        "  helper();",
        "}",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "helper"));
  });

  it("J. a reassigned binding holds no single authoritative value", async () => {
    const graph = await graphForSource(
      [
        "let a = () => {};",
        "function assign(p) {",
        "  a = p;",
        "}",
        "function caller() {",
        "  a();",
        "}",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "a"));
  });

  it("K. `new` on a name a parameter shadows is not the outer class", async () => {
    const graph = await graphForSource(
      [
        "class Thing {",
        "  constructor() {}",
        "}",
        "function main(Thing) {",
        "  return new Thing();",
        "}",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "Thing"));
  });

  it("a declaration with no initializer rescues nothing", async () => {
    const graph = await graphForSource(
      [
        "function main() {",
        "  let a;",
        "  a();",
        "}",
        "const a = () => {};",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "a"));
  });

  it("a name with no declaration anywhere resolves to nothing", async () => {
    const graph = await graphForSource(
      ["function main() {", "  nowhere();", "}", ""].join("\n"),
    );
    expect(nodesNamed(graph, "nowhere")).toHaveLength(0);
    const main = soleNodeNamed(graph, "main");
    expect(
      graph.edges
        .filter((edge) => edge.from === main.id)
        .every((edge) => edge.resolution.kind === "unknown"),
    ).toBe(true);
  });
});

describe("P1-B3b positive controls: authority that must be preserved", () => {
  it("a local function declaration still resolves", async () => {
    const graph = await graphForSource(
      [
        "function target() {}",
        "function main() {",
        "  target();",
        "}",
        "",
      ].join("\n"),
    );
    expectResolvedTo(graph, soleNodeNamed(graph, "target"));
  });

  it("a stable function-expression binding still resolves", async () => {
    const graph = await graphForSource(
      [
        "const target = function () {};",
        "function main() {",
        "  target();",
        "}",
        "",
      ].join("\n"),
    );
    expectResolvedTo(graph, soleNodeNamed(graph, "target"));
  });

  it("a stable arrow binding still resolves", async () => {
    const graph = await graphForSource(
      [
        "const target = () => {};",
        "function main() {",
        "  target();",
        "}",
        "",
      ].join("\n"),
    );
    expectResolvedTo(graph, soleNodeNamed(graph, "target"));
  });

  it("an alias to a stable callable still resolves", async () => {
    const graph = await graphForSource(
      [
        "function target() {}",
        "const alias = target;",
        "function main() {",
        "  alias();",
        "}",
        "",
      ].join("\n"),
    );
    expectResolvedTo(graph, soleNodeNamed(graph, "target"));
  });
});

describe("P1-B3b local class authority", () => {
  it("`new LocalClass()` resolves to the class's explicit constructor", async () => {
    const graph = await graphForSource(
      [
        "class Thing {",
        "  constructor() {}",
        "}",
        "function main() {",
        "  return new Thing();",
        "}",
        "",
      ].join("\n"),
    );
    expectResolvedTo(graph, soleNodeNamed(graph, "Thing"));
  });

  it("`new LocalClass()` resolves to a synthesized implicit constructor", async () => {
    const graph = await graphForSource(
      [
        "class Thing {}",
        "function main() {",
        "  return new Thing();",
        "}",
        "",
      ].join("\n"),
    );
    expectResolvedTo(graph, soleNodeNamed(graph, "Thing"));
  });

  it("an inner class shadows an outer class of the same name", async () => {
    const graph = await graphForSource(
      [
        "class Thing {",
        "  constructor() {}",
        "}",
        "function main() {",
        "  {",
        "    class Thing {",
        "      constructor() {}",
        "    }",
        "    return new Thing();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    // The outer class's constructor is on line 2, the inner one's on 7.
    expectNeverResolvedTo(graph, nodeNamedAtLine(graph, "Thing", 2));
    expectResolvedTo(graph, nodeNamedAtLine(graph, "Thing", 7));
  });

  it("a reassigned class binding is not authoritative", async () => {
    const graph = await graphForSource(
      [
        "class Thing {",
        "  constructor() {}",
        "}",
        "function swap(other) {",
        "  Thing = other;",
        "}",
        "function main() {",
        "  return new Thing();",
        "}",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "Thing"));
  });
});

describe("P1-B3b named function-expression self-reference", () => {
  it("the self-name resolves to the expression itself from inside its body", async () => {
    const graph = await graphForSource(
      [
        "const outer = function inner(n) {",
        "  if (n) {",
        "    return inner(n - 1);",
        "  }",
        "  return n;",
        "};",
        "",
      ].join("\n"),
    );
    expectResolvedTo(graph, soleNodeNamed(graph, "inner"));
  });

  it("the self-name wins over an outer binding of the same name", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const inner = danger;",
        "const x = function inner(n) {",
        "  if (n) {",
        "    return inner(n - 1);",
        "  }",
        "  return n;",
        "};",
        "",
      ].join("\n"),
    );
    expectResolvedTo(graph, soleNodeNamed(graph, "inner"));
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "danger"));
  });

  it("the self-name does not leak into a sibling function", async () => {
    const graph = await graphForSource(
      [
        "const outer = function inner(n) {",
        "  return n;",
        "};",
        "function main() {",
        "  return inner(1);",
        "}",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "inner"));
  });
});
