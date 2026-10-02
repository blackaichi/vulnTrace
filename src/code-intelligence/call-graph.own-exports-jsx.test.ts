import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import type { CallEdge, CallGraph } from "../domain/graph.js";
import {
  buildCallGraph,
  type InvocationAccountObservation,
} from "./call-graph.js";
import type { JsxSettings } from "./jsx-runtime.js";
import { findClosureWideningConstructs } from "./loader-constructs.js";
import { buildModuleModel } from "./module-model.js";
import { createModuleResolver } from "./module-resolver.js";
import { indexSourceFile } from "./source-index.js";
import { loadTsProject } from "./ts-project.js";

/**
 * Task A-3b (docs/tasks/A-3b-own-exports-jsx.md), at the graph level,
 * where each edge's reason, `from` and target are visible: a call rooted
 * in a CommonJS module-scope binding gets an unknown edge, never the
 * unproven no-edge account it had (`module_scope_callee`, AUD-02); a JSX
 * element or fragment gets its factory's unknown edge and a possible edge
 * for each attributable function it hands over (PRM-116); and the
 * module-load closure records a JSX site that loads `jsx-runtime`
 * (RWF-066). The end-to-end, real-Node versions are in
 * `tests/oracle/a3b-own-exports-jsx.test.ts`.
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
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-a3b-"));
  tempDirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const observations: InvocationAccountObservation[] = [];
  const entryPath = path.join(root, entry);
  const project = loadTsProject(root);
  const graph = await buildCallGraph({
    entryFiles: [entryPath],
    resolver: createModuleResolver(project),
    // A project with a tsconfig.json passes its JSX settings; without one
    // the graph is built with no project, as an older caller would.
    project: project.configFilePath ? project : undefined,
    onInvocationAccount: (o) => observations.push(o),
  });
  return { graph, observations, entry: entryPath };
}

function edgesFrom(graph: CallGraph, from: string): CallEdge[] {
  return graph.edges.filter((e) => e.from === from && e.type !== "module_load");
}

function moduleNode(built: Built): string {
  return `${built.entry}#<module>`;
}

/** `unknown <reason>` / `possible <target name>` / `resolved <target name>`, per edge. */
function describeEdges(graph: CallGraph, from: string): string[] {
  const nameOf = (id: string): string =>
    graph.nodes.find((n) => n.id === id)?.name ?? id;
  return edgesFrom(graph, from).map((e) =>
    e.resolution.kind === "unknown"
      ? `unknown ${e.resolution.reason}`
      : `${e.resolution.kind} ${nameOf(e.resolution.target)}`,
  );
}

function unprovenAccounts(built: Built): string[] {
  return built.observations.flatMap((o) =>
    o.account.kind === "unproven_no_edge" ? [o.account.reason] : [],
  );
}

// ---------------------------------------------------------------------------
// AUD-02 -- a module calling its own export
// ---------------------------------------------------------------------------

describe("a call rooted in a module-scope binding gets an unknown edge (AUD-02)", () => {
  it.each([
    ["exports.f()", `exports.f = function f() {};\nexports.f();\n`],
    [
      "module.exports.f()",
      `module.exports.f = function f() {};\nmodule.exports.f();\n`,
    ],
    ['exports["f"]()', `exports.f = function f() {};\nexports["f"]();\n`],
    [
      'module["exports"].f()',
      `module.exports.f = function f() {};\nmodule["exports"].f();\n`,
    ],
  ])("%s is an own-export call", async (_, source) => {
    const built = await build({ "index.js": source });
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      "unknown own_export_call",
    ]);
    expect(unprovenAccounts(built)).toEqual([]);
  });

  it.each([
    // A computed key is a dynamic member access, answered before the
    // module-scope check; `module.exports()` is answered by the loader
    // classifier's capability floor. Each is an unknown edge either way.
    [
      "exports[k]()",
      `exports.f = function f() {};\nconst k = "f";\nexports[k]();\n`,
      "dynamic_member_access",
    ],
    [
      "module.exports()",
      `module.exports = function f() {};\nmodule.exports();\n`,
      "loader_capability_escape",
    ],
  ])(
    "%s is answered earlier, by an unknown edge",
    async (_, source, reason) => {
      const built = await build({ "index.js": source });
      expect(describeEdges(built.graph, moduleNode(built))).toEqual([
        `unknown ${reason}`,
      ]);
      expect(unprovenAccounts(built)).toEqual([]);
    },
  );

  it("new exports.C() is an own-export construction", async () => {
    const built = await build({
      "index.js": `exports.C = class C {};\nnew exports.C();\n`,
    });
    expect(edgesFrom(built.graph, moduleNode(built))).toEqual([
      expect.objectContaining({
        type: "constructor",
        resolution: {
          kind: "unknown",
          reason: "own_export_call",
          potentialTargets: [],
        },
      }),
    ]);
  });

  it("a function handed to an own-export call escapes into it (a possible edge)", async () => {
    const built = await build({
      "index.js": `exports.run = function run(cb) { cb(); };\nfunction work() {}\nexports.run(work);\n`,
    });
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      "unknown own_export_call",
      "possible work",
    ]);
  });

  it.each([
    ["require.resolve", `require.resolve("./other.js");\n`],
    [
      "module.parent.require (RWF-065)",
      `module.parent.require("./other.js");\n`,
    ],
    [
      "module.children[0].require (RWF-065)",
      `module.children[0].require("./other.js");\n`,
    ],
    ["module[k]()", `const k = "require";\nmodule[k]("./other.js");\n`],
  ])(
    "%s is a use of the module's own loader: closure-widening",
    async (_, source) => {
      const built = await build({
        "index.js": source,
        "other.js": `module.exports = {};\n`,
      });
      expect(describeEdges(built.graph, moduleNode(built))).toEqual([
        "unknown loader_capability_escape",
      ]);
    },
  );

  it("a loader shape the loader classifier knows keeps its own reason", async () => {
    const built = await build({
      "index.js": `module.require("./other.js");\n`,
      "other.js": `module.exports = {};\n`,
    });
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      "unknown module_require",
    ]);
  });

  it("__dirname.split() is an unattributed member call, not an unproven account", async () => {
    const built = await build({ "index.js": `__dirname.split("/");\n` });
    const [edge] = edgesFrom(built.graph, moduleNode(built));
    expect(edge?.resolution).toMatchObject({ kind: "unknown" });
    expect(
      edge?.resolution.kind === "unknown" && edge.resolution.reason,
    ).toMatch(/^unsupported_/);
    expect(unprovenAccounts(built)).toEqual([]);
  });

  it.each([
    [
      "a parameter",
      `function g(exports) { return exports.f(); }\ng({ f() {} });\n`,
    ],
    ["a local", `const exports = { f() {} };\nexports.f();\n`],
    ["an assigned name", `exports = { f() {} };\nexports.f();\n`],
  ])(
    "an `exports` that is %s is not the module's own (lexical identity)",
    async (_, source) => {
      const built = await build({ "index.js": source });
      const reasons = built.graph.edges.flatMap((e) =>
        e.resolution.kind === "unknown" ? [e.resolution.reason] : [],
      );
      expect(reasons).not.toContain("own_export_call");
    },
  );
});

// ---------------------------------------------------------------------------
// PRM-116 -- a JSX element is a call to its factory
// ---------------------------------------------------------------------------

function tsconfig(options: Record<string, unknown>): string {
  return JSON.stringify({
    compilerOptions: { module: "commonjs", target: "es2022", ...options },
  });
}

describe("a JSX site is a call to its factory (PRM-116)", () => {
  it("<App />, classic: the factory's unknown edge and a possible edge to the component", async () => {
    const built = await build(
      {
        "tsconfig.json": tsconfig({ jsx: "react", jsxFactory: "h" }),
        "index.tsx": `function h(t: any) { return t; }\nfunction App() { return 1; }\nconst e = <App />;\nexport {};\n`,
      },
      "index.tsx",
    );
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      "unknown jsx_factory_call",
      "possible App",
    ]);
  });

  it("an intrinsic element calls the factory too, and hands it its attribute and child functions", async () => {
    const built = await build(
      {
        "tsconfig.json": tsconfig({ jsx: "react", jsxFactory: "h" }),
        "index.tsx": `function h(t: any) { return t; }\nfunction onClick() {}\nfunction child() {}\nconst e = <div onClick={onClick}>{child}</div>;\nexport {};\n`,
      },
      "index.tsx",
    );
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      "unknown jsx_factory_call",
      "possible onClick",
      "possible child",
    ]);
  });

  it("a fragment and a nested element are sites of their own", async () => {
    const built = await build(
      {
        "tsconfig.json": tsconfig({
          jsx: "react",
          jsxFactory: "h",
          jsxFragmentFactory: "Frag",
        }),
        "index.tsx": `function h(t: any) { return t; }\nfunction Frag() {}\nfunction A() { return 1; }\nconst e = <><A /></>;\nexport {};\n`,
      },
      "index.tsx",
    );
    expect(
      built.observations.filter((o) => o.site.kind === "jsx"),
    ).toHaveLength(2);
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      "unknown jsx_factory_call",
      "unknown jsx_factory_call",
      "possible A",
    ]);
  });

  it.each([
    ["the automatic runtime", { jsx: "react-jsx" }, ""],
    [
      "an @jsxImportSource pragma",
      { jsx: "react" },
      "/** @jsxImportSource lib */\n",
    ],
    ["jsx: preserve", { jsx: "preserve" }, ""],
    [
      "a classic factory rooted in `require`",
      { jsx: "react", jsxFactory: "require" },
      "",
    ],
  ])(
    "under %s, the site may load a module: jsx_runtime_load",
    async (_, options, pragma) => {
      const built = await build(
        {
          "tsconfig.json": tsconfig(options),
          "index.tsx": `${pragma}const e = <div />;\nexport {};\n`,
        },
        "index.tsx",
      );
      expect(describeEdges(built.graph, moduleNode(built))).toEqual([
        "unknown jsx_runtime_load",
      ]);
    },
  );

  it("without a project, the runtime is undetermined: jsx_runtime_load", async () => {
    const built = await build(
      { "index.jsx": `const e = <div />;\n` },
      "index.jsx",
    );
    expect(describeEdges(built.graph, moduleNode(built))).toEqual([
      "unknown jsx_runtime_load",
    ]);
  });

  it("a loader capability handed to a classic factory is a capability escape", async () => {
    const built = await build(
      {
        "tsconfig.json": tsconfig({ jsx: "react", jsxFactory: "h" }),
        "index.tsx": `declare const require: any;\nfunction h(t: any) { return t; }\nconst e = <div load={require} />;\nexport {};\n`,
      },
      "index.tsx",
    );
    expect(describeEdges(built.graph, moduleNode(built))).toContain(
      "unknown loader_capability_escape",
    );
  });

  it("a JSX element in an instance field initializer is accounted from the constructor", async () => {
    const built = await build(
      {
        "tsconfig.json": tsconfig({ jsx: "react", jsxFactory: "h" }),
        "index.tsx": `function h(t: any) { return t; }\nfunction App() { return 1; }\nclass C { el = <App />; }\nnew C();\nexport {};\n`,
      },
      "index.tsx",
    );
    const constructor = built.graph.nodes.find(
      (n) => n.kind === "constructor" && (n.name ?? "").includes("C"),
    );
    expect(constructor).toBeDefined();
    expect(describeEdges(built.graph, constructor!.id)).toEqual([
      "unknown jsx_factory_call",
      "possible App",
    ]);
    expect(describeEdges(built.graph, moduleNode(built))).not.toContain(
      "possible App",
    );
  });
});

// ---------------------------------------------------------------------------
// RWF-066 -- the module-load closure records a JSX site that loads a module
// ---------------------------------------------------------------------------

describe("the module-load closure records a JSX site that may load a module (RWF-066)", () => {
  function constructs(source: string, jsx: JsxSettings | undefined): string[] {
    const index = indexSourceFile("/virtual/index.tsx", source);
    return findClosureWideningConstructs({
      index,
      model: buildModuleModel(index),
      jsx,
    }).map((c) => c.reason);
  }

  const element = `const e = <div />;\nexport {};\n`;

  it("records the automatic runtime's site", () => {
    expect(constructs(element, { jsx: ts.JsxEmit.ReactJSX })).toEqual([
      "jsx_runtime_load",
    ]);
  });

  it("records an @jsxImportSource pragma in a classic project", () => {
    expect(
      constructs(`/** @jsxImportSource lib */\n${element}`, {
        jsx: ts.JsxEmit.React,
      }),
    ).toEqual(["jsx_runtime_load"]);
  });

  it("records every site when the settings are unknown", () => {
    expect(constructs(element, undefined)).toEqual(["jsx_runtime_load"]);
  });

  it("records nothing for a classic factory the file imports", () => {
    expect(
      constructs(`import React from "react";\n${element}`, {
        jsx: ts.JsxEmit.React,
      }),
    ).toEqual([]);
  });

  it("records a classic factory that is an alias of require (the audit's finding 3)", () => {
    expect(
      constructs(`const r = require;\n${element}`, {
        jsx: ts.JsxEmit.React,
        jsxFactory: "r",
      }),
    ).toEqual(["jsx_runtime_load"]);
  });

  it("records a loader capability handed to a classic factory", () => {
    expect(
      constructs(
        `import React from "react";\nconst e = <div load={require} />;\nexport {};\n`,
        { jsx: ts.JsxEmit.React },
      ),
    ).toContain("loader_capability_escape");
  });
});
