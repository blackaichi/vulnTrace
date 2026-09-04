import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-016: a top-level export write's RWF-015 "definitely reached" proof
 * must also account for a RESOLVABLE LOCAL CALL whose callee this file's
 * own text proves can only ever throw — not just a literal syntactic
 * `return`/`throw` at the call site itself.
 *
 * ```js
 * function dangerousOp() { ... }
 * function bail() { throw new Error("boom"); }
 *
 * if (flag) {
 *   module.exports = dangerousOp;
 *   bail();               // resolvable, definitely-abrupt local call
 * }
 * module.exports = safeOp; // syntactically unconditional -- not always run
 * ```
 *
 * RWF-015's own model deliberately does NOT treat an arbitrary call as a
 * terminator (`process.exit()`, `assert(...)`) because whether a call
 * returns is a property of its callee, not of call syntax in general.
 * RWF-016 adds exactly one narrow, PROVEN exception: a bare call to a
 * local, non-reassigned, uniquely-declared function/arrow whose own body
 * this file's text proves always throws. See module-model.ts's
 * `cannotCompleteNormally` and `resolveExactLocalCallable`.
 *
 * A cyclic CommonJS `require()` can genuinely retain the earlier
 * (dangerous) export before `bail()` throws — see
 * fixtures/commonjs-circular-import-throwing-export-ground-truth/ for a
 * real `node`-executed proof — so this is not merely a syntactic nicety.
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
const BAIL_THROWS = 'function bail() {\n  throw new Error("boom");\n}\n';

describe("RWF-016: a resolvable local throwing call invalidates later export authority", () => {
  it("refuses the final write when an earlier branch exports and calls a definitely-abrupt local function (the reproducer)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a final write preceded by a bare unconditional throwing call", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}bail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a final write bypassable by a CONDITIONAL throwing call", () => {
    // `bail()` itself always throws once reached, but the call is only
    // reached when `flag` is true -- so `second` is not definitely reached
    // on every path, exactly like RWF-015's bare conditional throw.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-016: the callee body decides whether a call is definitely abrupt", () => {
  it("keeps authority: callee only throws CONDITIONALLY (case B)", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  if (FLAG) throw new Error("x");\n}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses: callee throws on BOTH branches of an if/else (case C)", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  if (FLAG) {\n    throw new Error("a");\n  } else {\n    throw new Error("b");\n  }\n}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority: callee conditionally RETURNS before an unconditional throw (case D)", () => {
    // `return` is a normal completion for bail()'s caller -- reachable on
    // the `flag` branch, so the call MAY return normally.
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  if (FLAG) return;\n  throw new Error("x");\n}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: callee just RETURNS (case E)", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  return;\n}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: callee is an infinite loop -- no non-termination inference (case F)", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  while (true) {}\n}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the call MAY return normally (conditional-throw callee, direct call)", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  if (FLAG) throw new Error("x");\n}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-016: try/catch INSIDE the callee's own body", () => {
  it("keeps authority: callee's throw is caught and swallowed internally", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  try {\n    throw new Error("x");\n  } catch (e) {\n  }\n}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses: callee's catch clause RETHROWS unconditionally", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  try {\n    throw new Error("x");\n  } catch (e) {\n    throw e;\n  }\n}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority: callee has a FINALLY -- conservative refusal to reason about it", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  try {\n    throw new Error("x");\n  } finally {\n    cleanup();\n  }\n}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-016: try/catch AROUND the call site", () => {
  it("keeps authority: the throwing call is CAUGHT at the call site", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  bail();\n} catch (e) {\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses: the call-site catch clause RETHROWS", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  bail();\n} catch (e) {\n  throw e;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-016: the call must execute DURING module initialization", () => {
  it("keeps authority: the throwing call is nested inside a DEFERRED function", () => {
    // `configure` is never invoked at module scope, so its call to `bail()`
    // has no bearing on this load's module evaluation.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}function configure() {\n  bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-016: scope, shadowing and aliasing must not be guessed at", () => {
  it("refuses correctly when the call site's OWN block declares a shadowing bail (real lexical shadow)", () => {
    // The inner `bail` is block-scoped to this `if`, and the call sits in
    // that same block -- real JS lexical scoping resolves the call to the
    // INNER (non-throwing) `bail`, not the outer throwing one. `second`
    // stays authoritative precisely because RWF-016 must NOT confuse the
    // two: it proves the call resolves to the harmless shadow and declines
    // to treat it as abrupt at all.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  function bail() {}\n  bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("is unaffected by an UNRELATED same-name decoy nested inside a sibling, never-called function", () => {
    // A second, unrelated declaration of "bail" exists nested inside
    // `configure`, which is never called anywhere -- and which is not on
    // the top-level call's own lexical ancestor chain at all. Real JS
    // scoping resolves the top-level `bail()` unambiguously to the OUTER,
    // throwing `bail`, so `second` is correctly proven unreachable here --
    // this is a genuine defect the decoy does not save it from, not a
    // false positive.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}function configure() {\n  function bail() {}\n  bail();\n}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority for an ALIASED call -- no new alias resolution", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const x = bail;\nx();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority when the callee name is reassigned elsewhere (RWF-013b discipline)", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  throw new Error("x");\n}\nbail = function () {};\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("supports a const function-expression callee, exactly as authoritative as a declaration", () => {
    expect(
      defaultExportName(
        `${TWO}const bail = function () {\n  throw new Error("x");\n};\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("supports a const arrow-function callee", () => {
    expect(
      defaultExportName(
        `${TWO}const bail = () => {\n  throw new Error("x");\n};\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority for a `let`-bound throwing callee -- reassignment is a runtime possibility even if unseen", () => {
    expect(
      defaultExportName(
        `${TWO}let bail = function () {\n  throw new Error("x");\n};\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-016: excluded callable shapes", () => {
  it("keeps authority for a method call (obj.bail())", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const obj = { bail };\nobj.bail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a computed/registry call", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const registry = { bail };\nregistry["bail"]();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for an async function callee -- a synchronous throw becomes a rejected promise", () => {
    expect(
      defaultExportName(
        `${TWO}async function bail() {\n  throw new Error("x");\n}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a generator function callee -- calling it does not run its body", () => {
    expect(
      defaultExportName(
        `${TWO}function* bail() {\n  throw new Error("x");\n}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority when the call is embedded in a larger expression, not a bare statement", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const ok = bail() || first;\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-016: the rule applies to every whole-module value shape RWF-015 already covers", () => {
  it("refuses a PROPERTY export bypassable by a throwing call", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  exports.op = first;\n  bail();\n}\nexports.op = second;\n`,
        "op",
      ),
    ).toBeUndefined();
  });

  it("keeps a PROPERTY export authoritative when the call cannot bypass it", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  exports.op = first;\n}\nexports.op = second;\n`,
        "op",
      ),
    ).toBe("second");
  });

  it("refuses an OBJECT LITERAL export bypassable by a throwing call", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = { op: first };\n  bail();\n}\nmodule.exports = { op: second };\n`,
        "op",
      ),
    ).toBeUndefined();
  });

  it("refuses a CLASS export bypassable by a throwing call", () => {
    expect(
      defaultExportName(
        `class First {}\nclass Second {}\n${BAIL_THROWS}if (FLAG) {\n  module.exports = First;\n  bail();\n}\nmodule.exports = Second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a require() RE-EXPORT bypassable by a throwing call", () => {
    expect(
      defaultReExportSpecifier(
        `${BAIL_THROWS}if (FLAG) {\n  module.exports = require("nested-vuln");\n  bail();\n}\nmodule.exports = require("top-level-safe");\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-016: self-review attack cases", () => {
  it("duplicate top-level function declaration: LAST one wins, matching real JS runtime semantics", () => {
    // A second `function bail() {}` at the same top level silently
    // overrides the first at runtime (real JS redeclaration semantics).
    // The candidate map keeps whatever `sourceFile.statements` iteration
    // sees last, matching that.
    expect(
      defaultExportName(
        `${TWO}function bail() {}\nfunction bail() {\n  throw new Error("x");\n}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("duplicate top-level function declaration, reversed: the LAST one does not throw", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  throw new Error("x");\n}\nfunction bail() {}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a recursive callee with no throw -- no non-termination inference", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  bail();\n}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority when the throwing call is nested inside a CALLBACK, not called directly", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}[1, 2, 3].forEach(function () {\n  bail();\n});\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses correctly when the throwing call sits inside a deeply nested try/finally (no catch)", () => {
    // A `try`/`finally` with no `catch` does not stop the exception --
    // same RWF-015 rule the call-site case reuses.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (a) {\n  if (b) {\n    try {\n      bail();\n    } finally {\n      cleanup();\n    }\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-016: Family C positive control -- an unaffected call must not lose authority", () => {
  it("keeps a plain unconditional export with no bail() call anywhere", () => {
    expect(defaultExportName(`${TWO}module.exports = second;\n`)).toBe(
      "second",
    );
  });

  it("keeps authority when bail() is declared but never called at module scope", () => {
    expect(
      defaultExportName(`${TWO}${BAIL_THROWS}module.exports = second;\n`),
    ).toBe("second");
  });
});
