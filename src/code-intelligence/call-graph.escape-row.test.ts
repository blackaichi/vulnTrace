import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallEdge, CallGraph, NoEdgeProof } from "../domain/graph.js";
import { possibleEdgeProblems } from "../testing/possible-edge-obligation.js";
import { KNOWN_BUILTIN_CALLABLE_KEYS } from "./builtin-callables.data.js";
import { AMBIENT_GLOBAL_NAMES } from "./escape-row.js";
import {
  buildCallGraph,
  type InvocationAccountObservation,
} from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";

/**
 * Task A-3a (docs/tasks/A-3a-escaped-values.md), at the graph level: ADR
 * 0008 § 2's escape row, § 3's fail-closed default, § 4's documented
 * invoking builtins and non-invoking allowlist, the assignment form of the
 * escape row (PRM-114), RWF-060's forwarded arguments and
 * `Reflect.construct`.
 *
 * The OWNER TESTS of the two no-edge proofs A-3a makes real
 * (`primitive_only_arguments`, `non_invoking_builtin`) are here, and so is
 * a named test for each rule a mutation could remove: lexical identity,
 * the name exclusion of `new Proxy`, the escape row's precedence over an
 * admitted position, the fail-closed default, the exact-chain attribution
 * of an imported value. The end-to-end, real-Node versions are in
 * `tests/oracle/a3a-escaped-values.test.ts`.
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface Built {
  readonly graph: CallGraph;
  readonly observations: readonly InvocationAccountObservation[];
  readonly entry: string;
}

const LIB = `function parse(s) { return s; }\nfunction safe(s) { return s; }\nmodule.exports = { parse, safe };\n`;

async function build(source: string): Promise<Built> {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-a3a-"));
  tempDirs.push(root);
  const files = { "index.js": source, "lib.js": LIB };
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const observations: InvocationAccountObservation[] = [];
  const entryPath = path.join(root, "index.js");
  const graph = await buildCallGraph({
    entryFiles: [entryPath],
    resolver: createModuleResolver(loadTsProject(root)),
    onInvocationAccount: (o) => observations.push(o),
  });
  return { graph, observations, entry: entryPath };
}

function nodeNamed(graph: CallGraph, name: string): string {
  const matches = graph.nodes.filter((n) => n.name === name);
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

function proofs(built: Built): NoEdgeProof[] {
  return built.observations.flatMap((o) =>
    o.account.kind === "no_edge" ? [o.account.proof] : [],
  );
}

// ---------------------------------------------------------------------------
// The owner tests of ADR 0008 § 2's two builtin no-edge proofs
// ---------------------------------------------------------------------------

describe("PrimitiveOnlyArguments (owner test)", () => {
  it("a known builtin handed only primitives, or literals holding only primitives, needs no edge", async () => {
    const built = await build(
      `console.log("x", 1, \`t\${2 + 3}\`);\nnew Map();\nMath.max(1, 2);\nJSON.stringify({ a: 1, b: [2, "c"] });\n`,
    );
    expect(proofs(built)).toEqual([
      { kind: "primitive_only_arguments", builtin: "call global:console.log" },
      { kind: "primitive_only_arguments", builtin: "construct global:Map" },
      { kind: "primitive_only_arguments", builtin: "call global:Math.max" },
      {
        kind: "primitive_only_arguments",
        builtin: "call global:JSON.stringify",
      },
    ]);
    expect(edgesFrom(built.graph, moduleNode(built))).toEqual([]);
  });

  it("a builtin module's member, bound through its declaration, with primitive arguments", async () => {
    const built = await build(
      `const fs = require("fs");\nconst { basename } = require("path");\nfs.existsSync("x");\nbasename("a/b");\n`,
    );
    expect(proofs(built).map((p) => p.builtin)).toEqual([
      "call module:fs:existsSync",
      "call module:path:basename",
    ]);
  });
});

describe("NonInvokingBuiltin (owner test)", () => {
  it("a value the graph cannot attribute, at an admitted position, needs no edge", async () => {
    const built = await build(
      `function f(o) { return Array.isArray(o) && Object.keys(o); }\nf({});\n`,
    );
    expect(proofs(built)).toEqual([
      { kind: "non_invoking_builtin", builtin: "call global:Array.isArray" },
      { kind: "non_invoking_builtin", builtin: "call global:Object.keys" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// What must never yield a proof
// ---------------------------------------------------------------------------

describe("the fail-closed default (ADR 0008 § 3)", () => {
  it("a value the graph cannot attribute, at a position not admitted, gets an unknown edge", async () => {
    const built = await build(`function f(o) { console.log(o); }\nf({});\n`);
    expect(describeEdges(built.graph, nodeNamed(built.graph, "f"))).toEqual([
      "unknown escaped_value",
    ]);
    expect(proofs(built)).toEqual([]);
  });

  it("an object passed by name is not expanded, and gets an unknown edge at a position not admitted (PRM-117)", async () => {
    const built = await build(
      `const util = require("util");\nconst o = { [util.inspect.custom]() { return "x"; } };\nconsole.log(o);\n`,
    );
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      "unknown escaped_value",
    ]);
  });
});

describe("ambient identity is lexical (defect class A)", () => {
  it("a parameter named JSON is not the ambient JSON: no proof, an unknown edge", async () => {
    const built = await build(
      `function g(JSON) { JSON.parse("x"); }\ng({});\n`,
    );
    expect(proofs(built)).toEqual([]);
    expect(
      describeEdges(built.graph, nodeNamed(built.graph, "g")).every((d) =>
        d.startsWith("unknown "),
      ),
    ).toBe(true);
  });

  it("a local named setTimeout is not the documented invoking builtin", async () => {
    const built = await build(
      `function cb() {}\nfunction run(setTimeout) { setTimeout(cb); }\nrun(function never() {});\n`,
    );
    const cb = nodeNamed(built.graph, "cb");
    expect(
      describeEdges(built.graph, nodeNamed(built.graph, "run")),
    ).not.toContain(`resolved ${cb}`);
  });

  it("every global key of the builtin table is rooted in AMBIENT_GLOBAL_NAMES (whose writes are escapes)", () => {
    const roots = KNOWN_BUILTIN_CALLABLE_KEYS.filter((k) =>
      k.startsWith("global:"),
    ).map((k) => k.slice("global:".length).split(".")[0]!);
    expect(roots.filter((root) => !AMBIENT_GLOBAL_NAMES.has(root))).toEqual([]);
  });

  it("a destructuring assignment, a for-of head or a with body: no ambient identity, no proof", async () => {
    for (const source of [
      `({ setTimeout } = { setTimeout() {} });\nsetTimeout(1);\n`,
      `for (setTimeout of [function () {}]) {}\nsetTimeout(1);\n`,
      `with ({}) { setTimeout(1); }\n`,
    ]) {
      const built = await build(source);
      expect(proofs(built), source).toEqual([]);
    }
  });

  it("require('<builtin>').member(...) is not trusted as the builtin: an unknown callee, as on the base", async () => {
    const built = await build(`require("path").join("a");\n`);
    expect(proofs(built)).toEqual([]);
    expect(
      describeEdges(built.graph, moduleNode(built)).every((d) =>
        d.startsWith("unknown "),
      ),
    ).toBe(true);
  });

  it("a bare-name write anywhere in the file does not turn off the escape of a member write to that builtin", async () => {
    const built = await build(
      `function f() {}\nif (false) { Math = 0; }\nMath.max = f;\n`,
    );
    expect(describeEdges(built.graph, moduleNode(built))).toContain(
      `possible ${nodeNamed(built.graph, "f")}`,
    );
  });

  it("a builtin value handed to a builtin is opaque, never primitive-only", async () => {
    const built = await build(
      `Object.assign(Array, { isArray: setTimeout });\n`,
    );
    expect(proofs(built)).toEqual([]);
  });

  it("globalThis.X = stub in the file: X is no longer the ambient builtin", async () => {
    const built = await build(`globalThis.Math = {};\nMath.max(1);\n`);
    expect(proofs(built)).toEqual([]);
  });

  it("a file that assigns to a builtin's name has no ambient builtin of that name", async () => {
    const built = await build(`JSON = { parse() {} };\nJSON.parse("x");\n`);
    expect(proofs(built)).toEqual([]);
  });
});

describe("the non-invoking allowlist never removes an escape-row edge", () => {
  it("an attributable function at an admitted position still gets its possible edge", async () => {
    const built = await build(`function f() {}\nArray.isArray(f);\n`);
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      `possible ${nodeNamed(built.graph, "f")}`,
    ]);
    expect(proofs(built)).toEqual([]);
  });

  it("new Proxy is never admitted: a handler passed by name gets an unknown edge; an inline one, possible edges to its traps", async () => {
    const named = await build(
      `const h = { get() { return 1; } };\nnew Proxy({}, h);\n`,
    );
    expect(describeEdges(named.graph, moduleNode(named))).toEqual([
      "unknown escaped_value",
    ]);
    const inline = await build(`new Proxy({}, { get() { return 1; } });\n`);
    expect(describeEdges(inline.graph, moduleNode(inline))).toEqual([
      `possible ${nodeNamed(inline.graph, "get")}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The documented invoking builtins (ADR 0008 § 4)
// ---------------------------------------------------------------------------

describe("a documented invoking builtin: resolved", () => {
  it("setTimeout, process.nextTick, new Promise, Reflect.apply, Array.from's mapper", async () => {
    const built = await build(
      [
        `function a() {}`,
        `function b() {}`,
        `function c() {}`,
        `function d() {}`,
        `function e() {}`,
        `setTimeout(a, 0);`,
        `process.nextTick(b);`,
        `new Promise(c);`,
        `Reflect.apply(d, null, []);`,
        `Array.from([1], e);`,
        ``,
      ].join("\n"),
    );
    expect(describeEdges(built.graph, moduleNode(built)).sort()).toEqual(
      ["a", "b", "c", "d", "e"]
        .map((n) => `resolved ${nodeNamed(built.graph, n)}`)
        .sort(),
    );
  });

  it("a function that is only a MEMBER of an argument, even at an invoking position, is possible", async () => {
    const built = await build(`function a() {}\nsetTimeout([a], 0);\n`);
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      `possible ${nodeNamed(built.graph, "a")}`,
    ]);
    const member = await build(`function a() {}\nnew Promise({ run: a });\n`);
    expect(describeEdges(member.graph, moduleNode(member))).toEqual([
      `possible ${nodeNamed(member.graph, "a")}`,
    ]);
  });

  it("either operand of a conditional or logical operator is possible, never resolved", async () => {
    const built = await build(
      `function a() {}\nfunction b() {}\nsetTimeout(a || b, 0);\nsetTimeout(Math.random() ? a : b, 0);\n`,
    );
    const edges = describeEdges(built.graph, moduleNode(built));
    expect(edges.filter((d) => d.startsWith("resolved "))).toEqual([]);
    expect(edges).toContain(`possible ${nodeNamed(built.graph, "b")}`);
  });

  it("a reassigned function declaration is not attributed (PRM-104's shape)", async () => {
    const built = await build(
      `function cb() {}\ncb = function () {};\nsetTimeout(cb, 0);\n`,
    );
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      "unknown escaped_value",
    ]);
  });

  it("the invoking builtin's form must be able to invoke the value: a class is not called, a plain function is not a class constructor", async () => {
    const built = await build(
      `class A {}\nfunction f() {}\nsetTimeout(A, 0);\nReflect.construct(f, []);\n`,
    );
    const edges = describeEdges(built.graph, moduleNode(built));
    expect(edges.filter((d) => d.startsWith("resolved "))).toEqual([]);
    expect(edges).toContain(`possible ${nodeNamed(built.graph, "f")}`);
  });

  it("Reflect.construct(A, []) reaches A's constructor node, explicit or implicit (PRM-37's A-1 status update)", async () => {
    const built = await build(
      `class A { constructor() {} }\nclass B {}\nReflect.construct(A, []);\nReflect.construct(B, []);\n`,
    );
    const constructors = built.graph.nodes
      .filter((n) => n.kind === "constructor")
      .map((n) => `resolved ${n.id}`)
      .sort();
    expect(constructors).toHaveLength(2);
    expect(describeEdges(built.graph, moduleNode(built)).sort()).toEqual(
      constructors,
    );
  });

  it("an unattributable value at an invoking position gets an unknown edge", async () => {
    const built = await build(`function f(cb) { setTimeout(cb, 0); }\nf();\n`);
    expect(describeEdges(built.graph, nodeNamed(built.graph, "f"))).toEqual([
      "unknown escaped_value",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Escaped values: possible
// ---------------------------------------------------------------------------

describe("an escaped value that may run: possible", () => {
  it("an imported function passed to a builtin module's member (PRM-12)", async () => {
    const built = await build(
      `const fs = require("fs");\nconst lib = require("./lib.js");\nfs.readFile("x", lib.parse);\n`,
    );
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      `possible ${nodeNamed(built.graph, "parse")}`,
    ]);
  });

  it("an imported value is attributed only when its whole member chain is consumed", async () => {
    const built = await build(
      `const lib = require("./lib.js");\nsetTimeout(lib.parse.call, 0);\n`,
    );
    const parse = nodeNamed(built.graph, "parse");
    const edges = describeEdges(built.graph, moduleNode(built));
    expect(edges).not.toContain(`possible ${parse}`);
    expect(edges).not.toContain(`resolved ${parse}`);
    expect(edges).toContain("unknown escaped_value");

    // One hop past a named import: the binder names `parse`, and reports
    // `call` as not consumed.
    const named = await build(
      `const { parse } = require("./lib.js");\nsetTimeout(parse.call, 0);\n`,
    );
    const namedParse = nodeNamed(named.graph, "parse");
    expect(describeEdges(named.graph, moduleNode(named))).toEqual([
      "unknown escaped_value",
    ]);
    expect(describeEdges(named.graph, moduleNode(named)).join()).not.toContain(
      namedParse,
    );
  });

  it("a property descriptor's getter (AUD-01); the target object, held by a name, is the fail-closed default", async () => {
    const built = await build(
      `const o = {};\nObject.defineProperty(o, "k", { enumerable: true, get() { return 1; } });\n`,
    );
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      "unknown escaped_value",
      `possible ${nodeNamed(built.graph, "get")}`,
    ]);
  });

  it("an unknown callee keeps its unknown edge and adds a possible edge to an attributable argument", async () => {
    const built = await build(
      `function cb() {}\nfunction f(o) { o.run(cb); }\nf({});\n`,
    );
    expect(describeEdges(built.graph, nodeNamed(built.graph, "f"))).toEqual([
      "unknown unsupported_receiver_binding",
      `possible ${nodeNamed(built.graph, "cb")}`,
    ]);
  });

  it("a member of a builtin value that Node does not supply is an unknown callee", async () => {
    const built = await build(`globalThis.myHook();\n`);
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      "unknown unsupported_receiver_binding",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The assignment form (PRM-114)
// ---------------------------------------------------------------------------

describe("an assignment that stores into an ambient or builtin value (PRM-114)", () => {
  it("Error.prepareStackTrace = fn: a possible edge from the assigning owner", async () => {
    const built = await build(
      `function hook() {}\nError.prepareStackTrace = hook;\n`,
    );
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      `possible ${nodeNamed(built.graph, "hook")}`,
    ]);
  });

  it("a monkeypatched builtin member (Math.max = fn)", async () => {
    const built = await build(`function f() {}\nMath.max = f;\n`);
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      `possible ${nodeNamed(built.graph, "f")}`,
    ]);
  });

  it("a write through a conditional alias of the global object, and a destructuring assignment onto a builtin", async () => {
    const alias = await build(
      `function f() {}\nconst g = typeof globalThis !== "undefined" ? globalThis : global;\ng.JSON.parse = f;\n`,
    );
    expect(describeEdges(alias.graph, moduleNode(alias))).toEqual([
      `possible ${nodeNamed(alias.graph, "f")}`,
    ]);
    const destructured = await build(
      `function f() {}\n({ run: Math.max } = { run: f });\n`,
    );
    expect(describeEdges(destructured.graph, moduleNode(destructured))).toEqual(
      [`possible ${nodeNamed(destructured.graph, "f")}`],
    );
  });

  it("a write through a const alias of an ambient builtin (const M = Math; M.max = fn)", async () => {
    const built = await build(`function f() {}\nconst M = Math;\nM.max = f;\n`);
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      `possible ${nodeNamed(built.graph, "f")}`,
    ]);
  });

  it("a member of a builtin module's value", async () => {
    const built = await build(
      `const fs = require("fs");\nfunction f() {}\nfs.readFile = f;\n`,
    );
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      `possible ${nodeNamed(built.graph, "f")}`,
    ]);
  });

  it("an export write is not an escape (the export model owns it), and a primitive store is not one", async () => {
    const built = await build(
      `function f() {}\nexports.f = f;\nmodule.exports.g = f;\nError.stackTraceLimit = 20;\n`,
    );
    expect(built.observations.map((o) => o.site.kind)).not.toContain(
      "escaping_assignment",
    );
  });
});

// ---------------------------------------------------------------------------
// A-2's producer obligation: a possible edge points into a walked file
// ---------------------------------------------------------------------------

describe("a possible edge points at a node of a WALKED file (REMEDIATION-PLAN § 5a, A-2 additions)", () => {
  it("a possible edge into a file a resource limit left unwalked is withdrawn to unknown, naming its target", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-a3a-"));
    tempDirs.push(root);
    writeFileSync(path.join(root, "lib.js"), LIB);
    writeFileSync(
      path.join(root, "index.js"),
      `const lib = require("./lib.js");\nrequire("fs").readFile("x", lib.parse);\n`,
    );
    let walked: readonly string[] = [];
    const graph = await buildCallGraph({
      entryFiles: [path.join(root, "index.js")],
      resolver: createModuleResolver(loadTsProject(root)),
      // index.js's module node, then lib.js's three nodes: lib.js is
      // prepared (its nodes exist) but the walk stops before walking it.
      maxGraphNodes: 4,
      onWalkedFiles: (files) => {
        walked = files;
      },
    });
    const parse = graph.nodes.find((n) => n.name === "parse");
    expect(parse, "lib.js was prepared").toBeDefined();
    expect(walked).toEqual([path.join(root, "index.js")]);
    expect(graph.edges.some((e) => e.resolution.kind === "possible")).toBe(
      false,
    );
    expect(
      graph.edges.find(
        (e) =>
          e.resolution.kind === "unknown" &&
          e.resolution.potentialTargets.includes(parse!.id),
      )?.resolution,
    ).toMatchObject({ kind: "unknown", reason: "escaped_value" });
    expect(possibleEdgeProblems({ graph, walkedFiles: walked })).toEqual([]);
  });

  it("the checker reports a possible edge to a node that does not exist, or into an unwalked file", () => {
    const graph: CallGraph = {
      nodes: [
        { id: "a#<module>", kind: "module", module: "a" },
        { id: "b#f@1:1", kind: "function", module: "b", name: "f" },
      ],
      edges: [
        {
          from: "a#<module>",
          type: "callback",
          resolution: { kind: "possible", target: "b#f@1:1" },
        },
        {
          from: "a#<module>",
          type: "callback",
          resolution: { kind: "possible", target: "c#g@1:1" },
        },
      ],
    };
    expect(possibleEdgeProblems({ graph, walkedFiles: ["a"] })).toHaveLength(2);
    expect(possibleEdgeProblems({ graph, walkedFiles: ["a", "b"] })).toEqual([
      "possible edge a#<module> -> c#g@1:1: the target is not a node of the graph",
    ]);
  });
});

// ---------------------------------------------------------------------------
// RWF-060 -- forwarded arguments
// ---------------------------------------------------------------------------

describe("an implicit constructor forwards its arguments to an ambient or builtin base (RWF-060)", () => {
  it("new P(executor), class P extends Promise {}: the executor is resolved at the site", async () => {
    const built = await build(
      `function ex() {}\nclass P extends Promise {}\nnew P(ex);\n`,
    );
    const edges = describeEdges(built.graph, moduleNode(built));
    expect(edges).toContain(`resolved ${nodeNamed(built.graph, "ex")}`);
    expect(edges).toContain(`resolved ${nodeNamed(built.graph, "P")}`);
  });

  it("the implicit constructor's own construction of the builtin base: an unknown edge, since each construction supplies its arguments", async () => {
    const built = await build(`class P extends Promise {}\n`);
    expect(describeEdges(built.graph, nodeNamed(built.graph, "P"))).toEqual([
      "unknown escaped_value",
    ]);
  });

  it("the chain is followed through a second derived class with no constructor, and stops at an explicit one", async () => {
    const built = await build(
      `function ex() {}\nclass P extends Promise {}\nclass Q extends P {}\nnew Q(ex);\n` +
        `function other() {}\nclass R extends Promise { constructor(f) { super(f); } }\nclass S extends R {}\nnew S(other);\n`,
    );
    const edges = describeEdges(built.graph, moduleNode(built));
    expect(edges).toContain(`resolved ${nodeNamed(built.graph, "ex")}`);
    expect(edges.join(" ")).not.toContain(nodeNamed(built.graph, "other"));
  });
});
