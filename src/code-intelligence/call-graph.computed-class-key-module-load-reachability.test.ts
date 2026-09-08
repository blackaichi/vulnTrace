import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph } from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";
import type { CallGraph } from "../domain/graph.js";

/**
 * RWF-023, at the layer that actually owns the defect: which node the call
 * graph attributes a call written inside a computed class-element KEY to.
 *
 * `walkFile` keeps a stack of owner nodes, pushes one for every
 * function-like construct BEFORE descending into its children, and
 * attributes each call to the top of that stack. A class element's
 * computed name is one of those children -- so for the four element kinds
 * that ARE function-like (`MethodDeclaration`, covering instance, static,
 * `async` and generator methods) the key's calls were attributed to the
 * method's own node: a region that runs only if something calls the
 * method. A field and an accessor are not pushed, which is the whole
 * reason their keys already worked and the methods' did not.
 *
 * The fix visits the computed name under the ENCLOSING owner before the
 * member's node is pushed. These tests pin the resulting attribution
 * directly, because a verdict test can only observe the consequence: the
 * `from` of the edge is the actual claim RWF-023 makes.
 *
 * The companion suites are
 * `verdict.computed-class-key-module-load-reachability.integration.test.ts`
 * (the end-to-end verdicts) and
 * `fixtures/computed-class-key-module-load-reachability-ground-truth/`
 * (real node, asserted).
 */

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-rwf023-"));
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

/**
 * Builds a one-file graph whose module declares `key()` and places `body`
 * after it, then reports which owners have a resolved edge to `key`.
 */
async function ownersOfKeyCall(body: string): Promise<{
  readonly graph: CallGraph;
  readonly owners: readonly string[];
  readonly moduleOwned: boolean;
}> {
  const root = tempProject();
  const entry = write(
    root,
    "index.js",
    `function key() { return "x"; }\n${body}\n`,
  );
  const resolver = createModuleResolver(loadTsProject(root));
  const graph = await buildCallGraph({ entryFiles: [entry], resolver });

  const keyNode = graph.nodes.find((node) => node.name === "key");
  expect(keyNode, "the fixture must declare a `key` function").toBeDefined();

  const owners = graph.edges
    .filter(
      (edge) =>
        edge.resolution.kind === "resolved" &&
        edge.resolution.target === keyNode?.id,
    )
    .map((edge) => edge.from);

  const moduleNode = graph.nodes.find((node) => node.kind === "module");
  return {
    graph,
    owners,
    moduleOwned: owners.some((owner) => owner === moduleNode?.id),
  };
}

/** Every element kind whose computed key JavaScript evaluates at class-definition time. */
const REACHED_AT_MODULE_LOAD: ReadonlyArray<readonly [string, string]> = [
  ["a computed INSTANCE FIELD key", `class C { [key()] = 1; }`],
  ["a computed STATIC FIELD key", `class C { static [key()] = 1; }`],
  ["a computed INSTANCE METHOD key", `class C { [key()]() {} }`],
  ["a computed STATIC METHOD key", `class C { static [key()]() {} }`],
  ["a computed GETTER key", `class C { get [key()]() { return 1; } }`],
  ["a computed SETTER key", `class C { set [key()](v) {} }`],
  ["a computed ASYNC METHOD key", `class C { async [key()]() {} }`],
  ["a computed GENERATOR METHOD key", `class C { *[key()]() {} }`],
  ["a class EXPRESSION's method key", `const C = class { [key()]() {} };`],
  ["a PARENTHESIZED key", `class C { [(key())]() {} }`],
  ["a key nested inside another call", `class C { [String(key())]() {} }`],
  ["a key in a SEQUENCE expression", `class C { [(key(), "x")]() {} }`],
  ["a key in a TEMPLATE substitution", "class C { [`x${key()}`]() {} }"],
  ["a key as a LOGICAL OR operand", `class C { [key() || "x"]() {} }`],
  [
    "a key as a LOGICAL AND operand",
    `class C { [globalThis.f && key()]() {} }`,
  ],
  [
    "a key in a CONDITIONAL expression",
    `class C { [globalThis.f ? key() : "x"]() {} }`,
  ],
  [
    "a class inside a top-level IF",
    `if (globalThis.f) { class C { [key()]() {} } }`,
  ],
  [
    "a class expression in an OBJECT LITERAL",
    `const o = { C: class { [key()]() {} } };`,
  ],
  ["an OBJECT LITERAL's own method key", `const o = { [key()]() {} };`],
  [
    "a key under a VALID heritage clause",
    `class B {} class C extends B { [key()]() {} }`,
  ],
  [
    "a key under an INVALID heritage value, which runs before the TypeError",
    `function bad() { return 1; } class C extends bad() { [key()]() {} }`,
  ],
  [
    "a nested class held by a STATIC FIELD initializer",
    `class O { static inner = class I { [key()]() {} }; }`,
  ],
  [
    "a nested class inside a STATIC BLOCK",
    `class O { static { class I { [key()]() {} } this.i = I; } }`,
  ],
];

/**
 * The controls. Each uses the IDENTICAL computed key; only the position of
 * the class definition changes, and in every one of them the definition is
 * deferred, so the module must NOT own the key's call.
 */
const DEFERRED: ReadonlyArray<readonly [string, string]> = [
  [
    "a class inside an uncalled FUNCTION",
    `function configure() { class C { [key()]() {} } return C; }`,
  ],
  [
    "a class inside an uncalled ARROW",
    `const configure = () => { class C { [key()]() {} } return C; };`,
  ],
  [
    "a class inside a CALLBACK that is never invoked",
    `function never(cb) { return typeof cb; } never(function () { class C { [key()]() {} } });`,
  ],
  [
    "a class inside a METHOD body",
    `class O { m() { class C { [key()]() {} } return C; } }`,
  ],
  [
    "a class inside a GETTER body",
    `class O { get g() { class C { [key()]() {} } return C; } }`,
  ],
  [
    "a class inside a SETTER body",
    `class O { set s(v) { class C { [key()]() {} } this.c = C; } }`,
  ],
  [
    "a class inside a CONSTRUCTOR body",
    `class O { constructor() { class C { [key()]() {} } this.c = C; } }`,
  ],
  [
    "a nested class held by an INSTANCE FIELD",
    `class O { field = class I { [key()]() {} }; }`,
  ],
  [
    "an object literal held by an INSTANCE FIELD",
    `class O { literal = { [key()]() {} }; }`,
  ],
  [
    "a class in a METHOD PARAMETER default",
    `class O { m(x = class P { [key()]() {} }) { return x; } }`,
  ],
  [
    "a class in a SETTER PARAMETER default",
    `class O { set s(v = class P { [key()]() {} }) { this.v = v; } }`,
  ],
  [
    "a class two deferral levels deep",
    `function a() { return () => { class C { [key()]() {} } return C; }; }`,
  ],
];

describe("RWF-023: a computed class-element key executes during module evaluation", () => {
  describe("the module node owns the key's call", () => {
    for (const [label, body] of REACHED_AT_MODULE_LOAD) {
      it(`attributes ${label} to the module`, async () => {
        const { moduleOwned } = await ownersOfKeyCall(body);
        expect(moduleOwned).toBe(true);
      });
    }
  });

  describe("a DEFERRED class definition is not rooted at module load", () => {
    for (const [label, body] of DEFERRED) {
      it(`does not attribute ${label} to the module`, async () => {
        const { moduleOwned } = await ownersOfKeyCall(body);
        expect(moduleOwned).toBe(false);
      });
    }
  });

  it("still attributes the key's call to the enclosing function, not to nothing", async () => {
    const { owners, graph } = await ownersOfKeyCall(
      `function configure() { class C { [key()]() {} } return C; }`,
    );
    const configureNode = graph.nodes.find((node) => node.name === "configure");

    // The deferral controls assert the module does NOT own the call. This
    // asserts the complementary half -- the call did not simply vanish,
    // which would be the VT-201 completeness failure the whole graph is
    // built to avoid. `configure` owns it, and `configure` is unreachable.
    expect(owners).toContain(configureNode?.id);
  });

  it("keeps the method BODY separate from its own computed key", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "index.js",
      [
        `function key() { return "x"; }`,
        `function body() { return 1; }`,
        `class C { [key()]() { return body(); } }`,
      ].join("\n"),
    );
    const resolver = createModuleResolver(loadTsProject(root));
    const graph = await buildCallGraph({ entryFiles: [entry], resolver });

    const moduleNode = graph.nodes.find((node) => node.kind === "module");
    const bodyNode = graph.nodes.find((node) => node.name === "body");

    const moduleOwnsBody = graph.edges.some(
      (edge) =>
        edge.from === moduleNode?.id &&
        edge.resolution.kind === "resolved" &&
        edge.resolution.target === bodyNode?.id,
    );

    // The key runs at class-definition time; the body does not. Widening
    // the key's attribution must not drag the body along with it.
    expect(moduleOwnsBody).toBe(false);
  });

  it("adds the class-definition-time edge without removing the pre-existing one", async () => {
    const { owners, graph } = await ownersOfKeyCall(`class C { [key()]() {} }`);
    const moduleNode = graph.nodes.find((node) => node.kind === "module");
    const methodNode = graph.nodes.find((node) => node.kind === "method");

    // MONOTONICITY. Before RWF-023 the key's only edge came from the
    // method's own node; that edge is still there, and the module's is
    // added alongside it. A reachability fix must only ever ENLARGE the
    // reachable subgraph -- moving the edge could shrink it for a caller
    // that reaches the method by some route the module node does not
    // dominate, and a smaller subgraph is how a false NOT_AFFECTED is
    // born.
    expect(owners).toContain(moduleNode?.id);
    expect(owners).toContain(methodNode?.id);
  });

  it("resolves a member call written directly as the key, with no local wrapper", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/dep/package.json",
      `{ "name": "dep", "version": "1.0.0", "main": "index.js" }`,
    );
    write(
      root,
      "node_modules/dep/index.js",
      `exports.dangerousOp = function dangerousOp(x) { return x; };`,
    );
    const entry = write(
      root,
      "index.js",
      [
        `const dep = require("dep");`,
        `class C { [dep.dangerousOp("direct")]() {} }`,
      ].join("\n"),
    );

    const resolver = createModuleResolver(loadTsProject(root));
    const graph = await buildCallGraph({ entryFiles: [entry], resolver });

    const moduleNode = graph.nodes.find(
      (node) => node.kind === "module" && node.module === entry,
    );
    const target = graph.nodes.find((node) => node.name === "dangerousOp");

    // The most direct form the family has: the imported member call IS the
    // key. Nothing stands between the class definition and the sink.
    expect(
      graph.edges.some(
        (edge) =>
          edge.from === moduleNode?.id &&
          edge.resolution.kind === "resolved" &&
          edge.resolution.target === target?.id,
      ),
    ).toBe(true);
  });
});
