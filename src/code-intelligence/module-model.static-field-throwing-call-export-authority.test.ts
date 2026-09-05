import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-018: RWF-016 proved that a resolvable local call whose callee can
 * only ever throw ends module evaluation exactly as a literal `throw`
 * would, and RWF-017 proved that the call's syntactic position does not
 * change that. Both recognised the call in STATEMENT positions only
 * (`bail();` and `const x = bail();`). A class STATIC FIELD initializer is
 * neither, and has the identical runtime consequence:
 *
 * ```js
 * function dangerousOp() { ... }
 * function bail() { throw new Error("boom"); }
 *
 * if (flag) {
 *   module.exports = dangerousOp;
 *   class C { static x = bail(); }   // class evaluation -> throws -> load fails
 * }
 * module.exports = safeOp;           // syntactically unconditional -- not always run
 * ```
 *
 * Evaluating a class DEFINITION runs each static element -- `static { ... }`
 * blocks and `static x = ...` field initializers alike -- in declaration
 * order, as part of that evaluation, which is itself part of module
 * evaluation. So reaching the class necessarily invokes `bail()`, the class
 * definition never completes, `C` is never bound, and nothing below it runs.
 *
 * The whole soundness argument turns on the STATIC/INSTANCE distinction: an
 * instance field initializer is installed by class evaluation and executed
 * per-instance during construction, which is a caller's decision made after
 * this module finished loading. Both halves are exercised below, and both
 * are proven in one real `node` process in
 * fixtures/commonjs-circular-import-static-field-throw-ground-truth/.
 *
 * Everything about CALLEE identity and callee-body proof is RWF-016's,
 * unchanged and deliberately not re-derived here
 * (`resolveExactLocalCallable`, `cannotCompleteNormally`); this file's cases
 * are about the CALL SITE's enclosing class element.
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
const OTHERS = "function other() {}\nfunction later() {}\n";

describe("RWF-018: a throwing call in a class STATIC FIELD initializer invalidates later export authority", () => {
  it("refuses the final write when an earlier branch exports and then evaluates `class C { static x = bail(); }` (the reproducer)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  class C {\n    static x = bail();\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses the final write for the CLASS EXPRESSION form -- static fields run when the expression is evaluated", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  const C = class {\n    static x = bail();\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a final write preceded by an UNCONDITIONAL static-field class", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}class C {\n  static x = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a final write bypassable by a CONDITIONAL static-field class", () => {
    // The class only evaluates when `FLAG` is true -- but when it does,
    // `bail()` throws and `second` is never assigned. So `second` is not
    // definitely reached on every path.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  class C {\n    static x = bail();\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe(undefined);
  });

  it("keeps authority when the static field's call is the LAST thing in the file (nothing below it to invalidate)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}module.exports = second;\nclass C {\n  static x = bail();\n}\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-018: STATIC vs INSTANCE is the whole distinction", () => {
  it("keeps authority for an INSTANCE field -- evaluating the class installs the initializer and runs nothing", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  class C {\n    x = bail();\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for an INSTANCE field in a CLASS EXPRESSION", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  const C = class {\n    x = bail();\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a static field with NO INITIALIZER -- nothing is evaluated", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  class C {\n    static x;\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a static METHOD whose body throws -- a method body runs only when called", () => {
    expect(
      defaultExportName(
        `${TWO}if (FLAG) {\n  module.exports = first;\n  class C {\n    static m() {\n      throw new Error("boom");\n    }\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("REFUSES a nested class with an abrupt static field inside an INSTANCE field initializer -- the one over-approximation, matching the static-block spelling `main` already has", () => {
    // At runtime the outer instance field never evaluates at
    // class-definition time, so the inner class is never evaluated and
    // `second` really is reached -- this cutoff is an over-approximation.
    // It is pinned deliberately: the walk models which CONSTRUCTS execute
    // at class-definition time, not which expressions are evaluated, and
    // `main` already answers the static-BLOCK spelling of this exact shape
    // the same way. Erring toward UNKNOWN is the sound direction; see
    // tests/validation/FINDINGS.md's RWF-018 limitations.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}class C {\n  x = class {\n    static y = bail();\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority for a static field bound to an ARROW that calls bail -- the arrow is not invoked", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  class C {\n    static x = () => bail();\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-018: static elements run in declaration order, so position within the class cannot matter", () => {
  it("refuses when the abrupt static field is FIRST", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}class C {\n  static a = bail();\n  static b = other();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the abrupt static field is in the MIDDLE", () => {
    // `a` either completed normally (so `b` is reached and throws) or was
    // itself abrupt -- either way `c` never initializes and the class
    // definition never completes.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}class C {\n  static a = other();\n  static b = bail();\n  static c = later();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the abrupt static field is LAST", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}class C {\n  static a = other();\n  static b = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority when NO static field's initializer is a proven-abrupt call", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}class C {\n  static a = other();\n  static b = later();\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses when the abrupt static field follows a static BLOCK -- the two evaluate together", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}class C {\n  static {\n    other();\n  }\n  static b = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-018: transparent initializer shapes", () => {
  it("refuses for a PARENTHESIZED call -- parentheses do not change evaluation", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}class C {\n  static x = (bail());\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-018: the callee body still decides, exactly as under RWF-016", () => {
  it("keeps authority: the static field's callee only throws CONDITIONALLY", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  if (FLAG) throw new Error("x");\n}\nclass C {\n  static x = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the static field's callee just RETURNS", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  return 1;\n}\nclass C {\n  static x = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: an ASYNC throwing callee rejects a promise rather than throwing synchronously", () => {
    expect(
      defaultExportName(
        `${TWO}async function bail() {\n  throw new Error("x");\n}\nclass C {\n  static x = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: a GENERATOR callee does not run its body when called", () => {
    expect(
      defaultExportName(
        `${TWO}function* bail() {\n  throw new Error("x");\n}\nclass C {\n  static x = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses: a const arrow-function callee whose body always throws", () => {
    expect(
      defaultExportName(
        `${TWO}const bail = () => {\n  throw new Error("x");\n};\nclass C {\n  static x = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority: `new bail()` is a NewExpression, not a call this relation models", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}class C {\n  static x = new bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-018: try/catch around the class definition", () => {
  it("keeps authority: the class-evaluation throw is CAUGHT", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  class C {\n    static x = bail();\n  }\n} catch (e) {\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses: the catch clause RETHROWS", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  class C {\n    static x = bail();\n  }\n} catch (e) {\n  throw e;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses: try/FINALLY with no catch does not stop the exception", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  class C {\n    static x = bail();\n  }\n} finally {\n  cleanup();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-018: the class must be EVALUATED during module initialization", () => {
  it("keeps authority: the class declaration sits inside a DEFERRED function body", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}function configure() {\n  class C {\n    static x = bail();\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the class EXPRESSION sits inside a deferred function body", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}function configure() {\n  const C = class {\n    static x = bail();\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the class sits inside a callback, not evaluated directly", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}[1, 2, 3].forEach(function () {\n  class C {\n    static x = bail();\n  }\n});\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the class sits inside a static METHOD's body", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}class Outer {\n  static m() {\n    class C {\n      static x = bail();\n    }\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-018: nested module-evaluation positions reuse RWF-015's statement reachability", () => {
  it("refuses when the class sits in a nested BLOCK", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  {\n    class C {\n      static x = bail();\n    }\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the class sits in a SWITCH case", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}switch (K) {\n  case 1: {\n    class C {\n      static x = bail();\n    }\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the class sits in a LOOP body", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}for (const k of LIST) {\n  class C {\n    static x = bail();\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-018: scope, shadowing and aliasing must not be guessed at", () => {
  it("keeps authority when the class's enclosing block declares a shadowing, harmless bail", () => {
    // Real JS lexical scoping resolves this call to the INNER `bail`,
    // which returns -- so `second` really is reached. RWF-018 must not
    // reach past the shadow to the outer throwing declaration.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  function bail() {}\n  class C {\n    static x = bail();\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("is unaffected by an unrelated same-name decoy inside a never-called sibling function", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}function configure() {\n  function bail() {}\n  const y = bail();\n}\nclass C {\n  static x = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority when the callee name is REASSIGNED elsewhere -- no stale abrupt summary", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  throw new Error("x");\n}\nbail = function () {};\nclass C {\n  static x = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for an ALIASED callee -- one hop only, exactly as RWF-016 has it", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const alias = bail;\nclass C {\n  static x = alias();\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a MEMBER callee -- not a plain identifier", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const obj = { bail };\nclass C {\n  static x = obj.bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-018: every export surface loses authority the same way", () => {
  it("withdraws authority from a later PROPERTY export write", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  exports.foo = first;\n  class C {\n    static x = bail();\n  }\n}\nexports.foo = second;\n`,
        "foo",
      ),
    ).toBeUndefined();
  });

  it("withdraws authority from a later OBJECT-LITERAL whole-module export", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = { foo: first };\n  class C {\n    static x = bail();\n  }\n}\nmodule.exports = { foo: second };\n`,
        "foo",
      ),
    ).toBeUndefined();
  });

  it("withdraws authority from a later CLASS target export", () => {
    expect(
      defaultExportName(
        `class DangerousClass {}\nclass SafeClass {}\n${BAIL_THROWS}if (FLAG) {\n  module.exports = DangerousClass;\n  class C {\n    static x = bail();\n  }\n}\nmodule.exports = SafeClass;\n`,
      ),
    ).toBeUndefined();
  });

  it("withdraws authority from a later REQUIRE RE-EXPORT -- the safe twin must not replace the vulnerable one", () => {
    expect(
      defaultReExportSpecifier(
        `${BAIL_THROWS}if (FLAG) {\n  module.exports = require("nested-vulnerable");\n  class C {\n    static x = bail();\n  }\n}\nmodule.exports = require("safe-twin");\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps a class target attributable when the field is an INSTANCE field", () => {
    expect(
      defaultExportName(
        `class DangerousClass {}\nclass SafeClass {}\n${BAIL_THROWS}if (FLAG) {\n  module.exports = DangerousClass;\n  class C {\n    x = bail();\n  }\n}\nmodule.exports = SafeClass;\n`,
      ),
    ).toBe("SafeClass");
  });
});

describe("RWF-018: RWF-015/016/017 regressions -- no parallel model, no lost coverage", () => {
  it("still refuses for a literal top-level `throw` (RWF-015)", () => {
    expect(
      defaultExportName(
        `${TWO}if (FLAG) {\n  module.exports = first;\n  throw new Error("x");\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("still refuses for a bare `bail();` expression statement (RWF-016)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("still refuses for `const q = bail();` (RWF-017)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  const q = bail();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("still refuses for a static BLOCK calling bail (RWF-016 inside a class)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  class C {\n    static {\n      bail();\n    }\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("still refuses for a static BLOCK with `const q = bail();` (RWF-017 inside a class)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  class C {\n    static {\n      const q = bail();\n    }\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps a genuinely definitely-reached final write attributable (the Family C control)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a file whose only `static` is an ordinary static METHOD", () => {
    expect(
      defaultExportName(
        `${TWO}class C {\n  static helper() {\n    return 1;\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-018: expression positions inside the initializer stay OUT of scope", () => {
  // These are all evaluated (or conditionally evaluated) at runtime, but
  // recognising them means an evaluation-order model over arbitrary
  // expression trees -- the boundary `isDefinitelyAbruptCall` already
  // draws for RWF-016/017. They are pinned here so a later change to that
  // boundary is a deliberate decision rather than an accident, and they
  // are recorded as follow-ups in tests/validation/FINDINGS.md.
  // NOTE: the two COMPUTED KEY shapes that used to be pinned here
  // (`static [bail()] = 1` and `[bail()] = 1`) have moved out. RWF-018
  // recorded them as the RWF-019 candidate because a computed key is
  // evaluated at class-definition time for every element form, static and
  // instance alike, which makes it a key-POSITION rule rather than a
  // static-field one. RWF-019 implements that rule, so both now correctly
  // withdraw authority; their coverage lives in
  // module-model.computed-class-key-throwing-call-export-authority.test.ts.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["argument position", "class C {\n  static x = wrap(bail());\n}"],
    ["comma expression", "class C {\n  static x = (bail(), 1);\n}"],
    ["array element", "class C {\n  static x = [bail()];\n}"],
    ["object property", "class C {\n  static x = { v: bail() };\n}"],
    ["template hole", "class C {\n  static x = `v${bail()}`;\n}"],
    ["logical LHS", "class C {\n  static x = bail() || 1;\n}"],
    ["logical RHS", "class C {\n  static x = FLAG && bail();\n}"],
    ["ternary branch", "class C {\n  static x = FLAG ? bail() : 1;\n}"],
    [
      "throwing IIFE",
      'class C {\n  static x = (() => {\n    throw new Error("x");\n  })();\n}',
    ],
  ];

  for (const [label, body] of cases) {
    it(`keeps authority for an unmodeled ${label} (documented limitation)`, () => {
      expect(
        defaultExportName(
          `${TWO}${BAIL_THROWS}function wrap(a) {\n  return a;\n}\n${body}\nmodule.exports = second;\n`,
        ),
      ).toBe("second");
    });
  }
});
