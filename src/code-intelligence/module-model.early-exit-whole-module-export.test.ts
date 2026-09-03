import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-015: a top-level `module.exports` write is authoritative only if
 * module evaluation DEFINITELY REACHES it — see
 * `isDefinitelyReachedModuleScopeStatement` and
 * `firstModuleEvaluationCutoff` in module-model.ts.
 *
 * RWF-014 established that the last write in the file may define the
 * module's value when it is syntactically unconditional. That is not
 * enough. Node wraps every CommonJS module in a function, so a
 * module-scope `return` is legal and ends module evaluation where it
 * stands, and an uncaught module-scope `throw` ends it too:
 *
 * ```js
 * if (flag) {
 *   module.exports = dangerousOp;
 *   return;
 * }
 * module.exports = safeOp;   // unconditional, and still not always run
 * ```
 *
 * The final write is a direct child of the source file, so RWF-014's rule
 * accepted it and published `safeOp` as the module's identity — while the
 * module really exports `dangerousOp` on every load with the flag set.
 * Reproduced end to end as a NOT_AFFECTED carrying a complete Family C
 * proof; see fixtures/commonjs-early-exit-whole-module-export/.
 *
 * As in the RWF-014 suite, the unit under test is AUTHORITY SELECTION, so
 * every assertion is about the *identity* an export resolves to. The
 * refusals matter, but so do the acceptances: a model that answered
 * `undefined` for every file containing the word `throw` would pass every
 * negative test here and be useless, so each conservative case is paired
 * with the nearest shape that must still resolve.
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

/** The name a named (property / unpacked-object-literal) export resolves to. */
function namedExportName(text: string, name: string): string | undefined {
  const { index, model } = modelOf(text);
  return mapExportsToFunctions(index, model).get(name)?.name;
}

/** The `commonJsReExport` specifier the whole-module export carries, if any. */
function defaultReExportSpecifier(text: string): string | undefined {
  return modelOf(text).model.exports.find((e) => e.kind === "default")
    ?.commonJsReExport?.specifier;
}

const TWO = "function first() {}\nfunction second() {}\n";

describe("RWF-015: a top-level export write bypassable by an early exit is not definitive", () => {
  it("refuses the final write when an earlier branch exports and RETURNS (the reproducer)", () => {
    // The primary shape. `second` is syntactically unconditional and last,
    // which is exactly what RWF-014's rule accepted -- but on the run that
    // takes the branch, the module exports `first` and never reaches it.
    expect(
      defaultExportName(
        `${TWO}if (FLAG) {\n  module.exports = first;\n  return;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses the final write when an earlier branch exports and THROWS", () => {
    // Same defect through the other abrupt completion: an uncaught
    // module-scope throw propagates out of the require() that triggered
    // the load, leaving `first` as what module.exports holds.
    expect(
      defaultExportName(
        `${TWO}if (FLAG) {\n  module.exports = first;\n  throw new Error("stop");\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a final write preceded by a bare conditional RETURN", () => {
    // No competing write at all -- but the module may export the default
    // `exports` object instead of `second`, so `second` is not its identity.
    expect(
      defaultExportName(
        `${TWO}if (FLAG) {\n  return;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a final write preceded by a bare conditional THROW", () => {
    expect(
      defaultExportName(
        `${TWO}if (FLAG) {\n  throw new Error("stop");\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a write after an UNCONDITIONAL return -- the statement is dead code", () => {
    expect(
      defaultExportName(`${TWO}return;\nmodule.exports = second;\n`),
    ).toBeUndefined();
  });

  it("refuses a write after an UNCONDITIONAL throw -- the statement is dead code", () => {
    expect(
      defaultExportName(
        `${TWO}throw new Error("stop");\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a final write bypassable by a return nested in a top-level LOOP", () => {
    // The `return` is inside a `for`, but it is still a module-scope
    // return: it ends module evaluation, not just the loop.
    expect(
      defaultExportName(
        `${TWO}for (const x of xs) {\n  if (x) return;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a final write bypassable by a throw in a top-level SWITCH", () => {
    expect(
      defaultExportName(
        `${TWO}switch (k) {\n  case 1: throw new Error("stop");\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a final write bypassable by a throw in a CLASS STATIC BLOCK", () => {
    // A static block runs at class-definition time -- i.e. during module
    // evaluation -- so unlike a method body it really can abort the load.
    expect(
      defaultExportName(
        `${TWO}class K {\n  static { throw new Error("stop"); }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-015: abrupt completions that do NOT belong to module evaluation", () => {
  it("keeps the final write authoritative despite a nested function RETURN", () => {
    // The `return` belongs to `helper`, which module evaluation never
    // calls. Over-classifying this would withdraw the identity of very
    // nearly every CommonJS module in existence.
    expect(
      defaultExportName(
        `function helper() {\n  return 1;\n}\n${TWO}module.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps the final write authoritative despite an ARROW function return", () => {
    expect(
      defaultExportName(
        `const helper = () => {\n  return 1;\n};\n${TWO}module.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps the final write authoritative despite a DEFERRED function throw", () => {
    // `configure` throws only if an importer calls it, long after module
    // evaluation finished.
    expect(
      defaultExportName(
        `function configure() {\n  throw new Error("not configured");\n}\n${TWO}module.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps the final write authoritative despite a CLASS METHOD / ACCESSOR throw", () => {
    expect(
      defaultExportName(
        `class K {\n  m() { throw new Error("x"); }\n  get g() { throw new Error("x"); }\n}\n${TWO}module.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps the final write authoritative despite a CALLBACK throw", () => {
    expect(
      defaultExportName(
        `list.forEach(function (x) {\n  throw new Error("x");\n});\n${TWO}module.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps the final write authoritative despite a throw inside an IIFE", () => {
    // Documented conservatism in the PRECISION direction only: an IIFE's
    // body is skipped like any other function expression, because proving
    // a function expression is invoked immediately is call-graph work.
    // See mayEndModuleEvaluation's doc comment.
    expect(
      defaultExportName(
        `(function () {\n  throw new Error("x");\n})();\n${TWO}module.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps the final write authoritative when the return comes AFTER it", () => {
    // A later abrupt completion cannot un-run an earlier assignment.
    expect(
      defaultExportName(
        `${TWO}module.exports = second;\nif (FLAG) {\n  return;\n}\n`,
      ),
    ).toBe("second");
  });

  it("keeps the final write authoritative despite a top-level BREAK in a loop", () => {
    // `break`/`continue` transfer control WITHIN the enclosing statement;
    // execution continues with the next top-level statement regardless.
    expect(
      defaultExportName(
        `${TWO}for (const x of xs) {\n  if (x) break;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps the final write authoritative despite a top-level CONTINUE in a loop", () => {
    expect(
      defaultExportName(
        `${TWO}for (const x of xs) {\n  if (x) continue;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps the final write authoritative despite a BREAK in a top-level switch", () => {
    expect(
      defaultExportName(
        `${TWO}switch (k) {\n  case 1: break;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps the final write authoritative despite a LABELED break", () => {
    expect(
      defaultExportName(
        `${TWO}outer: {\n  if (FLAG) break outer;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("does not treat a CALL as a terminator (process.exit is not modeled)", () => {
    // Whether a call returns is a property of the callee, not of the call
    // syntax. Treating calls as terminators would withdraw almost every
    // real module's identity and would still be a guess.
    expect(
      defaultExportName(
        `${TWO}if (FLAG) {\n  process.exit(1);\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-015: try/catch decides whether a throw ends module evaluation", () => {
  it("keeps the final write authoritative when the throw is CAUGHT", () => {
    // Execution really does continue past a handled throw.
    expect(
      defaultExportName(
        `${TWO}try {\n  if (FLAG) throw new Error("x");\n} catch (e) {\n  // handled\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses when the catch clause RETHROWS", () => {
    // A throw inside a catch clause is not caught by its own try -- the
    // rethrow ends module evaluation exactly as the original would have.
    // This is the shape real `dunder-proto` uses (see FINDINGS.md).
    expect(
      defaultExportName(
        `${TWO}try {\n  if (FLAG) throw new Error("x");\n} catch (e) {\n  throw e;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the try has a FINALLY but no catch", () => {
    // `finally` runs, but it does not stop the exception propagating.
    expect(
      defaultExportName(
        `${TWO}try {\n  if (FLAG) throw new Error("x");\n} finally {\n  cleanup();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when a throw sits in a FINALLY clause", () => {
    expect(
      defaultExportName(
        `${TWO}try {\n  work();\n} finally {\n  throw new Error("x");\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority when an inner rethrow is caught by an OUTER try", () => {
    // The walk continues outward, so nesting resolves correctly rather
    // than defaulting to refusal.
    expect(
      defaultExportName(
        `${TWO}try {\n  try {\n    work();\n  } catch (e) {\n    throw e;\n  }\n} catch (outer) {\n  // handled\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses a RETURN inside a try/catch -- catch does not catch a return", () => {
    expect(
      defaultExportName(
        `${TWO}try {\n  if (FLAG) return;\n} catch (e) {\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("still refuses a write held in a FINALLY block (RWF-014's conditional rule)", () => {
    // Unchanged by RWF-015 and asserted here so the two rules are not
    // confused: a write inside `finally` is not a top-level statement at
    // all, so it was never `"unconditional"` to begin with.
    expect(
      defaultExportName(
        `${TWO}try {\n  module.exports = first;\n  return;\n} finally {\n  module.exports = second;\n}\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-015: the rule applies to every whole-module value shape", () => {
  it("refuses an OBJECT LITERAL export bypassable by an early return", () => {
    // Identity comes from the whole-module assignment, so unpacking a
    // literal that may never be assigned publishes a branch's export table
    // as the module's.
    expect(
      namedExportName(
        `${TWO}if (FLAG) {\n  module.exports = { op: first };\n  return;\n}\nmodule.exports = { op: second };\n`,
        "op",
      ),
    ).toBeUndefined();
  });

  it("refuses a CLASS export bypassable by an early return", () => {
    expect(
      defaultExportName(
        `class First {}\nclass Second {}\nif (FLAG) {\n  module.exports = First;\n  return;\n}\nmodule.exports = Second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses an ANONYMOUS function export bypassable by an early return", () => {
    // RWF-003's position-identity relation must fail closed: a position is
    // an exact identity, but only of a value actually exported.
    const { index, model } = modelOf(
      `if (FLAG) {\n  module.exports = function danger() {};\n  return;\n}\nmodule.exports = function () {};\n`,
    );
    expect(
      model.exports.find((e) => e.kind === "default")?.localFunctionLocation,
    ).toBeUndefined();
    expect(mapExportsToFunctions(index, model).get("default")).toBeUndefined();
  });

  it("refuses a CHAINED alias export bypassable by an early return (RWF-012 shape)", () => {
    expect(
      defaultExportName(
        `${TWO}if (FLAG) {\n  module.exports = alias = first;\n  return;\n}\nmodule.exports = alias = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a require() RE-EXPORT bypassable by an early return (RWF-004 shape)", () => {
    // The PackageInstance attack: the safe specifier must not become the
    // module's origin when the runtime can return the vulnerable one.
    expect(
      defaultReExportSpecifier(
        `if (FLAG) {\n  module.exports = require("nested-vuln");\n  return;\n}\nmodule.exports = require("top-level-safe");\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a PROPERTY export bypassable by an early return", () => {
    // Property exports read the same last-write-wins map through the same
    // gate, so they shared the defect exactly (see FINDINGS.md RWF-015).
    expect(
      namedExportName(
        `${TWO}if (FLAG) {\n  exports.op = first;\n  return;\n}\nexports.op = second;\n`,
        "op",
      ),
    ).toBeUndefined();
  });

  it("keeps a PROPERTY export authoritative when nothing can bypass it", () => {
    expect(
      namedExportName(
        `${TWO}if (FLAG) {\n  exports.op = first;\n}\nexports.op = second;\n`,
        "op",
      ),
    ).toBe("second");
  });
});

describe("RWF-015: RWF-014's authority model is unchanged where no early exit exists", () => {
  it("still keeps the last of TWO UNCONDITIONAL writes", () => {
    expect(
      defaultExportName(
        `${TWO}module.exports = first;\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("still keeps a final unconditional write over an earlier CONDITIONAL one", () => {
    expect(
      defaultExportName(
        `${TWO}if (FLAG) {\n  module.exports = first;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("still refuses UNCONDITIONAL followed by CONDITIONAL (ambiguous)", () => {
    expect(
      defaultExportName(
        `${TWO}module.exports = first;\nif (FLAG) {\n  module.exports = second;\n}\n`,
      ),
    ).toBeUndefined();
  });

  it("still refuses when any DEFERRED write exists", () => {
    expect(
      defaultExportName(
        `${TWO}function configure() {\n  module.exports = first;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("still resolves a plain single unconditional write (RWF-003 control)", () => {
    expect(defaultExportName(`${TWO}module.exports = second;\n`)).toBe(
      "second",
    );
  });
});
