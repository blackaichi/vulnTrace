import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-020: RWF-016 proved that a resolvable local call whose callee can
 * only ever throw ends module evaluation exactly as a literal `throw`
 * would; RWF-017 proved the call's syntactic POSITION does not change that;
 * RWF-018 carried it into a class STATIC FIELD's initializer and RWF-019
 * into any class element's COMPUTED KEY. All four read the call off a
 * STATEMENT or off a class ELEMENT. A class's `extends` HERITAGE
 * expression is on neither:
 *
 * ```js
 * function dangerousOp() { ... }
 * function bail() { throw new Error("boom"); }
 *
 * if (flag) {
 *   module.exports = dangerousOp;
 *   class C extends bail() {}   // EMPTY body -- no element to read a call off
 * }
 * module.exports = safeOp;      // syntactically unconditional -- not always run
 * ```
 *
 * ClassDefinitionEvaluation evaluates the heritage expression FIRST,
 * before it does anything else with the class: the superclass value has to
 * exist before the prototype chain can be built, so it runs strictly
 * before every computed key, every static field initializer and every
 * static block. Reaching this class therefore invokes `bail()`, the class
 * definition never completes, `C` is never bound, and nothing below runs.
 *
 * That the class body may be EMPTY is what makes RWF-020 a different rule
 * rather than a widening of RWF-018/019: those two predicates are handed a
 * `PropertyDeclaration` and a `ClassElement`, and `class C extends bail()
 * {}` has neither.
 *
 * The runtime facts these cases encode -- including the measured
 * evaluation ORDER, and the three heritage forms that throw for a reason
 * RWF-020 deliberately does NOT claim (`async` callee, generator callee,
 * invalid returned value) -- were all executed under real `node` v26 in
 * fixtures/commonjs-circular-import-class-heritage-throw-ground-truth/.
 *
 * Everything about CALLEE identity and callee-body proof is RWF-016's,
 * unchanged and deliberately not re-derived here
 * (`resolveExactLocalCallable`, `cannotCompleteNormally`); this file's
 * cases are about the CALL SITE being a heritage expression.
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
const BASE_FACTORY = "function baseFactory() {\n  return class Base {};\n}\n";
const OTHERS = "function other() {}\nfunction later() {}\n";

/** The canonical reproducer, parameterised over the class-defining source. */
function reproducer(body: string): string {
  return `${TWO}${BAIL_THROWS}${BASE_FACTORY}if (FLAG) {\n  module.exports = first;\n${body}}\nmodule.exports = second;\n`;
}

describe("RWF-020: an `extends` HERITAGE call that throws invalidates later export authority", () => {
  it("refuses the final write for a class DECLARATION with an empty body -- the shape RWF-018/019 cannot see", () => {
    expect(
      defaultExportName(reproducer("  class C extends bail() {}\n")),
    ).toBeUndefined();
  });

  it("refuses the final write for a class EXPRESSION -- heritage runs when the expression is evaluated", () => {
    expect(
      defaultExportName(reproducer("  const C = class extends bail() {};\n")),
    ).toBeUndefined();
  });

  it("refuses the final write for a NAMED class expression", () => {
    expect(
      defaultExportName(
        reproducer("  const C = class Named extends bail() {};\n"),
      ),
    ).toBeUndefined();
  });

  it("refuses the final write for a PARENTHESIZED heritage call -- parentheses are transparent", () => {
    expect(
      defaultExportName(reproducer("  class C extends (bail()) {}\n")),
    ).toBeUndefined();
  });

  it("refuses the final write for a DOUBLY parenthesized heritage call", () => {
    expect(
      defaultExportName(reproducer("  class C extends ((bail())) {}\n")),
    ).toBeUndefined();
  });

  it("refuses the final write for an optional heritage call `bail?.()` -- an exact local callable is never nullish", () => {
    expect(
      defaultExportName(reproducer("  class C extends bail?.() {}\n")),
    ).toBeUndefined();
  });

  it("refuses a final write preceded by an UNCONDITIONAL heritage class", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}class C extends bail() {}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a final write bypassable by a CONDITIONAL heritage class", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  class C extends bail() {}\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority when the heritage class is the LAST thing in the file (nothing below it to invalidate)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}module.exports = second;\nclass C extends bail() {}\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-020: heritage expressions that do NOT end module evaluation -- the controls that make this sound rather than merely conservative", () => {
  it("keeps authority for a heritage call that RETURNS a base class -- `extends baseFactory()`", () => {
    // RWF-020 asks only whether the CALL completes. It deliberately makes
    // no claim about the returned value being a usable superclass.
    expect(
      defaultExportName(reproducer("  class C extends baseFactory() {}\n")),
    ).toBe("second");
  });

  it("keeps authority for `extends null` -- legal, and no call at all", () => {
    expect(defaultExportName(reproducer("  class C extends null {}\n"))).toBe(
      "second",
    );
  });

  it("keeps authority for `extends Base` -- an identifier, not a call", () => {
    expect(defaultExportName(reproducer("  class C extends Base {}\n"))).toBe(
      "second",
    );
  });

  it("keeps authority for a class with no heritage clause at all", () => {
    expect(defaultExportName(reproducer("  class C {}\n"))).toBe("second");
  });

  it("keeps authority for a CONDITIONAL-THROW callee -- `bail` may return, so the call is not definitely abrupt", () => {
    // A separate, pre-existing family: RWF-016's `cannotCompleteNormally`
    // requires that EVERY path through the callee throws.
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  if (FLAG) throw new Error("boom");\n  return class Base {};\n}\nif (FLAG) {\n  module.exports = first;\n  class C extends bail() {}\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for an ASYNC callee -- calling it RETURNS a rejected promise rather than throwing", () => {
    // Measured under real node: the class definition does ultimately throw,
    // but with `TypeError: Class extends value #<Promise> is not a
    // constructor or null` -- an INVALID-HERITAGE-VALUE failure, which is a
    // different mechanism RWF-020 does not model. Classifying the CALL as
    // definitely abrupt here would be right by accident.
    expect(
      defaultExportName(
        `${TWO}async function bail() {\n  throw new Error("boom");\n}\nif (FLAG) {\n  module.exports = first;\n  class C extends bail() {}\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a GENERATOR callee -- calling it does not execute the body at all", () => {
    // Measured under real node: `TypeError: Class extends value [object
    // Generator] is not a constructor or null`. Again a different mechanism.
    expect(
      defaultExportName(
        `${TWO}function* bail() {\n  throw new Error("boom");\n}\nif (FLAG) {\n  module.exports = first;\n  class C extends bail() {}\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a callee REASSIGNED after declaration -- no stale abrupt summary", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}bail = () => class Base {};\nif (FLAG) {\n  module.exports = first;\n  class C extends bail() {}\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for an INVALID returned heritage value -- `extends notAConstructor()` is not modeled from return values", () => {
    // Runtime throws `TypeError: Class extends value 1 is not a constructor
    // or null`, so a later export really is bypassed -- but proving that
    // needs value/type interpretation VulnTrace does not have. Recorded as
    // a separate open finding rather than guessed at here.
    expect(
      defaultExportName(
        `${TWO}function notAConstructor() {\n  return 1;\n}\nif (FLAG) {\n  module.exports = first;\n  class C extends notAConstructor() {}\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-020: heritage is class-DEFINITION time, but a class inside a function body is DEFERRED", () => {
  it("keeps authority for a heritage class declared inside a never-called FUNCTION", () => {
    expect(
      defaultExportName(
        reproducer(
          "  function configure() {\n    class C extends bail() {}\n  }\n",
        ),
      ),
    ).toBe("second");
  });

  it("keeps authority for a heritage class EXPRESSION inside an ARROW body", () => {
    expect(
      defaultExportName(
        reproducer("  const make = () => class extends bail() {};\n"),
      ),
    ).toBe("second");
  });

  it("keeps authority for a heritage class inside a CALLBACK", () => {
    expect(
      defaultExportName(
        reproducer(
          "  register(function () {\n    class C extends bail() {}\n  });\n",
        ),
      ),
    ).toBe("second");
  });

  it("keeps authority for a heritage class inside a METHOD body", () => {
    expect(
      defaultExportName(
        reproducer(
          "  class Host {\n    make() {\n      class C extends bail() {}\n      return C;\n    }\n  }\n",
        ),
      ),
    ).toBe("second");
  });

  it("keeps authority for a heritage class inside a GETTER body", () => {
    expect(
      defaultExportName(
        reproducer(
          "  class Host {\n    get made() {\n      class C extends bail() {}\n      return C;\n    }\n  }\n",
        ),
      ),
    ).toBe("second");
  });
});

describe("RWF-020: interaction with RWF-018 and RWF-019 -- three independent rules over one class, none interfering", () => {
  it("still refuses via RWF-019 when the heritage is HARMLESS but a computed KEY throws", () => {
    expect(
      defaultExportName(
        reproducer(
          "  class C extends baseFactory() {\n    [bail()] = 1;\n  }\n",
        ),
      ),
    ).toBeUndefined();
  });

  it("still refuses via RWF-018 when the heritage is HARMLESS but a STATIC FIELD throws", () => {
    expect(
      defaultExportName(
        reproducer(
          "  class C extends baseFactory() {\n    static x = bail();\n  }\n",
        ),
      ),
    ).toBeUndefined();
  });

  it("refuses on the HERITAGE alone, even when every element is harmless -- heritage runs first", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${BASE_FACTORY}${OTHERS}if (FLAG) {\n  module.exports = first;\n  class C extends bail() {\n    [later()] = 1;\n    static x = other();\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority when heritage, key and static field are ALL harmless", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${BASE_FACTORY}${OTHERS}if (FLAG) {\n  module.exports = first;\n  class C extends baseFactory() {\n    [later()] = 1;\n    static x = other();\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for an INSTANCE FIELD VALUE under a harmless heritage -- RWF-018's line, unmoved", () => {
    expect(
      defaultExportName(
        reproducer("  class C extends baseFactory() {\n    x = bail();\n  }\n"),
      ),
    ).toBe("second");
  });
});

describe("RWF-020: try/catch semantics reuse RWF-015's existing model exactly", () => {
  it("keeps authority when the heritage throw is CAUGHT", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  class C extends bail() {}\n} catch {}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses when the catch RETHROWS", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  class C extends bail() {}\n} catch {\n  throw new Error("other");\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses for try/FINALLY with no catch -- the original throw still propagates", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  class C extends bail() {}\n} finally {\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority when the catch is on a try/catch/FINALLY", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  class C extends bail() {}\n} catch {\n} finally {\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-020: callee resolution is RWF-016's, reused unchanged", () => {
  it("resolves an own-BLOCK shadow to the harmless inner binding", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  {\n    function bail() {\n      return class Base {};\n    }\n    class C extends bail() {}\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for an ALIASED callee -- `const alias = bail; class C extends alias() {}`", () => {
    expect(
      defaultExportName(
        reproducer("  const alias = bail;\n  class C extends alias() {}\n"),
      ),
    ).toBe("second");
  });

  it("keeps authority for a MEMBER-call heritage -- `class C extends obj.bail() {}`", () => {
    expect(
      defaultExportName(reproducer("  class C extends obj.bail() {}\n")),
    ).toBe("second");
  });

  it("keeps authority for a NEW-expression heritage -- `class C extends new Bail() {}`", () => {
    // Constructor semantics are not modeled; inferring abruptness here
    // would be a guess.
    expect(
      defaultExportName(reproducer("  class C extends new Bail() {}\n")),
    ).toBe("second");
  });

  it("keeps authority for a CLASS-NAME shadow -- `class bail extends bail()` has its own TDZ semantics", () => {
    expect(
      defaultExportName(reproducer("  class bail extends bail() {}\n")),
    ).toBe("second");
  });
});

describe("RWF-020: nested heritage expressions stay at RWF-017's arbitrary-expression boundary", () => {
  // The first two DO always evaluate `bail` and are therefore known,
  // recorded precision limitations (see tests/validation/FINDINGS.md); the
  // last three genuinely may not call it at all, which is why the boundary
  // is drawn by shape rather than guessed past.
  const unmodeled: ReadonlyArray<readonly [string, string]> = [
    ["argument position", "  class C extends foo(bail()) {}\n"],
    ["comma sequence", "  class C extends (bail(), Base) {}\n"],
    ["logical LHS", "  class C extends (bail() || Base) {}\n"],
    ["logical RHS", "  class C extends (FLAG && bail()) {}\n"],
    ["conditional", "  class C extends (FLAG ? bail() : Base) {}\n"],
    [
      "throwing IIFE",
      "  class C extends (() => { throw new Error(); })() {}\n",
    ],
  ];

  for (const [label, body] of unmodeled) {
    it(`keeps authority for a ${label} heritage expression (deliberately unmodeled)`, () => {
      expect(defaultExportName(reproducer(body))).toBe("second");
    });
  }
});

describe("RWF-020: every export surface loses authority alike", () => {
  it("withdraws a later PROPERTY export", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  exports.foo = first;\n  class C extends bail() {}\n}\nexports.foo = second;\n`,
        "foo",
      ),
    ).toBeUndefined();
  });

  it("withdraws a later OBJECT-LITERAL export", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = { foo: first };\n  class C extends bail() {}\n}\nmodule.exports = { foo: second };\n`,
        "foo",
      ),
    ).toBeUndefined();
  });

  it("withdraws a later CLASS target", () => {
    expect(
      defaultExportName(
        `class DangerousClass {}\nclass SafeClass {}\n${BAIL_THROWS}if (FLAG) {\n  module.exports = DangerousClass;\n  class C extends bail() {}\n}\nmodule.exports = SafeClass;\n`,
      ),
    ).toBeUndefined();
  });

  it("withdraws a later REQUIRE re-export", () => {
    expect(
      defaultReExportSpecifier(
        `${BAIL_THROWS}if (FLAG) {\n  module.exports = require("nested-vulnerable");\n  class C extends bail() {}\n}\nmodule.exports = require("safe-twin");\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps a require re-export when the heritage is harmless", () => {
    expect(
      defaultReExportSpecifier(
        `${BAIL_THROWS}${BASE_FACTORY}if (FLAG) {\n  module.exports = require("nested-vulnerable");\n  class C extends baseFactory() {}\n}\nmodule.exports = require("safe-twin");\n`,
      ),
    ).toBe("safe-twin");
  });
});

describe("RWF-020: adjacent constructs deliberately left alone", () => {
  it("does not touch an OBJECT LITERAL's computed key -- a separate, still-open P0", () => {
    // `const x = { [bail()]: 1 };` really does end module evaluation, and
    // RWF-019 deliberately excluded object literals from its class-element
    // rule. RWF-020 changes nothing here either; the regression exists so
    // that a future fix is a deliberate decision rather than a side effect.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  const x = {\n    [bail()]: 1,\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("does not treat a TypeScript `implements` clause as executable", () => {
    const index = indexSourceFile(
      "/pkg/index.ts",
      `${TWO}${BAIL_THROWS}interface Shape {}\nif (FLAG) {\n  module.exports = first;\n  class C implements Shape {}\n}\nmodule.exports = second;\n`,
    );
    const model = buildModuleModel(index);
    expect(mapExportsToFunctions(index, model).get("default")?.name).toBe(
      "second",
    );
  });

  it("does not treat an INTERFACE's `extends` clause as executable", () => {
    const index = indexSourceFile(
      "/pkg/index.ts",
      `${TWO}${BAIL_THROWS}interface Base {}\ninterface Derived extends Base {}\nif (FLAG) {\n  module.exports = first;\n}\nmodule.exports = second;\n`,
    );
    const model = buildModuleModel(index);
    expect(mapExportsToFunctions(index, model).get("default")?.name).toBe(
      "second",
    );
  });
});
