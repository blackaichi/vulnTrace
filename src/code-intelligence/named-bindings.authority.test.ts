import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallEdge, CallGraph, GraphNode } from "../domain/graph.js";
import { buildCallGraph } from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";

/**
 * P1-B3 REMEDIATION — the two fabricated-edge classes an independent
 * soundness audit found in the first implementation, and the controls that
 * keep them closed.
 *
 * Both had the same shape: a name or a member was treated as authoritative
 * on evidence that does not establish it, so the call graph gained an edge
 * to a function the program never calls through that path. A fabricated
 * edge is the error class that ends in a wrong verdict rather than an
 * honest UNKNOWN, which is why each case here asserts that NOTHING
 * resolved rather than merely that the resolution changed.
 *
 * 1. DESTRUCTURED LEXICAL BINDINGS. `declarationsOwnedBy` recognized a
 *    parameter only when its name was a plain identifier, so
 *    `function main({ a }) { a(); }` introduced no declaration at all, the
 *    scope walk continued outward, and an outer `const a = danger` was
 *    read through a binding that shadows it.
 *
 * 2. OBJECT-LITERAL MEMBER AUTHORITY. Resolving a receiver to an object
 *    literal is only half the proof; the MEMBER has to be authoritative
 *    too. The shared `findObjectLiteralPropertyValue` takes the FIRST
 *    matching property, ignores spreads entirely, and knows nothing about
 *    a later `obj.m = ...` write — none of which mattered while only a
 *    direct `obj.m()` could reach it, and all of which began fabricating
 *    edges once P1-B3 let an ALIAS reach it.
 *
 * Every test in this file fails on the audited commit 28ac5a1.
 */

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-authority-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

async function graphForSource(source: string): Promise<CallGraph> {
  const root = tempProject();
  const entry = path.join(root, "src/index.js");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, source);
  const resolver = createModuleResolver(loadTsProject(root));
  return buildCallGraph({ entryFiles: [entry], resolver });
}

function findNode(
  graph: CallGraph,
  predicate: (node: GraphNode) => boolean,
): GraphNode | undefined {
  return graph.nodes.find(predicate);
}

function mainEdges(graph: CallGraph): CallEdge[] {
  const mainNode = findNode(graph, (n) => n.name === "main");
  return graph.edges.filter((e) => e.from === mainNode?.id);
}

/**
 * Asserts NO edge anywhere in the graph resolves to the named function.
 *
 * Deliberately graph-wide rather than scoped to `main`: a fabricated edge
 * that moved to another node would still be a fabricated edge, and an
 * assertion that only looked at one caller could not see it.
 */
function expectNoEdgeTo(graph: CallGraph, targetName: string): void {
  const target = findNode(graph, (n) => n.name === targetName);
  expect(target).toBeDefined();
  const borrowed = graph.edges.filter(
    (e) =>
      e.resolution.kind === "resolved" && e.resolution.target === target?.id,
  );
  expect(borrowed).toHaveLength(0);
}

function expectResolvedTo(graph: CallGraph, targetName: string): void {
  const target = findNode(graph, (n) => n.name === targetName);
  expect(target).toBeDefined();
  expect(mainEdges(graph)[0]).toMatchObject({
    resolution: { kind: "resolved", target: target?.id },
  });
}

describe("P1-B3 remediation: destructured bindings own their names", () => {
  it("an ARRAY-pattern parameter shadows an outer binding", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const a = danger;",
        "function main([a]) { a(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("an OBJECT-pattern parameter shadows an outer binding", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const a = danger;",
        "function main({ a }) { a(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("a RENAMED destructured parameter shadows under its LOCAL name", async () => {
    // `{ source: local }` binds `local`, never `source`.
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const local = danger;",
        "function main({ source: local }) { local(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("a renamed destructured parameter does NOT bind the PROPERTY name", async () => {
    // The mirror of the test above, and the reason it exists: binding the
    // property name instead of the local one would shadow `source` — a
    // name this function never declares — and leave `local` leaking.
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const source = danger;",
        "function main({ source: local }) { source(); void local; }",
        "module.exports = { main };",
      ].join("\n"),
    );
    // `source` is NOT bound here, so the outer const legitimately applies.
    expectResolvedTo(graph, "danger");
  });

  it("a DEFAULTED destructured parameter shadows an outer binding", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function fallback() {}",
        "const a = danger;",
        "function main({ a = fallback }) { a(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("a NESTED destructured parameter shadows an outer binding", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const a = danger;",
        "function main([{ a }]) { a(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("a REST element inside a destructured parameter shadows an outer binding", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const rest = danger;",
        "function main([first, ...rest]) { void first; rest(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("an ARROW function's destructured parameter shadows an outer binding", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const a = danger;",
        "const main = ({ a }) => a();",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("a METHOD's destructured parameter shadows an outer binding", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const a = danger;",
        "const holder = { main({ a }) { a(); } };",
        "module.exports = { main: holder.main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("a destructured RECEIVER parameter shadows an outer binding", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const obj = { m: danger };",
        "function main({ obj }) { obj.m(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("a destructured CATCH binding shadows an outer binding", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const a = danger;",
        "function main(run) {",
        "  try { run(); } catch ({ a }) { a(); }",
        "}",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("an ARRAY-pattern catch binding shadows an outer binding", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const a = danger;",
        "function main(run) {",
        "  try { run(); } catch ([a]) { a(); }",
        "}",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });
});

describe("P1-B3 remediation: object-literal members must be authoritative", () => {
  it("REFUSES a duplicate statically-known key", async () => {
    // JS makes the LAST definition authoritative, so resolving the first is
    // not merely imprecise -- it names the wrong function.
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function safe() {}",
        "const obj = { m: danger, m: safe };",
        "const x = obj;",
        "function main() { x.m(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("REFUSES a duplicate key written as a method shorthand", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const obj = { m: danger, m() {} };",
        "const x = obj;",
        "function main() { x.m(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("REFUSES a literal containing a spread AFTER the key", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function main(other) {",
        "  const obj = { m: danger, ...other };",
        "  const x = obj;",
        "  return x.m();",
        "}",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("REFUSES a literal containing a spread BEFORE the key", async () => {
    // Ordering would make this one authoritative, but P1-B3's chosen rule
    // is "any spread refuses" -- see the remediation record.
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function main(other) {",
        "  const obj = { ...other, m: danger };",
        "  const x = obj;",
        "  return x.m();",
        "}",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("REFUSES when the member is written later through the binding itself", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function safe() {}",
        "const obj = { m: danger };",
        "obj.m = safe;",
        "const x = obj;",
        "function main() { x.m(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("REFUSES when the member is written through an ALIAS of the object", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function safe() {}",
        "const obj = { m: danger };",
        "const alias = obj;",
        "alias.m = safe;",
        "function main() { obj.m(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("REFUSES when the member is written with a computed string key", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function safe() {}",
        "const obj = { m: danger };",
        "obj['m'] = safe;",
        "const x = obj;",
        "function main() { x.m(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("REFUSES when the member is written from inside a nested function", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function safe() {}",
        "const obj = { m: danger };",
        "function mutate() { obj.m = safe; }",
        "const x = obj;",
        "function main() { mutate(); x.m(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectNoEdgeTo(graph, "danger");
  });

  it("still resolves a clean single-key object literal through an alias", async () => {
    // The capability P1-B3 added must survive the hardening.
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const obj = { m: danger };",
        "const x = obj;",
        "function main() { x.m(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectResolvedTo(graph, "danger");
  });

  it("still resolves a clean object literal addressed directly", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const obj = { m: danger };",
        "function main() { obj.m(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectResolvedTo(graph, "danger");
  });
});
