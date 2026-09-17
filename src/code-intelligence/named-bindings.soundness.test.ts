import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallEdge, CallGraph, GraphNode } from "../domain/graph.js";
import { buildCallGraph } from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";

/**
 * P1-B3 -- the SOUNDNESS CONTRACT of named binding resolution.
 *
 * call-graph.test.ts already covers what the alias paths resolve. This
 * suite covers the other half, which is the half that can only be tested
 * deliberately: WHAT THEY MUST REFUSE TO RESOLVE, and why each refusal is
 * a different one. Every negative case here would have produced a
 * FABRICATED CALL EDGE under a name-only lookup -- an edge to a function
 * the program never reaches through that name -- and a fabricated edge is
 * the one error class this engine is not allowed to make, because it is
 * the class that ends in a wrong verdict rather than an honest UNKNOWN.
 *
 * The suite is organized as the P1-B3 task's own matrices:
 *
 * - § 24 callee forms;
 * - § 25 receiver forms;
 * - § 26 near-neighbour constructs that must NOT become supported;
 * - § 18 exact-PackageInstance isolation between same-name twins.
 *
 * § 30-33's mutation controls are run against this suite rather than
 * living in it: each guard in named-bindings.ts was weakened in turn and
 * the specific tests that break are recorded in FINDINGS.md RWF-042 § 12.
 *
 * A note on what the negative assertions check. They assert the call
 * stayed UNKNOWN under a named-binding reason, NOT merely that it did not
 * resolve to one particular node. Asserting `target !== danger` would
 * pass just as happily if the edge vanished entirely or resolved
 * somewhere else again -- and a vanished edge is its own defect (a call
 * the reachability search would never account for), so it must not be
 * allowed to masquerade as a refusal.
 */

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-named-binding-"));
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

/** Every edge leaving the function named `main`. */
function mainEdges(graph: CallGraph): CallEdge[] {
  const mainNode = findNode(graph, (n) => n.name === "main");
  return graph.edges.filter((e) => e.from === mainNode?.id);
}

function mainEdge(graph: CallGraph): CallEdge | undefined {
  return mainEdges(graph)[0];
}

/** Builds a one-file project whose `main` contains the construct under test. */
async function graphForSource(source: string): Promise<CallGraph> {
  const root = tempProject();
  const entry = write(root, "src/index.js", source);
  return graphFor(root, entry);
}

const NAMED_BINDING_REASONS = new Set([
  "unsupported_callee_binding",
  "unsupported_receiver_binding",
]);

/**
 * Asserts the call under test produced exactly one edge, that edge is
 * UNKNOWN, and its reason is still a named-binding reason. The last part
 * is what keeps P1-B3 honest about reason migration (§ 21): a refusal
 * that quietly re-labels the occurrence as some other subtype would
 * reduce the Block A count without resolving anything.
 */
function expectUnresolvedNamedBinding(graph: CallGraph): void {
  const edges = mainEdges(graph);
  expect(edges).toHaveLength(1);
  const [edge] = edges;
  expect(edge?.resolution.kind).toBe("unknown");
  const reason =
    edge?.resolution.kind === "unknown" ? edge.resolution.reason : undefined;
  expect(NAMED_BINDING_REASONS.has(String(reason))).toBe(true);
}

function expectResolvedTo(graph: CallGraph, targetName: string): void {
  const target = findNode(graph, (n) => n.name === targetName);
  expect(target).toBeDefined();
  expect(mainEdge(graph)).toMatchObject({
    resolution: { kind: "resolved", target: target?.id },
  });
}

describe("P1-B3 § 24: callee binding matrix", () => {
  it("resolves a const bound to a local function declaration", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const fn = danger;",
        "function main() { fn(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectResolvedTo(graph, "danger");
  });

  it("resolves a binding whose value is a NAMED function expression under a different name", async () => {
    // The shape that dominates the measured corpus: `source-index` names a
    // function expression by its OWN name, so a name-match against the
    // BINDING never finds it (`qs/lib/parse.js`'s `parseValues` /
    // `parseKeys`). Only resolving the binding makes the two meet.
    const graph = await graphForSource(
      [
        "var parseValues = function parseQueryStringValues() {};",
        "function main() { parseValues(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectResolvedTo(graph, "parseQueryStringValues");
  });

  it("resolves a binding whose value is an anonymous arrow function", async () => {
    const graph = await graphForSource(
      [
        "const handler = () => {};",
        "function main() { handler(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectResolvedTo(graph, "handler");
  });

  it("resolves a multi-hop alias chain a = b, b = fn", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const b = danger;",
        "const a = b;",
        "function main() { a(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectResolvedTo(graph, "danger");
  });

  it("resolves an imported function through a local alias", async () => {
    const root = tempProject();
    write(
      root,
      "src/lib.js",
      "function vulnerable() {}\nexports.vulnerable = vulnerable;\n",
    );
    const entry = write(
      root,
      "src/index.js",
      [
        'const lib = require("./lib.js");',
        "const doIt = lib.vulnerable;",
        "function main() { doIt(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expectResolvedTo(graph, "vulnerable");
  });

  it("REFUSES an inner binding that shadows an outer one", async () => {
    // The defect this control exists for: a whole-file, first-match-wins
    // lookup reads the OUTER `fn = danger` for a reference that the
    // language binds to the INNER `fn`.
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const fn = danger;",
        "function main(unknownValue) {",
        "  const fn = unknownValue;",
        "  fn();",
        "}",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectUnresolvedNamedBinding(graph);
  });

  it("binds a shadowing declaration to its OWN value, not the outer one", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function safe() {}",
        "const fn = danger;",
        "function main() {",
        "  const fn = safe;",
        "  fn();",
        "}",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectResolvedTo(graph, "safe");
  });

  it("REFUSES a parameter that shadows a module binding", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const fn = danger;",
        "function main(fn) { fn(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectUnresolvedNamedBinding(graph);
  });

  it("REFUSES a reassigned binding", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function safe() {}",
        "let fn = danger;",
        "fn = safe;",
        "function main() { fn(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectUnresolvedNamedBinding(graph);
  });

  it("REFUSES a binding assigned inside a branch", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function safe() {}",
        "let fn = safe;",
        "if (process.env.X) { fn = danger; }",
        "function main() { fn(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectUnresolvedNamedBinding(graph);
  });

  it("REFUSES a binding assigned inside a loop", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function safe() {}",
        "let fn = safe;",
        "for (let i = 0; i < 2; i++) { fn = danger; }",
        "function main() { fn(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectUnresolvedNamedBinding(graph);
  });

  it("REFUSES a call written before the initializer that would give it a value", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function main() { fn(); }",
        "const fn = danger;",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectUnresolvedNamedBinding(graph);
  });

  it("REFUSES two declarations of the same name in one scope", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function safe() {}",
        "function main(flag) {",
        "  if (flag) { var fn = danger; } else { var fn = safe; }",
        "  fn();",
        "}",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectUnresolvedNamedBinding(graph);
  });

  it("REFUSES a cyclic alias a = b, b = a", async () => {
    const graph = await graphForSource(
      [
        "const a = b;",
        "const b = a;",
        "function main() { a(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    // Fails CLOSED: the chain returns to a declaration it already visited
    // and resolves to nothing, so no target is fabricated. The reason on
    // the edge is `loader_capability_escape` rather than a named-binding
    // one, because the loader classifier (loader-constructs.ts) inspects
    // this shape BEFORE any binding path runs and already owns it -- so
    // this case is asserted on the outcome that matters, and deliberately
    // not on a reason P1-B3 neither sets nor should start competing for.
    const edges = mainEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.resolution.kind).toBe("unknown");
    expect(graph.edges.some((e) => e.resolution.kind === "resolved")).toBe(
      false,
    );
  });

  it("REFUSES a binding declared without an initializer", async () => {
    const graph = await graphForSource(
      [
        "function main() {",
        "  var fn;",
        "  fn();",
        "}",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectUnresolvedNamedBinding(graph);
  });

  it("REFUSES an alias to an ambient global that shares a name with a local function (RWF-043)", async () => {
    // The real shape, from `lodash`: `var freeParseInt = parseInt;` sits at
    // MODULE scope, where `parseInt` is the ambient global -- while the
    // same file separately defines its own `function parseInt` inside a
    // deeply nested closure. The two names are unrelated, and an alias
    // that hands the bare name onward to a name-only match pairs them and
    // attributes the call to the wrong function.
    //
    // Caught by the P1-B3 corpus differential, not by intuition: the
    // fabricated edge showed up as `callsResolved` rising by one in the
    // two lodash cases, with no verdict to make it visible.
    const graph = await graphForSource(
      [
        "var freeParseInt = parseInt;",
        "function main(value) { return freeParseInt(value, 10); }",
        "function nested() {",
        "  function parseInt(string, radix) { return radix; }",
        "  return parseInt;",
        "}",
        "module.exports = { main, nested };",
      ].join("\n"),
    );
    // No edge may point at the file's own `parseInt`, which is not the
    // binding `freeParseInt` was initialized from.
    const localParseInt = findNode(graph, (n) => n.name === "parseInt");
    expect(localParseInt).toBeDefined();
    expect(
      graph.edges.some(
        (e) =>
          e.resolution.kind === "resolved" &&
          e.resolution.target === localParseInt?.id,
      ),
    ).toBe(false);
  });

  it("REFUSES a value shape it does not model, leaving the precise reason intact", async () => {
    const graph = await graphForSource(
      [
        "const fn = 42;",
        "function main() { fn(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectUnresolvedNamedBinding(graph);
  });
});

describe("P1-B3 § 25: receiver binding matrix", () => {
  it("resolves a member call through an aliased object literal receiver", async () => {
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

  it("resolves a member call through an aliased imported receiver", async () => {
    const root = tempProject();
    write(
      root,
      "src/lib.js",
      "function vulnerable() {}\nexports.vulnerable = vulnerable;\n",
    );
    const entry = write(
      root,
      "src/index.js",
      [
        'const lib = require("./lib.js");',
        "const x = lib;",
        "function main() { x.vulnerable(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expectResolvedTo(graph, "vulnerable");
  });

  it("REFUSES a shadowed receiver", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const obj = { m: danger };",
        "const x = obj;",
        "function main(unknownValue) {",
        "  const x = unknownValue;",
        "  x.m();",
        "}",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectUnresolvedNamedBinding(graph);
  });

  it("REFUSES a reassigned receiver", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const obj = { m: danger };",
        "const other = {};",
        "let x = obj;",
        "x = other;",
        "function main() { x.m(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectUnresolvedNamedBinding(graph);
  });

  it("REFUSES a member the resolved receiver does not have", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const obj = { m: danger };",
        "const x = obj;",
        "function main() { x.missing(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectUnresolvedNamedBinding(graph);
  });

  it("REFUSES a receiver used before its own initializer", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function main() { x.m(); }",
        "const obj = { m: danger };",
        "const x = obj;",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectUnresolvedNamedBinding(graph);
  });

  it("REFUSES a factory-result receiver -- Block B stays Block B", async () => {
    // `const x = factory(); x.m()` needs interprocedural RETURN modeling.
    // Resolving the NAME `x` is not the same as knowing the VALUE it got,
    // and P1-B3 § 13 keeps the two apart deliberately.
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function factory() { return { m: danger }; }",
        "const x = factory();",
        "function main() { x.m(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectUnresolvedNamedBinding(graph);
  });

  it("REFUSES a constructed receiver -- Block C stays Block C", async () => {
    const graph = await graphForSource(
      [
        "class Thing { m() {} }",
        "const x = new Thing();",
        "function main() { x.m(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expectUnresolvedNamedBinding(graph);
  });
});

describe("P1-B3 § 26: near-neighbour constructs must not become supported", () => {
  function unknownReasonsOf(graph: CallGraph): string[] {
    return mainEdges(graph).map((e) =>
      e.resolution.kind === "unknown" ? e.resolution.reason : "resolved",
    );
  }

  it("leaves a call-result receiver f().m() on its own reason", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "function f() { return { m: danger }; }",
        "function main() { f().m(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expect(unknownReasonsOf(graph)).toContain(
      "unsupported_call_result_receiver",
    );
  });

  it("leaves a literal receiver on its own reason", async () => {
    const graph = await graphForSource(
      [
        "function main() { [1, 2].join(','); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expect(unknownReasonsOf(graph)).toContain("unsupported_literal_receiver");
  });

  it("leaves a dynamic member callee obj[key]() on dynamic_member_access", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const obj = { m: danger };",
        "function main(key) { obj[key](); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expect(unknownReasonsOf(graph)).toContain("dynamic_member_access");
  });

  it("leaves a dynamically-indexed receiver obj[key].m() on its own reason", async () => {
    const graph = await graphForSource(
      [
        "function danger() {}",
        "const obj = { a: { m: danger } };",
        "function main(key) { obj[key].m(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expect(unknownReasonsOf(graph)).toContain("unsupported_indexed_receiver");
  });

  it("leaves a this receiver on its own reason", async () => {
    const graph = await graphForSource(
      [
        "function main() { return this.parse('x'); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    expect(unknownReasonsOf(graph)).toContain("unsupported_this_receiver");
  });
});

/**
 * P1-B3 § 18. Two installs with the SAME package name and the SAME
 * version, one nested inside the wrapper that uses it. A named binding
 * that resolves through the wrapper must land on the wrapper's own
 * install, never on the identically-spelled twin at the top level.
 *
 * Every assertion checks the target's own module PATH. An assertion that
 * only checked the exported name would pass against the wrong instance,
 * which is the entire failure mode being excluded.
 */
describe("P1-B3 § 18: exact PackageInstance isolation", () => {
  function pkgJson(name: string): string {
    return JSON.stringify({ name, version: "1.0.0", main: "index.js" });
  }

  function writeVulnPkg(root: string, dir: string): void {
    write(root, `${dir}/package.json`, pkgJson("vuln-pkg"));
    write(
      root,
      `${dir}/index.js`,
      "function parse(x) { return x; }\nexports.parse = parse;\n",
    );
  }

  function twinRoots(wrapperBody: string): { root: string; entry: string } {
    const root = tempProject();
    writeVulnPkg(root, "node_modules/vuln-pkg");
    writeVulnPkg(root, "node_modules/wrapper/node_modules/vuln-pkg");
    write(root, "node_modules/wrapper/package.json", pkgJson("wrapper"));
    write(root, "node_modules/wrapper/index.js", wrapperBody);
    const entry = write(
      root,
      "src/app.js",
      [
        'const wrapper = require("wrapper");',
        "function main(input) { return wrapper.run(input); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    return { root, entry };
  }

  function nestedParse(graph: CallGraph, root: string): GraphNode | undefined {
    const nestedDir =
      path.join(root, "node_modules", "wrapper", "node_modules", "vuln-pkg") +
      path.sep;
    return findNode(
      graph,
      (n) => n.name === "parse" && n.module.startsWith(nestedDir),
    );
  }

  function topLevelParse(
    graph: CallGraph,
    root: string,
  ): GraphNode | undefined {
    const topDir = path.join(root, "node_modules", "vuln-pkg") + path.sep;
    return findNode(
      graph,
      (n) => n.name === "parse" && n.module.startsWith(topDir),
    );
  }

  function hasResolvedEdgeTo(
    graph: CallGraph,
    node: GraphNode | undefined,
  ): boolean {
    if (!node) {
      return false;
    }
    return graph.edges.some(
      (e) =>
        e.resolution.kind === "resolved" && e.resolution.target === node.id,
    );
  }

  function expectNestedOnly(graph: CallGraph, root: string): void {
    const nested = nestedParse(graph, root);
    expect(nested).toBeDefined();
    expect(hasResolvedEdgeTo(graph, nested)).toBe(true);
    expect(hasResolvedEdgeTo(graph, topLevelParse(graph, root))).toBe(false);
  }

  it("a CALLEE binding never borrows the sibling instance's callable", async () => {
    const { root, entry } = twinRoots(
      [
        'const dep = require("vuln-pkg");',
        "const doIt = dep.parse;",
        "function run(x) { return doIt(x); }",
        "exports.run = run;",
      ].join("\n"),
    );
    expectNestedOnly(await graphFor(root, entry), root);
  });

  it("a RECEIVER binding never borrows the sibling instance's member", async () => {
    const { root, entry } = twinRoots(
      [
        'const dep = require("vuln-pkg");',
        "const alias = dep;",
        "function run(x) { return alias.parse(x); }",
        "exports.run = run;",
      ].join("\n"),
    );
    expectNestedOnly(await graphFor(root, entry), root);
  });

  it("an alias CHAIN never borrows the sibling instance", async () => {
    const { root, entry } = twinRoots(
      [
        'const dep = require("vuln-pkg");',
        "const a = dep;",
        "const b = a;",
        "function run(x) { return b.parse(x); }",
        "exports.run = run;",
      ].join("\n"),
    );
    expectNestedOnly(await graphFor(root, entry), root);
  });
});
