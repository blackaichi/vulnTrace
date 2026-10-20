import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallEdge, CallGraph } from "../domain/graph.js";
import {
  buildCallGraph,
  definitionIndexBuildCount,
  type InvocationAccountObservation,
} from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";

/**
 * Task BL-100 (RWF-142, RWF-149): what TypeScript's decorator helpers do
 * with a decorator's RESULT, at the graph level -- each rule of
 * `decoratorResultOf`, `decoratorResultEdges` and `replacedClassEdges`
 * (`call-graph.ts`) pinned by a named test.
 *
 * The end-to-end, real-Node versions are in
 * `tests/oracle/bl100-decorator-helper-calls.test.ts`.
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

async function build(files: Readonly<Record<string, string>>): Promise<Built> {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-bl100-"));
  tempDirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const observations: InvocationAccountObservation[] = [];
  const entryPath = path.join(root, "index.ts");
  const graph = await buildCallGraph({
    entryFiles: [entryPath],
    resolver: createModuleResolver(loadTsProject(root)),
    onInvocationAccount: (o) => observations.push(o),
  });
  return { graph, observations, entry: entryPath };
}

/** The node id of the function-like node named `name` (the unique one). */
function nodeNamed(graph: CallGraph, name: string, kind?: string): string {
  const matches = graph.nodes.filter(
    (n) => n.name === name && (kind === undefined || n.kind === kind),
  );
  expect(matches, `exactly one node named ${name}`).toHaveLength(1);
  return matches[0]!.id;
}

/** The edges of every site of `kind` the walk accounted. */
function siteEdges(built: Built, kind: string): CallEdge[] {
  return built.observations
    .filter((o) => o.site.kind === kind)
    .flatMap((o) => (o.account.kind === "edges" ? o.account.edges : []));
}

function targets(edges: readonly CallEdge[], kind: string): string[] {
  return edges.flatMap((e) =>
    e.resolution.kind === kind && "target" in e.resolution
      ? [e.resolution.target]
      : [],
  );
}

function unknownReasons(edges: readonly CallEdge[]): string[] {
  return edges.flatMap((e) =>
    e.resolution.kind === "unknown" ? [e.resolution.reason] : [],
  );
}

describe("a member decorator's result is handed to the helper (RWF-142)", () => {
  it("gives a possible edge to each function the returned object literal carries, from the class-definition owner", async () => {
    const built = await build({
      "index.ts":
        `function dec(t: any, k: string): any { return { set(v: any) { v(1); } }; }\n` +
        `class C { @dec x: any = 1; }\nnew C();\n`,
    });
    const edges = siteEdges(built, "decorator");
    expect(targets(edges, "resolved")).toEqual([nodeNamed(built.graph, "dec")]);
    expect(targets(edges, "possible")).toEqual([nodeNamed(built.graph, "set")]);
    expect(unknownReasons(edges)).toEqual([]);
    expect(edges.every((e) => e.from === `${built.entry}#<module>`)).toBe(true);
  });

  it("gives a possible edge to a returned function and to the imported target a descriptor names", async () => {
    const built = await build({
      "lib.js": `function parse() {}\nfunction safe() {}\nmodule.exports = { parse, safe };\n`,
      "index.ts":
        `import lib = require("./lib.js");\n` +
        `function a(t: any, k: string): any { return function init(v: any) { return v; }; }\n` +
        `function b(t: any, k: string): any { return { set: lib.parse }; }\n` +
        `class C { @a x: any = 1; @b y: any = 2; }\n`,
    });
    expect(targets(siteEdges(built, "decorator"), "possible")).toEqual([
      nodeNamed(built.graph, "init"),
      nodeNamed(built.graph, "parse"),
    ]);
    expect(unknownReasons(siteEdges(built, "decorator"))).toEqual([]);
  });

  it("adds nothing for a decorator with no return of a value, `return undefined` or `return void 0`", async () => {
    const built = await build({
      "index.ts":
        `function a(t: any, k: string): void {}\n` +
        `function b(t: any, k: string): any { if (k) { return; } return undefined; }\n` +
        `function c(t: any, k: string): any { return void 0; }\n` +
        `class C { @a x: any = 1; @b y: any = 2; @c z: any = 3; }\n`,
    });
    const edges = siteEdges(built, "decorator");
    expect(edges).toHaveLength(3);
    expect(edges.every((e) => e.resolution.kind === "resolved")).toBe(true);
  });

  it("reads only the decorator's own `return`s, not a nested function's", async () => {
    const built = await build({
      "index.ts":
        `function dec(t: any, k: string): void { const f = () => { return { set(v: any) { v(1); } }; }; f; }\n` +
        `class C { @dec x: any = 1; }\n`,
    });
    const edges = siteEdges(built, "decorator");
    expect(edges).toHaveLength(1);
    expect(targets(edges, "resolved")).toEqual([nodeNamed(built.graph, "dec")]);
  });

  it("gives an unknown edge for a returned value it cannot attribute: a parameter, or an object held by a name", async () => {
    const built = await build({
      "index.ts":
        `function a(t: any, k: string, d?: any): any { return d; }\n` +
        `function b(t: any, k: string): any { const d = { set(v: any) { v(1); } }; return d; }\n` +
        `class C { @a m() {} @b x: any = 1; }\n`,
    });
    expect(unknownReasons(siteEdges(built, "decorator"))).toEqual([
      "escaped_value",
      "escaped_value",
    ]);
  });

  it("gives an unknown edge for an async or generator decorator, whose result is not its `return`'s value", async () => {
    const built = await build({
      "index.ts":
        `async function a(t: any, k: string): Promise<any> { return 1; }\n` +
        `function* b(t: any, k: string): any { return 1; }\n` +
        `class C { @a x: any = 1; @b y: any = 2; }\n`,
    });
    expect(unknownReasons(siteEdges(built, "decorator"))).toEqual([
      "escaped_value",
      "escaped_value",
    ]);
  });

  it("gives an unknown edge for a returned imported function that may carry its own members", async () => {
    const built = await build({
      "lib.js": `function K() {}\nK.max = function () {};\nmodule.exports = { K };\n`,
      "index.ts":
        `import lib = require("./lib.js");\n` +
        `function dec(t: any, k: string): any { return { value: lib.K }; }\n` +
        `class C { @dec m() {} }\n`,
    });
    const edges = siteEdges(built, "decorator");
    expect(unknownReasons(edges)).toEqual(["escaped_value"]);
    expect(targets(edges, "possible")).toEqual([nodeNamed(built.graph, "K")]);
  });

  it("reads an imported decorator's returns in its own file", async () => {
    const built = await build({
      "decs.ts": `export function dec(t: any, k: string): any { return { set(v: any) { v(1); } }; }\n`,
      "index.ts": `import { dec } from "./decs";\nclass C { @dec x: any = 1; }\n`,
    });
    const edges = siteEdges(built, "decorator");
    expect(targets(edges, "possible")).toEqual([nodeNamed(built.graph, "set")]);
    expect(unknownReasons(edges)).toEqual([]);
  });

  it("adds nothing for a parameter decorator, whose result `__param` discards", async () => {
    const built = await build({
      "index.ts":
        `function dec(t: any, k: any, i: number): any { return { set(v: any) { v(1); } }; }\n` +
        `class C { constructor(@dec a: any) {} m(@dec b: any) {} }\n`,
    });
    const edges = siteEdges(built, "decorator");
    expect(edges).toHaveLength(2);
    expect(targets(edges, "possible")).toEqual([]);
  });

  it("adds nothing to a decorator call accounted only by an unknown edge (a factory's result)", async () => {
    const built = await build({
      "index.ts":
        `function make(): any { return (t: any, k: string) => ({ set(v: any) { v(1); } }); }\n` +
        `class C { @make() x: any = 1; }\n`,
    });
    const edges = siteEdges(built, "decorator");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.resolution.kind).toBe("unknown");
  });
});

describe("a class decorator's result replaces the class (RWF-149)", () => {
  it("constructs a class whose decorator returns a class through a possible edge, never a resolved one, and accounts the result", async () => {
    const built = await build({
      "index.ts":
        `function dec(c: any): any { return class R { constructor() {} }; }\n` +
        `@dec class C { constructor() {} }\nnew C();\n`,
    });
    const declared = nodeNamed(built.graph, "C", "constructor");
    const replacement = nodeNamed(built.graph, "R", "constructor");
    const edges = siteEdges(built, "construct");
    expect(targets(edges, "resolved")).toEqual([]);
    expect(targets(edges, "possible")).toEqual([declared, replacement]);
  });

  it("keeps the resolved construction when every class decorator returns nothing", async () => {
    const built = await build({
      "index.ts":
        `function a(c: any): void {}\nfunction b(c: any): any { return undefined; }\n` +
        `@a @b class C { constructor() {} }\nnew C();\n`,
    });
    expect(targets(siteEdges(built, "construct"), "resolved")).toEqual([
      nodeNamed(built.graph, "C", "constructor"),
    ]);
  });

  it("does not take a shadowed `undefined` for nothing: a local, and a parameter default (the independent audit's finding 3)", async () => {
    const built = await build({
      "index.ts":
        `function a(c: any): any { const undefined = class R { constructor() {} }; return undefined; }\n` +
        `function b(c: any, undefined: any = class S { constructor() {} }): any { return undefined; }\n` +
        `@a class C { constructor() {} }\n@b class D { constructor() {} }\nnew C();\nnew D();\n`,
    });
    const edges = siteEdges(built, "construct");
    expect(targets(edges, "resolved")).toEqual([]);
    expect(targets(edges, "possible")).toContain(
      nodeNamed(built.graph, "C", "constructor"),
    );
    expect(targets(edges, "possible")).toContain(
      nodeNamed(built.graph, "D", "constructor"),
    );
  });

  it("takes a class decorator it cannot read for an unknown result: a class (the site's call is unknown already)", async () => {
    const built = await build({
      "index.ts": `class D {}\n@(D as any) class C { constructor() {} }\nnew C();\n`,
    });
    const edges = siteEdges(built, "construct");
    expect(targets(edges, "resolved")).toEqual([]);
    expect(unknownReasons(edges)).toEqual(["escaped_value"]);
  });

  it("does not resolve a construction through a member decorator alone", async () => {
    const built = await build({
      "index.ts":
        `function dec(t: any, k: string): any { return { set(v: any) {} }; }\n` +
        `class C { @dec x: any = 1; constructor() {} }\nnew C();\n`,
    });
    expect(targets(siteEdges(built, "construct"), "resolved")).toEqual([
      nodeNamed(built.graph, "C", "constructor"),
    ]);
  });

  it("applies to an imported class and to an implicit `super` into a replaced base", async () => {
    const built = await build({
      "c.ts": `function dec(c: any): any { return class {}; }\n@dec export class C { constructor() {} }\n`,
      "index.ts": `import { C } from "./c";\nclass D extends C {}\nnew C();\nnew D();\n`,
    });
    const declared = nodeNamed(built.graph, "C", "constructor");
    expect(targets(siteEdges(built, "construct"), "resolved")).toEqual([
      nodeNamed(built.graph, "D", "constructor"),
    ]);
    expect(targets(siteEdges(built, "construct"), "possible")).toContain(
      declared,
    );
    const implicit = siteEdges(built, "implicit_super");
    expect(targets(implicit, "resolved")).toEqual([]);
    expect(targets(implicit, "possible")).toContain(declared);
  });

  it("does not resolve `Reflect.construct` of a replaced class", async () => {
    const built = await build({
      "index.ts":
        `function dec(c: any): any { return class {}; }\n` +
        `@dec class C { constructor() {} }\nReflect.construct(C, []);\n`,
    });
    const declared = nodeNamed(built.graph, "C", "constructor");
    const edges = siteEdges(built, "call");
    expect(targets(edges, "resolved")).not.toContain(declared);
    expect(targets(edges, "possible")).toContain(declared);
  });
});

describe("a constructed class is located by one index per file (the independent audit's finding 2)", () => {
  /** One class constructed `count` times at the top level of one file. */
  async function buildFor(count: number): Promise<number> {
    const before = definitionIndexBuildCount();
    await build({
      "index.ts":
        `function dec(c: any): void {}\n@dec class C { constructor() {} }\n` +
        `new C();\n`.repeat(count),
    });
    return definitionIndexBuildCount() - before;
  }

  it("builds the same number of definition indexes for 5 and for 500 constructions", async () => {
    const small = await buildFor(5);
    const large = await buildFor(500);
    expect(small).toBeGreaterThan(0);
    expect(large).toBe(small);
  });
});
