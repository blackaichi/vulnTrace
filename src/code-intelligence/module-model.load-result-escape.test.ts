import { describe, expect, it } from "vitest";
import {
  buildModuleModel,
  fileReachesLoaderRegistry,
  loadReachQuery,
  mapExportsToFunctions,
  type LoadReach,
} from "./module-model.js";
import { indexSourceFile } from "./source-index.js";
import { commonJsExportForwardingHop } from "./export-forwarding.js";

/**
 * Task BL-074 (RWF-103, RWF-106; ADR 0009 § 1, § 4): a load's result that
 * may be an export object of this file is censused wherever it flows. The
 * module graph's answers are `load-reach.test.ts`'s; here the census is
 * given a context and asked what it does with it.
 */

const HEAD =
  `function safe() {}\nfunction dangerous() {}\n` +
  `function set(m) { m.run = dangerous; }\n`;

/** A context in which only the listed specifiers may reach back. */
function reachingOnly(...specifiers: string[]): LoadReach {
  const reaching = new Set(specifiers);
  return { mayReachBack: (specifier) => reaching.has(specifier) };
}

function attributed(source: string, reach?: LoadReach): string | undefined {
  const index = indexSourceFile("/p/node_modules/pkg/index.js", source);
  return mapExportsToFunctions(index, buildModuleModel(index, reach)).get("run")
    ?.name;
}

describe("BL-074: the census without a module graph is the per-file rule", () => {
  it("withdraws a file whose load result is handed on, whatever it loads", () => {
    expect(
      attributed(`${HEAD}exports.run = safe;\nset(require("./plain"));\n`),
    ).toBeUndefined();
  });

  it("keeps a file whose loads stay on the routes the census follows", () => {
    expect(
      attributed(
        `${HEAD}const lib = require("./lib");\nlib.helper();\nconst x = lib.value;\nif (x) { void 0; }\nrequire("./side");\nexports.run = safe;\n`,
      ),
    ).toBe("safe");
  });
});

describe("BL-074: a load that may reach back is an alias wherever it flows", () => {
  it.each([
    ["an argument", `set(require("./other"));\n`],
    [
      "a return",
      `function get() { return require("./other"); }\nget().run = dangerous;\n`,
    ],
    [
      "an array element",
      `const a = [require("./other")];\na[0].run = dangerous;\n`,
    ],
    [
      "an object property",
      `const o = { m: require("./other") };\no.m.run = dangerous;\n`,
    ],
    [
      "a for-of iterable",
      `for (const m of [require("./other")]) m.run = dangerous;\n`,
    ],
    [
      "a destructuring assignment",
      `let o;\n[o] = [require("./other")];\no.run = dangerous;\n`,
    ],
    ["a spread", `const o = { ...require("./other") };\nvoid o;\n`],
    ["a member read handed on", `set(require("./other").self);\n`],
    ["a binding handed on", `const m = require("./other");\nset(m);\n`],
    [
      "a destructured binding handed on",
      `const { self } = require("./other");\nset(self);\n`,
    ],
    [
      "an assigned binding handed on",
      `let m;\nm = require("./other");\nset(m);\n`,
    ],
    [
      "a property write's value, read back",
      `exports.other = require("./other");\nexports.other.run = dangerous;\n`,
    ],
    [
      "a property write's value, read back through a method's this",
      `exports.other = require("./other");\nexports.f = function () { this.other.run = dangerous; };\n`,
    ],
    [
      "a property write's value, in a file that calls its own export",
      `exports.other = require("./other");\nexports.go = function () {};\nexports.go();\n`,
    ],
    [
      "a property write's value, in a file that loads itself",
      `exports.other = require("./other");\nconst me = require("./index");\nvoid me;\n`,
    ],
    [
      "an assignment's value handed on",
      `let a;\nset(a = require("./other"));\n`,
    ],
    [
      "a chained assignment",
      `let a, b;\na = b = require("./other");\nset(a);\n`,
    ],
    [
      "an own-property write's value handed on",
      `set(exports.b = require("./other"));\n`,
    ],
    [
      "a whole-module write's value handed on",
      `set(module.exports = require("./other"));\n`,
    ],
    ["await", `async function f() { await require("./other"); }\nvoid f;\n`],
    ["require.call", `set(require.call(null, "./plain"));\n`],
    ["require.main.require", `set(require.main.require("./plain"));\n`],
    ["a computed specifier", `const n = "./plain";\nset(require(n + ""));\n`],
  ])("withdraws the file: %s", (_label, use) => {
    expect(
      attributed(`${HEAD}exports.run = safe;\n${use}`, reachingOnly("./other")),
    ).toBeUndefined();
  });

  it.each([
    ["exports.x", `exports.other = require("./other");\n`],
    ["module.exports.x", `module.exports.other = require("./other");\n`],
    ["a bracket key", `exports["other"] = require("./other");\n`],
  ])(
    "keeps a file that never reads its export objects back: %s = load",
    (_label, use) => {
      expect(
        attributed(
          `function safe() {}\nexports.run = safe;\n${use}`,
          reachingOnly("./other"),
        ),
      ).toBe("safe");
    },
  );

  it("withdraws on a bound loader that escapes uncalled", () => {
    expect(
      attributed(
        `${HEAD}exports.run = safe;\nconst r = require.bind(null);\nvoid r;\n`,
        reachingOnly(),
      ),
    ).toBeUndefined();
  });

  it.each([
    ["a member call", `require("./other").helper();\n`],
    ["a callee", `require("./other")();\n`],
    ["a construction", `new (require("./other"))();\n`],
    ["a member read, tested", `if (require("./other").flag) { void 0; }\n`],
    ["a discarded load", `require("./other");\n`],
    ["typeof", `void typeof require("./other");\n`],
    [
      "a binding only called through",
      `const m = require("./other");\nm.helper();\nconst h = m.value;\nif (h) { void 0; }\n`,
    ],
    ["a bound loader called at once", `require.bind(null)("./plain");\n`],
  ])("keeps the file: %s", (_label, use) => {
    expect(
      attributed(`${HEAD}exports.run = safe;\n${use}`, reachingOnly("./other")),
    ).toBe("safe");
  });

  it("a member write through a confined load still withdraws its name (E-1)", () => {
    const index = indexSourceFile(
      "/p/node_modules/pkg/index.js",
      `${HEAD}exports.run = safe;\nexports.keep = safe;\nrequire("./other").run = dangerous;\n`,
    );
    const map = mapExportsToFunctions(
      index,
      buildModuleModel(index, reachingOnly("./other")),
    );
    expect(map.get("run")).toBeUndefined();
    expect(map.get("keep")?.name).toBe("safe");
  });

  it("keeps the file when the same flows reach only loads that cannot reach back", () => {
    expect(
      attributed(
        `${HEAD}exports.run = safe;\nset(require("./plain"));\nconst a = [require("./leaf")];\nvoid a;\n`,
        reachingOnly("./other"),
      ),
    ).toBe("safe");
  });
});

describe("BL-074: the forwarded object (RWF-106)", () => {
  function hop(source: string, reach?: LoadReach) {
    const index = indexSourceFile("/p/node_modules/wrap/index.js", source);
    return commonJsExportForwardingHop(buildModuleModel(index, reach), "run");
  }

  it("the whole-module write itself is the identity walk's, not an escape", () => {
    expect(
      hop(`module.exports = require("./safe");\n`, reachingOnly("./safe")),
    ).toEqual({ specifier: "./safe", exportName: "run", syntax: "commonjs" });
  });

  it("refuses every forward once a load of the forwarded module is handed on", () => {
    expect(
      hop(
        `module.exports = require("./safe");\nfunction patch(o) { o.run = 1; }\npatch(require("./safe"));\n`,
        reachingOnly("./safe"),
      ),
    ).toBeUndefined();
  });

  it("keeps the forward when the load handed on cannot reach the forwarded module", () => {
    expect(
      hop(
        `module.exports = require("./safe");\nfunction patch(o) { o.run = 1; }\npatch(require("./plain"));\n`,
        reachingOnly("./safe"),
      ),
    ).toEqual({ specifier: "./safe", exportName: "run", syntax: "commonjs" });
  });
});

describe("BL-074: what the census asks of the module graph", () => {
  const query = (source: string) =>
    loadReachQuery(indexSourceFile("/p/index.js", source));

  it("every literal specifier resolved from this file", () => {
    expect(
      [
        ...query(
          `require("./a");\nconst r = require;\nr("./b");\nmodule.require("./c");\nrequire.main.require("./d");\nrequire(x);\n`,
        ).specifiers,
      ].sort(),
    ).toEqual(["./a", "./b", "./c"]);
  });

  it.each([
    ["a load", `module.exports = require("./safe");\n`, ["./safe"], false],
    [
      "a member of a load",
      `module.exports = require("./lib").sub;\n`,
      ["./lib"],
      false,
    ],
    ["export =", `export = require("./safe");\n`, ["./safe"], false],
    [
      "a chained write",
      `exports = module.exports = require("./safe");\n`,
      ["./safe"],
      false,
    ],
    ["an object literal", `module.exports = { a: 1 };\n`, [], false],
    [
      "a function declaration",
      `function f() {}\nmodule.exports = f;\n`,
      [],
      false,
    ],
    [
      "a const bound to a literal",
      `const api = {};\nmodule.exports = api;\n`,
      [],
      false,
    ],
    ["a call's result", `module.exports = make();\n`, [], true],
    ["a construction", `module.exports = new Thing();\n`, [], true],
    [
      "a reassigned binding",
      `let api = {};\napi = other;\nmodule.exports = api;\n`,
      [],
      true,
    ],
    [
      "a binding bound to a load",
      `const lib = require("./lib");\nmodule.exports = lib;\n`,
      [],
      true,
    ],
    ["a computed load", `module.exports = require(name);\n`, [], true],
  ])("a whole-module write of %s", (_label, source, forwards, opaque) => {
    const answer = query(source);
    expect([...answer.forwardSpecifiers]).toEqual(forwards);
    expect(answer.opaqueFinalObject).toBe(opaque);
  });
});

describe("BL-074: the loader-registry scan of a closure member", () => {
  const reaches = (source: string) =>
    fileReachesLoaderRegistry(indexSourceFile("/p/m.js", source));

  it.each([
    ["module.parent", "exports.p = module.parent;"],
    ["module.constructor", "exports.M = module.constructor;"],
    ["require.cache", "void require.cache;"],
    ["require.apply", 'require.apply(null, ["./x"]);'],
    ["process.mainModule", "void process.mainModule;"],
    ["a module builtin", 'require("node:module");'],
    ["the wrapper's arguments at module scope", "exports.a = arguments;"],
  ])("reaches: %s", (_label, source) => {
    expect(reaches(source)).toBe(true);
  });

  it.each([
    [
      "a function's own arguments",
      "function f() { return arguments; }\nexports.f = f;",
    ],
    [
      "a lodash-style alias reading only exports",
      'var freeModule = typeof module == "object" && module;\nif (freeModule) { freeModule.exports = {}; }',
    ],
    ["process.env", "exports.e = process.env.HOME;"],
    ["require.main compared", "if (require.main === module) { void 0; }"],
    ["a direct require", 'require("./x");'],
  ])("does not reach: %s", (_label, source) => {
    expect(reaches(source)).toBe(false);
  });
});
