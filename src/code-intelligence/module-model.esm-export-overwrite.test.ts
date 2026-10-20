import { NO_LOAD_REACHES_BACK } from "../testing/load-reach.js";
import { describe, expect, it } from "vitest";
import { esmExportForwardingHop } from "./export-forwarding.js";
import {
  buildModuleModel,
  entrypointRootCandidates,
  loadReachQuery,
  mapExportsToFunctions,
  type ExportBinding,
  type LoadReach,
} from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * Task BL-105 (RWF-150): an ES module compiled to CommonJS publishes each
 * export as a property of the wrapper's `exports` object, which an
 * importer reads at each use; a write the file makes onto its export
 * objects replaces what the importer reads. E-1's census (ADR 0009 § 1)
 * gates the ES exports too, and reads the export objects through
 * TypeScript's value-preserving wrappers.
 *
 * Real-Node ground truth for every shape is in
 * `tests/oracle/bl105-ts-esm-export-overwrite.test.ts`; this file pins the
 * rules one at a time.
 */

const FILE = "/pkg/src/decs.ts";

/** Declarations every case shares: two callables, `run` exported. */
const HEAD =
  'import lib = require("lib");\nexport function run() { return lib.parse(); }\nfunction safe() { return lib.safe(); }\n';

function modelOf(text: string, reach: LoadReach = NO_LOAD_REACHES_BACK) {
  const index = indexSourceFile(FILE, text);
  return { index, model: buildModuleModel(index, reach) };
}

function attributed(
  text: string,
  name = "run",
  reach: LoadReach = NO_LOAD_REACHES_BACK,
): string | undefined {
  const { index, model } = modelOf(text, reach);
  return mapExportsToFunctions(index, model).get(name)?.name;
}

function bindingsNamed(
  text: string,
  name: string,
  reach: LoadReach = NO_LOAD_REACHES_BACK,
): ExportBinding[] {
  return modelOf(text, reach).model.exports.filter(
    (binding) =>
      (binding.kind === "default" ? "default" : binding.exportedName) === name,
  );
}

function expectWithdrawn(
  text: string,
  name = "run",
  reach: LoadReach = NO_LOAD_REACHES_BACK,
): void {
  expect(attributed(text, name, reach), "no function is attributed").toBe(
    undefined,
  );
  const bindings = bindingsNamed(text, name, reach);
  expect(bindings.length, "the export still exists").toBeGreaterThan(0);
  expect(
    bindings.every((binding) => binding.exportAttributionWithdrawn === true),
    "and every binding of it is withdrawn",
  ).toBe(true);
}

describe("BL-105: an ES export the file overwrites is withdrawn", () => {
  it("keeps the declared function when nothing writes the export objects", () => {
    expect(attributed(HEAD)).toBe("run");
  });

  it.each([
    ["a cast", "(exports as any).run = safe;"],
    ["an angle-bracket assertion", "(<any>exports).run = safe;"],
    ["a non-null assertion", "exports!.run = safe;"],
    ["`satisfies`", "(exports satisfies any).run = safe;"],
    ["parentheses", "(exports).run = safe;"],
    ["no wrapper", "exports.run = safe;"],
    ["a bracket key through a cast", '(exports as any)["run"] = safe;'],
    ["`module.exports` through a cast", "(module.exports as any).run = safe;"],
    ["`module` through a cast", "(module as any).exports.run = safe;"],
    ["`module.exports.run`", "module.exports.run = safe;"],
    ["an alias", "const e: any = exports;\ne.run = safe;"],
    ["an alias through a cast", "const e = exports as any;\ne.run = safe;"],
    [
      "`Object.defineProperty` through a cast",
      'Object.defineProperty(exports as any, "run", { value: safe });',
    ],
    [
      "a write in a function body",
      "export function swap() { (exports as any).run = safe; }",
    ],
    ["a compound write", "(exports as any).run ||= safe;"],
  ])("withdraws `run` written through %s", (_label, write) => {
    expectWithdrawn(`${HEAD}${write}\n`);
  });

  it("withdraws an `export const` overwritten through a cast", () => {
    expectWithdrawn(
      'import lib = require("lib");\nexport const run = function () { return lib.parse(); };\nconst safe = () => lib.safe();\n(exports as any).run = safe;\n',
    );
  });

  it("withdraws a renamed export under the name it publishes", () => {
    const text =
      'import lib = require("lib");\nfunction impl() { return lib.parse(); }\nexport { impl as run };\n(exports as any).run = () => lib.safe();\n';
    expectWithdrawn(text);
  });

  it("withdraws a default export overwritten under `default`", () => {
    expectWithdrawn(
      'import lib = require("lib");\nexport default function run() { return lib.parse(); }\n(exports as any).default = () => lib.safe();\n',
      "default",
    );
  });

  it("withdraws the CommonJS binding of a name an ES export also publishes", () => {
    const bindings = bindingsNamed(`${HEAD}exports.run = safe;\n`, "run");
    expect(bindings.map((binding) => binding.syntax).sort()).toEqual([
      "commonjs",
      "esm",
    ]);
    expect(
      bindings.every((binding) => binding.exportAttributionWithdrawn === true),
    ).toBe(true);
  });

  it("keeps an export whose name no write sets", () => {
    expect(attributed(`${HEAD}(exports as any).other = safe;\n`)).toBe("run");
    expect(attributed(`${HEAD}exports!.other = safe;\n`)).toBe("run");
    expect(
      attributed(`${HEAD}const e: any = exports;\ne.other = safe;\n`),
    ).toBe("run");
  });

  it("keeps an export the file only reads through a cast", () => {
    expect(attributed(`${HEAD}if ((exports as any).other) { safe(); }\n`)).toBe(
      "run",
    );
  });
});

describe("BL-105: every ES export is withdrawn when the object is not enumerable", () => {
  const OTHER = "export function other() { return lib.safe(); }\n";

  it.each([
    ["the object handed to a call", "hand(exports as any);"],
    ["`module.exports` replaced", "module.exports = { run: safe };"],
    [
      "`module.exports` replaced through a cast",
      "(module as any).exports = {};",
    ],
    [
      "`module.exports` replaced later",
      "export function swap() { module.exports = {}; }",
    ],
    ["`exports` rebound", "exports = {} as any;"],
  ])("%s", (_label, write) => {
    const text = `${HEAD}${OTHER}${write}\n`;
    expectWithdrawn(text, "run");
    expectWithdrawn(text, "other");
  });

  it("an import that may load this file, handed on", () => {
    const text = `${HEAD}${OTHER}import * as self from "./decs";\nhand(self);\n`;
    const reachesBack: LoadReach = { mayReachBack: () => true };
    expectWithdrawn(text, "run", reachesBack);
    expectWithdrawn(text, "other", reachesBack);
    // Its specifier reaches nothing back: the object is another module's.
    expect(attributed(text, "run")).toBe("run");
  });

  it("an import that may load this file, bound to a local, written through", () => {
    // `const o = self` follows the binding: only the name written.
    const text = `${HEAD}${OTHER}import * as self from "./decs";\nconst o: any = self;\no.run = safe;\n`;
    expectWithdrawn(text, "run");
    expect(attributed(text, "other")).toBe("other");
  });
});

describe("BL-105: a member write through an import is a write of its name", () => {
  it.each([
    [
      "a namespace import",
      'import * as self from "./decs";',
      "(self as any).run = safe;",
    ],
    [
      "`import … = require`",
      'import self = require("./decs");',
      "(self as any).run = safe;",
    ],
    [
      "a default import",
      'import self from "./decs";',
      "(self as any).run = safe;",
    ],
    [
      "a named import's member",
      'import { holder } from "./other";',
      "(holder as any).run = safe;",
    ],
  ])("%s", (_label, imported, write) => {
    expectWithdrawn(`${HEAD}${imported}\n${write}\n`);
  });

  // BL-105's independent audit, finding 1: TypeScript compiles a write to a
  // named or default import binding into a member write on the load.
  it.each([
    ["`=`", "r2 = safe;"],
    ["`||=`", "r2 ||= safe;"],
    ["a destructuring", "[r2] = [safe];"],
    ["a later `=`", "export function init() { r2 = safe; }"],
  ])("a write to a named import binding through %s", (_label, write) => {
    expectWithdrawn(`${HEAD}import { run as r2 } from "./decs";\n${write}\n`);
  });

  it("a write to a default import binding writes `default`", () => {
    expectWithdrawn(
      'import lib = require("lib");\nexport default function run() { return lib.parse(); }\nimport self from "./decs";\nself = () => lib.safe();\n',
      "default",
    );
  });

  it("a write to a local that shares an import's spelling elsewhere writes nothing", () => {
    expect(
      attributed(
        `${HEAD}import { run as r2 } from "./decs";\nvoid r2;\nfunction f() { let r2 = safe; r2 = safe; return r2; }\nvoid f;\n`,
      ),
    ).toBe("run");
  });

  it.each([
    ["a type-only namespace import", 'import type * as self from "./decs";'],
    ["a type-only default import", 'import type self from "./decs";'],
    ["a type-only named import", 'import type { self } from "./decs";'],
    ["a type-only specifier", 'import { type self } from "./decs";'],
  ])("not through %s, which loads nothing", (_label, imported) => {
    // TypeScript elides it: `self` is a global at run time.
    expect(attributed(`${HEAD}${imported}\n(self as any).run = safe;\n`)).toBe(
      "run",
    );
  });
});

describe("BL-105: an ES re-export the file may overwrite forwards nothing", () => {
  const REEXPORT = 'export { run } from "./impl";\n';

  it("forwards a re-export nothing writes", () => {
    const { model } = modelOf(REEXPORT);
    expect(esmExportForwardingHop(model, "run")).toEqual({
      specifier: "./impl",
      exportName: "run",
      syntax: "esm",
    });
  });

  it("withdraws it, keeping the module it loads, and the hop refuses it", () => {
    const { model } = modelOf(`${REEXPORT}(exports as any).run = () => 1;\n`);
    const [binding] = model.exports.filter((exp) => exp.kind === "re-export");
    expect(binding?.exportAttributionWithdrawn).toBe(true);
    expect(binding?.specifier).toBe("./impl");
    expect(esmExportForwardingHop(model, "run")).toBeUndefined();
  });
});

describe("BL-105: an entrypoint's withdrawn ES export is a root gap", () => {
  // Found by BL-105's own corpus differential: a withdrawn ES export lost
  // its root and the derivation stayed complete, so family C proved the
  // target unreachable (eight adversarial cases moved into NOT_AFFECTED).
  it("reports the gap, and does not root the declared function", () => {
    const { index, model } = modelOf(`${HEAD}hand(exports as any);\n`);
    const candidates = entrypointRootCandidates(index, model);
    expect(candidates.complete).toBe(false);
    expect(candidates.incompleteness).toContainEqual(
      expect.objectContaining({
        reason: "unresolved_entrypoint_root_candidate",
        exportedName: "run",
      }),
    );
    expect(candidates.locations.map((location) => location.line)).not.toContain(
      2,
    );
  });

  it("names a withdrawn default export `default`", () => {
    const { index, model } = modelOf(
      "export default function run() { return 1; }\n(exports as any).default = () => 2;\n",
    );
    expect(
      entrypointRootCandidates(index, model).incompleteness,
    ).toContainEqual(expect.objectContaining({ exportedName: "default" }));
  });

  it("roots an export nothing overwrites, completely", () => {
    const { index, model } = modelOf(HEAD);
    const candidates = entrypointRootCandidates(index, model);
    expect(candidates.complete).toBe(true);
    expect(candidates.locations.map((location) => location.line)).toContain(2);
  });
});

describe("BL-105: the module-graph query asks about imports", () => {
  it("lists a value import's specifier, not a type-only one's", () => {
    const index = indexSourceFile(
      FILE,
      'import * as a from "./a";\nimport b = require("./b");\nimport { c } from "./c";\nimport type { d } from "./d";\nimport { type e } from "./e";\nimport f from "./f";\nvoid [a, b, c, f];\n',
    );
    expect([...loadReachQuery(index).specifiers].sort()).toEqual([
      "./a",
      "./b",
      "./c",
      "./f",
    ]);
  });

  it("an import its context says reaches nothing back is confined", () => {
    // `hand(x)` hands the import on; only a reach back makes that a write.
    const text = `${HEAD}import * as x from "./x";\nhand(x);\n`;
    expect(attributed(text, "run")).toBe("run");
    expectWithdrawn(text, "run", { mayReachBack: () => true });
    // No context: the census's fail-closed per-file rule.
    const index = indexSourceFile(FILE, text);
    const model = buildModuleModel(index, undefined);
    expect(mapExportsToFunctions(index, model).get("run")).toBeUndefined();
    expect(
      model.exports.find((exp) => exp.exportedName === "run")
        ?.exportAttributionWithdrawn,
    ).toBe(true);
  });
});

describe("BL-105: the census in a CommonJS file reads through the wrappers", () => {
  const CJS =
    'import lib = require("lib");\nfunction dangerous() { return lib.parse(); }\nfunction safe() { return lib.safe(); }\nexports.run = dangerous;\n';

  it("keeps a name a cast write of another name does not set", () => {
    // The base withdrew every name: the cast was an un-enumerable reference.
    expect(attributed(`${CJS}(exports as any).other = safe;\n`)).toBe(
      "dangerous",
    );
  });

  it("withdraws a name whose effective write no binding carries", () => {
    expectWithdrawn(`${CJS}(exports as any).run = safe;\n`);
  });

  it("withdraws every name when `module.exports` is replaced through a cast", () => {
    // No whole-module relation sees `(module as any).exports = v`: it
    // stays an un-enumerable reference.
    expectWithdrawn(`${CJS}(module as any).exports = { run: safe };\n`);
    expectWithdrawn(`${CJS}(module.exports as any) = { run: safe };\n`);
  });

  it("withdraws a name written through a `require` result behind a cast", () => {
    // Another module's load may hand this file's exports object back (E-1's
    // re-audit, F1); the base did not see the member write behind the cast.
    expectWithdrawn(
      `${CJS}const o = require("./other");\n(o as any).run = safe;\n`,
    );
  });
});
