import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LoadReachGraph,
  loadReachGraphFor,
  preparingResolver,
} from "./load-reach.js";
import type {
  ModuleResolutionResult,
  ModuleResolver,
} from "./module-resolver.js";
import { indexSourceFileFromDisk } from "./source-index.js";
import {
  loadDefectRegisters,
  openSoundnessDefectProblems,
  type OpenSoundnessDefect,
  type OutcomeDomain,
} from "../testing/open-soundness-defect.js";

/**
 * Task BL-074: the module graph the export census asks "may this load
 * hand back one of my export objects?" (`load-reach.ts`; ADR 0009 § 4).
 * Each answer below is checked against real files, with a resolver that
 * maps `./x` to `x.js` next to the importer and nothing else, so what the
 * graph follows is exactly what the test spells.
 */

const BUILTINS = new Set(["fs", "path", "module", "process", "vm"]);

function fakeResolver(): ModuleResolver & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve: async (specifier, importer): Promise<ModuleResolutionResult> => {
      calls.push(specifier);
      const bare = specifier.replace(/^node:/, "");
      if (BUILTINS.has(bare)) {
        return { kind: "builtin", specifier };
      }
      if (specifier.startsWith(".")) {
        const file = path.resolve(path.dirname(importer), `${specifier}.js`);
        if (existsSync(file)) {
          return {
            kind: "resolved",
            resolvedFileName: file,
            isExternalLibraryImport: false,
          };
        }
      }
      return { kind: "unresolved", specifier, importer, reason: "test" };
    },
  };
}

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), "vt-load-reach-"));
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return root;
}

async function reachOf(
  files: Readonly<Record<string, string>>,
  options: { readonly maxFiles?: number } = {},
): Promise<(specifier: string) => boolean> {
  const root = project(files);
  const graph = new LoadReachGraph(fakeResolver(), options);
  const reach = await graph.prepare(
    indexSourceFileFromDisk(path.join(root, "index.js")),
  );
  return (specifier) => reach.mayReachBack(specifier);
}

describe("BL-074: what may reach back", () => {
  it("a leaf, a builtin and a module loading only leaves cannot", async () => {
    const reaches = await reachOf({
      "index.js": `require("./leaf"); require("./mid"); require("fs");\n`,
      "leaf.js": `exports.v = 1;\n`,
      "mid.js": `require("./leaf");\nexports.w = 2;\n`,
    });
    expect(reaches("./leaf")).toBe(false);
    expect(reaches("./mid")).toBe(false);
    expect(reaches("fs")).toBe(false);
  });

  it("a cycle back to this file may, at any depth, through any static load", async () => {
    const reaches = await reachOf({
      "index.js": `require("./a"); require("./far"); require("./lazy"); require("./esm");\n`,
      "a.js": `module.exports = require("./index");\n`,
      "far.js": `require("./mid");\n`,
      "mid.js": `require("./index");\n`,
      // A deferred load is an edge too: a function this module exports may
      // load the file back when it is called.
      "lazy.js": `exports.get = function () { return require("./index"); };\n`,
      "esm.js": `import x from "./index";\nexport { x };\n`,
    });
    expect(reaches("./a")).toBe(true);
    expect(reaches("./far")).toBe(true);
    expect(reaches("./lazy")).toBe(true);
    expect(reaches("./esm")).toBe(true);
  });

  it("a load of the module a whole-module write installs may, and of one that reaches it", async () => {
    const reaches = await reachOf({
      "index.js": `module.exports = require("./safe");\nrequire("./alias"); require("./other");\n`,
      "safe.js": `exports.run = 1;\n`,
      "alias.js": `module.exports = require("./safe");\n`,
      "other.js": `exports.v = 1;\n`,
    });
    expect(reaches("./safe")).toBe(true);
    expect(reaches("./alias")).toBe(true);
    expect(reaches("./other")).toBe(false);
  });

  it("an opaque whole-module value lets every load reach back", async () => {
    const reaches = await reachOf({
      "index.js": `module.exports = make();\nrequire("./leaf");\nfunction make() { return {}; }\n`,
      "leaf.js": `exports.v = 1;\n`,
    });
    expect(reaches("./leaf")).toBe(true);
  });

  it("a fresh whole-module value does not", async () => {
    const reaches = await reachOf({
      "index.js": `function api() {}\nmodule.exports = api;\nrequire("./leaf");\n`,
      "leaf.js": `exports.v = 1;\n`,
    });
    expect(reaches("./leaf")).toBe(false);
  });

  it.each([
    ["module.parent", `module.exports = module.parent.exports;\n`],
    ["module.children", `exports.c = module.children;\n`],
    ["module handed on", `exports.m = module;\n`],
    ["require.cache", `exports.c = require.cache;\n`],
    ["require.main read", `exports.m = require.main;\n`],
    ["process.mainModule", `exports.m = process.mainModule;\n`],
    ["process handed on", `exports.p = process;\n`],
    ["globalThis.process", `exports.p = globalThis.process;\n`],
    ["the module builtin", `exports.M = require("module");\n`],
    ["the vm builtin", `exports.vm = require("vm");\n`],
    ["a loader alias", `const r = require;\nr("./x");\n`],
    ["module.require", `module.require("./x");\n`],
    ["require.call", `require.call(null, "./x");\n`],
    ["a template specifier", "require(`./x`);\n"],
    ["a computed require", `require(process.env.X || "./x");\n`],
    ["eval", `eval("1");\n`],
    ["a dynamic import", `import("./x");\n`],
    ["with", `with ({}) { void 0; }\n`],
    [
      "a caller's frame",
      `Object.defineProperty(exports, "obj", { get: function g() { return g.caller; } });\n`,
    ],
    [
      "V8 call sites",
      `Error.prepareStackTrace = (e, s) => s;\nexports.s = new Error().stack;\n`,
    ],
    ["a call site's this", `exports.t = (s) => s.getThis();\n`],
    [
      "mainModule through a sloppy this",
      `function g() { return this; }\nvar root = g();\nmodule.exports = root.process.mainModule.children[0].exports;\n`,
    ],
    [
      "getBuiltinModule",
      `function g() { return this; }\nexports.M = g().process.getBuiltinModule("module");\n`,
    ],
    ["eval as a member", `function g() { return this; }\ng().eval("1");\n`],
    [
      "caller through Reflect.get",
      `exports.c = (f) => Reflect.get(f, "caller");\n`,
    ],
    [
      "caller destructured",
      `exports.c = (f) => { const { caller } = f; return caller; };\n`,
    ],
    [
      "prepareStackTrace through defineProperty",
      `Object.defineProperty(Error, "prepareStackTrace", { value: (e, s) => s });\n`,
    ],
    ["the wrapper's arguments", `exports.a = arguments;\n`],
    ["an unresolved load", `require("./missing");\n`],
    ["a syntax error", `exports.v = (;\n`],
  ])(
    "a closure member reaching the loader registry taints it: %s",
    async (_l, source) => {
      const reaches = await reachOf({
        "index.js": `require("./holder");\n`,
        "holder.js": `require("./tainted");\n`,
        "tainted.js": source,
      });
      expect(reaches("./holder")).toBe(true);
    },
  );

  it.each([
    ["process.env", `exports.e = process.env.NODE_ENV;\n`],
    ["module.exports", `module.exports = { v: 1 };\n`],
    ["module.id", `exports.id = module.id;\n`],
    ["require.main tested", `if (require.main === module) { void 0; }\n`],
    ["require.resolve", `exports.p = require.resolve("./leaf");\n`],
  ])("an inert use does not taint: %s", async (_l, source) => {
    const reaches = await reachOf({
      "index.js": `require("./holder");\n`,
      "holder.js": source,
      "leaf.js": `exports.v = 1;\n`,
    });
    expect(reaches("./holder")).toBe(false);
  });

  it("a lodash-style `module` alias reading only `exports` does not taint, though the closure-widening scan counts it a capability escape", async () => {
    // `findClosureWideningConstructs` reports `loader_capability_escape`
    // here; `fileReachesLoaderRegistry` reads the alias as inert (it reads
    // only `exports`), and it alone decides for that reason (VAL-001's
    // `lodash.template`).
    const reaches = await reachOf({
      "index.js": `require("./holder");\n`,
      "holder.js": `var freeModule = typeof module == "object" && module;\nif (freeModule) { freeModule.exports = {}; }\n`,
    });
    expect(reaches("./holder")).toBe(false);
  });

  it.each([
    ["reading parent", `var m = module;\nexports.p = m.parent;\n`],
    ["handed on", `var m = module;\nexports.m = m;\n`],
    ["calling require", `var m = module;\nm.require("./x");\n`],
    ["a require alias handed on", `var r = require;\nexports.r = r;\n`],
  ])(
    "a capability alias that may reach the registry still taints: %s",
    async (_l, source) => {
      const reaches = await reachOf({
        "index.js": `require("./holder");\n`,
        "holder.js": source,
      });
      expect(reaches("./holder")).toBe(true);
    },
  );

  const LODASH_ROOT =
    `var freeGlobal = typeof global == "object" && global && global.Object === Object && global;\n` +
    `var freeSelf = typeof self == "object" && self && self.Object === Object && self;\n` +
    `var root = freeGlobal || freeSelf || Function("return this")();\n`;

  it("lodash's global-object idiom does not taint while its binding reads only plain globals", async () => {
    const reaches = await reachOf({
      "index.js": `require("./holder");\n`,
      "holder.js": `${LODASH_ROOT}var Symbol = root.Symbol;\nexports.s = Symbol;\n`,
    });
    expect(reaches("./holder")).toBe(false);
  });

  it.each([
    ["root.eval", `${LODASH_ROOT}root.eval("1");\n`],
    ["root.Function", `${LODASH_ROOT}root.Function("x")();\n`],
    ["root.process", `${LODASH_ROOT}exports.p = root.process;\n`],
    ["root.globalThis", `${LODASH_ROOT}exports.p = root.globalThis.process;\n`],
    ["root.constructor", `${LODASH_ROOT}exports.c = root.constructor;\n`],
    ["a computed member", `${LODASH_ROOT}exports.v = root[name];\n`],
    ["the object handed on", `${LODASH_ROOT}exports.root = root;\n`],
    ["the object passed to a call", `${LODASH_ROOT}use(root);\n`],
    ["the idiom not bound", `exports.p = Function("return this")().Symbol;\n`],
    ["another Function body", `var root = Function("return process")();\n`],
    ["an alias of global", `var g = global;\ng.eval("1");\n`],
  ])(
    "a use of the global object that may reach taints: %s",
    async (_l, source) => {
      const reaches = await reachOf({
        "index.js": `require("./holder");\n`,
        "holder.js": source,
      });
      expect(reaches("./holder")).toBe(true);
    },
  );

  it("registry builtins reach; others do not", async () => {
    const reaches = await reachOf({
      "index.js": `require("module"); require("node:process"); require("vm"); require("path");\n`,
    });
    expect(reaches("module")).toBe(true);
    expect(reaches("node:process")).toBe(true);
    expect(reaches("vm")).toBe(true);
    expect(reaches("path")).toBe(false);
  });

  it("an unresolved specifier, and one the context was not asked about, may reach", async () => {
    const reaches = await reachOf({
      "index.js": `require("not-installed");\n`,
    });
    expect(reaches("not-installed")).toBe(true);
    expect(reaches("./never-loaded")).toBe(true);
  });

  it("past its file bound the closure may reach (fail closed, never partial)", async () => {
    const files = {
      "index.js": `require("./c0");\n`,
      "c0.js": `require("./c1");\n`,
      "c1.js": `require("./c2");\n`,
      "c2.js": `exports.v = 1;\n`,
    };
    expect((await reachOf(files))("./c0")).toBe(false);
    expect((await reachOf(files, { maxFiles: 2 }))("./c0")).toBe(true);
  });

  it("a symlinked spelling of this file is this file", async () => {
    const root = project({
      "index.js": `require("./a");\n`,
      "a.js": `require("./link");\n`,
    });
    // `link.js` is this file under another name: Node loads one module.
    const { symlinkSync } = await import("node:fs");
    symlinkSync(path.join(root, "index.js"), path.join(root, "link.js"));
    const graph = new LoadReachGraph(fakeResolver());
    const reach = await graph.prepare(
      indexSourceFileFromDisk(path.join(root, "index.js")),
    );
    expect(reach.mayReachBack("./a")).toBe(true);
  });
});

describe("BL-074: sharing and preparation", () => {
  it("one graph per resolver, one context per file", async () => {
    const root = project({ "index.js": `require("./leaf");\n`, "leaf.js": "" });
    const resolver = fakeResolver();
    const graph = loadReachGraphFor(resolver);
    expect(loadReachGraphFor(resolver)).toBe(graph);
    const index = indexSourceFileFromDisk(path.join(root, "index.js"));
    const first = await graph.prepare(index);
    expect(await graph.prepareFile(path.join(root, "index.js"))).toBe(first);
    expect(graph.cached(path.join(root, "index.js"))).toBe(first);
  });

  it("an unprepared file has no context (the census's per-file rule)", () => {
    const graph = new LoadReachGraph(fakeResolver());
    expect(graph.cached("/nowhere/index.js")).toBeUndefined();
  });

  it("the preparing resolver readies every file it resolves to, and answers unchanged", async () => {
    const root = project({ "index.js": `require("./leaf");\n`, "leaf.js": "" });
    const inner = fakeResolver();
    const graph = new LoadReachGraph(inner);
    const resolver = preparingResolver(inner, graph);
    const answer = await resolver.resolve(
      "./leaf",
      path.join(root, "index.js"),
    );
    expect(answer).toEqual(
      await inner.resolve("./leaf", path.join(root, "index.js")),
    );
    expect(graph.cached(path.join(root, "leaf.js"))).toBeDefined();
  });
});

describe("the global object as a sloppy function's `this` (BL-074's audit, round 3)", () => {
  it.each([
    ["a computed member chain", "root[p][m]"],
    ["Reflect.get", "Reflect.get(Reflect.get(root, p), m)"],
    ["a concatenated key", 'root.process["main" + "Module"]'],
    ["a destructuring assignment", "(({ mainModule: mm } = root.process), mm)"],
  ])("taints: %s", async (_label, read) => {
    const reaches = await reachOf({
      "index.js": `require("./holder");\n`,
      "holder.js":
        `function g() { return this; }\nvar root = g();\nvar mm;\n` +
        `var p = ["pro", "cess"].join(""), m = ["main", "Module"].join("");\n` +
        `module.exports = ${read}.children[0].exports;\n`,
    });
    expect(reaches("./holder")).toBe(true);
  });

  it.each([
    [
      "a strict file",
      `"use strict";\nfunction g() { return this; }\nexports.g = g;\n`,
    ],
    [
      "a strict function",
      `function g() { "use strict"; return this; }\nexports.g = g;\n`,
    ],
    ["a class method", `class C { m() { return this; } }\nexports.C = C;\n`],
    [
      "an ES5 constructor's members",
      `function C() { this.a = 1; }\nC.prototype.m = function () { return this.a; };\nexports.C = C;\n`,
    ],
    [
      "a binding of this read by member",
      `function f() { var self = this; self.on("x", function () {}); }\nexports.f = f;\n`,
    ],
  ])("does not taint: %s", async (_label, source) => {
    const reaches = await reachOf({
      "index.js": `require("./holder");\n`,
      "holder.js": source,
    });
    expect(reaches("./holder")).toBe(false);
  });

  it.each([
    [
      "a strict arrow in between",
      `function g() { var f = () => { "use strict"; return this; }; return f(); }\nexports.g = g;\n`,
    ],
    [
      "a class heritage clause",
      `function g() { var t; class C extends (t = this, Object) {} return t; }\nexports.g = g;\n`,
    ],
    [
      "a class's computed key",
      `function g() { var t; class C { static [(t = this, "x")] = 1; } return t; }\nexports.g = g;\n`,
    ],
    [
      "an object method's computed key",
      `function g() { var t; var o = { [(t = this, "m")]() {} }; void o; return t; }\nexports.g = g;\n`,
    ],
  ])(
    "the binding function decides, not what lies between: %s",
    async (_l, source) => {
      const reaches = await reachOf({
        "index.js": `require("./holder");\n`,
        "holder.js": source,
      });
      expect(reaches("./holder")).toBe(true);
    },
  );

  it.each([
    ["a class field initializer", `class C { f = this; }\nexports.C = C;\n`],
    [
      "a class static block",
      `class C { static { C.self = this; } }\nexports.C = C;\n`,
    ],
    [
      "a function inside a class method",
      `class C { m() { return function () { return this; }; } }\nexports.C = C;\n`,
    ],
  ])("class code binds its own strict this: %s", async (_l, source) => {
    const reaches = await reachOf({
      "index.js": `require("./holder");\n`,
      "holder.js": source,
    });
    expect(reaches("./holder")).toBe(false);
  });

  it("an escaped directive is no strict directive: its this still taints", async () => {
    const reaches = await reachOf({
      "index.js": `require("./holder");\n`,
      "holder.js": `"use\\x20strict";\nfunction g() { return this; }\nexports.g = g;\n`,
    });
    expect(reaches("./holder")).toBe(true);
  });

  it("a sloppy this handed on taints (it may be the global object)", async () => {
    const reaches = await reachOf({
      "index.js": `require("./holder");\n`,
      "holder.js": `function g() { return this; }\nexports.g = g;\n`,
    });
    expect(reaches("./holder")).toBe(true);
  });
});

describe("RWF-109 (open): a caller's frame read through a key computed at run time", () => {
  // Masked end to end by the call graph (`tests/oracle/bl074-load-result-dataflow`,
  // `rwf109.frame-key-masked`); the graph's own answer is wrong.
  const DOMAIN: OutcomeDomain<boolean, boolean> = {
    name: "may reach back",
    admits: (pattern, outcome) => pattern === outcome,
  };
  it.each([
    ["a computed key on a function", "g[k]"],
    ["Reflect.get on a function", "Reflect.get(g, k)"],
  ])("%s", async (label, read) => {
    const reaches = await reachOf({
      "index.js": `require("./holder");\n`,
      "holder.js":
        `var k = "cal" + "ler";\n` +
        `Object.defineProperty(exports, "obj", { get: function g() { return ${read}.arguments[0]; } });\n`,
    });
    const record: OpenSoundnessDefect<boolean, boolean> = {
      caseId: `rwf109.${label}`,
      rwf: "RWF-109",
      debt: "D-17",
      admissible: [true],
      expected: true,
      observed: false,
    };
    expect(
      openSoundnessDefectProblems(
        record,
        DOMAIN,
        reaches("./holder"),
        loadDefectRegisters(),
      ),
      `${record.rwf} / ${record.debt}: ${record.caseId}`,
    ).toEqual([]);
  });
});
