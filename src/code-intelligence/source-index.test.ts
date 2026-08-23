import { describe, expect, it } from "vitest";
import { SourceFileNotFoundError } from "./source-index-errors.js";
import { indexSourceFile, indexSourceFiles } from "./source-index.js";

describe("indexSourceFile: functions", () => {
  it("indexes a named function declaration with its location", () => {
    const index = indexSourceFile("a.ts", "function foo() {}\n");
    expect(index.functions).toEqual([
      {
        kind: "function",
        name: "foo",
        isAsync: false,
        location: { file: "a.ts", line: 1, column: 1 },
      },
    ]);
  });

  it("captures async on a function declaration", () => {
    const index = indexSourceFile("a.ts", "async function foo() {}\n");
    expect(index.functions[0]?.isAsync).toBe(true);
  });

  it("indexes a class method and constructor, naming the constructor after its class (VT-207)", () => {
    const index = indexSourceFile(
      "a.ts",
      "class Foo {\n  constructor() {}\n  bar() {}\n}\n",
    );
    expect(index.functions).toEqual([
      {
        kind: "constructor",
        name: "Foo",
        isAsync: false,
        location: { file: "a.ts", line: 2, column: 3 },
        memberOf: { className: "Foo", isStatic: false },
      },
      {
        kind: "method",
        name: "bar",
        isAsync: false,
        location: { file: "a.ts", line: 3, column: 3 },
        memberOf: { className: "Foo", isStatic: false },
      },
    ]);
  });

  it("names an anonymous class expression's constructor after the variable it's assigned to", () => {
    const index = indexSourceFile(
      "a.ts",
      "const Foo = class {\n  constructor() {}\n};\n",
    );
    expect(index.functions[0]).toMatchObject({
      kind: "constructor",
      name: "Foo",
    });
  });

  it("names an anonymous class expression's constructor from a CommonJS exports.X assignment", () => {
    const index = indexSourceFile(
      "a.js",
      "exports.Foo = class {\n  constructor() {}\n};\n",
    );
    expect(index.functions[0]).toMatchObject({
      kind: "constructor",
      name: "Foo",
    });
  });

  it("leaves a fully anonymous class expression's constructor unnamed", () => {
    const index = indexSourceFile(
      "a.ts",
      "[class {\n  constructor() {}\n}];\n",
    );
    expect(index.functions[0]).toMatchObject({
      kind: "constructor",
      name: undefined,
    });
  });

  it("synthesizes a constructor entry for a class with no explicit constructor of its own (VT-215)", () => {
    const index = indexSourceFile("a.ts", "class Foo {\n  bar() {}\n}\n");
    expect(index.functions).toEqual([
      {
        kind: "constructor",
        name: "Foo",
        isAsync: false,
        location: { file: "a.ts", line: 1, column: 7 },
        memberOf: { className: "Foo", isStatic: false },
      },
      {
        kind: "method",
        name: "bar",
        isAsync: false,
        location: { file: "a.ts", line: 2, column: 3 },
        memberOf: { className: "Foo", isStatic: false },
      },
    ]);
  });

  it("does not synthesize a duplicate constructor entry when an explicit one already exists", () => {
    const index = indexSourceFile(
      "a.ts",
      "class Foo {\n  constructor() {}\n}\n",
    );
    const constructors = index.functions.filter(
      (fn) => fn.kind === "constructor",
    );
    expect(constructors).toHaveLength(1);
    expect(constructors[0]).toMatchObject({ name: "Foo" });
  });

  it("names a synthesized constructor after the variable an anonymous class expression is assigned to", () => {
    const index = indexSourceFile(
      "a.ts",
      "const Foo = class {\n  bar() {}\n};\n",
    );
    const constructors = index.functions.filter(
      (fn) => fn.kind === "constructor",
    );
    expect(constructors).toHaveLength(1);
    expect(constructors[0]).toMatchObject({ name: "Foo" });
  });

  it("infers a name for an arrow function assigned to a variable", () => {
    const index = indexSourceFile("a.ts", "const foo = () => 1;\n");
    expect(index.functions).toEqual([
      {
        kind: "function",
        name: "foo",
        isAsync: false,
        location: { file: "a.ts", line: 1, column: 13 },
      },
    ]);
  });

  it("classifies an inline function argument as a callback", () => {
    const index = indexSourceFile("a.ts", "[1, 2].map(x => x + 1);\n");
    expect(index.functions[0]?.kind).toBe("callback");
    expect(index.functions[0]?.name).toBeUndefined();
  });

  it("prefers a function expression's own name over its assignment target", () => {
    const index = indexSourceFile(
      "a.ts",
      "module.exports = function main() {};\n",
    );
    expect(index.functions[0]?.name).toBe("main");
  });

  it("infers a name for a property-assigned function expression", () => {
    const index = indexSourceFile(
      "a.ts",
      "const obj = { foo: function () {} };\n",
    );
    expect(index.functions[0]?.name).toBe("foo");
  });
});

describe("indexSourceFile: class-member provenance (memberOf, VT-301A)", () => {
  it("records instance-method ownership", () => {
    const index = indexSourceFile(
      "a.ts",
      "class Lib {\n  runDangerous() {}\n}\n",
    );
    const method = index.functions.find((fn) => fn.name === "runDangerous");
    expect(method?.memberOf).toEqual({ className: "Lib", isStatic: false });
  });

  it("records static-method ownership with isStatic true", () => {
    const index = indexSourceFile(
      "a.ts",
      "class Lib {\n  static staticDangerous() {}\n}\n",
    );
    const method = index.functions.find((fn) => fn.name === "staticDangerous");
    expect(method?.memberOf).toEqual({ className: "Lib", isStatic: true });
  });

  it("records constructor ownership (explicit constructor)", () => {
    const index = indexSourceFile(
      "a.ts",
      "class Lib {\n  constructor() {}\n}\n",
    );
    const ctor = index.functions.find((fn) => fn.kind === "constructor");
    expect(ctor?.memberOf).toEqual({ className: "Lib", isStatic: false });
  });

  it("records constructor ownership for a synthesized implicit constructor (VT-215)", () => {
    const index = indexSourceFile("a.ts", "class Lib {\n  foo() {}\n}\n");
    const ctor = index.functions.find((fn) => fn.kind === "constructor");
    expect(ctor?.memberOf).toEqual({ className: "Lib", isStatic: false });
  });

  it("attributes a base class's own method to the base class, not any subclass (inheritance)", () => {
    const index = indexSourceFile(
      "a.ts",
      "class Base {\n  dangerousOp() {}\n}\n\nclass Sub extends Base {}\n",
    );
    const method = index.functions.find((fn) => fn.name === "dangerousOp");
    expect(method?.memberOf).toEqual({ className: "Base", isStatic: false });
    // Sub declares no members of its own beyond its synthesized
    // constructor -- dangerousOp must not be duplicated/reattributed to it.
    const subOwned = index.functions.filter(
      (fn) => fn.memberOf?.className === "Sub",
    );
    expect(subOwned).toHaveLength(1);
    expect(subOwned[0]?.kind).toBe("constructor");
  });

  it("distinguishes two classes that each declare a member with the same name", () => {
    const index = indexSourceFile(
      "a.ts",
      "class A {\n  parse() {}\n}\nclass B {\n  parse() {}\n}\n",
    );
    const parses = index.functions.filter((fn) => fn.name === "parse");
    expect(parses).toHaveLength(2);
    expect(parses.map((fn) => fn.memberOf?.className).sort()).toEqual([
      "A",
      "B",
    ]);
  });

  it("attributes a method on an anonymous class expression assigned to a variable", () => {
    const index = indexSourceFile(
      "a.ts",
      "const Lib = class {\n  runDangerous() {}\n};\n",
    );
    const method = index.functions.find((fn) => fn.name === "runDangerous");
    expect(method?.memberOf).toEqual({ className: "Lib", isStatic: false });
  });

  it("attributes a method on an anonymous default-exported class expression", () => {
    const index = indexSourceFile(
      "a.js",
      "module.exports = class Lib {\n  runDangerous() {}\n};\n",
    );
    const method = index.functions.find((fn) => fn.name === "runDangerous");
    expect(method?.memberOf).toEqual({ className: "Lib", isStatic: false });
  });

  it("leaves memberOf undefined for a plain, non-class function", () => {
    const index = indexSourceFile("a.ts", "function plain() {}\n");
    expect(index.functions[0]?.memberOf).toBeUndefined();
  });

  it("leaves memberOf undefined for a method-shaped property on a plain object literal", () => {
    const index = indexSourceFile("a.ts", "const obj = {\n  foo() {}\n};\n");
    const method = index.functions.find((fn) => fn.name === "foo");
    expect(method?.memberOf).toBeUndefined();
  });
});

describe("indexSourceFile: ESM imports", () => {
  it("indexes a default import", () => {
    const index = indexSourceFile("a.ts", 'import foo from "foo";\n');
    expect(index.imports).toEqual([
      {
        specifier: "foo",
        bindingKind: "default",
        localName: "foo",
        location: { file: "a.ts", line: 1, column: 8 },
      },
    ]);
  });

  it("indexes named imports, including an alias", () => {
    const index = indexSourceFile("a.ts", 'import { a, b as c } from "foo";\n');
    expect(index.imports).toEqual([
      {
        specifier: "foo",
        bindingKind: "named",
        localName: "a",
        importedName: "a",
        location: { file: "a.ts", line: 1, column: 10 },
      },
      {
        specifier: "foo",
        bindingKind: "named",
        localName: "c",
        importedName: "b",
        location: { file: "a.ts", line: 1, column: 13 },
      },
    ]);
  });

  it("indexes a namespace import", () => {
    const index = indexSourceFile("a.ts", 'import * as ns from "foo";\n');
    expect(index.imports).toEqual([
      {
        specifier: "foo",
        bindingKind: "namespace",
        localName: "ns",
        location: { file: "a.ts", line: 1, column: 8 },
      },
    ]);
  });

  it("indexes a side-effect-only import", () => {
    const index = indexSourceFile("a.ts", 'import "foo";\n');
    expect(index.imports).toEqual([
      {
        specifier: "foo",
        bindingKind: "side-effect",
        location: { file: "a.ts", line: 1, column: 1 },
      },
    ]);
  });

  it("excludes type-only imports (irrelevant to runtime reachability)", () => {
    const index = indexSourceFile("a.ts", 'import type { Foo } from "foo";\n');
    expect(index.imports).toEqual([]);
  });

  it("excludes a type-only named import specifier within a mixed import", () => {
    const index = indexSourceFile(
      "a.ts",
      'import { type Foo, bar } from "foo";\n',
    );
    expect(index.imports).toEqual([
      {
        specifier: "foo",
        bindingKind: "named",
        localName: "bar",
        importedName: "bar",
        location: { file: "a.ts", line: 1, column: 20 },
      },
    ]);
  });
});

describe("indexSourceFile: CommonJS require", () => {
  it("indexes a simple identifier binding", () => {
    const index = indexSourceFile("a.js", 'const foo = require("foo");\n');
    expect(index.imports).toEqual([
      {
        specifier: "foo",
        bindingKind: "commonjs",
        localName: "foo",
        location: { file: "a.js", line: 1, column: 13 },
      },
    ]);
  });

  it("indexes an object-destructured binding, including aliasing", () => {
    const index = indexSourceFile(
      "a.js",
      'const { a, b: c } = require("foo");\n',
    );
    expect(index.imports).toEqual([
      {
        specifier: "foo",
        bindingKind: "commonjs",
        localName: "a",
        importedName: "a",
        location: { file: "a.js", line: 1, column: 9 },
      },
      {
        specifier: "foo",
        bindingKind: "commonjs",
        localName: "c",
        importedName: "b",
        location: { file: "a.js", line: 1, column: 12 },
      },
    ]);
  });

  it("indexes a bare require() as a side-effect-only commonjs import", () => {
    const index = indexSourceFile("a.js", 'require("foo");\n');
    expect(index.imports).toEqual([
      {
        specifier: "foo",
        bindingKind: "commonjs",
        location: { file: "a.js", line: 1, column: 1 },
      },
    ]);
  });

  it("does not fabricate a binding for deep member access on require()", () => {
    const index = indexSourceFile(
      "a.js",
      'const bar = require("foo").bar.baz;\n',
    );
    expect(index.imports).toEqual([
      {
        specifier: "foo",
        bindingKind: "commonjs",
        location: { file: "a.js", line: 1, column: 13 },
      },
    ]);
  });
});

describe("indexSourceFile: TypeScript import-equals (VT-307c-fix-8)", () => {
  it('indexes `import lib = require("pkg")` as a commonjs module load', () => {
    const index = indexSourceFile("a.ts", 'import lib = require("pkg");\n');
    expect(index.imports).toEqual([
      {
        specifier: "pkg",
        bindingKind: "commonjs",
        localName: "lib",
        location: { file: "a.ts", line: 1, column: 1 },
      },
    ]);
  });

  it('excludes `import type lib = require("pkg")` (erased at compile time)', () => {
    const index = indexSourceFile(
      "a.ts",
      'import type lib = require("pkg");\n',
    );
    expect(index.imports).toEqual([]);
  });

  it("does not treat a non-external import-equals (`import q = A.B;`) as a module load", () => {
    const index = indexSourceFile(
      "a.ts",
      "namespace A { export const B = 1; }\nimport q = A.B;\n",
    );
    expect(index.imports).toEqual([]);
  });
});

describe("indexSourceFile: ESM exports", () => {
  it("indexes an exported function declaration", () => {
    const index = indexSourceFile("a.ts", "export function foo() {}\n");
    expect(index.exports).toEqual([
      {
        bindingKind: "named",
        exportedName: "foo",
        localName: "foo",
        location: { file: "a.ts", line: 1, column: 1 },
      },
    ]);
  });

  it("indexes an anonymous default export", () => {
    const index = indexSourceFile("a.ts", "export default function () {}\n");
    expect(index.exports).toEqual([
      {
        bindingKind: "default",
        location: { file: "a.ts", line: 1, column: 1 },
      },
    ]);
  });

  it("indexes `export default identifier;`", () => {
    const index = indexSourceFile(
      "a.ts",
      "const foo = 1;\nexport default foo;\n",
    );
    expect(index.exports.some((entry) => entry.bindingKind === "default")).toBe(
      true,
    );
  });

  it("indexes multiple exported const declarators", () => {
    const index = indexSourceFile("a.ts", "export const x = 1, y = 2;\n");
    expect(index.exports).toEqual([
      {
        bindingKind: "named",
        exportedName: "x",
        localName: "x",
        location: { file: "a.ts", line: 1, column: 14 },
      },
      {
        bindingKind: "named",
        exportedName: "y",
        localName: "y",
        location: { file: "a.ts", line: 1, column: 21 },
      },
    ]);
  });

  it("indexes a local named export list", () => {
    const index = indexSourceFile(
      "a.ts",
      "const a = 1, b = 2;\nexport { a, b as c };\n",
    );
    expect(index.exports).toEqual([
      {
        bindingKind: "named",
        exportedName: "a",
        localName: "a",
        specifier: undefined,
        location: { file: "a.ts", line: 2, column: 10 },
      },
      {
        bindingKind: "named",
        exportedName: "c",
        localName: "b",
        specifier: undefined,
        location: { file: "a.ts", line: 2, column: 13 },
      },
    ]);
  });

  it("indexes a re-export with its source specifier", () => {
    const index = indexSourceFile("a.ts", 'export { a } from "./other";\n');
    expect(index.exports).toEqual([
      {
        bindingKind: "re-export",
        exportedName: "a",
        localName: "a",
        specifier: "./other",
        location: { file: "a.ts", line: 1, column: 10 },
      },
    ]);
  });

  it("excludes type-only exports", () => {
    const index = indexSourceFile("a.ts", "export type { Foo };\n");
    expect(index.exports).toEqual([]);
  });

  it("indexes `export * from` with its source specifier and no local name (VT-307c-fix-8)", () => {
    const index = indexSourceFile("a.ts", 'export * from "./other";\n');
    expect(index.exports).toEqual([
      {
        bindingKind: "re-export",
        specifier: "./other",
        location: { file: "a.ts", line: 1, column: 1 },
      },
    ]);
  });

  it("indexes `export * as ns from` as a re-export with its namespace name (VT-307c-fix-8, previously dropped entirely)", () => {
    const index = indexSourceFile("a.ts", 'export * as ns from "./other";\n');
    expect(index.exports).toEqual([
      {
        bindingKind: "re-export",
        exportedName: "ns",
        specifier: "./other",
        location: { file: "a.ts", line: 1, column: 8 },
      },
    ]);
  });
});

describe("indexSourceFile: CommonJS exports", () => {
  it("indexes module.exports = ...", () => {
    const index = indexSourceFile("a.js", "module.exports = { foo: 1 };\n");
    expect(index.exports).toEqual([
      {
        bindingKind: "commonjs-module-exports",
        location: { file: "a.js", line: 1, column: 1 },
      },
    ]);
  });

  it("indexes exports.foo = ...", () => {
    const index = indexSourceFile("a.js", "exports.foo = function () {};\n");
    expect(index.exports).toEqual([
      {
        bindingKind: "commonjs-exports-property",
        exportedName: "foo",
        location: { file: "a.js", line: 1, column: 1 },
      },
    ]);
  });

  it("indexes module.exports.foo = ...", () => {
    const index = indexSourceFile(
      "a.js",
      "module.exports.foo = function () {};\n",
    );
    expect(index.exports).toEqual([
      {
        bindingKind: "commonjs-exports-property",
        exportedName: "foo",
        location: { file: "a.js", line: 1, column: 1 },
      },
    ]);
  });
});

describe("indexSourceFile: file extensions (docs/SDD.md § 15 scope)", () => {
  it.each([
    ["a.ts", "export const x: number = 1;\n"],
    ["a.tsx", "export const X = () => <div />;\n"],
    ["a.js", "module.exports = { x: 1 };\n"],
    ["a.jsx", "module.exports = () => <div />;\n"],
    ["a.mjs", 'export const x = 1;\nimport "foo";\n'],
    ["a.cjs", 'const foo = require("foo");\nmodule.exports = foo;\n'],
  ])("parses %s without throwing", (fileName, text) => {
    expect(() => indexSourceFile(fileName, text)).not.toThrow();
  });
});

describe("indexSourceFileFromDisk / indexSourceFiles", () => {
  it("throws SourceFileNotFoundError for a missing file", () => {
    expect(() => indexSourceFiles(["/does/not/exist.ts"])).toThrow(
      SourceFileNotFoundError,
    );
  });

  it("indexes multiple in-memory-equivalent files via indexSourceFile", () => {
    const a = indexSourceFile("a.ts", "export function foo() {}\n");
    const b = indexSourceFile("b.ts", "export function bar() {}\n");
    expect(a.functions[0]?.name).toBe("foo");
    expect(b.functions[0]?.name).toBe("bar");
  });
});
