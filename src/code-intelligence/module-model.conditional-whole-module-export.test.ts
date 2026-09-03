import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-014: which `module.exports = X` write, if any, may define the
 * module's whole exported value — see
 * `selectAuthoritativeWholeModuleExport` in module-model.ts.
 *
 * The unit under test is AUTHORITY SELECTION, so every assertion here is
 * about the *identity* the canonical `"default"` export resolves to, and
 * every ambiguous fixture deliberately offers TWO equally plausible
 * answers. Binding either one is the defect: a wrong definitive target is
 * what lets Family C issue a complete, internally consistent, and false
 * NOT_AFFECTED (reproduced end to end in
 * fixtures/commonjs-conditional-whole-module-export/).
 */

function modelOf(text: string) {
  const index = indexSourceFile("/pkg/index.js", text);
  return { index, model: buildModuleModel(index) };
}

/** The name of the function the whole-module export resolves to, or `undefined`. */
function defaultExportName(text: string): string | undefined {
  const { index, model } = modelOf(text);
  return mapExportsToFunctions(index, model).get("default")?.name;
}

/** Every canonical export name the module model attributes to a real function. */
function attributedNames(text: string): readonly string[] {
  const { index, model } = modelOf(text);
  return [...mapExportsToFunctions(index, model).keys()].sort();
}

/** The `kind` of every export binding the model produced, sorted. */
function exportKinds(text: string): readonly string[] {
  return modelOf(text)
    .model.exports.map((e) => e.kind)
    .sort();
}

const TWO = "function first() {}\nfunction second() {}\n";

describe("RWF-014: a conditional whole-module CommonJS export is not definitive", () => {
  it("refuses BOTH arms of an if/else over plain identifiers", () => {
    // The representative unsafe pattern. Pre-fix this bound `second`
    // purely because it comes last in the file.
    expect(
      defaultExportName(
        `${TWO}if (FLAG) {\n  module.exports = first;\n} else {\n  module.exports = second;\n}\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a SINGLE conditional write", () => {
    // Nothing overwrites it, but nothing guarantees it runs either -- the
    // module may export the default `exports` object instead.
    expect(
      defaultExportName(`${TWO}if (FLAG) {\n  module.exports = first;\n}\n`),
    ).toBeUndefined();
  });

  it("refuses a conditional ANONYMOUS function expression", () => {
    // RWF-003's identity relation must fail closed here: a position is an
    // exact identity, but only of a value that is actually exported.
    expect(
      defaultExportName("if (FLAG) {\n  module.exports = function () {};\n}\n"),
    ).toBeUndefined();
  });

  it("refuses a conditional ARROW function", () => {
    expect(
      defaultExportName("if (FLAG) {\n  module.exports = () => {};\n}\n"),
    ).toBeUndefined();
  });

  it("refuses alternative writes in try/catch", () => {
    expect(
      defaultExportName(
        `${TWO}try {\n  module.exports = first;\n} catch (e) {\n  module.exports = second;\n}\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a write in a finally block", () => {
    expect(
      defaultExportName(
        `${TWO}try {\n  go();\n} finally {\n  module.exports = first;\n}\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses alternative writes across switch cases", () => {
    expect(
      defaultExportName(
        `${TWO}switch (mode) {\n  case 1:\n    module.exports = first;\n    break;\n  default:\n    module.exports = second;\n}\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a write nested in a further if", () => {
    expect(
      defaultExportName(
        `${TWO}if (a) {\n  if (b) {\n    module.exports = first;\n  } else {\n    module.exports = second;\n  }\n}\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a write inside a loop body", () => {
    expect(
      defaultExportName(
        `${TWO}for (const x of xs) {\n  module.exports = first;\n}\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a short-circuit write", () => {
    // `flag && (module.exports = first)` is a conditional write wearing an
    // expression's clothes.
    expect(
      defaultExportName(`${TWO}flag && (module.exports = first);\n`),
    ).toBeUndefined();
  });

  it("refuses a write in a FUNCTION BODY, and does so file-wide", () => {
    // The deferred case, and the one source position cannot order at all:
    // an importer may call `configure()` after module evaluation and
    // overwrite the "final" top-level assignment below it. So the later
    // unconditional write does NOT rescue this file.
    expect(
      defaultExportName(
        `${TWO}function configure() {\n  module.exports = first;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a write inside an IIFE", () => {
    // Proving a function expression is invoked immediately is call-graph
    // work this relation deliberately does not do.
    expect(
      defaultExportName(
        `${TWO}(function () {\n  module.exports = first;\n})();\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a conditional CHAINED assignment (RWF-012 composed with RWF-014)", () => {
    expect(
      defaultExportName(
        `${TWO}if (FLAG) {\n  module.exports = alias = first;\n} else {\n  module.exports = alias = second;\n}\n`,
      ),
    ).toBeUndefined();
  });

  it("still records that the module HAS a whole-module export when it refuses one", () => {
    // Refusing an identity must not be mistaken for "this module exports
    // nothing" -- that is its own unsound claim, and downstream absence
    // reasoning must never be able to read it that way.
    expect(
      exportKinds(`${TWO}if (FLAG) {\n  module.exports = first;\n}\n`),
    ).toEqual(["default"]);
  });
});

describe("RWF-014: last-write-wins is preserved wherever source order really is execution order", () => {
  it("keeps a single unconditional assignment authoritative", () => {
    expect(defaultExportName(`${TWO}module.exports = first;\n`)).toBe("first");
  });

  it("keeps the LAST of two unconditional assignments authoritative", () => {
    // Both definitely run, in this order, so `second` definitely wins.
    expect(
      defaultExportName(
        `${TWO}module.exports = first;\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps a final unconditional assignment authoritative over an EARLIER conditional one", () => {
    // The asymmetry that makes this sound without a CFG: whether or not
    // the guarded write runs, the top-level statement after it runs, and
    // runs later. Position dominates because module evaluation really is
    // straight-line here.
    expect(
      defaultExportName(
        `${TWO}if (flag) {\n  module.exports = first;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses the MIRROR IMAGE: an unconditional assignment then a conditional overwrite", () => {
    // Runtime exports `first` or `second`. Nothing static picks.
    expect(
      defaultExportName(
        `${TWO}module.exports = first;\nif (flag) {\n  module.exports = second;\n}\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps an unconditional ANONYMOUS function export (RWF-003 regression)", () => {
    const { index, model } = modelOf("module.exports = function () {};\n");
    const fn = mapExportsToFunctions(index, model).get("default");
    expect(fn?.location).toMatchObject({ line: 1, column: 18 });
  });

  it("keeps an unconditional ARROW export (RWF-003 regression)", () => {
    const { index, model } = modelOf("module.exports = () => {};\n");
    expect(mapExportsToFunctions(index, model).get("default")).toBeDefined();
  });

  it("keeps an unconditional CHAINED assignment (RWF-012 regression)", () => {
    const { index, model } = modelOf(
      "const impl = function () {};\nmodule.exports = alias = impl;\n",
    );
    expect(mapExportsToFunctions(index, model).get("default")?.name).toBe(
      "impl",
    );
  });

  it("keeps an unconditional whole-module re-export origin (RWF-004a regression)", () => {
    const { model } = modelOf('module.exports = require("./impl");\n');
    expect(model.exports[0]?.commonJsReExport).toMatchObject({
      specifier: "./impl",
    });
  });

  it("withdraws the re-export origin when the assignment is conditional", () => {
    // `require` resolution being authoritative is not the question; whether
    // the assignment executes is.
    const { model } = modelOf(
      'module.exports = null;\nif (flag) {\n  module.exports = require("pkg");\n}\n',
    );
    expect(model.exports[0]?.commonJsReExport).toBeUndefined();
  });

  it("keeps an unconditional object-literal export table", () => {
    expect(
      attributedNames("function foo() {}\nmodule.exports = { foo };\n"),
    ).toEqual(["foo"]);
  });

  it("refuses a CONDITIONAL object-literal export table", () => {
    // The named bindings describe the contents of one assigned object, so
    // publishing them would publish one branch's export table as the
    // module's.
    expect(
      attributedNames(
        "function foo() {}\nif (flag) {\n  module.exports = { foo };\n}\n",
      ),
    ).toEqual([]);
  });
});

describe("RWF-014: neighbouring provenance guards are unaffected", () => {
  it("does not suppress an independent `exports.foo =` property export", () => {
    // Property exports are a different relation with their own guards
    // (RWF-011/RWF-013). A conditional WHOLE-MODULE write must not
    // silently take them down with it.
    expect(
      attributedNames(
        "function foo() {}\nif (flag) {\n  module.exports = {};\n}\nexports.foo = foo;\n",
      ),
    ).toEqual(["foo"]);
  });

  it("does not suppress `module.exports.foo =` property mutation", () => {
    expect(
      attributedNames(
        "function foo() {}\nmodule.exports = {};\nmodule.exports.foo = foo;\n",
      ),
    ).toEqual(["foo"]);
  });

  it("does not resurrect a same-name decoy when it refuses (RWF-011 regression)", () => {
    // `safeOp` matches nothing the export's right-hand side established.
    // Refusing the whole-module identity must not fall back to a name.
    expect(
      defaultExportName(
        "function safeOp() {}\nif (flag) {\n  module.exports = registry.impl;\n}\n",
      ),
    ).toBeUndefined();
  });

  it("still refuses a reassigned alias (RWF-013 regression)", () => {
    expect(
      defaultExportName(
        "let impl = function () {};\nimpl = other;\nmodule.exports = impl;\n",
      ),
    ).toBeUndefined();
  });
});

/**
 * Composed shapes, from the post-implementation soundness attack. Each one
 * stacks constructs that are individually handled, because the failure mode
 * a per-construct guard has is that two of them together fall between the
 * guards. Every case must land on `undefined` or on the ONE identity the
 * language itself forces — never on a branch.
 */
describe("RWF-014: composed control-flow shapes", () => {
  it.each([
    [
      "if/else nested inside if/else",
      `${TWO}if (p) {\n  if (q) {\n    module.exports = first;\n  } else {\n    module.exports = second;\n  }\n} else {\n  module.exports = first;\n}\n`,
    ],
    [
      "switch inside try/catch",
      `${TWO}try {\n  switch (m) {\n    case 1:\n      module.exports = first;\n      break;\n    default:\n      module.exports = second;\n  }\n} catch (e) {\n  module.exports = first;\n}\n`,
    ],
    [
      "try, catch and finally all writing",
      `${TWO}try {\n  module.exports = first;\n} catch (e) {\n  module.exports = second;\n} finally {\n  module.exports = first;\n}\n`,
    ],
    [
      "unconditional then a loop that overwrites",
      `${TWO}module.exports = first;\nwhile (x) {\n  module.exports = second;\n}\n`,
    ],
    [
      "an IIFE writing AFTER the final unconditional write",
      `${TWO}module.exports = first;\n(function () {\n  module.exports = second;\n})();\n`,
    ],
    [
      "an IIFE writing BEFORE the final unconditional write",
      // Still refused: an IIFE is a function body, and this relation does
      // not prove immediate invocation.
      `${TWO}(function () {\n  module.exports = first;\n})();\nmodule.exports = second;\n`,
    ],
    [
      "an exported configure() that rewrites the export",
      // The shape the deferred rule exists for: an IMPORTER can call this
      // after module evaluation and replace the "final" value.
      `${TWO}module.exports = second;\nmodule.exports.configure = function () {\n  module.exports = first;\n};\n`,
    ],
    [
      "a class static block writing before the final write",
      `${TWO}class K {\n  static {\n    module.exports = first;\n  }\n}\nmodule.exports = second;\n`,
    ],
    [
      "a class method writing",
      `${TWO}class K {\n  m() {\n    module.exports = first;\n  }\n}\nmodule.exports = K;\n`,
    ],
    [
      "an unconditional chained write then a conditional chained overwrite",
      `${TWO}module.exports = alias = second;\nif (f) {\n  module.exports = alias = first;\n}\n`,
    ],
    [
      "a conditional ANONYMOUS overwrite after an unconditional named write",
      `${TWO}module.exports = first;\nif (f) {\n  module.exports = function () {};\n}\n`,
    ],
    [
      "a conditional require() re-export after an unconditional one",
      'module.exports = require("./a");\nif (f) {\n  module.exports = require("./b");\n}\n',
    ],
    [
      "a ternary overwrite after an unconditional write",
      `${TWO}module.exports = first;\nmodule.exports = f ? first : second;\n`,
    ],
    [
      "a do/while body",
      `${TWO}do {\n  module.exports = first;\n} while (f);\n`,
    ],
    [
      "a catch-only rebind after an unconditional write",
      `${TWO}module.exports = first;\ntry {\n  go();\n} catch (e) {\n  module.exports = second;\n}\n`,
    ],
    [
      "a write two function levels deep",
      `${TWO}function outer() {\n  function inner() {\n    module.exports = first;\n  }\n  inner();\n}\nmodule.exports = first;\n`,
    ],
  ])("refuses %s", (_label, source) => {
    expect(defaultExportName(source)).toBeUndefined();
  });

  it.each([
    [
      "three sequential unconditional writes",
      `function a() {}\nfunction b() {}\nfunction c() {}\nmodule.exports = a;\nmodule.exports = b;\nmodule.exports = c;\n`,
      "c",
    ],
    [
      "a try/catch followed by an unconditional write",
      `${TWO}try {\n  module.exports = first;\n} catch (e) {}\nmodule.exports = second;\n`,
      "second",
    ],
    [
      "a loop followed by an unconditional write",
      // The loop may run any number of times, including zero -- and the
      // statement after it runs regardless, and last.
      `${TWO}while (x) {\n  module.exports = first;\n}\nmodule.exports = second;\n`,
      "second",
    ],
    [
      "a labeled block followed by an unconditional write",
      // `break outer` leaves the labeled statement, it does not skip what
      // follows it.
      `${TWO}outer: {\n  module.exports = first;\n  break outer;\n}\nmodule.exports = second;\n`,
      "second",
    ],
    [
      "a switch followed by an unconditional write",
      `${TWO}switch (m) {\n  case 1:\n    module.exports = first;\n}\nmodule.exports = second;\n`,
      "second",
    ],
  ])("still resolves %s", (_label, source, expected) => {
    expect(defaultExportName(source)).toBe(expected);
  });
});
