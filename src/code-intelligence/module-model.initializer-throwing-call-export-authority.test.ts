import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-017: RWF-016 proved that a resolvable local call whose callee can
 * only ever throw ends module evaluation exactly as a literal `throw`
 * would — but recognised that call in ONE syntactic position only, a bare
 * `ExpressionStatement`. The identical call in a variable declaration's
 * INITIALIZER has the identical runtime consequence:
 *
 * ```js
 * function dangerousOp() { ... }
 * function bail() { throw new Error("boom"); }
 *
 * if (flag) {
 *   module.exports = dangerousOp;
 *   const result = bail();   // initializer evaluated -> throws -> load fails
 * }
 * module.exports = safeOp;   // syntactically unconditional -- not always run
 * ```
 *
 * JavaScript evaluates a declarator's initializer as part of executing the
 * declaration, so reaching that statement necessarily invokes `bail()`,
 * the declaration never completes, and nothing below it runs. Abrupt
 * module-evaluation behavior is a property of execution semantics, not of
 * whether the `CallExpression` is wrapped in an `ExpressionStatement`.
 *
 * A cyclic CommonJS `require()` can genuinely retain the earlier
 * (dangerous) export before the initializer throws — see
 * fixtures/commonjs-circular-import-initializer-throw-ground-truth/ for a
 * real `node`-executed proof — so this is not merely a syntactic nicety.
 *
 * Everything about CALLEE identity and callee-body proof is RWF-016's,
 * unchanged and deliberately not re-derived here (`resolveExactLocalCallable`,
 * `cannotCompleteNormally`); this file's cases are about the CALL SITE's
 * enclosing declaration.
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

describe("RWF-017: a throwing call in a variable initializer invalidates later export authority", () => {
  it("refuses the final write when an earlier branch exports and then evaluates `const x = bail()` (the reproducer)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  const result = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a final write preceded by an UNCONDITIONAL `const x = bail()`", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const result = bail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a final write bypassable by a CONDITIONAL initializer call", () => {
    // The declaration itself only executes when `flag` is true -- but when
    // it does, `bail()` throws and `second` is never assigned. So `second`
    // is not definitely reached on every path.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  const result = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-017: the declaration keyword is about the CALL SITE, not the callee", () => {
  it("refuses for `const x = bail()`", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const x = bail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses for `let x = bail()` -- same call-site semantics", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}let x = bail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses for `var x = bail()` -- same call-site semantics", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}var x = bail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority for `let x;` -- a declaration with NO initializer evaluates nothing", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}let x;\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("does NOT extend the callee rule: a `let`-bound throwing callee is still refused as a callee", () => {
    // RWF-016 only accepts `const`-bound function expressions as callees.
    // RWF-017 changes the call SITE's shape, never that rule.
    expect(
      defaultExportName(
        `${TWO}let bail = function () {\n  throw new Error("x");\n};\nconst x = bail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-017: transparent and guaranteed-evaluation initializer shapes", () => {
  it("refuses for a PARENTHESIZED call -- parentheses do not change evaluation", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const x = (bail());\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses for an OBJECT destructuring RHS -- the right-hand side is evaluated first", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const { x } = bail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses for an ARRAY destructuring RHS", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const [x] = bail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-017: multiple declarators evaluate left to right", () => {
  it("refuses when the abrupt call is the FIRST declarator", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const a = bail(), b = other();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the abrupt call is a MIDDLE declarator", () => {
    // `a`'s initializer either completed normally (so `b` is reached and
    // throws) or was itself abrupt -- either way `c` never runs and the
    // statement never completes.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const a = other(), b = bail(), c = later();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the abrupt call is the LAST declarator", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const a = other(), b = bail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority when no declarator's initializer is a proven-abrupt call", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const a = other(), b = later();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-017: the callee body still decides, exactly as under RWF-016", () => {
  it("keeps authority: the initializer's callee only throws CONDITIONALLY", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  if (FLAG) throw new Error("x");\n}\nconst x = bail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the initializer's callee just RETURNS", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  return 1;\n}\nconst x = bail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: an ASYNC throwing callee rejects a promise rather than throwing synchronously", () => {
    expect(
      defaultExportName(
        `${TWO}async function bail() {\n  throw new Error("x");\n}\nconst x = bail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: a GENERATOR callee does not run its body when called", () => {
    expect(
      defaultExportName(
        `${TWO}function* bail() {\n  throw new Error("x");\n}\nconst x = bail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses: a const arrow-function callee whose body always throws", () => {
    expect(
      defaultExportName(
        `${TWO}const bail = () => {\n  throw new Error("x");\n};\nconst x = bail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-017: try/catch around the initializer's call site", () => {
  it("keeps authority: the initializer's throw is CAUGHT at the call site", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  const x = bail();\n} catch (e) {\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses: the call-site catch clause RETHROWS", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  const x = bail();\n} catch (e) {\n  throw e;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses: try/FINALLY with no catch does not stop the exception", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  const x = bail();\n} finally {\n  cleanup();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-017: the initializer must execute DURING module initialization", () => {
  it("keeps authority: the initializer sits inside a DEFERRED function body", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}function configure() {\n  const x = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the initializer is an INSTANCE class field, which does not run at class-definition time", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}class C {\n  x = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the initializer sits inside a callback, not called directly", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}[1, 2, 3].forEach(function () {\n  const x = bail();\n});\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-017: scope, shadowing and aliasing must not be guessed at", () => {
  it("keeps authority when the call site's OWN block declares a shadowing, harmless bail", () => {
    // Real JS lexical scoping resolves this call to the INNER `bail`,
    // which returns -- so `second` really is reached and really is
    // authoritative. RWF-017 must not reach past the shadow to the outer
    // throwing declaration.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  function bail() {}\n  const x = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("is unaffected by an unrelated same-name decoy inside a never-called sibling function", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}function configure() {\n  function bail() {}\n  const y = bail();\n}\nconst x = bail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority when the callee name is REASSIGNED elsewhere -- no stale abrupt summary", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  throw new Error("x");\n}\nbail = function () {};\nconst x = bail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for an ALIASED initializer call -- no new alias resolution", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const alias = bail;\nconst x = alias();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a METHOD initializer call", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const obj = { bail };\nconst x = obj.bail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-017: initializer expression forms that do NOT guarantee the call", () => {
  it("keeps authority for a CONDITIONAL (ternary) initializer", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const x = FLAG ? bail() : first;\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a short-circuiting `&&` initializer", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const x = FLAG && bail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a call embedded in a larger binary expression", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const ok = bail() || first;\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for an argument-position call (documented limitation, conservative)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const x = wrap(bail());\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a comma-sequence initializer (documented limitation, conservative)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const x = (bail(), first);\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for an optional call on a RECEIVER (obj?.bail())", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const obj = { bail };\nconst x = obj?.bail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses for `bail?.()` -- an exactly-resolved local callee is never nullish, so the call always happens", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const x = bail?.();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-017: the rule applies to every export surface RWF-015/016 already cover", () => {
  it("refuses a PROPERTY export bypassable by an initializer call", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  exports.op = first;\n  const x = bail();\n}\nexports.op = second;\n`,
        "op",
      ),
    ).toBeUndefined();
  });

  it("keeps a PROPERTY export authoritative when no initializer call can bypass it", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  exports.op = first;\n}\nexports.op = second;\n`,
        "op",
      ),
    ).toBe("second");
  });

  it("refuses a WHOLE-MODULE export bypassable by an initializer call", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  const x = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses an OBJECT LITERAL export bypassable by an initializer call", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = { op: first };\n  const x = bail();\n}\nmodule.exports = { op: second };\n`,
        "op",
      ),
    ).toBeUndefined();
  });

  it("refuses a CLASS export bypassable by an initializer call", () => {
    expect(
      defaultExportName(
        `class First {}\nclass Second {}\n${BAIL_THROWS}if (FLAG) {\n  module.exports = First;\n  const x = bail();\n}\nmodule.exports = Second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a require() RE-EXPORT bypassable by an initializer call", () => {
    expect(
      defaultReExportSpecifier(
        `${BAIL_THROWS}if (FLAG) {\n  module.exports = require("nested-vulnerable");\n  const x = bail();\n}\nmodule.exports = require("safe-twin");\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-017: Family C positive controls -- unaffected modules must not lose authority", () => {
  it("keeps a plain unconditional export with no bail() anywhere", () => {
    expect(defaultExportName(`${TWO}module.exports = second;\n`)).toBe(
      "second",
    );
  });

  it("keeps authority when bail() is declared but never called at module scope", () => {
    expect(
      defaultExportName(`${TWO}${BAIL_THROWS}module.exports = second;\n`),
    ).toBe("second");
  });

  it("keeps authority for ordinary initializers that call ordinary functions", () => {
    expect(
      defaultExportName(
        `${TWO}function helper() {\n  return 1;\n}\nconst value = helper();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a require() initializer -- the common real-world shape", () => {
    expect(
      defaultExportName(
        `${TWO}const dep = require("dep");\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-017: RWF-016 regression -- the direct-call path is untouched", () => {
  it("still refuses a bare `bail();` statement above a later export", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("still refuses an unconditional bare `bail();`", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}bail();\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("still keeps authority for a bare call to a conditionally-throwing callee", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  if (FLAG) throw new Error("x");\n}\nbail();\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-017: RWF-015 regression -- literal return/throw cutoffs are untouched", () => {
  it("still refuses a later export below a top-level `return`", () => {
    expect(
      defaultExportName(
        `${TWO}if (FLAG) {\n  module.exports = first;\n  return;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("still refuses a later export below an uncaught top-level `throw`", () => {
    expect(
      defaultExportName(
        `${TWO}if (FLAG) {\n  module.exports = first;\n  throw new Error("x");\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("still keeps authority when a top-level throw is caught", () => {
    expect(
      defaultExportName(
        `${TWO}try {\n  if (FLAG) {\n    throw new Error("x");\n  }\n} catch (e) {\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});
