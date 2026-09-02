import { describe, expect, it } from "vitest";
import {
  buildModuleModel,
  findExportedClassMembers,
  mapExportsToFunctions,
} from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

function modelOf(fileName: string, text: string) {
  return buildModuleModel(indexSourceFile(fileName, text));
}

describe("buildModuleModel: imports converge across ESM/CommonJS syntax", () => {
  it("unifies a default ESM import and a whole-module require() as kind:default", () => {
    const esm = modelOf("a.ts", 'import foo from "foo";\n');
    const cjs = modelOf("a.js", 'const foo = require("foo");\n');

    expect(esm.imports[0]).toMatchObject({
      kind: "default",
      syntax: "esm",
      localName: "foo",
    });
    expect(cjs.imports[0]).toMatchObject({
      kind: "default",
      syntax: "commonjs",
      localName: "foo",
    });
  });

  it("unifies an aliased named ESM import and a destructured require() as kind:named", () => {
    const esm = modelOf("a.ts", 'import { vulnerable as v } from "foo";\n');
    const cjs = modelOf("a.js", 'const { vulnerable: v } = require("foo");\n');

    for (const model of [esm, cjs]) {
      expect(model.imports[0]).toMatchObject({
        kind: "named",
        localName: "v",
        importedName: "vulnerable",
      });
    }
    expect(esm.imports[0]?.syntax).toBe("esm");
    expect(cjs.imports[0]?.syntax).toBe("commonjs");
  });

  it("classifies a namespace import as kind:namespace (ESM only)", () => {
    const model = modelOf("a.ts", 'import * as ns from "foo";\n');
    expect(model.imports[0]).toMatchObject({
      kind: "namespace",
      syntax: "esm",
    });
  });

  it("unifies side-effect imports and bare require() calls as kind:side-effect", () => {
    const esm = modelOf("a.ts", 'import "foo";\n');
    const cjs = modelOf("a.js", 'require("foo");\n');

    expect(esm.imports[0]).toMatchObject({
      kind: "side-effect",
      syntax: "esm",
    });
    expect(cjs.imports[0]).toMatchObject({
      kind: "side-effect",
      syntax: "commonjs",
    });
  });
});

describe("buildModuleModel: exports converge across ESM/CommonJS syntax", () => {
  it("unifies a named ESM export and exports.foo = ... as kind:named", () => {
    const esm = modelOf("a.ts", "export function vulnerable() {}\n");
    const cjs = modelOf("a.js", "exports.vulnerable = function () {};\n");

    expect(esm.exports[0]).toMatchObject({
      kind: "named",
      exportedName: "vulnerable",
      syntax: "esm",
    });
    expect(cjs.exports[0]).toMatchObject({
      kind: "named",
      exportedName: "vulnerable",
      syntax: "commonjs",
    });
  });

  it("unifies a default ESM export and module.exports = <non-object> as kind:default", () => {
    const esm = modelOf("a.ts", "export default function () {}\n");
    const cjs = modelOf("a.js", "module.exports = function () {};\n");

    expect(esm.exports[0]).toMatchObject({ kind: "default", syntax: "esm" });
    expect(cjs.exports[0]).toMatchObject({
      kind: "default",
      syntax: "commonjs",
    });
  });

  it("captures the local name of a named function expression assigned to module.exports", () => {
    const model = modelOf("a.js", "module.exports = function main() {};\n");
    expect(model.exports[0]).toMatchObject({
      kind: "default",
      localName: "main",
    });
  });

  it("captures the local name of an identifier assigned to module.exports", () => {
    const model = modelOf(
      "a.js",
      "function main() {}\nmodule.exports = main;\n",
    );
    expect(model.exports[0]).toMatchObject({
      kind: "default",
      localName: "main",
    });
  });

  it("leaves localName undefined for an anonymous inline export value", () => {
    const model = modelOf("a.js", "module.exports = () => {};\n");
    expect(model.exports[0]).toMatchObject({
      kind: "default",
      localName: undefined,
    });
  });

  it("preserves a re-export's source specifier", () => {
    const model = modelOf("a.ts", 'export { vulnerable } from "./other";\n');
    expect(model.exports[0]).toMatchObject({
      kind: "re-export",
      specifier: "./other",
    });
  });
});

describe("buildModuleModel: module.exports object literal unpacking", () => {
  it("unpacks shorthand and renamed properties into named exports", () => {
    const model = modelOf(
      "a.js",
      "function vulnerable() {}\nfunction safe() {}\n" +
        "module.exports = { vulnerable, safeFn: safe };\n",
    );

    expect(model.exports).toEqual([
      {
        kind: "named",
        syntax: "commonjs",
        exportedName: "vulnerable",
        localName: "vulnerable",
        location: expect.any(Object),
      },
      {
        kind: "named",
        syntax: "commonjs",
        exportedName: "safeFn",
        localName: "safe",
        location: expect.any(Object),
      },
    ]);
  });

  it("unpacks method-shorthand properties", () => {
    const model = modelOf(
      "a.js",
      "module.exports = { vulnerable() { return 1; } };\n",
    );

    expect(model.exports).toEqual([
      {
        kind: "named",
        syntax: "commonjs",
        exportedName: "vulnerable",
        localName: "vulnerable",
        // RWF-011: a method IS its own function node, so the binding also
        // carries that node's exact position. `localName` alone is the
        // method's own name, which for this shape necessarily equals the
        // exported name and so cannot distinguish the method from an
        // unrelated same-file `function vulnerable() {}`.
        localFunctionLocation: expect.any(Object),
        location: expect.any(Object),
      },
    ]);
  });

  it("falls back to a single default export when the object literal has no statically nameable properties", () => {
    const model = modelOf("a.js", "module.exports = { ...someObject };\n");

    expect(model.exports).toEqual([
      { kind: "default", syntax: "commonjs", location: expect.any(Object) },
    ]);
  });

  it("represents export = { ... } (TypeScript syntax) the same way as module.exports = { ... }", () => {
    const model = modelOf(
      "a.ts",
      "function vulnerable() {}\nexport = { vulnerable };\n",
    );

    expect(model.exports).toEqual([
      {
        kind: "named",
        syntax: "commonjs",
        exportedName: "vulnerable",
        localName: "vulnerable",
        location: expect.any(Object),
      },
    ]);
  });

  it("uses only the last module.exports assignment when reassigned", () => {
    const model = modelOf(
      "a.js",
      "module.exports = { a: 1 };\nmodule.exports = { b: 2 };\n",
    );

    expect(model.exports).toEqual([
      {
        kind: "named",
        syntax: "commonjs",
        exportedName: "b",
        localName: undefined,
        location: expect.any(Object),
      },
    ]);
  });

  it("unpacks a computed property whose key is a same-file const string literal (VT-217)", () => {
    const model = modelOf(
      "a.js",
      'const NAME = "vulnerable";\n' +
        "function vulnerableImpl() {}\n" +
        "module.exports = { [NAME]: vulnerableImpl };\n",
    );

    expect(model.exports).toEqual([
      {
        kind: "named",
        syntax: "commonjs",
        exportedName: "vulnerable",
        localName: "vulnerableImpl",
        location: expect.any(Object),
      },
    ]);
  });

  it("unpacks a computed property whose key is a direct string literal", () => {
    const model = modelOf(
      "a.js",
      'module.exports = { ["vulnerable"]: function () {} };\n',
    );

    expect(model.exports[0]).toMatchObject({
      exportedName: "vulnerable",
    });
  });

  it("unpacks a computed method-shorthand property whose key resolves to a literal", () => {
    const model = modelOf(
      "a.js",
      'const NAME = "vulnerable";\n' +
        "module.exports = { [NAME]() { return 1; } };\n",
    );

    expect(model.exports).toEqual([
      {
        kind: "named",
        syntax: "commonjs",
        exportedName: "vulnerable",
        localName: "vulnerable",
        // RWF-011: load-bearing for this shape rather than merely more
        // precise — source indexing records a computed method under its
        // literal source text (`[NAME]`), so no name search could ever
        // find it and position is the only thing that resolves it.
        localFunctionLocation: expect.any(Object),
        location: expect.any(Object),
      },
    ]);
  });

  it("does not unpack a computed property whose key cannot be statically resolved", () => {
    const model = modelOf(
      "a.js",
      "module.exports = { [computeName()]: function () {} };\n",
    );

    expect(model.exports).toEqual([
      { kind: "default", syntax: "commonjs", location: expect.any(Object) },
    ]);
  });

  it("does not unpack a computed property whose key is a let (reassignment not tracked)", () => {
    const model = modelOf(
      "a.js",
      'let NAME = "vulnerable";\n' +
        "module.exports = { [NAME]: function () {} };\n",
    );

    expect(model.exports).toEqual([
      { kind: "default", syntax: "commonjs", location: expect.any(Object) },
    ]);
  });
});

describe("mapExportsToFunctions: canonical export name -> underlying function", () => {
  it("maps 'default' to the function even though the function's own name differs (module.exports = someNamedFunction)", () => {
    const fileName = "a.js";
    const text =
      "function vulnerable() {\n  return 1;\n}\n\nmodule.exports = vulnerable;\n";
    const index = indexSourceFile(fileName, text);
    const model = buildModuleModel(index);

    const mapped = mapExportsToFunctions(index, model);

    expect(mapped.get("default")?.name).toBe("vulnerable");
    // The regression this guards: a naive lookup keyed by the function's
    // own name (as a GraphNode.name comparison would do) must NOT be what
    // callers rely on for a canonical "default" export -- only the
    // canonical name "default" should be a key here.
    expect(mapped.has("vulnerable")).toBe(false);
  });

  it("maps a named ESM export to the function of the same name", () => {
    const fileName = "a.ts";
    const text = "export function vulnerable() {\n  return 1;\n}\n";
    const index = indexSourceFile(fileName, text);
    const model = buildModuleModel(index);

    const mapped = mapExportsToFunctions(index, model);

    expect(mapped.get("vulnerable")?.name).toBe("vulnerable");
  });

  it("returns an empty map when module.exports is an object literal (unpacked named exports already carry their own localName)", () => {
    const fileName = "a.js";
    const text =
      "function vulnerable() {\n  return 1;\n}\n\nmodule.exports = { vulnerable };\n";
    const index = indexSourceFile(fileName, text);
    const model = buildModuleModel(index);

    const mapped = mapExportsToFunctions(index, model);

    expect(mapped.get("vulnerable")?.name).toBe("vulnerable");
    expect(mapped.has("default")).toBe(false);
  });

  it("maps a named class export to its own constructor (VT-207)", () => {
    const fileName = "a.ts";
    const text = "export class Vulnerable {\n  constructor() {}\n}\n";
    const index = indexSourceFile(fileName, text);
    const model = buildModuleModel(index);

    const mapped = mapExportsToFunctions(index, model);

    expect(mapped.get("Vulnerable")).toMatchObject({ kind: "constructor" });
  });
});

describe("findExportedClassMembers: export -> exported class -> member provenance (VT-301A)", () => {
  it("attributes an instance method of an exported class by structural provenance, not name search", () => {
    const fileName = "a.ts";
    const text = "export class Lib {\n  runDangerous() {}\n  runSafe() {}\n}\n";
    const index = indexSourceFile(fileName, text);
    const model = buildModuleModel(index);

    const candidates = findExportedClassMembers(index, model, "runDangerous");

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "method",
      name: "runDangerous",
      memberOf: { className: "Lib", isStatic: false },
    });
  });

  it("attributes a static method of an exported class", () => {
    const fileName = "a.ts";
    const text = "export class Lib {\n  static staticDangerous() {}\n}\n";
    const index = indexSourceFile(fileName, text);
    const model = buildModuleModel(index);

    const candidates = findExportedClassMembers(
      index,
      model,
      "staticDangerous",
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.memberOf).toEqual({
      className: "Lib",
      isStatic: true,
    });
  });

  it("attributes a base class's method reached only via a rule targeting the exporting module (inheritance)", () => {
    const fileName = "a.ts";
    const text = "export class Base {\n  dangerousOp() {}\n}\n";
    const index = indexSourceFile(fileName, text);
    const model = buildModuleModel(index);

    const candidates = findExportedClassMembers(index, model, "dangerousOp");

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.memberOf?.className).toBe("Base");
  });

  it("does NOT attribute a same-named method belonging to a class the module does not export (RWF-011 provenance guard)", () => {
    const fileName = "a.ts";
    const text =
      "class Unexported {\n  parse() {}\n}\n\nexport class Lib {\n  runDangerous() {}\n}\n";
    const index = indexSourceFile(fileName, text);
    const model = buildModuleModel(index);

    // "parse" exists in the file (on Unexported) but Unexported is never
    // exported -- a same-file bare-name search would find it; structural
    // export provenance must not.
    const candidates = findExportedClassMembers(index, model, "parse");

    expect(candidates).toHaveLength(0);
  });

  it("returns every structurally valid candidate when two exported classes both declare a member with the same name (ambiguity is preserved, not resolved arbitrarily)", () => {
    const fileName = "a.ts";
    const text =
      "export class A {\n  parse() {}\n}\nexport class B {\n  parse() {}\n}\n";
    const index = indexSourceFile(fileName, text);
    const model = buildModuleModel(index);

    const candidates = findExportedClassMembers(index, model, "parse");

    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.memberOf?.className).sort()).toEqual([
      "A",
      "B",
    ]);
  });

  it("returns an empty array when the module exports no attributable class at all (RWB-03/fast-xml-parser shape: no class in the canonical export table)", () => {
    const fileName = "a.js";
    // Simulates a webpack-style export where the export table can't
    // attribute any class at all -- module-model.ts's mapExportsToFunctions
    // never sees a class here, so findExportedClassMembers must not fall
    // back to scanning every class declared anywhere in the file.
    const text =
      "class Hidden {\n  parse() {}\n}\n\nObject.defineProperty(module.exports, 'X', { get: () => Hidden });\n";
    const index = indexSourceFile(fileName, text);
    const model = buildModuleModel(index);

    const candidates = findExportedClassMembers(index, model, "parse");

    expect(candidates).toHaveLength(0);
  });

  it("returns an empty array for a member name that no exported class declares", () => {
    const fileName = "a.ts";
    const text = "export class Lib {\n  runDangerous() {}\n}\n";
    const index = indexSourceFile(fileName, text);
    const model = buildModuleModel(index);

    const candidates = findExportedClassMembers(index, model, "nope");

    expect(candidates).toHaveLength(0);
  });
});
