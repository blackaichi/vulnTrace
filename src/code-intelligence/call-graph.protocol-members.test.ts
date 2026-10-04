import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import type { CallEdge, CallGraph } from "../domain/graph.js";
import { buildCallGraph } from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { protocolKeyOf } from "./protocol-members.js";
import { loadTsProject } from "./ts-project.js";

/**
 * Task A-4 (docs/tasks/A-4-protocol-members.md), at the graph level: ADR
 * 0008 § 2's protocol-member row and Amendment A-0 part B (an accessor is
 * its own owner). A named test for each rule a mutation could remove: the
 * protocol keys (the iterator methods of RWF-068 included), a computed key
 * that cannot be read, the ambient `Symbol` by binding, the possible edge
 * from the defining owner, a value that cannot be attributed, a protocol
 * getter's returned value, the accessor's own node and its separation from
 * every function lookup, and the accessor's name evaluated with its
 * definition. The real-Node versions are in
 * `tests/oracle/a4-protocol-members.test.ts`.
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface Built {
  readonly graph: CallGraph;
  readonly entry: string;
  readonly lib: string;
}

const LIB = `function parse(s) { return s; }\nfunction safe(s) { return s; }\nmodule.exports = { parse, safe };\n`;

async function build(
  source: string,
  extra: Readonly<Record<string, string>> = {},
): Promise<Built> {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-a4-"));
  tempDirs.push(root);
  const files = { "index.js": source, "lib.js": LIB, ...extra };
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const entry = path.join(root, "index.js");
  const project = loadTsProject(root);
  // The project enables VT-208's checker resolution, one of the lookups an
  // accessor must never answer.
  const graph = await buildCallGraph({
    entryFiles: [entry],
    resolver: createModuleResolver(project),
    project,
  });
  return { graph, entry, lib: path.join(root, "lib.js") };
}

function nodeNamed(graph: CallGraph, name: string, kind?: string): string {
  const matches = graph.nodes.filter(
    (n) => n.name === name && (kind === undefined || n.kind === kind),
  );
  expect(matches, `exactly one node named ${name}`).toHaveLength(1);
  return matches[0]!.id;
}

function moduleNode(built: Built): string {
  return `${built.entry}#<module>`;
}

function edgesFrom(graph: CallGraph, from: string): CallEdge[] {
  return graph.edges.filter((e) => e.from === from && e.type !== "module_load");
}

/** `kind target` for every resolved and possible edge, `unknown reason` for the rest. */
function describeEdges(graph: CallGraph, from: string): string[] {
  return edgesFrom(graph, from).map((e) =>
    e.resolution.kind === "unknown"
      ? `unknown ${e.resolution.reason}`
      : `${e.resolution.kind} ${e.resolution.target}`,
  );
}

/** Every edge, from anywhere, whose target is `target`. */
function edgesInto(graph: CallGraph, target: string): CallEdge[] {
  return graph.edges.filter(
    (e) => e.resolution.kind !== "unknown" && e.resolution.target === target,
  );
}

function keyOf(source: string): string {
  const file = ts.createSourceFile(
    "k.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let found: ts.PropertyName | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && found === undefined) {
      found = node.name;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return protocolKeyOf(found!);
}

describe("protocol keys (protocolKeyOf)", () => {
  it.each([
    ["const o = { toString() {} };", "protocol"],
    ["const o = { valueOf() {} };", "protocol"],
    ["const o = { toJSON() {} };", "protocol"],
    ["const o = { then() {} };", "protocol"],
    // RWF-068, the project owner's decision of 2026-10-04.
    ["const o = { next() {} };", "protocol"],
    ["const o = { return() {} };", "protocol"],
    ["const o = { throw() {} };", "protocol"],
    [`const o = { "toString"() {} };`, "protocol"],
    [`const o = { ["then"]() {} };`, "protocol"],
    ["const o = { [Symbol.iterator]() {} };", "protocol"],
    ["const o = { [Symbol.asyncIterator]() {} };", "protocol"],
    ["class C { static [Symbol.hasInstance]() {} }", "protocol"],
    ["const o = { [Symbol.toPrimitive]() {} };", "protocol"],
    ["const o = { [Symbol.dispose]() {} };", "protocol"],
    ["const o = { [Symbol.asyncDispose]() {} };", "protocol"],
    [`const k = "valueOf"; const o = { [k]() {} };`, "protocol"],
    ["const o = { run() {} };", "other"],
    ["const o = { 0() {} };", "other"],
    ["class C { #toString() {} }", "other"],
    ["const o = { [Symbol.toStringTag]() {} };", "other"],
    [`const o = { [Symbol("toString")]() {} };`, "other"],
    // Node registers its own hooks: Symbol.for("nodejs.util.inspect.custom")
    // IS util.inspect.custom (task A-4's independent audit).
    [`const o = { [Symbol.for("x")]() {} };`, "unread"],
    [`const k = Symbol("x"); const o = { [k]() {} };`, "other"],
    ["function f(k) { return { [k]() {} }; }", "unread"],
    ["const o = { [`to${'String'}`]() {} };", "unread"],
    ["let k = 'run'; k = 'toString'; const o = { [k]() {} };", "unread"],
    // The ambient `Symbol` by binding, never by spelling (defect class A).
    [
      `const Symbol = { toStringTag: "toString" }; const o = { [Symbol.toStringTag]() {} };`,
      "unread",
    ],
  ])("%s -> %s", (source, expected) => {
    expect(keyOf(source)).toBe(expected);
  });
});

describe("a protocol member is reached by a possible edge from the owner that evaluates its definition", () => {
  it("an object-literal toString, from the module", async () => {
    const built = await build(`const o = { toString() { return ""; } };\n`);
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      `possible ${nodeNamed(built.graph, "toString")}`,
    ]);
  });

  it("a class's methods, from the owner of the class definition (a function)", async () => {
    const built = await build(
      `function make() {\n  return class { valueOf() { return 1; } run() {} };\n}\nmake();\n`,
    );
    expect(describeEdges(built.graph, nodeNamed(built.graph, "make"))).toEqual([
      `possible ${nodeNamed(built.graph, "valueOf")}`,
    ]);
    expect(edgesInto(built.graph, nodeNamed(built.graph, "run"))).toEqual([]);
  });

  it("the iterator's next, return and throw (RWF-068)", async () => {
    const built = await build(
      `const it = { [Symbol.iterator]() { return { next() {}, return() {}, throw() {} }; } };\n`,
    );
    const iterator = nodeNamed(built.graph, "[Symbol.iterator]");
    expect(describeEdges(built.graph, iterator).sort()).toEqual(
      [
        `possible ${nodeNamed(built.graph, "next")}`,
        `possible ${nodeNamed(built.graph, "return")}`,
        `possible ${nodeNamed(built.graph, "throw")}`,
      ].sort(),
    );
  });

  it("a method under a computed key the analyzer cannot read", async () => {
    const built = await build(
      `function make(k) { return { [k]() { return 1; } }; }\nmake("toString");\n`,
    );
    expect(describeEdges(built.graph, nodeNamed(built.graph, "make"))).toEqual([
      `possible ${nodeNamed(built.graph, "[k]")}`,
    ]);
  });

  it("an instance field, from the constructor that evaluates its initializer", async () => {
    const built = await build(
      `class C { toString = function shown() { return ""; }; }\nnew C();\n`,
    );
    const ctor = nodeNamed(built.graph, "C", "constructor");
    expect(describeEdges(built.graph, ctor)).toEqual([
      `possible ${nodeNamed(built.graph, "shown")}`,
    ]);
  });

  it("a stored function, from the owner performing the store", async () => {
    const built = await build(
      `function install(o) { o.toString = function shown() { return ""; }; }\ninstall({});\n`,
    );
    expect(
      describeEdges(built.graph, nodeNamed(built.graph, "install")),
    ).toEqual([`possible ${nodeNamed(built.graph, "shown")}`]);
  });

  it("an ES module's exports under a protocol name: properties of its namespace object (task A-4's audit)", async () => {
    const built = await build(`export {};\n`, {
      "index.js": `function f() { return ""; }\nexport function then() {}\nexport const toString = function shown() { return ""; };\nexport { f as valueOf };\nexport { g as next } from "./other.js";\nexport function run() {}\n`,
      "other.js": `export function g() {}\n`,
    });
    expect(describeEdges(built.graph, moduleNode(built)).sort()).toEqual(
      [
        `possible ${nodeNamed(built.graph, "then")}`,
        `possible ${nodeNamed(built.graph, "shown")}`,
        `possible ${nodeNamed(built.graph, "f")}`,
        "unknown protocol_value",
      ].sort(),
    );
  });

  it.each([
    [
      "an exported let assigned later",
      `export let toString;\ntoString = () => "s";\n`,
    ],
    [
      "a reassigned exported function",
      `export function then() {}\nthen = () => 1;\n`,
    ],
    [
      "an object-pattern export",
      `export const { a: valueOf } = { a: () => 1 };\n`,
    ],
    ["an array-pattern export", `export const [next] = [() => 1];\n`],
    [
      "a redeclared exported var",
      `export var toString = () => "a";\nvar toString = () => "b";\n`,
    ],
    [
      "an exported var written by a for-var-of head",
      `export var then;\nfor (var then of [() => 1]) {}\n`,
    ],
  ])(
    "an exported binding that may hold several values -- %s -- is a live binding: an unknown edge (task A-4's re-audit)",
    async (_name, source) => {
      const built = await build(`export {};\n`, { "index.js": source });
      expect(describeEdges(built.graph, moduleNode(built))).toContain(
        "unknown protocol_value",
      );
    },
  );

  it("an imported function under a protocol key, bound exactly", async () => {
    const built = await build(
      `const lib = require("./lib.js");\nconst t = { then: lib.parse };\n`,
    );
    const parse = `${built.lib}#parse@1:1`;
    expect(describeEdges(built.graph, moduleNode(built))).toContain(
      `possible ${parse}`,
    );
  });
});

describe("a value that cannot be attributed gets an unknown protocol_value edge (ADR 0008 § 3)", () => {
  it.each([
    ["a stored parameter", `function f(o, v) { o.then = v; }\nf({}, 1);\n`],
    [
      "a dynamic-key store (the project owner's decision of 2026-10-04)",
      `function f(o, k, v) { o[k] = v; }\nf({}, "x", 1);\n`,
    ],
    ["a property", `function f(v) { return { toString: v }; }\nf(1);\n`],
    [
      "a destructuring store into a protocol member",
      `function f(o, src) { ({ a: o.toString } = src); }\nf({}, {});\n`,
    ],
  ])("%s", async (_name, source) => {
    const built = await build(source);
    expect(describeEdges(built.graph, nodeNamed(built.graph, "f"))).toEqual([
      "unknown protocol_value",
    ]);
  });

  it("a value that may be either an attributable function or an unattributable one gets both edges", async () => {
    const built = await build(
      `function f(v) { return { toString: v || function shown() { return ""; } }; }\nf(1);\n`,
    );
    expect(
      describeEdges(built.graph, nodeNamed(built.graph, "f")).sort(),
    ).toEqual(
      [
        "unknown protocol_value",
        `possible ${nodeNamed(built.graph, "shown")}`,
      ].sort(),
    );
  });

  it("a store under a key proven not to be a protocol key gets nothing", async () => {
    const built = await build(`function f(o, v) { o.run = v; }\nf({}, 1);\n`);
    expect(describeEdges(built.graph, nodeNamed(built.graph, "f"))).toEqual([]);
  });

  it("a protocol GETTER's returned value is invoked: a possible edge from the getter", async () => {
    const built = await build(
      `const t = { get then() { return function handed() {}; } };\n`,
    );
    const getter = nodeNamed(built.graph, "get then", "accessor");
    expect(describeEdges(built.graph, getter)).toEqual([
      `possible ${nodeNamed(built.graph, "handed")}`,
    ]);
  });
});

describe("an accessor is its own owner (Amendment A-0 part B, PRM-118)", () => {
  it("its body's calls hang from its own node, reached by a possible edge from its definer", async () => {
    const built = await build(
      `const lib = require("./lib.js");\nclass C { get v() { return lib.parse("x"); } set v(x) { lib.safe(x); } }\n`,
    );
    const getter = nodeNamed(built.graph, "get v", "accessor");
    const setter = nodeNamed(built.graph, "set v", "accessor");
    const parse = `${built.lib}#parse@1:1`;
    const safe = `${built.lib}#safe@2:1`;
    expect(describeEdges(built.graph, moduleNode(built)).sort()).toEqual(
      [`possible ${getter}`, `possible ${setter}`].sort(),
    );
    expect(describeEdges(built.graph, getter)).toEqual([`resolved ${parse}`]);
    expect(describeEdges(built.graph, setter)).toEqual([`resolved ${safe}`]);
  });

  it("its computed name runs with its definition, under the definer", async () => {
    const built = await build(
      `const lib = require("./lib.js");\nconst o = { get [lib.parse("k")]() { return 1; } };\n`,
    );
    const parse = `${built.lib}#parse@1:1`;
    const getter = built.graph.nodes.find((n) => n.kind === "accessor")!.id;
    expect(describeEdges(built.graph, moduleNode(built))).toContain(
      `resolved ${parse}`,
    );
    expect(describeEdges(built.graph, getter)).toEqual([]);
  });

  it("a class defined in a getter body has its computed keys evaluated by the getter (RWF-023's owner walk)", async () => {
    const built = await build(
      `const lib = require("./lib.js");\nclass H { get g() { class Inner { [lib.parse("k")]() {} } return Inner; } }\n`,
    );
    const parse = `${built.lib}#parse@1:1`;
    const getter = nodeNamed(built.graph, "get g", "accessor");
    expect(describeEdges(built.graph, getter)).toContain(`resolved ${parse}`);
    expect(describeEdges(built.graph, moduleNode(built))).not.toContain(
      `resolved ${parse}`,
    );
  });

  it("a setter's default parameter runs on set, under the setter", async () => {
    const built = await build(
      `const lib = require("./lib.js");\nconst o = { set v(x = lib.parse("x")) {} };\n`,
    );
    const parse = `${built.lib}#parse@1:1`;
    const setter = nodeNamed(built.graph, "set v", "accessor");
    expect(describeEdges(built.graph, setter)).toEqual([`resolved ${parse}`]);
    expect(describeEdges(built.graph, moduleNode(built))).not.toContain(
      `resolved ${parse}`,
    );
  });

  it("no call resolves to an accessor: a getter is never what `o.x()` calls", async () => {
    const built = await build(
      `class C { get run() { return function inner() {}; } }\nconst c = new C();\nc.run();\n`,
    );
    const getter = nodeNamed(built.graph, "get run", "accessor");
    expect(
      edgesInto(built.graph, getter).every(
        (e) => e.resolution.kind === "possible",
      ),
    ).toBe(true);
  });

  it("no export resolves to an accessor: an importer's call of a getter export is not attributed to it", async () => {
    const built = await build(
      `const lib = require("./getters.js");\nlib.run();\n`,
      {
        "getters.js": `module.exports = { get run() { return function inner() {}; } };\n`,
      },
    );
    const getter = nodeNamed(built.graph, "get run", "accessor");
    expect(
      edgesInto(built.graph, getter).every(
        (e) => e.resolution.kind === "possible",
      ),
    ).toBe(true);
  });
});
