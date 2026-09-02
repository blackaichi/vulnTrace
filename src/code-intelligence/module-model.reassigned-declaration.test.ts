import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-013b: reassignment is authoritative negative provenance, and it is
 * INDEPENDENT of how the reassigned name was originally declared (see
 * `classifyLocalBinding` and `CommonJsFacts.reassignedNames` in
 * commonjs-reexports.ts).
 *
 * RWF-013 (module-model.stale-alias.test.ts) established the rule for
 * `var`/`let`/`const` bindings. It classified provenance by asking how the
 * name was DECLARED, so a reassigned `function`/`class` declaration —
 * which JavaScript rebinds just as freely — was reported "unmodeled" and
 * still fell through to the legacy name search. This file pins the fix and,
 * just as importantly, pins that un-reassigned declarations keep resolving.
 */

/** `line:column` of the function a canonical export name resolved to, or `undefined`. */
function exportPosition(text: string, name = "default"): string | undefined {
  const index = indexSourceFile("/pkg/index.js", text);
  const fn = mapExportsToFunctions(index, buildModuleModel(index)).get(name);
  return fn ? `${fn.location.line}:${fn.location.column}` : undefined;
}

function bindingFor(text: string, exportedName?: string) {
  const index = indexSourceFile("/pkg/index.js", text);
  return buildModuleModel(index).exports.find((e) =>
    exportedName === undefined
      ? e.kind === "default"
      : e.exportedName === exportedName,
  );
}

const VULN = "const vulnerable = require('dep');\n";

/**
 * Every export form whose value is an identifier, paired with the export
 * name it publishes. The refusal must reach all of them: leaving one path
 * open leaves the whole defect open, since an author picks the spelling.
 */
const EXPORT_FORMS: ReadonlyArray<readonly [string, string, string]> = [
  ["module.exports = fn", "module.exports = fn;", "default"],
  ["exports.fn = fn", "exports.fn = fn;", "fn"],
  ["module.exports.fn = fn", "module.exports.fn = fn;", "fn"],
  ["module.exports = { fn: fn }", "module.exports = { fn: fn };", "fn"],
  ["module.exports = { fn }", "module.exports = { fn };", "fn"],
];

describe("RWF-013b: a reassigned FUNCTION DECLARATION is never attributed by name", () => {
  for (const [label, exportLine, exportName] of EXPORT_FORMS) {
    it(`refuses through ${label}`, () => {
      const source = `${VULN}function fn() { return 'stale'; }\nfn = vulnerable;\n${exportLine}\n`;

      // The stale declaration is present and indexed under exactly the
      // exported name -- it is literally `function fn()`.
      const index = indexSourceFile("/pkg/index.js", source);
      expect(index.functions.some((f) => f.name === "fn")).toBe(true);

      expect(exportPosition(source, exportName)).toBeUndefined();
      expect(
        bindingFor(source, exportName === "default" ? undefined : exportName)
          ?.localIdentifierProvenanceRefused,
      ).toBe(true);
    });
  }

  it("refuses a CONDITIONALLY reassigned function declaration", () => {
    // Static analysis cannot know whether the branch runs, so it cannot
    // know the binding's value. The safe declaration must never be
    // presented as the answer.
    expect(
      exportPosition(
        [
          "const native = require('dep');",
          "function fn() { return 'safe'; }",
          "if (native.available) {",
          "  fn = native.impl;",
          "}",
          "module.exports = fn;",
        ].join("\n"),
      ),
    ).toBeUndefined();
  });

  it("refuses a reassigned CLASS declaration", () => {
    const source = [
      "const Other = require('dep');",
      "class C { constructor() {} }",
      "C = Other;",
      "module.exports = C;",
    ].join("\n");

    // The class's own constructor node is indexed under "C", which is
    // exactly what canonical-export attribution looks up for a class.
    const index = indexSourceFile("/pkg/index.js", source);
    expect(index.functions.some((f) => f.name === "C")).toBe(true);

    expect(exportPosition(source)).toBeUndefined();
  });

  it("refuses a reassigned class declaration through a property export too", () => {
    expect(
      exportPosition(
        [
          "const Other = require('dep');",
          "class C { constructor() {} }",
          "C = Other;",
          "exports.C = C;",
        ].join("\n"),
        "C",
      ),
    ).toBeUndefined();
  });
});

/**
 * Every compound/implicit write the fact collector already marks. These
 * are not a syntax enumeration bolted onto the fix: they are whatever
 * `markAssigned` records, which is the same set the single-assignment
 * proof has always trusted for variables. RWF-013b simply stops making
 * that set conditional on the declaration form.
 */
const MUTATIONS: ReadonlyArray<readonly [string, string]> = [
  ["logical OR assignment", "fn ||= require('dep');"],
  ["logical AND assignment", "fn &&= require('dep');"],
  ["nullish assignment", "fn ??= require('dep');"],
  ["compound arithmetic assignment", "fn += 1;"],
  ["postfix increment", "fn++;"],
  ["prefix increment", "++fn;"],
  ["for-of rebinding", "for (fn of [1]) { void fn; }"],
  ["object destructuring assignment", "({ fn } = require('dep'));"],
  ["array destructuring assignment", "[fn] = [require('dep')];"],
  [
    "reassignment from a nested function body",
    "function init() { fn = require('dep'); }",
  ],
];

describe("RWF-013b: any recorded write to a function declaration's name refuses it", () => {
  for (const [label, mutation] of MUTATIONS) {
    it(label, () => {
      expect(
        exportPosition(
          `function fn() { return 'stale'; }\n${mutation}\nmodule.exports = fn;\n`,
        ),
      ).toBeUndefined();
    });
  }
});

describe("RWF-013b: un-reassigned declarations keep resolving exactly as before", () => {
  it("resolves a plain function declaration export", () => {
    expect(
      exportPosition(
        ["function fn() { return 'x'; }", "module.exports = fn;"].join("\n"),
      ),
    ).toBe("1:1");
  });

  it("resolves a plain function declaration through exports.foo", () => {
    expect(
      exportPosition(
        ["function foo() { return 'x'; }", "exports.foo = foo;"].join("\n"),
        "foo",
      ),
    ).toBe("1:1");
  });

  it("resolves a plain function declaration through an object shorthand", () => {
    expect(
      exportPosition(
        ["function foo() { return 'x'; }", "module.exports = { foo };"].join(
          "\n",
        ),
        "foo",
      ),
    ).toBe("1:1");
  });

  it("resolves a plain class declaration export", () => {
    // Resolves to the class's own CONSTRUCTOR node (column 11), which is
    // how canonical-export attribution models a class target.
    expect(
      exportPosition(
        ["class C { constructor() {} }", "module.exports = C;"].join("\n"),
      ),
    ).toBe("1:11");
  });

  it("marks an un-reassigned declaration as silence, never as a refusal", () => {
    // The distinction the whole tri-state rests on: this export is NOT
    // refused, it is simply not modeled by the single-assignment relation,
    // so the legacy name path stays available to it.
    expect(
      bindingFor(["function fn() {}", "module.exports = fn;"].join("\n"))
        ?.localIdentifierProvenanceRefused,
    ).toBeUndefined();
  });

  it("keeps RWF-013's own variable-binding cases closed", () => {
    // Guards against a regression that "fixes" declarations by relaxing
    // the variable rule.
    expect(
      exportPosition(
        [
          "let fn = function () { return 'stale'; };",
          "fn = require('dep');",
          "module.exports = fn;",
        ].join("\n"),
      ),
    ).toBeUndefined();
  });

  it("keeps safe const/let/var aliases resolving", () => {
    expect(
      exportPosition(
        ["const fn = function () {};", "module.exports = fn;"].join("\n"),
      ),
    ).toBe("1:12");
    expect(
      exportPosition(
        ["let fn = function () {};", "module.exports = fn;"].join("\n"),
      ),
    ).toBe("1:10");
    expect(
      exportPosition(
        ["var fn = function () {};", "module.exports = fn;"].join("\n"),
      ),
    ).toBe("1:10");
  });

  it("keeps RWF-003's direct anonymous exports resolving", () => {
    expect(exportPosition("module.exports = function () {};")).toBe("1:18");
    expect(exportPosition("module.exports = async () => {};")).toBe("1:18");
  });
});
