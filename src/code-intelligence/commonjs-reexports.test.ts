import { describe, expect, it } from "vitest";
import { buildModuleModel, type ExportBinding } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-004a unit coverage for the CommonJS re-export ORIGIN relation
 * (commonjs-reexports.ts), observed through the export table it annotates
 * (module-model.ts's `ExportBinding.commonJsReExport`).
 *
 * This layer answers exactly one question -- "where did this exported value
 * come from?" -- and deliberately answers it without resolving a specifier,
 * touching the filesystem, or knowing anything about packages. Resolution,
 * the same-canonical-PackageInstance rule and graph binding are the call
 * graph's job and are covered in call-graph.test.ts.
 */
function exportsOf(source: string): readonly ExportBinding[] {
  return buildModuleModel(indexSourceFile("/virtual/index.js", source)).exports;
}

function originOf(source: string, exportedName: string) {
  return exportsOf(source).find((exp) => exp.exportedName === exportedName)
    ?.commonJsReExport;
}

function defaultOriginOf(source: string) {
  return exportsOf(source).find((exp) => exp.kind === "default")
    ?.commonJsReExport;
}

describe("CommonJS re-export origins: the supported static forms (RWF-004a A-F)", () => {
  it("A: exports.foo = require('./lib').foo", () => {
    expect(
      originOf(
        `exports.vulnerable = require("./lib").vulnerable;`,
        "vulnerable",
      ),
    ).toEqual({ specifier: "./lib", importedName: "vulnerable" });
  });

  it("B: module.exports.foo = require('./lib').foo", () => {
    expect(
      originOf(
        `module.exports.vulnerable = require("./lib").vulnerable;`,
        "vulnerable",
      ),
    ).toEqual({ specifier: "./lib", importedName: "vulnerable" });
  });

  it("C: module.exports = require('./lib') -- whole module, no selected name", () => {
    expect(defaultOriginOf(`module.exports = require("./lib");`)).toEqual({
      specifier: "./lib",
    });
  });

  it("D: const lib = require('./lib'); exports.foo = lib.foo", () => {
    expect(
      originOf(
        `const lib = require("./lib");\nexports.vulnerable = lib.vulnerable;`,
        "vulnerable",
      ),
    ).toEqual({ specifier: "./lib", importedName: "vulnerable" });
  });

  it("E: const { foo } = require('./lib'); exports.foo = foo", () => {
    expect(
      originOf(
        `const { vulnerable } = require("./lib");\nexports.vulnerable = vulnerable;`,
        "vulnerable",
      ),
    ).toEqual({ specifier: "./lib", importedName: "vulnerable" });
  });

  it("E': a renaming destructure keeps the ORIGINAL name, not the local alias", () => {
    expect(
      originOf(
        `const { realName: local } = require("./lib");\nexports.publicName = local;`,
        "publicName",
      ),
    ).toEqual({ specifier: "./lib", importedName: "realName" });
  });

  it("F: const foo = require('./lib').foo; module.exports.foo = foo", () => {
    expect(
      originOf(
        `const vulnerable = require("./lib").vulnerable;\nmodule.exports.vulnerable = vulnerable;`,
        "vulnerable",
      ),
    ).toEqual({ specifier: "./lib", importedName: "vulnerable" });
  });

  it("object-literal shorthand over a local require (the qs/semver shape)", () => {
    expect(
      originOf(
        `var vulnerable = require("./lib").vulnerable;\nmodule.exports = { vulnerable };`,
        "vulnerable",
      ),
    ).toEqual({ specifier: "./lib", importedName: "vulnerable" });
  });

  it("object-literal property holding a whole required module (qs's real shape)", () => {
    // `stringify: stringify` over `var stringify = require('./stringify')` --
    // the exported value IS that module, so no name is selected here; the
    // call graph is what turns "no selected name" into the target's
    // canonical "default" export.
    expect(
      originOf(
        `var stringify = require("./stringify");\nmodule.exports = { stringify: stringify };`,
        "stringify",
      ),
    ).toEqual({ specifier: "./stringify" });
  });

  it("an inline require in an object-literal property initializer", () => {
    expect(
      originOf(
        `module.exports = { vulnerable: require("./lib").vulnerable };`,
        "vulnerable",
      ),
    ).toEqual({ specifier: "./lib", importedName: "vulnerable" });
  });

  it("a string-literal element access selects a name, same as dot access", () => {
    expect(
      originOf(
        `exports.vulnerable = require("./lib")["vulnerable"];`,
        "vulnerable",
      ),
    ).toEqual({ specifier: "./lib", importedName: "vulnerable" });
  });

  it("last-write-wins on a re-assigned exports property, matching Node", () => {
    expect(
      originOf(
        `exports.vulnerable = require("./first").vulnerable;\nexports.vulnerable = require("./second").vulnerable;`,
        "vulnerable",
      ),
    ).toEqual({ specifier: "./second", importedName: "vulnerable" });
  });

  it("accepts a top-level `var` that is declared once and never reassigned", () => {
    // The dominant real-world CommonJS spelling (qs, semver, debug).
    expect(
      originOf(
        `var lib = require("./lib");\nexports.vulnerable = lib.vulnerable;`,
        "vulnerable",
      ),
    ).toEqual({ specifier: "./lib", importedName: "vulnerable" });
  });
});

describe("CommonJS re-export origins: nothing is guessed (RWF-004a precision controls)", () => {
  it("a dynamic require specifier produces no origin at all", () => {
    expect(
      originOf(
        `const name = process.env.LIB;\nexports.vulnerable = require(name).vulnerable;`,
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("a template-literal require specifier produces no origin", () => {
    expect(
      originOf(
        "exports.vulnerable = require(`./${dir}/lib`).vulnerable;",
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("a conditional whole-module re-export produces no origin", () => {
    expect(
      defaultOriginOf(
        `module.exports = process.env.X ? require("./a") : require("./b");`,
      ),
    ).toBeUndefined();
  });

  it("a logical-fallback whole-module re-export produces no origin", () => {
    expect(
      defaultOriginOf(`module.exports = require("./a") || require("./b");`),
    ).toBeUndefined();
  });

  it("a deep member access past the selected export produces no origin", () => {
    expect(
      originOf(`exports.vulnerable = require("./lib").a.b;`, "vulnerable"),
    ).toBeUndefined();
  });

  it("a computed (non-literal) element access produces no origin", () => {
    expect(
      originOf(`exports.vulnerable = require("./lib")[key];`, "vulnerable"),
    ).toBeUndefined();
  });

  it("the value of a require() CALL is not an origin", () => {
    expect(
      originOf(`exports.vulnerable = require("./lib").make();`, "vulnerable"),
    ).toBeUndefined();
  });

  it("a SECOND alias hop is not followed (that is RWF-012, not this task)", () => {
    expect(
      originOf(
        `const a = require("./lib");\nconst b = a;\nexports.vulnerable = b.vulnerable;`,
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("a locally-declared `exports` object disables the relation for the whole file", () => {
    // A user object that merely LOOKS like CommonJS. Provenance, not a
    // name match, is what licenses the relation.
    expect(
      originOf(
        `const exports = {};\nexports.vulnerable = require("./lib").vulnerable;`,
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("a locally-declared `module` object disables the relation for the whole file", () => {
    expect(
      originOf(
        `const module = { exports: {} };\nmodule.exports.vulnerable = require("./lib").vulnerable;`,
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("a locally-declared `require` function disables the relation for the whole file", () => {
    expect(
      originOf(
        `function require(x) { return {}; }\nexports.vulnerable = require("./lib").vulnerable;`,
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("a name declared twice is ambiguous and is never resolved", () => {
    expect(
      originOf(
        `var lib = require("./lib");\nfunction outer(lib) { return lib; }\nexports.vulnerable = lib.vulnerable;`,
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("a `var` that is reassigned later is not single-assignment and is never resolved", () => {
    expect(
      originOf(
        `var lib = require("./lib");\nif (process.env.X) { lib = require("./other"); }\nexports.vulnerable = lib.vulnerable;`,
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("a `let` reassigned through a destructuring assignment is not resolved", () => {
    expect(
      originOf(
        `let lib = require("./lib");\n[lib] = [require("./other")];\nexports.vulnerable = lib.vulnerable;`,
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("a binding declared inside a function is not the module-scope binding", () => {
    expect(
      originOf(
        `function init() { const lib = require("./lib"); return lib; }\nexports.vulnerable = lib.vulnerable;`,
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("a locally DEFINED export is not a re-export", () => {
    const model = exportsOf(
      `function vulnerable() {}\nexports.vulnerable = vulnerable;`,
    );
    expect(
      model.find((e) => e.exportedName === "vulnerable")?.commonJsReExport,
    ).toBeUndefined();
  });

  it("an ESM re-export is never annotated as a CommonJS one", () => {
    const model = exportsOf(`export { vulnerable } from "./lib";`);
    const binding = model.find((e) => e.exportedName === "vulnerable");
    expect(binding?.kind).toBe("re-export");
    expect(binding?.specifier).toBe("./lib");
    expect(binding?.commonJsReExport).toBeUndefined();
  });
});
