import { describe, expect, it } from "vitest";
import { findClosureWideningConstructs } from "./loader-constructs.js";
import { buildModuleModel } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * Task BL-092 (docs/tasks/BL-092-loader-capability-routes.md): the loader
 * classifier recognises a `Module` instance's lookup list (RWF-129, and
 * PRM-107's false NOT_AFFECTED half), `Module.prototype` through
 * `__proto__` (RWF-130), every write a destructuring pattern, a `for…in` /
 * `for…of` head, `++` / `--` or a compound operator makes (RWF-133), the
 * CommonJS wrapper's own `arguments` (RWF-134) and an instance's inherited
 * loader methods (RWF-135) by the object they reach, not by spelling.
 * Real Node's answers: `tests/oracle/bl092-loader-capability-routes.test.ts`.
 * These pin the classifier's answer per rule, so each of the task's
 * mutations is caught by name.
 */

function reasons(source: string): string[] {
  const index = indexSourceFile("/virtual/index.js", source);
  return findClosureWideningConstructs({
    index,
    model: buildModuleModel(index),
  }).map((construct) => construct.reason);
}

describe("a Module instance's lookup list, through any route (RWF-129)", () => {
  it.each([
    ["a const alias, then shift", "const p = module.paths;\np.shift();\n"],
    [
      "a const alias, then unshift (PRM-107)",
      "const p = module.paths;\np.unshift(d);\n",
    ],
    ["the element-access spelling", 'module["paths"].shift();\n'],
    ["require.main's list", "require.main.paths.push(d);\n"],
    ["an alias of module", "const m = module;\nm.paths.splice(0, 1);\n"],
    ["a method named by a literal key", 'module.paths["pop"]();\n'],
  ])(
    "a mutating method through %s is loader_hook_mutation",
    (_label, source) => {
      expect(reasons(source)).toContain("loader_hook_mutation");
    },
  );

  it.each([
    ["an element store", "module.paths[0] = d;\n"],
    ["a computed element store", "module.paths[i] = d;\n"],
    [
      "an element store through an alias",
      "const p = module.paths;\np[0] = d;\n",
    ],
    ["a length store", "module.paths.length = 0;\n"],
    ["a compound element store", 'module.paths[0] += "/x";\n'],
    ["a whole replacement", "module.paths = [d];\n"],
  ])("%s is loader_hook_mutation", (_label, source) => {
    expect(reasons(source)).toContain("loader_hook_mutation");
  });

  it.each([
    ["handed to a function", "drop(module.paths);\n"],
    [
      "handed to Array.prototype.shift.call",
      "Array.prototype.shift.call(module.paths);\n",
    ],
    ["held in an object", "const h = { p: module.paths };\n"],
    ["held in an array", "const ps = [module.paths];\n"],
    ["returned", "function get() { return module.paths; }\n"],
    ["stored in a let", "let p = module.paths;\n"],
    ["spread into an array", "const copy = [...module.paths];\n"],
    [
      "a callback method, which hands the list to its callback",
      "module.paths.forEach((p, i, a) => a.shift());\n",
    ],
    ["a method under a computed key", "module.paths[m]();\n"],
    ["an unknown method", "module.paths.frobnicate();\n"],
    ["a delete of an element", "delete module.paths[0];\n"],
  ])("%s is loader_capability_escape", (_label, source) => {
    expect(reasons(source)).toContain("loader_capability_escape");
  });

  it.each([
    [
      "the read-only methods",
      "const s = module.paths.slice();\nconst h = module.paths.includes(d) || module.paths.indexOf(d) >= 0;\nconst j = module.paths.join(':');\n",
    ],
    [
      "an element read and length",
      "const n = module.paths.length;\nconst first = module.paths[0];\nconst last = module.paths[n - 1];\n",
    ],
    [
      "iteration",
      "for (const dir of module.paths) { use(dir); }\nfor (const i in module.paths) { use(i); }\n",
    ],
    [
      "a const alias that is only read",
      "const p = module.paths;\nconst n = p.length;\n",
    ],
    [
      "a same-file object's own paths",
      "const obj = { paths: [] };\nobj.paths.shift();\nobj.paths[0] = d;\n",
    ],
    [
      "the module's own exports",
      "module.exports.paths = [];\nexports.paths.push(d);\n",
    ],
  ])("%s stays complete (precision control)", (_label, source) => {
    expect(reasons(source)).toEqual([]);
  });
});

describe("module.__proto__ is Module.prototype (RWF-130)", () => {
  it.each([
    ["spelled", "module.__proto__.require = hook;\n"],
    ["the element-access spelling", 'module["__proto__"].require = hook;\n'],
    ["a const alias", "const P = module.__proto__;\nP._compile = hook;\n"],
    ["off require.main", "require.main.__proto__.load = hook;\n"],
  ])(
    "replacing a loader member through it %s is loader_hook_mutation",
    (_label, source) => {
      expect(reasons(source)).toContain("loader_hook_mutation");
    },
  );

  it("calling a loader member through it keeps the prototype member's reason", () => {
    expect(reasons("module.__proto__.require.call(module, name);\n")).toContain(
      "module_internal_load",
    );
  });
});

describe("every write a target makes (RWF-133)", () => {
  it.each([
    [
      "an array pattern onto a Module static member",
      'const Module = require("module");\n[Module._resolveFilename] = [hook];\n',
    ],
    [
      "an object pattern onto a Module static member",
      'const Module = require("module");\n({ a: Module._load } = o);\n',
    ],
    [
      "a nested pattern with a default",
      'const Module = require("module");\n[{ x: [Module._findPath = d] }] = o;\n',
    ],
    ["a rest target replacing the lookup list", "[...module.paths] = [d];\n"],
    [
      "an object pattern replacing the lookup list",
      "({ paths: module.paths } = o);\n",
    ],
    [
      "an array pattern onto an element of the list",
      "[module.paths[0]] = [d];\n",
    ],
    ["a for…of head", "for (module.paths[0] of [d]);\n"],
    ["a for…in head", "for (module.paths[0] in o);\n"],
    [
      "a destructuring for…of head",
      'const Module = require("module");\nfor ([Module._resolveFilename] of [[hook]]);\n',
    ],
    ["++ on an element of the list", "module.paths[0]++;\n"],
    ["-- on the list's length", "module.paths.length--;\n"],
    [
      "a compound assignment onto a Module static member",
      'const Module = require("module");\nModule._resolveFilename += "";\n',
    ],
  ])("%s is loader_hook_mutation", (_label, source) => {
    expect(reasons(source)).toContain("loader_hook_mutation");
  });

  it("a pattern of plain bindings writes nothing modeled (precision control)", () => {
    expect(
      reasons(
        "let a, b;\n[a, b] = [1, 2];\n({ a, b } = o);\nfor (a of [1]);\na++;\n",
      ),
    ).toEqual([]);
  });
});

describe("the CommonJS wrapper's own arguments (RWF-134)", () => {
  it.each([
    ["arguments[1] called (require)", 'arguments[1]("x");\n'],
    ["arguments[2]'s lookup list (module)", "arguments[2].paths.shift();\n"],
    [
      "arguments[2]'s constructor member written",
      "arguments[2].constructor._resolveFilename = hook;\n",
    ],
    [
      "an alias, then an element",
      "const a = arguments;\na[2].paths.shift();\n",
    ],
    ["inside a top-level arrow", "const f = () => arguments[1](n);\nf();\n"],
    [
      "a method's computed name, evaluated outside the method",
      'class C { [arguments[1]("x")]() {} }\n',
    ],
    [
      "a method's decorator, evaluated outside the method",
      'class C { @(arguments[1])("x") m() {} }\n',
    ],
    ["handed to a function", "inspect(arguments);\n"],
    [
      "with a same-name const in some function (audit finding 3)",
      "function f() { const arguments = 1; return arguments; }\narguments[2].constructor._resolveFilename = hook;\n",
    ],
  ])("%s is loader_capability_escape", (_label, source) => {
    expect(reasons(source)).toContain("loader_capability_escape");
  });

  it.each([
    [
      "the Module constructor",
      'function f() { const arguments = require("module"); arguments._resolveFilename = hook; }\nf();\n',
      "loader_hook_mutation",
    ],
    [
      "the lookup list",
      "function f() { const arguments = module.paths; arguments.shift(); }\nf();\n",
      "loader_hook_mutation",
    ],
    [
      "require",
      "function f() { const arguments = require; return arguments(p); }\nf();\n",
      "aliased_require",
    ],
  ])(
    "a function's own `const arguments` aliasing %s is followed (audit round 2, R2-1)",
    (_label, source, reason) => {
      expect(reasons(source)).toContain(reason);
    },
  );

  it("a function's own arguments stay that function's (precision control)", () => {
    expect(
      reasons(
        "function f() { const a = arguments; g(arguments); return arguments[1]; }\n" +
          "const o = { m() { return arguments[0]; } };\n" +
          "class K { constructor() { use(arguments); } }\n",
      ),
    ).toEqual([]);
  });
});

describe("an instance's inherited loader methods (RWF-135)", () => {
  it.each([
    [
      "a const alias of module.require, called",
      "const r = module.require;\nr(name);\n",
      "module_require",
    ],
    [
      "the spelled call, unchanged",
      "module.require(name);\n",
      "module_require",
    ],
    [
      "an alias of require.main.load, called",
      "const l = require.main.load;\nl.call(m, f);\n",
      "module_internal_load",
    ],
    [
      "an alias of module._compile, applied",
      "const c = module._compile;\nc.apply(module, [src, f]);\n",
      "vm_execution",
    ],
  ])("%s keeps its reason", (_label, source, reason) => {
    expect(reasons(source)).toContain(reason);
  });

  it.each([
    ["exported", "exports.req = module.require;\n"],
    ["handed to a function", "keep(module.require);\n"],
    ["stored in a let", "let r = module.require;\n"],
  ])("module.require %s is loader_capability_escape", (_label, source) => {
    expect(reasons(source)).toContain("loader_capability_escape");
  });
});

describe("a with head (RWF-138)", () => {
  it.each([
    ["the lookup list", "with (module.paths) { shift(); }\n"],
    ["a Module instance", "with (module) { paths.shift(); }\n"],
    [
      "the Module constructor",
      'with (require("module")) { _resolveFilename = hook; }\n',
    ],
    [
      "process (audit round 2, R2-2)",
      "with (process) { mainModule.require(p); }\n",
    ],
    [
      "the global object",
      "with (globalThis) { process.mainModule.require(p); }\n",
    ],
  ])("%s is loader_capability_escape", (_label, source) => {
    expect(reasons(source)).toContain("loader_capability_escape");
  });

  it("an ordinary object stays complete (precision control)", () => {
    expect(reasons("with (Math) { use(max(1, 2)); }\n")).toEqual([]);
  });
});
