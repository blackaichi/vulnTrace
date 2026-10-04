import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallEdge, CallGraph, NoEdgeProof } from "../domain/graph.js";
import {
  buildCallGraph,
  type InvocationAccountObservation,
} from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";

/**
 * Task A-1: the invocation accounts ADR 0008 § 8 assigns to A-1 --
 * tagged templates (PRM-37), decorators (PRM-115), implicit `super`
 * (PRM-19) -- at the graph level, where the edge's `from` and target are
 * visible; and (task A-5a) the owner tests of the two no-edge proofs that
 * replaced the last unproven no-edge accounts: `ambient_static_require`
 * (PRM-15) and `provably_dead_branch` (PRM-14).
 *
 * The end-to-end, real-Node versions of the same shapes are in
 * `tests/oracle/a1-invocation-sites.test.ts`.
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

async function build(
  files: Readonly<Record<string, string>>,
  entry = "index.js",
): Promise<Built> {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-a1-"));
  tempDirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const observations: InvocationAccountObservation[] = [];
  const entryPath = path.join(root, entry);
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

function moduleNode(built: Built): string {
  return `${built.entry}#<module>`;
}

function edgesFrom(graph: CallGraph, from: string): CallEdge[] {
  return graph.edges.filter((e) => e.from === from && e.type !== "module_load");
}

function resolvedTargets(graph: CallGraph, from: string): string[] {
  return edgesFrom(graph, from).flatMap((e) =>
    e.resolution.kind === "resolved" ? [e.resolution.target] : [],
  );
}

function unknownReasons(graph: CallGraph, from: string): string[] {
  return edgesFrom(graph, from).flatMap((e) =>
    e.resolution.kind === "unknown" ? [e.resolution.reason] : [],
  );
}

function noEdgeProofs(built: Built, siteKind: string): NoEdgeProof["kind"][] {
  return built.observations
    .filter((o) => o.site.kind === siteKind)
    .flatMap((o) =>
      o.account.kind === "no_edge" ? [o.account.proof.kind] : [],
    );
}

// ---------------------------------------------------------------------------
// PRM-37 -- tagged templates
// ---------------------------------------------------------------------------

describe("a tagged template is a call to its tag (PRM-37)", () => {
  it("resolves a same-file tag, from the owner that evaluates the template", async () => {
    const built = await build({
      "index.js": `function tag(s) { return s; }\ntag\`x\`;\n`,
    });
    expect(resolvedTargets(built.graph, moduleNode(built))).toContain(
      nodeNamed(built.graph, "tag"),
    );
  });

  it("resolves an imported tag to the exporting module's function", async () => {
    const built = await build({
      "lib.js": `function parse(s) { return s; }\nfunction safe(s) { return s; }\nmodule.exports = { parse, safe };\n`,
      "index.js": `const lib = require("./lib.js");\nlib.parse\`x\`;\n`,
    });
    const targets = resolvedTargets(built.graph, moduleNode(built));
    expect(targets).toContain(nodeNamed(built.graph, "parse"));
    expect(targets).not.toContain(nodeNamed(built.graph, "safe"));
  });

  it("gives an unattributable tag an unknown edge, never nothing", async () => {
    const built = await build({
      "index.js": `const tags = [(s) => s];\ntags[0]\`x\`;\n`,
    });
    expect(unknownReasons(built.graph, moduleNode(built))).toEqual([
      "dynamic_member_access",
    ]);
  });

  it("classifies a loader tag before resolving it: vm.runInThisContext runs the template text", async () => {
    const built = await build({
      "index.js": `const vm = require("vm");\nvm.runInThisContext\`1 + 1\`;\n`,
    });
    expect(unknownReasons(built.graph, moduleNode(built))).toEqual([
      "vm_execution",
    ]);
  });

  it("gives a tag's one inline callback no resolved callback edge (PRM-13; VT-213's fallback is deleted)", async () => {
    const built = await build({
      "index.js": `function helper() { return 1; }\nconst tags = [];\ntags[0]\`\${() => helper()}\`;\n`,
    });
    const from = moduleNode(built);
    expect(unknownReasons(built.graph, from)).toEqual([
      "dynamic_member_access",
    ]);
    expect(
      edgesFrom(built.graph, from).filter((e) => e.type === "callback"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PRM-19 -- implicit super
// ---------------------------------------------------------------------------

describe("a derived class's implicit constructor constructs its base (PRM-19)", () => {
  it("edges the implicit constructor node to the base constructor", async () => {
    const built = await build({
      "index.js": `class Base { constructor() { this.x = 1; } }\nclass Sub extends Base {}\nnew Sub();\n`,
    });
    const sub = nodeNamed(built.graph, "Sub", "constructor");
    const base = nodeNamed(built.graph, "Base", "constructor");
    expect(edgesFrom(built.graph, sub)).toEqual([
      expect.objectContaining({
        type: "constructor",
        resolution: { kind: "resolved", target: base },
      }),
    ]);
  });

  it("chains through a base that itself has an implicit constructor", async () => {
    const built = await build({
      "index.js": `class Base { constructor() {} }\nclass Mid extends Base {}\nclass Leaf extends Mid {}\n`,
    });
    const leaf = nodeNamed(built.graph, "Leaf", "constructor");
    const mid = nodeNamed(built.graph, "Mid", "constructor");
    const base = nodeNamed(built.graph, "Base", "constructor");
    expect(resolvedTargets(built.graph, leaf)).toEqual([mid]);
    expect(resolvedTargets(built.graph, mid)).toEqual([base]);
  });

  it("resolves an imported base class", async () => {
    const built = await build({
      "lib.js": `class Base { constructor() {} }\nmodule.exports = { Base };\n`,
      "index.js": `const { Base } = require("./lib.js");\nclass Sub extends Base {}\n`,
    });
    const sub = nodeNamed(built.graph, "Sub", "constructor");
    expect(resolvedTargets(built.graph, sub)).toEqual([
      nodeNamed(built.graph, "Base", "constructor"),
    ]);
  });

  it("gives an unattributable base an unknown edge from the implicit constructor", async () => {
    const built = await build({
      "index.js": `const bases = [class {}];\nclass Sub extends bases[0] {}\n`,
    });
    const sub = nodeNamed(built.graph, "Sub", "constructor");
    expect(unknownReasons(built.graph, sub)).toEqual(["dynamic_member_access"]);
  });

  it("classifies a loader base: a subclass of worker_threads.Worker starts a worker", async () => {
    const built = await build({
      "index.js": `const { Worker } = require("worker_threads");\nclass W extends Worker {}\n`,
    });
    const w = nodeNamed(built.graph, "W", "constructor");
    expect(unknownReasons(built.graph, w)).toEqual(["worker_execution"]);
  });

  it("accounts an ambient base by the builtin table: the forwarded arguments are values it cannot see (task A-3a)", async () => {
    // Before task A-3a this was the unproven `ambient_global_callee`
    // account. `Error`'s first position is admitted since task A-4, but
    // its second (`{ cause }`, stored on the error) never is, and the
    // forwarded `...args` may fill any position: the fail-closed unknown
    // edge.
    const built = await build({
      "index.js": `class MyError extends Error {}\n`,
    });
    const myError = nodeNamed(built.graph, "MyError", "constructor");
    expect(unknownReasons(built.graph, myError)).toEqual(["escaped_value"]);
    expect(noEdgeProofs(built, "implicit_super")).toEqual([]);
  });

  it("gives a base class, and a class with its own constructor, no implicit-super account", async () => {
    const built = await build({
      "index.js": `class Base {}\nclass Own extends Base { constructor() { super(); } }\n`,
    });
    expect(
      built.observations.filter((o) => o.site.kind === "implicit_super"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PRM-115 -- decorators
// ---------------------------------------------------------------------------

describe("a decorator is called at class definition (PRM-115)", () => {
  const LOGGED = `function logged(...args) { return undefined; }\n`;

  it("edges a class decorator from the owner that evaluates the class", async () => {
    const built = await build(
      { "index.ts": LOGGED + `@logged\nclass X {}\n` },
      "index.ts",
    );
    expect(resolvedTargets(built.graph, moduleNode(built))).toContain(
      nodeNamed(built.graph, "logged"),
    );
  });

  it("edges a method, static-method, accessor, field and parameter decorator from the class-definition owner, never from the member", async () => {
    const built = await build(
      {
        "index.ts":
          LOGGED +
          `class X {\n` +
          `  @logged m() {}\n` +
          `  @logged static s() {}\n` +
          `  @logged get g() { return 1; }\n` +
          `  @logged f = 1;\n` +
          `  constructor(@logged a: any) {}\n` +
          `  n(@logged b: any) {}\n` +
          `}\n`,
      },
      "index.ts",
    );
    const logged = nodeNamed(built.graph, "logged");
    const fromModule = resolvedTargets(built.graph, moduleNode(built)).filter(
      (t) => t === logged,
    );
    expect(fromModule).toHaveLength(6);
    for (const member of ["m", "s", "n"]) {
      expect(
        resolvedTargets(built.graph, nodeNamed(built.graph, member)),
      ).not.toContain(logged);
    }
    expect(
      resolvedTargets(built.graph, nodeNamed(built.graph, "X", "constructor")),
    ).not.toContain(logged);
  });

  it("edges a decorator of a class defined inside a function from that function", async () => {
    const built = await build(
      {
        "index.ts":
          LOGGED +
          `function make() {\n  class X {\n    @logged m() {}\n  }\n  return X;\n}\n`,
      },
      "index.ts",
    );
    const logged = nodeNamed(built.graph, "logged");
    expect(
      resolvedTargets(built.graph, nodeNamed(built.graph, "make")),
    ).toEqual([logged]);
    expect(resolvedTargets(built.graph, moduleNode(built))).not.toContain(
      logged,
    );
  });

  it("resolves the target export used directly as a decorator", async () => {
    const built = await build(
      {
        "lib.js": `function parse() {}\nfunction safe() {}\nmodule.exports = { parse, safe };\n`,
        "index.ts": `import lib = require("./lib.js");\n@lib.parse\nclass X {}\n`,
      },
      "index.ts",
    );
    const targets = resolvedTargets(built.graph, moduleNode(built));
    expect(targets).toContain(nodeNamed(built.graph, "parse"));
    expect(targets).not.toContain(nodeNamed(built.graph, "safe"));
  });

  it("accounts a decorator factory as two invocations: the factory call, and an unknown call of its result", async () => {
    const built = await build(
      {
        "index.ts": `function make() { return function (...a: any[]) {}; }\n@make()\nclass X {}\n`,
      },
      "index.ts",
    );
    const from = moduleNode(built);
    expect(resolvedTargets(built.graph, from)).toContain(
      nodeNamed(built.graph, "make"),
    );
    const decorator = built.observations.filter(
      (o) => o.site.kind === "decorator",
    );
    expect(decorator).toHaveLength(1);
    expect(decorator[0]!.account).toEqual({
      kind: "edges",
      edges: [
        expect.objectContaining({
          from,
          resolution: expect.objectContaining({ kind: "unknown" }),
        }),
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// The owner that evaluates a site (task A-1 audit, finding 2)
// ---------------------------------------------------------------------------

describe("a tagged template or decorator is accounted from the owner that evaluates it", () => {
  const LOGGED = `function logged(...args) { return undefined; }\n`;

  it("a decorated class in an instance field initializer: the enclosing class's implicit constructor", async () => {
    const built = await build(
      {
        "index.ts":
          LOGGED + `class A {\n  f = class {\n    @logged m() {}\n  };\n}\n`,
      },
      "index.ts",
    );
    const logged = nodeNamed(built.graph, "logged");
    expect(
      resolvedTargets(built.graph, nodeNamed(built.graph, "A", "constructor")),
    ).toContain(logged);
    expect(resolvedTargets(built.graph, moduleNode(built))).not.toContain(
      logged,
    );
  });

  it("a tagged template in an instance field initializer: the enclosing class's explicit constructor", async () => {
    const built = await build({
      "index.js":
        `function tag(s) { return s; }\n` +
        `class A {\n  f = tag\`x\`;\n  constructor() {}\n}\n`,
    });
    const tag = nodeNamed(built.graph, "tag");
    const ctor = built.graph.nodes.find(
      (n) => n.kind === "constructor" && n.name === "A",
    )!.id;
    expect(resolvedTargets(built.graph, ctor)).toContain(tag);
    expect(resolvedTargets(built.graph, moduleNode(built))).not.toContain(tag);
  });

  it("a static field initializer runs at class definition: the class-definition owner", async () => {
    const built = await build({
      "index.js": `function tag(s) { return s; }\nclass A {\n  static f = tag\`x\`;\n}\n`,
    });
    expect(resolvedTargets(built.graph, moduleNode(built))).toContain(
      nodeNamed(built.graph, "tag"),
    );
  });

  it("inside a getter body: from the getter's own node (task A-4: an accessor is its own owner)", async () => {
    const built = await build(
      {
        "index.ts":
          LOGGED +
          `class A {\n  get g() {\n    class B {\n      @logged m() {}\n    }\n    return B;\n  }\n}\n`,
      },
      "index.ts",
    );
    const logged = nodeNamed(built.graph, "logged");
    const getter = nodeNamed(built.graph, "get g", "accessor");
    const decorator = built.observations.filter(
      (o) => o.site.kind === "decorator",
    );
    expect(decorator.map((o) => o.account)).toEqual([
      {
        kind: "edges",
        edges: [
          expect.objectContaining({
            from: getter,
            resolution: { kind: "resolved", target: logged },
          }),
        ],
      },
    ]);
  });

  it("a tagged template inside a member decorator's expression: the class-definition owner, not the member", async () => {
    const built = await build(
      {
        "index.ts":
          `function tag(s: any) { return (...a: any[]) => undefined; }\n` +
          `class X {\n  @(tag\`x\`) m() {}\n}\n`,
      },
      "index.ts",
    );
    const tag = nodeNamed(built.graph, "tag");
    expect(resolvedTargets(built.graph, moduleNode(built))).toContain(tag);
    expect(
      resolvedTargets(built.graph, nodeNamed(built.graph, "m")),
    ).not.toContain(tag);
  });
});

// ---------------------------------------------------------------------------
// Task A-5a: the last two no-edge proofs (ADR 0008 § 2)
// ---------------------------------------------------------------------------

describe("a static require of the ambient require is AmbientStaticRequire (PRM-15)", () => {
  it('gives a module-scope require("x") the proof, with its specifier', async () => {
    const built = await build({
      "index.js": `require("./other.js");\n`,
      "other.js": `module.exports = {};\n`,
    });
    expect(
      built.observations.flatMap((o) =>
        o.account.kind === "no_edge" ? [o.account.proof] : [],
      ),
    ).toEqual([{ kind: "ambient_static_require", specifier: "./other.js" }]);
    expect(edgesFrom(built.graph, moduleNode(built))).toEqual([]);
  });

  it("keeps the proof for a require in a function when only an unrelated scope declares require", async () => {
    const built = await build({
      "index.js": `function a() { function require(n) { return n; } return require; }\nfunction b() { return require("./other.js"); }\nb();\n`,
      "other.js": `module.exports = {};\n`,
    });
    expect(noEdgeProofs(built, "call")).toEqual(["ambient_static_require"]);
  });

  it.each([
    [
      "a function-local function require",
      `function main() { function require(n) { return n; } return require("./other.js"); }\nmain();\n`,
      "resolved require",
    ],
    [
      "a block-scoped const require",
      `function main() { const require = (n) => n; return require("./other.js"); }\nmain();\n`,
      "resolved require",
    ],
    [
      "a parameter named require",
      `function main(require) { return require("./other.js"); }\nmain((n) => n);\n`,
      "unknown",
    ],
  ])(
    "refuses the proof under %s: the call is an ordinary callee",
    async (_label, source, expected) => {
      const built = await build({
        "index.js": source,
        "other.js": `module.exports = {};\n`,
      });
      expect(noEdgeProofs(built, "call")).toEqual([]);
      const main = nodeNamed(built.graph, "main");
      const accounts = edgesFrom(built.graph, main).map((e) =>
        e.resolution.kind === "resolved"
          ? `resolved ${built.graph.nodes.find((n) => n.id === (e.resolution as { target: string }).target)?.name}`
          : e.resolution.kind,
      );
      expect(accounts[0]).toBe(expected);
    },
  );

  it.each([
    ["a bare-name write", `require = (n) => n;\nrequire("./other.js");\n`],
    [
      "a destructuring write",
      `({ require } = { require: (n) => n });\nrequire("./other.js");\n`,
    ],
    [
      "a with body",
      `with ({ require: (n) => n }) { require("./other.js"); }\n`,
    ],
  ])(
    "refuses the proof under %s anywhere in the file",
    async (_label, source) => {
      const built = await build({
        "index.js": source,
        "other.js": `module.exports = {};\n`,
      });
      expect(noEdgeProofs(built, "call")).toEqual([]);
    },
  );

  it("refuses the proof under a TypeScript namespace named require", async () => {
    const built = await build(
      {
        "index.ts": `namespace require { export const x = 1; }\nrequire("./other.js");\n`,
        "other.js": `module.exports = {};\n`,
      },
      "index.ts",
    );
    expect(noEdgeProofs(built, "call")).toEqual([]);
  });
});

describe("a branch is pruned only by a fold that is a proof: ProvablyDeadBranch (PRM-14)", () => {
  it("accounts a pruned branch's sites with the proof and adds no edge for them", async () => {
    const built = await build({
      "index.js": `function f() {}\nfunction g() {}\nif (false) { f(); } else { g(); }\n`,
    });
    expect(resolvedTargets(built.graph, moduleNode(built))).toEqual([
      nodeNamed(built.graph, "g"),
    ]);
    expect(noEdgeProofs(built, "call")).toEqual(["provably_dead_branch"]);
  });

  it.each([
    ["1 === 2", "strict, two numbers"],
    ['1 === "1"', "strict, across types"],
    ['"a" == "b"', "loose, two strings"],
    ["1 != 1", "loose, two numbers"],
  ])("prunes under %s (%s)", async (condition) => {
    const built = await build({
      "index.js": `function f() {}\nif (${condition}) { f(); }\n`,
    });
    expect(resolvedTargets(built.graph, moduleNode(built))).toEqual([]);
    expect(noEdgeProofs(built, "call")).toEqual(["provably_dead_branch"]);
  });

  it.each([
    ['1 == "1"', "true by conversion"],
    ['0 == ""', "true by conversion"],
    ['1 != "1"', "false by conversion"],
    ['"1" == 1', "true by conversion"],
  ])(
    "visits both branches under the loose cross-type %s (%s)",
    async (condition) => {
      const built = await build({
        "index.js": `function f() {}\nfunction g() {}\nif (${condition}) { f(); } else { g(); }\n`,
      });
      expect(resolvedTargets(built.graph, moduleNode(built)).sort()).toEqual(
        [nodeNamed(built.graph, "f"), nodeNamed(built.graph, "g")].sort(),
      );
      expect(noEdgeProofs(built, "call")).toEqual([]);
    },
  );
});
