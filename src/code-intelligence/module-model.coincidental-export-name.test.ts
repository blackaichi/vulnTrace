import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-011: a CommonJS export must never be attributed to a same-file
 * function merely because the function's name equals the EXPORTED name.
 *
 * The invariant, stated once:
 *
 * ```text
 * exports.foo = <expression this analyzer does not model>
 * + function foo() {}
 * -> NOT a binding
 * ```
 *
 * A public export name is a property key an importer writes; it is not
 * provenance for any local symbol. Attribution has to come from the
 * export's own right-hand side — as a local NAME the right-hand side
 * states (`exports.foo = internal`), or as an exact POSITION when the
 * right-hand side IS a function/class/method node.
 *
 * The two halves of this file are equally load-bearing. The refusals are
 * the soundness fix; the resolutions are the reason the fix is "require
 * positive provenance" rather than "delete the name search". Every shape
 * in the second half is attributed by a name or a position the export's
 * own right-hand side established, and every one of them must keep
 * resolving.
 */

/** `line:column` of the function a canonical export name resolved to, or `undefined`. */
function exportPosition(text: string, name: string): string | undefined {
  const index = indexSourceFile("/pkg/index.js", text);
  const fn = mapExportsToFunctions(index, buildModuleModel(index)).get(name);
  return fn ? `${fn.location.line}:${fn.location.column}` : undefined;
}

/** The named export binding the model built for `text`. */
function binding(text: string, name: string) {
  const index = indexSourceFile("/pkg/index.js", text);
  return buildModuleModel(index).exports.find((e) => e.exportedName === name);
}

describe("RWF-011: a public export name is never local symbol provenance", () => {
  it("refuses a member-expression right-hand side over a same-name decoy (the reproducer)", () => {
    // The audit's exact shape. `registry.impl` is the vulnerable value;
    // `function parse` is unrelated. Binding the decoy and proving IT
    // unreachable produced a complete Family C false NOT_AFFECTED.
    expect(
      exportPosition(
        [
          "function parse(input) { return 'safe:' + input; }",
          "const registry = { impl: require('./lib/parse') };",
          "exports.parse = registry.impl;",
          "exports.parseSync = require('./lib/parse');",
        ].join("\n"),
        "parse",
      ),
    ).toBeUndefined();
  });

  it("refuses a call-expression right-hand side over a same-name decoy", () => {
    expect(
      exportPosition(
        ["function foo() {}", "exports.foo = makeValue();"].join("\n"),
        "foo",
      ),
    ).toBeUndefined();
  });

  it("refuses a property access over a same-name decoy", () => {
    expect(
      exportPosition(
        ["function foo() {}", "exports.foo = object.property;"].join("\n"),
        "foo",
      ),
    ).toBeUndefined();
  });

  it("refuses an element access over a same-name decoy", () => {
    expect(
      exportPosition(
        ["function foo() {}", "exports.foo = object['foo'];"].join("\n"),
        "foo",
      ),
    ).toBeUndefined();
  });

  it("refuses a conditional right-hand side over a same-name decoy", () => {
    expect(
      exportPosition(
        ["function foo() {}", "exports.foo = cond ? a : b;"].join("\n"),
        "foo",
      ),
    ).toBeUndefined();
  });

  it("refuses the module.exports.foo spelling of the same shape", () => {
    expect(
      exportPosition(
        ["function foo() {}", "module.exports.foo = object.property;"].join(
          "\n",
        ),
        "foo",
      ),
    ).toBeUndefined();
  });

  it("refuses an object-literal property whose value is unmodeled, over a same-name decoy", () => {
    expect(
      exportPosition(
        [
          "function foo() {}",
          "module.exports = { foo: object.property };",
        ].join("\n"),
        "foo",
      ),
    ).toBeUndefined();
  });

  it("refuses an object-literal property whose value is a call, over a same-name decoy", () => {
    expect(
      exportPosition(
        ["function foo() {}", "module.exports = { foo: makeValue() };"].join(
          "\n",
        ),
        "foo",
      ),
    ).toBeUndefined();
  });

  it("refuses a computed-key object-literal property whose value is unmodeled (VT-217 shape)", () => {
    expect(
      exportPosition(
        [
          "function vulnerable() {}",
          "const NAME = 'vulnerable';",
          "module.exports = { [NAME]: obj.x };",
        ].join("\n"),
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("does not borrow a NESTED same-name declaration either", () => {
    // `index.functions` is flat, so a function declared inside another
    // function's body was just as findable by a bare name search -- and is
    // even further from being the module's export.
    expect(
      exportPosition(
        [
          "function outer() { function foo() { return 'inner'; } return foo; }",
          "exports.foo = registry.impl;",
        ].join("\n"),
        "foo",
      ),
    ).toBeUndefined();
  });

  it("does not let a same-name decoy shadow a same-package re-export (RWF-004a stays the resolver)", () => {
    // `exports.foo = require("./impl").foo` has real provenance -- it is a
    // re-export, chased by call-graph.ts. Binding the local decoy here
    // would hand the target a wrong node BEFORE that chase ever ran.
    const text = [
      "function foo() {}",
      "exports.foo = require('./impl').foo;",
    ].join("\n");

    expect(exportPosition(text, "foo")).toBeUndefined();
    expect(binding(text, "foo")?.commonJsReExport).toEqual({
      specifier: "./impl",
      importedName: "foo",
    });
  });

  it("does not let a same-name decoy shadow a whole-module re-export", () => {
    const text = ["function foo() {}", "exports.foo = require('./impl');"].join(
      "\n",
    );

    expect(exportPosition(text, "foo")).toBeUndefined();
    expect(binding(text, "foo")?.commonJsReExport).toEqual({
      specifier: "./impl",
    });
  });

  it("never borrows a same-name function from a DIFFERENT file", () => {
    // Attribution is per-`SourceIndex`, and stays that way: the other
    // file's `parse` is not a candidate for this file's export at all.
    const other = indexSourceFile(
      "/pkg/other.js",
      "function parse() { return 'other'; }\n",
    );
    expect(other.functions.some((fn) => fn.name === "parse")).toBe(true);

    const index = indexSourceFile("/pkg/index.js", "exports.parse = reg.impl;");
    expect(
      mapExportsToFunctions(index, buildModuleModel(index)).get("parse"),
    ).toBeUndefined();
  });

  it("does not bind a NESTED same-name function to a top-level property (real qs/lib/formats.js)", () => {
    // The shape this found in the vendored corpus. `exports.RFC1738` is the
    // STRING 'RFC1738'; the only function of that name is a formatter
    // nested one level down under `formatters`. The old name search bound
    // the export to it -- a different value entirely, of a different type.
    const text = [
      "var Format = { RFC1738: 'RFC1738' };",
      "module.exports = {",
      "  formatters: {",
      "    RFC1738: function (value) { return value; }",
      "  },",
      "  RFC1738: Format.RFC1738",
      "};",
    ].join("\n");

    expect(exportPosition(text, "RFC1738")).toBeUndefined();
    // The nested formatter is still indexed under that name -- which is
    // exactly why the old search found it.
    const index = indexSourceFile("/pkg/index.js", text);
    expect(index.functions.some((fn) => fn.name === "RFC1738")).toBe(true);
  });

  it("refuses a right-hand side assigned inside a conditional, rather than picking a branch", () => {
    // The module-scope guard the other two identity relations already
    // apply. A property assigned only inside an `if` may never run, and
    // the fact model picks the LAST assignment in source order, not the
    // one control flow reaches.
    expect(
      exportPosition("if (x) { exports.foo = function () {}; }", "foo"),
    ).toBeUndefined();
  });
});

describe("RWF-011: RWF-013/RWF-013b refusals are untouched", () => {
  it("still refuses a reassigned `let` alias (ADV2-069)", () => {
    expect(
      exportPosition(
        [
          "const other = require('dep');",
          "let fn = function () { return 'stale'; };",
          "fn = other;",
          "module.exports = fn;",
        ].join("\n"),
        "default",
      ),
    ).toBeUndefined();
  });

  it("still refuses a reassigned function DECLARATION (ADV2-070)", () => {
    expect(
      exportPosition(
        [
          "function dangerousOp(input) { return 'safe:' + input; }",
          "dangerousOp = require('./native');",
          "exports.dangerousOp = dangerousOp;",
        ].join("\n"),
        "dangerousOp",
      ),
    ).toBeUndefined();
  });

  it("records a reassigned property-export identifier as examined-and-refused, not as silence", () => {
    expect(
      binding(
        ["function foo() {}", "foo = other;", "exports.foo = foo;"].join("\n"),
        "foo",
      )?.localIdentifierProvenanceRefused,
    ).toBe(true);
  });

  it("refuses a reassigned identifier behind a computed object-literal key", () => {
    // The computed-key branch shipped without the RWF-013 refusal wired
    // in; RWF-011 wires it, so both key forms behave identically.
    expect(
      exportPosition(
        [
          "const NAME = 'vulnerable';",
          "let fn = function () { return 'stale'; };",
          "fn = other;",
          "module.exports = { [NAME]: fn };",
        ].join("\n"),
        "vulnerable",
      ),
    ).toBeUndefined();
  });
});

describe("RWF-011: positive provenance still resolves", () => {
  it("binds an identifier right-hand side that matches the exported name", () => {
    // Resolves because the RHS names `foo`, not because the export does.
    expect(
      exportPosition(
        ["function foo() {}", "exports.foo = foo;"].join("\n"),
        "foo",
      ),
    ).toBe("1:1");
  });

  it("binds a DIFFERENT local name than the exported one, from the right-hand side", () => {
    // The case a public-name search could never get right: the export is
    // `publicName` and the function is `internal`.
    expect(
      exportPosition(
        ["function internal() {}", "exports.publicName = internal;"].join("\n"),
        "publicName",
      ),
    ).toBe("1:1");
    expect(
      binding(
        ["function internal() {}", "exports.publicName = internal;"].join("\n"),
        "publicName",
      )?.localName,
    ).toBe("internal");
  });

  it("binds a stable local const alias", () => {
    expect(
      exportPosition(
        ["const fn = function () {};", "exports.foo = fn;"].join("\n"),
        "foo",
      ),
    ).toBe("1:12");
  });

  it("binds a directly-assigned function expression by position", () => {
    expect(exportPosition("exports.foo = function () {};", "foo")).toBe("1:15");
  });

  it("binds a directly-assigned arrow function by position", () => {
    expect(exportPosition("exports.foo = () => {};", "foo")).toBe("1:15");
  });

  it("binds a directly-assigned async function by position", () => {
    expect(exportPosition("exports.foo = async function () {};", "foo")).toBe(
      "1:15",
    );
  });

  it("binds a NAMED function expression by position, not by its internal name", () => {
    // `bar` is the function's own internal name and `foo` the public one;
    // neither is a lookup key, and the position resolves it regardless.
    expect(exportPosition("exports.foo = function bar() {};", "foo")).toBe(
      "1:15",
    );
  });

  it("binds the module.exports.foo spelling by position", () => {
    expect(exportPosition("module.exports.foo = function () {};", "foo")).toBe(
      "1:22",
    );
  });

  it("selects the RIGHT function when a same-name decoy also exists (property form)", () => {
    // Source indexing names the anonymous export value after the property
    // it is assigned to, so this file indexes TWO functions called `foo`.
    // The old name search returned whichever came first -- the decoy.
    expect(
      exportPosition(
        [
          "function foo() { return 'decoy'; }",
          "exports.foo = function () { return 'real'; };",
        ].join("\n"),
        "foo",
      ),
    ).toBe("2:15");
  });

  it("selects the RIGHT function when a same-name decoy also exists (object-method form)", () => {
    expect(
      exportPosition(
        [
          "function foo() { return 'decoy'; }",
          "module.exports = { foo() { return 'real'; } };",
        ].join("\n"),
        "foo",
      ),
    ).toBe("2:20");
  });

  it("binds an object-literal shorthand property", () => {
    expect(
      exportPosition(
        ["function foo() {}", "module.exports = { foo };"].join("\n"),
        "foo",
      ),
    ).toBe("1:1");
  });

  it("binds an object-literal renamed property from its VALUE identifier", () => {
    expect(
      exportPosition(
        ["function bar() {}", "module.exports = { foo: bar };"].join("\n"),
        "foo",
      ),
    ).toBe("1:1");
  });

  it("binds an object-literal function-expression property by position", () => {
    expect(
      exportPosition("module.exports = { foo: function () {} };", "foo"),
    ).toBe("1:25");
  });

  it("binds an object-literal method by position", () => {
    expect(exportPosition("module.exports = { foo() {} };", "foo")).toBe(
      "1:20",
    );
  });

  it("binds a computed-key method, which no name search could ever find", () => {
    // Source indexing records this method under its literal source text
    // (`[NAME]`), so position is the only thing that can resolve it.
    expect(
      exportPosition(
        [
          "const NAME = 'vulnerable';",
          "module.exports = { [NAME]() {} };",
        ].join("\n"),
        "vulnerable",
      ),
    ).toBe("2:20");
  });

  it("binds a class assigned to a property, via its constructor (class semantics preserved)", () => {
    expect(exportPosition("exports.Foo = class { m() {} };", "Foo")).toBe(
      "1:15",
    );
  });

  it("binds a class with an EXPLICIT constructor assigned to a property", () => {
    expect(
      exportPosition("exports.Foo = class { constructor() {} };", "Foo"),
    ).toBe("1:23");
  });

  it("binds a NAMED class expression assigned to a property", () => {
    expect(exportPosition("exports.Foo = class Named { m() {} };", "Foo")).toBe(
      "1:21",
    );
  });

  it("binds through a CHAINED module-scope assignment (real ini/ini.js)", () => {
    // `exports.parse = exports.decode = decode` is one unconditional
    // top-level statement, and `decode`'s own right-hand side is a bare
    // identifier -- perfect provenance. Only the enclosing NODE differs
    // from the simple form (an assignment rather than a statement), which
    // must not cost the binding.
    const text = [
      "exports.parse = exports.decode = decode",
      "exports.stringify = exports.encode = encode",
      "function encode (obj) { return obj }",
      "function decode (str) { return str }",
    ].join("\n");

    expect(exportPosition(text, "decode")).toBe("4:1");
    expect(exportPosition(text, "encode")).toBe("3:1");
  });

  it("does not resolve the OUTER name of a chained assignment through the assignment's value", () => {
    // `exports.parse`'s own right-hand side is the inner assignment
    // EXPRESSION, not an identifier or a function node. Resolving through
    // an assignment's value is a separate relation, deliberately not
    // attempted -- so this stays unattributed rather than guessing.
    expect(
      exportPosition(
        [
          "exports.parse = exports.decode = decode",
          "function decode (str) { return str }",
        ].join("\n"),
        "parse",
      ),
    ).toBeUndefined();
  });

  it("binds a class declaration named by an identifier right-hand side", () => {
    expect(
      exportPosition(
        ["class Klass { m() {} }", "exports.Klass = Klass;"].join("\n"),
        "Klass",
      ),
    ).toBe("1:7");
  });
});

describe("RWF-011: RWF-003's whole-module identity relation is untouched", () => {
  it.each([
    ["module.exports = function () {};", "1:18"],
    ["module.exports = async function () {};", "1:18"],
    ["module.exports = () => {};", "1:18"],
    ["module.exports = async () => {};", "1:18"],
  ])("still binds %s", (text, expected) => {
    expect(exportPosition(text, "default")).toBe(expected);
  });

  it("still binds module.exports = <un-reassigned function declaration> by name", () => {
    expect(
      exportPosition(
        ["function foo() {}", "module.exports = foo;"].join("\n"),
        "default",
      ),
    ).toBe("1:1");
  });
});

describe("RWF-011: ESM attribution is untouched", () => {
  it.each([
    ["export function foo() {}", "foo", "1:1"],
    ["export async function foo() {}", "foo", "1:1"],
    ["export const foo = () => {};", "foo", "1:20"],
    ["export class Foo { m() {} }", "Foo", "1:14"],
    ["function a() {}\nexport { a as b };", "b", "1:1"],
    ["export default class Foo { m() {} }", "default", "1:22"],
  ])("still binds %s", (text, name, expected) => {
    const index = indexSourceFile("/pkg/index.ts", text);
    const fn = mapExportsToFunctions(index, buildModuleModel(index)).get(name);
    expect(fn && `${fn.location.line}:${fn.location.column}`).toBe(expected);
  });
});
