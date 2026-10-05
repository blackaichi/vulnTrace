import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallGraph } from "../domain/graph.js";
import { buildCallGraph } from "./call-graph.js";
import { memberWriteIndexBuilds } from "./member-writes.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";

/**
 * Task A-5b (docs/tasks/A-5b-receiver-member-writes.md): the receiver
 * authority that replaced VT-208 (ADR 0008 invariant A2, § 4; PRM-18), at
 * the graph level where the edge is visible. Each refusal and each member
 * write form has a named test, the one a mutation removing it fails (the
 * task file lists them); each group has controls that still resolve, so a
 * refusal that fired everywhere fails too.
 *
 * - THE RECEIVER: a stable class (`C.m()`) or a `const` bound to
 *   `new C()` (`x.m()`), nothing else.
 * - THE CHAIN: plain class declarations; the runtime's lookup, with fields
 *   as own properties.
 * - THE WRITES: a resolved method edge is withdrawn to
 *   `receiver_member_written` when any prepared file may write the member.
 *
 * The real-Node versions are in `tests/oracle/a5b-receiver-member-writes.*`.
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function graphFor(
  files: Readonly<Record<string, string>>,
  entry = "src/index.js",
): Promise<CallGraph> {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-a5b-"));
  tempDirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const resolver = createModuleResolver(loadTsProject(root));
  return buildCallGraph({
    entryFiles: [path.join(root, entry)],
    resolver,
  });
}

/** What the edges out of the one node named `from` resolve to: `resolved <name>`, `possible <name>`, `unknown <reason>`. */
function accountOf(graph: CallGraph, from = "main"): string[] {
  const nodes = graph.nodes.filter((n) => n.name === from);
  expect(nodes, `exactly one node named ${from}`).toHaveLength(1);
  const nameOf = (id: string): string =>
    graph.nodes.find((n) => n.id === id)?.name ?? id;
  return graph.edges
    .filter((e) => e.from === nodes[0]!.id)
    .map((e) =>
      e.resolution.kind === "unknown"
        ? `unknown ${e.resolution.reason}`
        : `${e.resolution.kind} ${nameOf(e.resolution.target)}`,
    );
}

/** A one-file program: `defs`, then `function main() { body }`. */
function program(defs: string, body: string, after = ""): string {
  return `${defs}\nfunction main() {\n${body}\n}\n${after}\nmain();\n`;
}

const RUN = `class C {\n  run(x) { return x; }\n}\n`;
const RESOLVED = ["resolved run"];
const WITHDRAWN = ["unknown receiver_member_written"];

// ---------------------------------------------------------------------------
// The receiver
// ---------------------------------------------------------------------------

describe("the receiver authority resolves a stable class and a const bound to new (ADR 0008 A2, § 4)", () => {
  it("control: a const bound to `new C()`", async () => {
    const graph = await graphFor({
      "src/index.js": program(RUN, "const x = new C();\nx.run(1);"),
    });
    expect(accountOf(graph)).toEqual(["resolved C", "resolved run"]);
  });

  it("control: a static method on a stable class", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class C {\n  static run(x) { return x; }\n}\n`,
        "C.run(1);",
      ),
    });
    expect(accountOf(graph)).toEqual(RESOLVED);
  });

  it("control: a const aliasing a const bound to `new C()`", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        RUN,
        "const x = new C();\nconst y = x;\ny.run(1);",
      ),
    });
    expect(accountOf(graph)).toContain("resolved run");
  });

  it("control: a class required from another file", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `const { C } = require("./c.js");\n`,
        "const x = new C();\nx.run(1);",
      ),
      "src/c.js": `${RUN}module.exports = { C };\n`,
    });
    expect(accountOf(graph)).toContain("resolved run");
  });

  it("refuses a `let` receiver (PRM-18: a reassignable binding)", async () => {
    const graph = await graphFor({
      "src/index.js": program(RUN, "let x = new C();\nx.run(1);"),
    });
    expect(accountOf(graph)).toEqual([
      "resolved C",
      "unknown unsupported_receiver_binding",
    ]);
  });

  it("refuses a `var` receiver", async () => {
    const graph = await graphFor({
      "src/index.js": program(RUN, "var x = new C();\nx.run(1);"),
    });
    expect(accountOf(graph)).toEqual([
      "resolved C",
      "unknown unsupported_receiver_binding",
    ]);
  });

  it("refuses a parameter receiver", async () => {
    const graph = await graphFor({
      "src/index.js": `${RUN}function main(x) { x.run(1); }\nmain(new C());\n`,
    });
    expect(accountOf(graph)).toEqual(["unknown unsupported_receiver_binding"]);
  });

  it("refuses a `this` receiver (PRM-18: an override in the instantiated subclass)", async () => {
    const graph = await graphFor({
      "src/index.js": `class Base {\n  start() { return this.run(); }\n  run() {}\n}\nconst b = new Base();\nb.start();\n`,
    });
    expect(accountOf(graph, "start")).toEqual([
      "unknown unsupported_this_receiver",
    ]);
  });

  it("refuses an inline `new C()` receiver", async () => {
    const graph = await graphFor({
      "src/index.js": program(RUN, "new C().run(1);"),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses a const bound to a choice between two constructions", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `${RUN}class D {\n  run(x) { return x; }\n}\n`,
        "const x = Math.random() ? new C() : new D();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses an element-access receiver", async () => {
    const graph = await graphFor({
      "src/index.js": program(RUN, "const xs = [new C()];\nxs[0].run(1);"),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses a class EXPRESSION", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `const C = class {\n  run(x) { return x; }\n};\n`,
        "const x = new C();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses a reassigned class binding, static and instance (PRM-18)", async () => {
    const statics = await graphFor({
      "src/index.js": program(
        `class C {\n  static run(x) { return x; }\n}\nC = class {};\n`,
        "C.run(1);",
      ),
    });
    expect(accountOf(statics)).not.toContain("resolved run");
    const instance = await graphFor({
      "src/index.js": program(
        `${RUN}C = class {};\n`,
        "const x = new C();\nx.run(1);",
      ),
    });
    expect(accountOf(instance)).not.toContain("resolved run");
  });

  it("refuses an imported class its own file reassigns", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `const { C } = require("./c.js");\n`,
        "const x = new C();\nx.run(1);",
      ),
      "src/c.js": `${RUN}function swap() { C = class {}; }\nmodule.exports = { C, swap };\n`,
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses an ES module class its own file reassigns", async () => {
    const graph = await graphFor(
      {
        "src/index.mjs": program(
          `import { C } from "./c.mjs";\n`,
          "const x = new C();\nx.run(1);",
        ),
        "src/c.mjs": `export ${RUN}export function swap() { C = class {}; }\n`,
      },
      "src/index.mjs",
    );
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses a named class expression's self-binding (not a declaration)", async () => {
    const graph = await graphFor({
      "src/index.js": `const K = class C {\n  static run(x) { return x; }\n  static go() { return C.run(1); }\n};\nK.go();\n`,
    });
    expect(accountOf(graph, "go")).not.toContain("resolved run");
  });

  it("refuses an instance call of a static-only method", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class C {\n  static run(x) { return x; }\n}\n`,
        "const x = new C();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses an alias hop through a `let`", async () => {
    const graph = await graphFor({
      "src/index.js": program(RUN, "const x = new C();\nlet y = x;\ny.run(1);"),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses a destructured import binding that is reassigned", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `let { C } = require("./c.js");\nC = class {\n  run(x) { return -x; }\n};\n`,
        "const x = new C();\nx.run(1);",
      ),
      "src/c.js": `${RUN}module.exports = { C };\n`,
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });
});

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

describe("the chain is plain class declarations, looked up as the runtime does", () => {
  it("control: a static method found before a non-plain base needs nothing above it", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class C extends Map {\n  static run(x) { return x; }\n}\n`,
        "C.run(1);",
      ),
    });
    expect(accountOf(graph)).toEqual(RESOLVED);
  });

  it("control: an inherited method through a chain of plain classes", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class Base {\n  run(x) { return x; }\n}\nclass Sub extends Base {}\n`,
        "const x = new Sub();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).toContain("resolved run");
  });

  it("control: a static method inherited from the base", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class Base {\n  static run(x) { return x; }\n}\nclass Sub extends Base {}\n`,
        "Sub.run(1);",
      ),
    });
    expect(accountOf(graph)).toEqual(RESOLVED);
  });

  it("control: an accessor ABOVE the method found does not shadow it", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class Base {\n  get run() { return 1; }\n}\nclass Sub extends Base {\n  run(x) { return x; }\n}\n`,
        "const x = new Sub();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).toContain("resolved run");
  });

  it("control: a static field above the static method found does not shadow it", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class Base {\n  static run = 1;\n}\nclass Sub extends Base {\n  static run(x) { return x; }\n}\n`,
        "Sub.run(1);",
      ),
    });
    expect(accountOf(graph)).toEqual(RESOLVED);
  });

  it("control: a `return` in a function nested in the constructor", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class C {\n  constructor() { this.f = () => { return 1; }; }\n  run(x) { return x; }\n}\n`,
        "const x = new C();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).toContain("resolved run");
  });

  it("control: a literal computed name is read", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class C {\n  ["run"](x) { return x; }\n}\n`,
        "const x = new C();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).toContain('resolved ["run"]');
  });

  it("refuses a builtin base", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class C extends Map {\n  run(x) { return x; }\n}\n`,
        "const x = new C();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses a function-constructor base, even below the method found", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `function B() {}\nclass C extends B {\n  run(x) { return x; }\n}\n`,
        "const x = new C();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses a base produced by a call (a mixin)", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class Base {}\nfunction mix(B) { return B; }\nclass C extends mix(Base) {\n  run(x) { return x; }\n}\n`,
        "const x = new C();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses a constructor that returns (PRM-18)", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class C {\n  constructor() { return {}; }\n  run(x) { return x; }\n}\n`,
        "const x = new C();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses a BASE constructor that returns", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class Base {\n  constructor() { return {}; }\n}\nclass Sub extends Base {\n  run(x) { return x; }\n}\n`,
        "const x = new Sub();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses a field of the name in the same class (PRM-18)", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class C {\n  run(x) { return x; }\n  run = (x) => x;\n}\n`,
        "const x = new C();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses a field of the name in a BASE class (PRM-18)", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class Base {\n  run = (x) => x;\n}\nclass Sub extends Base {\n  run(x) { return x; }\n}\n`,
        "const x = new Sub();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses an accessor of the name before the method", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class Base {\n  run(x) { return x; }\n}\nclass Sub extends Base {\n  get run() { return () => 1; }\n}\n`,
        "const x = new Sub();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses two implementations of the name in one class", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `class C {\n  run(x) { return x; }\n  run(x) { return -x; }\n}\n`,
        "const x = new C();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses a computed member name the analyzer cannot read", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `const k = String("run");\nclass C {\n  [k](x) { return -x; }\n  run(x) { return x; }\n}\n`,
        "const x = new C();\nx.run(1);",
      ),
    });
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("refuses a static field and a static accessor of the name", async () => {
    const field = await graphFor({
      "src/index.js": program(
        `class C {\n  static run(x) { return x; }\n  static run = (x) => x;\n}\n`,
        "C.run(1);",
      ),
    });
    expect(accountOf(field)).not.toContain("resolved run");
    const accessor = await graphFor({
      "src/index.js": program(
        `class Base {\n  static run(x) { return x; }\n}\nclass Sub extends Base {\n  static get run() { return () => 1; }\n}\n`,
        "Sub.run(1);",
      ),
    });
    expect(accountOf(accessor)).not.toContain("resolved run");
  });

  it("refuses a decorated class, and a decorated member (TypeScript)", async () => {
    const onClass = await graphFor(
      {
        "src/index.ts": program(
          `function dec(c: any) { return c; }\n@dec\nclass C {\n  run(x: number) { return x; }\n}\n`,
          "const x = new C();\nx.run(1);",
        ),
      },
      "src/index.ts",
    );
    expect(accountOf(onClass)).not.toContain("resolved run");
    const onMember = await graphFor(
      {
        "src/index.ts": program(
          `function dec(t: any, k: any, d: any) { return d; }\nclass C {\n  @dec\n  run(x: number) { return x; }\n}\n`,
          "const x = new C();\nx.run(1);",
        ),
      },
      "src/index.ts",
    );
    expect(accountOf(onMember)).not.toContain("resolved run");
  });

  it("refuses a TypeScript parameter property of the name", async () => {
    const graph = await graphFor(
      {
        "src/index.ts": program(
          `class Base {\n  run(x: number) { return x; }\n}\nclass Sub extends Base {\n  constructor(public run: (x: number) => number) { super(); }\n}\n`,
          "const x = new Sub((n) => n);\nx.run(1);",
        ),
      },
      "src/index.ts",
    );
    expect(accountOf(graph)).not.toContain("resolved run");
  });

  it("control: overload signatures and a `declare` field have no runtime presence (TypeScript)", async () => {
    const overloads = await graphFor(
      {
        "src/index.ts": program(
          `class C {\n  run(): number;\n  run(x: number): number;\n  run(x?: number) { return x ?? 0; }\n}\n`,
          "const x = new C();\nx.run(1);",
        ),
      },
      "src/index.ts",
    );
    expect(accountOf(overloads)).toContain("resolved run");
    const declared = await graphFor(
      {
        "src/index.ts": program(
          `class Base {\n  run(x: number) { return x; }\n}\nclass Sub extends Base {\n  declare run: (x: number) => number;\n}\n`,
          "const x = new Sub();\nx.run(1);",
        ),
      },
      "src/index.ts",
    );
    expect(accountOf(declared)).toContain("resolved run");
  });
});

// ---------------------------------------------------------------------------
// The whole-graph member-write check
// ---------------------------------------------------------------------------

/** `body` is placed after the instance's construction; `x` is the instance, `C` the class. */
async function withWrite(body: string, extra = ""): Promise<string[]> {
  const graph = await graphFor({
    "src/index.js": program(
      `${RUN}function helper(x) { return x; }\n${extra}`,
      "const x = new C();\nx.run(1);",
      body,
    ),
  });
  return accountOf(graph);
}

describe("a resolved method edge is withdrawn when any prepared file may write the member (the decision of 2026-10-04)", () => {
  it("control: nothing writes the member", async () => {
    expect(await withWrite("")).toEqual(["resolved C", "resolved run"]);
  });

  it("control: a write to a member of another name", async () => {
    expect(await withWrite("C.prototype.other = helper;")).toContain(
      "resolved run",
    );
  });

  it("withdraws on an assignment, naming the method it no longer proves", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        RUN,
        "const x = new C();\nx.run(1);",
        "C.prototype.run = function other() {};",
      ),
    });
    const run = graph.nodes.find((n) => n.name === "run");
    const main = graph.nodes.find((n) => n.name === "main");
    const edge = graph.edges.find(
      (e) => e.from === main?.id && e.type === "method",
    );
    expect(edge?.resolution).toEqual({
      kind: "unknown",
      reason: "receiver_member_written",
      potentialTargets: [run?.id],
    });
  });

  it("withdraws on a write in ANOTHER prepared file (PRM-18: the third file)", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `const { C } = require("./c.js");\nrequire("./patch.js");\n`,
        "C.run(1);",
      ),
      "src/c.js": `class C {\n  static run(x) { return x; }\n}\nmodule.exports = { C };\n`,
      "src/patch.js": `const { C } = require("./c.js");\nC.run = function other() {};\n`,
    });
    expect(accountOf(graph)).toEqual(WITHDRAWN);
  });

  it("withdraws on a compound assignment, `delete`, a destructuring and a for-of target", async () => {
    expect(await withWrite("x.run ||= helper;")).toContain(WITHDRAWN[0]);
    expect(await withWrite("delete C.prototype.run;")).toContain(WITHDRAWN[0]);
    expect(await withWrite("[C.prototype.run] = [helper];")).toContain(
      WITHDRAWN[0],
    );
    expect(await withWrite("for (C.prototype.run of [helper]) {}")).toContain(
      WITHDRAWN[0],
    );
  });

  it("withdraws on a dynamic key", async () => {
    expect(
      await withWrite("const k = String('run');\nx[k] = helper;"),
    ).toContain(WITHDRAWN[0]);
  });

  it("withdraws on a `__proto__` write (PRM-18)", async () => {
    expect(await withWrite("x.__proto__ = {};")).toContain(WITHDRAWN[0]);
  });

  it('withdraws on a `"__proto__"` string handed to a call (the setter through its descriptor)', async () => {
    expect(
      await withWrite(
        `Object.getOwnPropertyDescriptor(Object.prototype, "__proto__").set.call(x, {});`,
      ),
    ).toContain(WITHDRAWN[0]);
  });

  it("withdraws on a `with` statement (PRM-18)", async () => {
    expect(await withWrite("with (x) { run = helper; }")).toContain(
      WITHDRAWN[0],
    );
  });

  it("withdraws on Object.defineProperty and Reflect.defineProperty with the name", async () => {
    expect(
      await withWrite(
        `Object.defineProperty(C.prototype, "run", { value: 1 });`,
      ),
    ).toContain(WITHDRAWN[0]);
    expect(
      await withWrite(
        `Reflect.defineProperty(C.prototype, "run", { value: 1 });`,
      ),
    ).toContain(WITHDRAWN[0]);
  });

  it("control: Object.defineProperty with another literal name", async () => {
    expect(
      await withWrite(
        `Object.defineProperty(C.prototype, "other", { value: 1 });`,
      ),
    ).toContain("resolved run");
  });

  it("withdraws on Object.defineProperty with a key it cannot read", async () => {
    expect(
      await withWrite(
        `const k = String("run");\nObject.defineProperty(C.prototype, k, { value: 1 });`,
      ),
    ).toContain(WITHDRAWN[0]);
  });

  it("withdraws on Object.defineProperties with the name", async () => {
    expect(
      await withWrite(
        `Object.defineProperties(C.prototype, { run: { value: 1 } });`,
      ),
    ).toContain(WITHDRAWN[0]);
  });

  it("withdraws on Object.assign with the name, or with a source it cannot read", async () => {
    expect(await withWrite(`Object.assign(x, { run: helper });`)).toContain(
      WITHDRAWN[0],
    );
    expect(
      await withWrite(`const src = { run: helper };\nObject.assign(x, src);`),
    ).toContain(WITHDRAWN[0]);
  });

  it("withdraws on a computed or shorthand `__proto__` key copied by Object.assign (the audit's finding 1)", async () => {
    expect(
      await withWrite(`Object.assign(x, { ["__proto__"]: {} });`),
    ).toContain(WITHDRAWN[0]);
    expect(
      await withWrite(
        `const __proto__ = {};\nObject.assign(x, { __proto__ });`,
      ),
    ).toContain(WITHDRAWN[0]);
  });

  it("control: a plain `__proto__:` key is the literal's prototype, not a property", async () => {
    expect(
      await withWrite(`Object.assign(x, { __proto__: null, other: 1 });`),
    ).toContain("resolved run");
  });

  it("control: Object.assign onto a fresh literal", async () => {
    expect(
      await withWrite(`const src = { run: helper };\nObject.assign({}, src);`),
    ).toContain("resolved run");
  });

  it("withdraws on Object.setPrototypeOf, Reflect.setPrototypeOf and util.inherits", async () => {
    expect(await withWrite(`Object.setPrototypeOf(x, {});`)).toContain(
      WITHDRAWN[0],
    );
    expect(await withWrite(`Reflect.setPrototypeOf(x, {});`)).toContain(
      WITHDRAWN[0],
    );
    expect(
      await withWrite(`require("util").inherits(C, function B() {});`),
    ).toContain(WITHDRAWN[0]);
    expect(
      await withWrite(
        `inherits(C, function B() {});`,
        `const { inherits } = require("util");\n`,
      ),
    ).toContain(WITHDRAWN[0]);
  });

  it("withdraws on Reflect.set and Reflect.deleteProperty with the name", async () => {
    expect(await withWrite(`Reflect.set(x, "run", helper);`)).toContain(
      WITHDRAWN[0],
    );
    expect(
      await withWrite(`Reflect.deleteProperty(C.prototype, "run");`),
    ).toContain(WITHDRAWN[0]);
  });

  it("control: a `set` that is not Reflect's (Map#set)", async () => {
    expect(
      await withWrite(`const m = new Map();\nm.set("run", helper);`),
    ).toContain("resolved run");
  });

  it("withdraws on __defineGetter__ and __defineSetter__ with the name", async () => {
    expect(
      await withWrite(`x.__defineGetter__("run", () => helper);`),
    ).toContain(WITHDRAWN[0]);
    expect(await withWrite(`x.__defineSetter__("run", () => {});`)).toContain(
      WITHDRAWN[0],
    );
  });

  it("withdraws on an ES module's named import of a mutator", async () => {
    const graph = await graphFor(
      {
        "src/index.mjs": program(
          `import { inherits } from "node:util";\n${RUN}`,
          "const x = new C();\nx.run(1);",
          "inherits(C, function B() {});",
        ),
      },
      "src/index.mjs",
    );
    expect(accountOf(graph)).toContain(WITHDRAWN[0]);
  });

  it("withdraws on a mutator destructured from a value that is not Object", async () => {
    expect(
      await withWrite(
        `function take({ defineProperty }) { return defineProperty; }\nvoid take;`,
      ),
    ).toContain(WITHDRAWN[0]);
  });

  it("withdraws on a mutator taken under another name", async () => {
    expect(
      await withWrite(
        `const { defineProperty } = Object;\ndefineProperty(x, "other", { value: 1 });`,
      ),
    ).toContain(WITHDRAWN[0]);
    expect(
      await withWrite(
        `const dp = Object.defineProperty;\ndp(x, "other", { value: 1 });`,
      ),
    ).toContain(WITHDRAWN[0]);
    expect(
      await withWrite(
        `Object.defineProperty.call(null, x, "other", { value: 1 });`,
      ),
    ).toContain(WITHDRAWN[0]);
  });

  it("withdraws on Object or Reflect used as a value, or read with a dynamic key", async () => {
    expect(await withWrite(`const O = Object;\nvoid O;`)).toContain(
      WITHDRAWN[0],
    );
    expect(await withWrite(`const R = [Reflect];\nvoid R;`)).toContain(
      WITHDRAWN[0],
    );
    expect(
      await withWrite(`const k = String("keys");\nvoid Object[k];`),
    ).toContain(WITHDRAWN[0]);
    expect(
      await withWrite(`const k = String("Object");\nvoid globalThis[k];`),
    ).toContain(WITHDRAWN[0]);
  });

  it("control: Object and Reflect used inertly", async () => {
    expect(
      await withWrite(
        `void Object.keys(x);\nvoid (x instanceof Object);\nvoid (typeof Reflect);\nvoid Object(x);`,
      ),
    ).toContain("resolved run");
  });

  it("a withdrawn edge's arguments get the escape row's edges an unknown callee gets (ADR 0008 § 2)", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `${RUN}function helper(x) { return x; }\n`,
        "const x = new C();\nx.run(helper);",
        "C.prototype.run = function other() {};",
      ),
    });
    expect(accountOf(graph)).toEqual([
      "resolved C",
      "unknown receiver_member_written",
      "possible helper",
    ]);
  });

  it("control: a resolved edge's arguments get no escape edge", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `${RUN}function helper(x) { return x; }\n`,
        "const x = new C();\nx.run(helper);",
      ),
    });
    expect(accountOf(graph)).toEqual(["resolved C", "resolved run"]);
  });
});

describe("a method edge is withdrawn when the export slot its class was read from is written (the audit's finding 2)", () => {
  const LIB = `class Lib {\n  static run(x) { return x; }\n  go(x) { return x; }\n}\nclass Evil {}\nmodule.exports = { Lib, Evil };\n`;

  it("control: nothing writes the slot", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `const m = require("./lib.js");\n`,
        "m.Lib.run(1);",
      ),
      "src/lib.js": LIB,
    });
    expect(accountOf(graph)).toEqual(RESOLVED);
  });

  it("withdraws a static call when the slot is written", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `const m = require("./lib.js");\n`,
        "m.Lib.run(1);",
        "m.Lib = m.Evil;",
      ),
      "src/lib.js": LIB,
    });
    expect(accountOf(graph)).toEqual(WITHDRAWN);
  });

  it("withdraws an instance call when the slot is written in the defining file", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `const { Lib } = require("./lib.js");\n`,
        "const x = new Lib();\nx.go(1);",
      ),
      "src/lib.js": `${LIB}function swap() { module.exports.Lib = module.exports.Evil; }\nmodule.exports.swap = swap;\n`,
    });
    expect(accountOf(graph)).toContain(WITHDRAWN[0]);
  });
});

// ---------------------------------------------------------------------------
// Structure: what the whole-graph check costs (ARCHITECTURE § 10)
// ---------------------------------------------------------------------------

describe("the whole-graph member-write check is one index build per prepared file, and none without a method edge", () => {
  it("builds no index when no method edge was resolved", async () => {
    const before = memberWriteIndexBuilds();
    await graphFor({
      "src/index.js": program(`const { f } = require("./a.js");\n`, "f();"),
      "src/a.js": `function f() {}\nmodule.exports = { f };\n`,
    });
    expect(memberWriteIndexBuilds() - before).toBe(0);
  });

  it("builds at most one index per prepared file, however many method edges", async () => {
    const before = memberWriteIndexBuilds();
    const graph = await graphFor({
      "src/index.js": program(
        `const { C } = require("./c.js");\nrequire("./d.js");\n`,
        "const x = new C();\nx.run(1);\nx.go(1);\nx.run(2);\nC.make();",
      ),
      "src/c.js": `class C {\n  run(x) { return x; }\n  go(x) { return x; }\n  static make() { return new C(); }\n}\nmodule.exports = { C };\n`,
      "src/d.js": `module.exports = {};\n`,
    });
    const files = new Set(graph.nodes.map((n) => n.module)).size;
    expect(files).toBe(3);
    expect(memberWriteIndexBuilds() - before).toBeLessThanOrEqual(files);
    expect(memberWriteIndexBuilds() - before).toBeGreaterThan(0);
  });
});
