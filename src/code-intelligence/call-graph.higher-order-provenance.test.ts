import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallGraph, GraphNode, GraphNodeId } from "../domain/graph.js";
import { buildCallGraph } from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";

/**
 * P1-B3b REMEDIATION -- VT-210's OWN TEXT AUTHORITY, and the class-call
 * boundary.
 *
 * P1-B3b removed the flat same-name matcher from the four direct-call
 * sites and then claimed no name-based fallback remained anywhere. An
 * independent audit found that claim false: VT-210's higher-order rescue
 * kept TWO text comparisons, each able to decide a call edge on its own.
 *
 * 1. WHICH NAME IS A PARAMETER.
 *
 *        enclosing.parameters.findIndex(
 *          (p) => ts.isIdentifier(p.name) && p.name.text === callee.text)
 *
 *    This asks whether a name SPELLS a parameter, not whether the
 *    reference BINDS to one. A block-scoped declaration shadowing a
 *    parameter's name still matches, so VT-210 would reinterpret a call
 *    to the inner declaration as a call to the parameter and redirect it
 *    to whatever the caller passed -- overriding a refusal the binding
 *    model had already issued. On the audited commit this made the graph
 *    WORSE than the flat matcher it replaced, which happened to get this
 *    shape right.
 *
 * 2. WHICH CALL SITES BELONG TO THE ENCLOSING FUNCTION.
 *
 *        node.expression.text === functionName
 *
 *    A whole-file search by name, so a DIFFERENT function of the same
 *    name in an unrelated scope donates its arguments.
 *
 * 3. AND HOW MANY TARGETS A PARAMETER MAY HAVE. VT-210 took the first
 *    resolvable identifier argument and ignored every other call site,
 *    including ones passing a different function, an inline function, or
 *    a call result. `lodash`'s `arrayMap` receives `baseToString` at one
 *    site and `castArrayLikeObject` at three others; the graph claimed
 *    `baseToString` because it is written first. A resolved edge
 *    SUPPRESSES the `unknown` blocker, so an arbitrary pick among real
 *    candidates is the RWF-043 displacement mechanism wearing a
 *    different hat.
 *
 * The rule enforced here: VT-210 may name a target only when the callee
 * binds to the enclosing function's exact parameter declaration AND every
 * authoritative call site of that exact declaration agrees on one
 * callable. Anything else is UNKNOWN.
 *
 * Separately, class authority must be CONSTRUCT-only. `Thing()` without
 * `new` throws a TypeError before the constructor body runs, so an edge
 * into that constructor describes an execution that cannot happen.
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
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-b3b-ho-"));
  tempDirs.push(root);
  const entry = path.join(root, "src/index.js");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, source);
  const resolver = createModuleResolver(loadTsProject(root));
  return buildCallGraph({ entryFiles: [entry], resolver });
}

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

function soleNodeNamed(graph: CallGraph, name: string): GraphNode {
  const found = nodesNamed(graph, name);
  expect(
    found,
    `expected exactly one node named ${name}, found ${found.length}`,
  ).toHaveLength(1);
  return found[0] as GraphNode;
}

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

function expectNeverResolvedTo(graph: CallGraph, node: GraphNode): void {
  expect(
    resolvedTargets(graph).has(node.id),
    `no call may resolve to ${node.name ?? node.id}`,
  ).toBe(false);
}

function expectResolvedTo(graph: CallGraph, node: GraphNode): void {
  expect(
    resolvedTargets(graph).has(node.id),
    `expected a call resolved to ${node.name ?? node.id}`,
  ).toBe(true);
}

describe("P1-B3b remediation: VT-210 binds the exact parameter declaration", () => {
  it("Q2. a nested declaration shadowing a parameter's NAME is not the parameter", async () => {
    // `fn()` binds the inner `function fn() {}`, not `invoke`'s parameter.
    // The binding model refuses this name (two declarations own it in
    // `invoke`'s scope), and VT-210 must NOT rescue that refusal by
    // spelling.
    const graph = await graphForSource(
      [
        "function vulnerable() {}",
        "function invoke(fn) {",
        "  {",
        "    function fn() {}",
        "    fn();",
        "  }",
        "}",
        "function main() { invoke(vulnerable); }",
        "module.exports = { main };",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "vulnerable"));
  });

  it("a block `let` shadowing a parameter's NAME is not the parameter", async () => {
    const graph = await graphForSource(
      [
        "function vulnerable() {}",
        "function safe() {}",
        "function invoke(fn, other) {",
        "  {",
        "    let fn = other;",
        "    fn();",
        "  }",
        "}",
        "function main() { invoke(vulnerable, safe); }",
        "module.exports = { main };",
        "",
      ].join("\n"),
    );
    // `fn` in the block is the inner `let`, whose value comes from the
    // OTHER parameter. Neither argument may be attributed here.
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "vulnerable"));
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "safe"));
  });

  it("a catch binding sharing a parameter's name is not the parameter", async () => {
    const graph = await graphForSource(
      [
        "function vulnerable() {}",
        "function invoke(fn) {",
        "  try {",
        "  } catch (fn) {",
        "    fn();",
        "  }",
        "}",
        "function main() { invoke(vulnerable); }",
        "module.exports = { main };",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "vulnerable"));
  });
});

describe("P1-B3b remediation: VT-210 argument provenance must be unique", () => {
  it("one target passed from several call sites still resolves", async () => {
    const graph = await graphForSource(
      [
        "function fnA() {}",
        "function apply(iteratee, value) {",
        "  return iteratee(value);",
        "}",
        "function main() {",
        "  apply(fnA, 1);",
        "  apply(fnA, 2);",
        "}",
        "module.exports = { main };",
        "",
      ].join("\n"),
    );
    expectResolvedTo(graph, soleNodeNamed(graph, "fnA"));
  });

  it("two DIFFERENT targets fail closed rather than picking the first", async () => {
    const graph = await graphForSource(
      [
        "function fnA() {}",
        "function fnB() {}",
        "function apply(iteratee, value) {",
        "  return iteratee(value);",
        "}",
        "function main() {",
        "  apply(fnA, 1);",
        "  apply(fnB, 2);",
        "}",
        "module.exports = { main };",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "fnA"));
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "fnB"));
  });

  it("a known target beside a CALL-RESULT argument fails closed", async () => {
    const graph = await graphForSource(
      [
        "function fnA() {}",
        "function getFn() { return fnA; }",
        "function apply(iteratee, value) {",
        "  return iteratee(value);",
        "}",
        "function main() {",
        "  apply(fnA, 1);",
        "  apply(getFn(), 2);",
        "}",
        "module.exports = { main };",
        "",
      ].join("\n"),
    );
    // `getFn()` could return anything; claiming `fnA` uniquely would be a
    // certainty the program does not support.
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "fnA"));
  });

  it("a known target beside an INLINE function argument fails closed", async () => {
    const graph = await graphForSource(
      [
        "function fnA() {}",
        "function apply(iteratee, value) {",
        "  return iteratee(value);",
        "}",
        "function main() {",
        "  apply(fnA, 1);",
        "  apply(function (x) { return x; }, 2);",
        "}",
        "module.exports = { main };",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "fnA"));
  });

  it("a REASSIGNED identifier argument fails closed", async () => {
    const graph = await graphForSource(
      [
        "function fnA() {}",
        "function fnB() {}",
        "let chosen = fnA;",
        "function swap() { chosen = fnB; }",
        "function apply(iteratee, value) {",
        "  return iteratee(value);",
        "}",
        "function main() {",
        "  apply(chosen, 1);",
        "}",
        "module.exports = { main, swap };",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "fnA"));
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "fnB"));
  });

  it("a recursive enclosing function passing its own parameter fails closed", async () => {
    const graph = await graphForSource(
      [
        "function fnA() {}",
        "function apply(iteratee, n) {",
        "  if (n > 0) {",
        "    return apply(iteratee, n - 1);",
        "  }",
        "  return iteratee(n);",
        "}",
        "function main() { return apply(fnA, 3); }",
        "module.exports = { main };",
        "",
      ].join("\n"),
    );
    // The recursive site passes the parameter itself, whose value is not
    // authoritative, so the whole provenance is refused. Terminating at
    // all is the other half of what this pins.
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "fnA"));
  });
});

describe("P1-B3b remediation: VT-210 call sites are matched by declaration", () => {
  it("a same-named function in a sibling scope does not donate arguments", async () => {
    const graph = await graphForSource(
      [
        "function vulnerable() {}",
        "function safe() {}",
        "function outer() {",
        "  function invoke(fn) { return fn(); }",
        "  return invoke(safe);",
        "}",
        "function invoke(fn) {",
        "  return fn();",
        "}",
        "function main() { return invoke(vulnerable); }",
        "module.exports = { main, outer };",
        "",
      ].join("\n"),
    );
    // The module-level `invoke` (line 7) is only ever called with
    // `vulnerable`; the inner `invoke` (line 4) is only ever called with
    // `safe`. Neither may read the other's call sites.
    const moduleInvoke = nodeNamedAtLine(graph, "invoke", 7);
    const innerInvoke = nodeNamedAtLine(graph, "invoke", 4);
    const vulnerable = soleNodeNamed(graph, "vulnerable");
    const safe = soleNodeNamed(graph, "safe");

    const from = (node: GraphNode): GraphNodeId[] =>
      graph.edges
        .filter((e) => e.from === node.id && e.resolution.kind === "resolved")
        .map((e) =>
          e.resolution.kind === "resolved" ? e.resolution.target : "",
        );

    expect(from(moduleInvoke)).toContain(vulnerable.id);
    expect(from(moduleInvoke)).not.toContain(safe.id);
    expect(from(innerInvoke)).toContain(safe.id);
    expect(from(innerInvoke)).not.toContain(vulnerable.id);
  });
});

describe("P1-B3b remediation: a class is constructable, not callable", () => {
  it("`new LocalClass()` still resolves to its constructor", async () => {
    const graph = await graphForSource(
      [
        "class Thing { constructor() {} }",
        "function main() { return new Thing(); }",
        "module.exports = { main };",
        "",
      ].join("\n"),
    );
    expectResolvedTo(graph, soleNodeNamed(graph, "Thing"));
  });

  it("`new AliasOfClass()` resolves through the alias", async () => {
    const graph = await graphForSource(
      [
        "class Thing { constructor() {} }",
        "const Alias = Thing;",
        "function main() { return new Alias(); }",
        "module.exports = { main };",
        "",
      ].join("\n"),
    );
    expectResolvedTo(graph, soleNodeNamed(graph, "Thing"));
  });

  it("`LocalClass()` without `new` produces no constructor edge", async () => {
    // Calling a class throws a TypeError before the constructor body
    // runs, so an edge into it describes an execution that cannot happen.
    const graph = await graphForSource(
      [
        "class Thing { constructor() {} }",
        "function main() { return Thing(); }",
        "module.exports = { main };",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "Thing"));
  });

  it("`AliasOfClass()` without `new` produces no constructor edge", async () => {
    const graph = await graphForSource(
      [
        "class Thing { constructor() {} }",
        "const Alias = Thing;",
        "function main() { return Alias(); }",
        "module.exports = { main };",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "Thing"));
  });

  it("a parameter still shadows an outer class under `new`", async () => {
    const graph = await graphForSource(
      [
        "class Thing { constructor() {} }",
        "function f(Thing) { return new Thing(); }",
        "module.exports = { f };",
        "",
      ].join("\n"),
    );
    expectNeverResolvedTo(graph, soleNodeNamed(graph, "Thing"));
  });

  it("`new LocalFunction()` still resolves -- functions stay constructable", async () => {
    const graph = await graphForSource(
      [
        "function Ctor() { this.x = 1; }",
        "function main() { return new Ctor(); }",
        "module.exports = { main };",
        "",
      ].join("\n"),
    );
    expectResolvedTo(graph, soleNodeNamed(graph, "Ctor"));
  });
});
