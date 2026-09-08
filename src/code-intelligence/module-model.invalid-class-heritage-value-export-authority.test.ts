import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-022: RWF-020 proved that a class's `extends` HERITAGE expression runs
 * at class-definition time, and withdrew a later export's authority when
 * evaluating that expression could only ever THROW. It deliberately stopped
 * there, and recorded the rest of the family as an open finding:
 *
 * ```js
 * function notAConstructor() { return 1; }   // returns NORMALLY, always
 *
 * if (FLAG) {
 *   module.exports = dangerousOp;
 *   class C extends notAConstructor() {}     // TypeError anyway
 * }
 * module.exports = safeOp;                   // NOT definitely reached
 * ```
 *
 * The call completes. `1` is neither `null` nor a constructor, so
 * ClassDefinitionEvaluation itself throws
 * `TypeError: Class extends value 1 is not a constructor or null`, the class
 * definition never completes, and the later `module.exports = safeOp` never
 * runs. A cyclic importer keeps the dangerous value.
 *
 * **The distinction this file exists to hold.** RWF-020 asks whether the
 * heritage CALL completes; RWF-022 asks what the heritage VALUE is when the
 * call completes normally. The two mechanisms are disjoint by construction
 * — RWF-020 needs a body that always throws, RWF-022 needs a body that
 * always returns — and the `RWF-020/016: the abrupt-CALL mechanism is
 * untouched by RWF-022` block in
 * module-model.class-heritage-throwing-call-export-authority.test.ts asserts
 * that RWF-022 did not simply widen `isDefinitelyAbruptCall`.
 *
 * Every runtime fact encoded here was executed and ASSERTED under real
 * `node` v26.7.0 in
 * fixtures/commonjs-circular-import-invalid-class-heritage-ground-truth/,
 * whose 31-row `forms.js` table is the source of the value categories below.
 *
 * The controls matter more than the positives. Classifying a VALID heritage
 * value as invalid would withdraw a correct export and could only ever cost
 * precision — but classifying `null`, a class or an ordinary function as
 * invalid is a modeling error regardless of which way the verdict moves, so
 * each has an explicit control here.
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
const BASE = "class Base {}\n";

/** A factory whose single unconditional `return` hands back `body`. */
function factory(name: string, body: string): string {
  return `function ${name}() {\n  return ${body};\n}\n`;
}

const NOT_A_CTOR = factory("notAConstructor", "1");
const MAKE_BASE = "function makeBase() {\n  return class Base2 {};\n}\n";

/** The canonical reproducer, parameterised over declarations and body. */
function reproducer(declarations: string, body: string): string {
  return `${TWO}${declarations}if (FLAG) {\n  module.exports = first;\n${body}}\nmodule.exports = second;\n`;
}

/** The canonical reproducer over a `notAConstructor()` heritage class. */
function canonical(body: string): string {
  return reproducer(NOT_A_CTOR, body);
}

describe("RWF-022: a heritage value that is definitely NOT a constructor invalidates later export authority", () => {
  it("refuses the final write for the canonical `class C extends notAConstructor() {}`", () => {
    expect(
      defaultExportName(canonical("  class C extends notAConstructor() {}\n")),
    ).toBeUndefined();
  });

  it("refuses a final write preceded by an UNCONDITIONAL invalid-heritage class", () => {
    expect(
      defaultExportName(
        `${TWO}${NOT_A_CTOR}class C extends notAConstructor() {}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority when the invalid-heritage class is the LAST thing in the file", () => {
    // Nothing below it to invalidate.
    expect(
      defaultExportName(
        `${TWO}${NOT_A_CTOR}module.exports = second;\nclass C extends notAConstructor() {}\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-022: returned VALUE categories -- every row measured under real node", () => {
  /** [label, returned expression, withdraws authority?] */
  const returns: ReadonlyArray<readonly [string, string, boolean]> = [
    // Definitely non-constructable -> withdraw.
    ["number", "1", true],
    ["number zero", "0", true],
    ["bigint", "1n", true],
    ["string", '"x"', true],
    ["no-substitution template", "`x`", true],
    ["template with substitution", "`a${1}b`", true],
    ["true", "true", true],
    ["false", "false", true],
    ["object literal", "{}", true],
    ["non-empty object literal", "{ a: 1 }", true],
    [
      "object literal with __proto__",
      "{ __proto__: Function.prototype }",
      true,
    ],
    ["array literal", "[]", true],
    ["arrow function", "() => {}", true],
    ["async arrow function", "async () => {}", true],
    ["async function expression", "async function B() {}", true],
    ["generator function expression", "function* B() {}", true],
    ["async generator function expression", "async function* B() {}", true],

    // Definitely VALID -> must keep. These are the modeling-error controls.
    ["null", "null", false],
    ["class expression", "class B {}", false],
    ["named class expression", "class Named {}", false],
    ["ordinary function expression", "function B() {}", false],
    ["anonymous function expression", "function () {}", false],

    // Not decided by node kind alone -> must keep (conservative).
    ["identifier", "Base", false],
    ["member access", "obj.Base", false],
    ["call", "makeBase()", false],
    ["new expression", "new Base()", false],
    ["conditional", "FLAG ? 1 : Base", false],
    ["logical", "Base || 1", false],
    ["negated number", "-1", false],
    ["void 0", "void 0", false],
    [
      "identifier `undefined` (shadowable -- never classified by spelling)",
      "undefined",
      false,
    ],
  ];

  for (const [label, returned, withdraws] of returns) {
    it(`${withdraws ? "withdraws" : "KEEPS"} authority for a factory returning ${label}`, () => {
      const actual = defaultExportName(
        reproducer(
          `${BASE}${MAKE_BASE}${factory("make", returned)}`,
          "  class C extends make() {}\n",
        ),
      );
      if (withdraws) {
        expect(actual).toBeUndefined();
      } else {
        expect(actual).toBe("second");
      }
    });
  }
});

describe("RWF-022: body shapes -- only an unconditional single return is classified", () => {
  it("withdraws for an EMPTY body -- the call returns undefined", () => {
    expect(
      defaultExportName(
        reproducer("function make() {}\n", "  class C extends make() {}\n"),
      ),
    ).toBeUndefined();
  });

  it("withdraws for a BARE `return;` -- also undefined", () => {
    expect(
      defaultExportName(
        reproducer(
          "function make() {\n  return;\n}\n",
          "  class C extends make() {}\n",
        ),
      ),
    ).toBeUndefined();
  });

  it("withdraws for a CONCISE ARROW body -- the body IS the returned value", () => {
    expect(
      defaultExportName(
        reproducer("const make = () => 1;\n", "  class C extends make() {}\n"),
      ),
    ).toBeUndefined();
  });

  it("KEEPS authority for a concise arrow returning a CLASS", () => {
    expect(
      defaultExportName(
        reproducer(
          "const make = () => class B {};\n",
          "  class C extends make() {}\n",
        ),
      ),
    ).toBe("second");
  });

  it("KEEPS authority for MULTIPLE returns, even when one of them is invalid", () => {
    // `maybeBase(flag)` is not definitely anything. Treating it as
    // definitely invalid would be exactly the over-inference this task is
    // scoped to avoid.
    expect(
      defaultExportName(
        reproducer(
          `${BASE}function make(flag) {\n  if (flag) return 1;\n  return Base;\n}\n`,
          "  class C extends make(FLAG) {}\n",
        ),
      ),
    ).toBe("second");
  });

  it("KEEPS authority for two returns that are BOTH invalid -- still not a single-return body", () => {
    // Deliberately conservative: recognising this needs path reasoning the
    // classifier does not have, and its absence costs only precision.
    expect(
      defaultExportName(
        reproducer(
          "function make(flag) {\n  if (flag) return 1;\n  return 2;\n}\n",
          "  class C extends make(FLAG) {}\n",
        ),
      ),
    ).toBe("second");
  });

  it("KEEPS authority for a body with a statement BEFORE the return", () => {
    expect(
      defaultExportName(
        reproducer(
          'function make() {\n  "use strict";\n  return 1;\n}\n',
          "  class C extends make() {}\n",
        ),
      ),
    ).toBe("second");
  });

  it("KEEPS authority for a single non-return statement", () => {
    expect(
      defaultExportName(
        reproducer(
          "function make() {\n  doSomething();\n}\n",
          "  class C extends make() {}\n",
        ),
      ),
    ).toBe("second");
  });

  it("KEEPS authority for a return inside a TRY -- not a bare single return", () => {
    expect(
      defaultExportName(
        reproducer(
          "function make() {\n  try {\n    return 1;\n  } finally {\n  }\n}\n",
          "  class C extends make() {}\n",
        ),
      ),
    ).toBe("second");
  });

  it("withdraws for a THROWING body via RWF-020's mechanism -- RWF-022 classifies it `unknown` and does not compete", () => {
    // The two mechanisms are disjoint: a body that always throws has no
    // `return` for RWF-022 to read, and a body RWF-022 can read always
    // returns. Authority is still withdrawn here -- by RWF-020.
    expect(
      defaultExportName(
        reproducer(
          'function make() {\n  throw new Error("boom");\n}\n',
          "  class C extends make() {}\n",
        ),
      ),
    ).toBeUndefined();
  });

  it("KEEPS authority for a CONDITIONALLY throwing body that may return a class", () => {
    // Neither mechanism applies: not always-throwing (RWF-020 refuses), and
    // not a single unconditional return (RWF-022 refuses).
    expect(
      defaultExportName(
        reproducer(
          `${BASE}function make(flag) {\n  if (flag) throw new Error("boom");\n  return Base;\n}\n`,
          "  class C extends make(FLAG) {}\n",
        ),
      ),
    ).toBe("second");
  });

  it("KEEPS authority for a conditionally throwing body that otherwise returns an INVALID value", () => {
    // Recorded as a follow-up rather than implemented: at runtime the class
    // definition cannot complete either way (throw, or TypeError on `1`), so
    // this IS definitely abrupt at class level. Proving it needs multi-path
    // reasoning across the two mechanisms, which is a separate boundary.
    expect(
      defaultExportName(
        reproducer(
          'function make(flag) {\n  if (flag) throw new Error("boom");\n  return 1;\n}\n',
          "  class C extends make(FLAG) {}\n",
        ),
      ),
    ).toBe("second");
  });
});

describe("RWF-022: CALLEE identity alone decides async and generator callees", () => {
  // A separate mechanism from the return-value one, and RWF-020's doc
  // comment records exactly why: calling these cannot throw synchronously,
  // so RWF-020 must refuse them -- but the VALUE each call produces is a
  // known non-constructor, which is decidable from syntax alone with no
  // body analysis at all.
  it("withdraws for an ASYNC callee -- the call returns a Promise", () => {
    expect(
      defaultExportName(
        reproducer(
          "async function make() {\n  return class B {};\n}\n",
          "  class C extends make() {}\n",
        ),
      ),
    ).toBeUndefined();
  });

  it("withdraws for a GENERATOR callee -- the call returns a generator object", () => {
    expect(
      defaultExportName(
        reproducer(
          "function* make() {\n  yield class B {};\n}\n",
          "  class C extends make() {}\n",
        ),
      ),
    ).toBeUndefined();
  });

  it("withdraws for an ASYNC GENERATOR callee", () => {
    expect(
      defaultExportName(
        reproducer(
          "async function* make() {\n  yield 1;\n}\n",
          "  class C extends make() {}\n",
        ),
      ),
    ).toBeUndefined();
  });

  it("withdraws for an ASYNC ARROW callee bound to a const", () => {
    expect(
      defaultExportName(
        reproducer(
          "const make = async () => class B {};\n",
          "  class C extends make() {}\n",
        ),
      ),
    ).toBeUndefined();
  });

  it("withdraws for an async callee even when its body would be UNCLASSIFIABLE", () => {
    // The body is never consulted: identity settles it.
    expect(
      defaultExportName(
        reproducer(
          "async function make(flag) {\n  if (flag) return 1;\n  doStuff();\n  return Base;\n}\n",
          "  class C extends make(FLAG) {}\n",
        ),
      ),
    ).toBeUndefined();
  });
});

describe("RWF-022: heritage call SHAPES", () => {
  it("withdraws for a class EXPRESSION", () => {
    expect(
      defaultExportName(
        canonical("  const C = class extends notAConstructor() {};\n"),
      ),
    ).toBeUndefined();
  });

  it("withdraws for a NAMED class expression", () => {
    expect(
      defaultExportName(
        canonical("  const C = class Named extends notAConstructor() {};\n"),
      ),
    ).toBeUndefined();
  });

  it("withdraws for a PARENTHESIZED heritage call", () => {
    expect(
      defaultExportName(
        canonical("  class C extends (notAConstructor()) {}\n"),
      ),
    ).toBeUndefined();
  });

  it("withdraws for a DOUBLY parenthesized heritage call", () => {
    expect(
      defaultExportName(
        canonical("  class C extends ((notAConstructor())) {}\n"),
      ),
    ).toBeUndefined();
  });

  it("withdraws for an OPTIONAL heritage call -- an exact local callable is never nullish", () => {
    expect(
      defaultExportName(
        canonical("  class C extends notAConstructor?.() {}\n"),
      ),
    ).toBeUndefined();
  });

  it("withdraws for a heritage class carrying elements -- heritage is validated before any of them binds", () => {
    expect(
      defaultExportName(
        canonical(
          "  class C extends notAConstructor() {\n    x = 1;\n    static y = 2;\n    m() {}\n  }\n",
        ),
      ),
    ).toBeUndefined();
  });
});

describe("RWF-022: DIRECT (non-call) heritage values -- the same classifier, no call involved", () => {
  it("withdraws for `class C extends 1 {}`", () => {
    expect(
      defaultExportName(reproducer("", "  class C extends 1 {}\n")),
    ).toBeUndefined();
  });

  it("withdraws for `class C extends (() => {}) {}`", () => {
    expect(
      defaultExportName(reproducer("", "  class C extends (() => {}) {}\n")),
    ).toBeUndefined();
  });

  it('withdraws for `class C extends "x" {}`', () => {
    expect(
      defaultExportName(reproducer("", '  class C extends "x" {}\n')),
    ).toBeUndefined();
  });

  it("KEEPS authority for `class C extends null {}` -- legal and valid", () => {
    expect(
      defaultExportName(reproducer("", "  class C extends null {}\n")),
    ).toBe("second");
  });

  it("KEEPS authority for `class C extends Base {}` -- an identifier", () => {
    expect(
      defaultExportName(reproducer(BASE, "  class C extends Base {}\n")),
    ).toBe("second");
  });

  it("KEEPS authority for `class C extends (class B {}) {}`", () => {
    expect(
      defaultExportName(reproducer("", "  class C extends (class B {}) {}\n")),
    ).toBe("second");
  });

  it("KEEPS authority for a class with no heritage clause at all", () => {
    expect(defaultExportName(reproducer("", "  class C {}\n"))).toBe("second");
  });
});

describe("RWF-022: try/catch semantics reuse RWF-015's existing model exactly", () => {
  it("KEEPS authority when the invalid-heritage TypeError is CAUGHT", () => {
    expect(
      defaultExportName(
        `${TWO}${NOT_A_CTOR}try {\n  class C extends notAConstructor() {}\n} catch {}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("withdraws when the catch RETHROWS", () => {
    expect(
      defaultExportName(
        `${TWO}${NOT_A_CTOR}try {\n  class C extends notAConstructor() {}\n} catch {\n  throw new Error("other");\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("withdraws for try/FINALLY with no catch -- the TypeError still propagates", () => {
    expect(
      defaultExportName(
        `${TWO}${NOT_A_CTOR}try {\n  class C extends notAConstructor() {}\n} finally {\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("KEEPS authority when the catch is on a try/catch/FINALLY", () => {
    expect(
      defaultExportName(
        `${TWO}${NOT_A_CTOR}try {\n  class C extends notAConstructor() {}\n} catch {\n} finally {\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-022: a class inside a function body is DEFERRED and must not poison module evaluation", () => {
  const deferred: ReadonlyArray<readonly [string, string]> = [
    [
      "never-called FUNCTION",
      "  function configure() {\n    class C extends notAConstructor() {}\n  }\n",
    ],
    [
      "ARROW body class expression",
      "  const make = () => class extends notAConstructor() {};\n",
    ],
    [
      "CALLBACK",
      "  register(function () {\n    class C extends notAConstructor() {}\n  });\n",
    ],
    [
      "METHOD body",
      "  class Host {\n    make() {\n      class C extends notAConstructor() {}\n      return C;\n    }\n  }\n",
    ],
    [
      "GETTER body",
      "  class Host {\n    get made() {\n      class C extends notAConstructor() {}\n      return C;\n    }\n  }\n",
    ],
    [
      "nested class EXPRESSION inside a function",
      "  function configure() {\n    return class Outer {\n      static make() {\n        return class extends notAConstructor() {};\n      }\n    };\n  }\n",
    ],
  ];

  for (const [label, body] of deferred) {
    it(`KEEPS authority for an invalid-heritage class inside a ${label}`, () => {
      expect(defaultExportName(canonical(body))).toBe("second");
    });
  }
});

describe("RWF-022: callee resolution is RWF-016's, reused unchanged", () => {
  it("resolves an own-BLOCK shadow to the harmless inner binding", () => {
    expect(
      defaultExportName(
        `${TWO}${BASE}${NOT_A_CTOR}if (FLAG) {\n  module.exports = first;\n  {\n    function notAConstructor() {\n      return Base;\n    }\n    class C extends notAConstructor() {}\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("KEEPS authority for a callee REASSIGNED after declaration -- no stale return-value summary", () => {
    // RWF-013/013b's refusal, reused verbatim.
    expect(
      defaultExportName(
        `${TWO}${BASE}${NOT_A_CTOR}notAConstructor = () => Base;\nif (FLAG) {\n  module.exports = first;\n  class C extends notAConstructor() {}\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("KEEPS authority for a callee reassigned to ANOTHER invalid factory -- the refusal is on identity, not outcome", () => {
    expect(
      defaultExportName(
        `${TWO}${NOT_A_CTOR}notAConstructor = () => 2;\nif (FLAG) {\n  module.exports = first;\n  class C extends notAConstructor() {}\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("KEEPS authority for an ALIASED callee -- no alias resolution is added here", () => {
    expect(
      defaultExportName(
        canonical(
          "  const alias = notAConstructor;\n  class C extends alias() {}\n",
        ),
      ),
    ).toBe("second");
  });

  it("KEEPS authority for a MEMBER-call heritage", () => {
    expect(
      defaultExportName(canonical("  class C extends obj.make() {}\n")),
    ).toBe("second");
  });

  it("KEEPS authority for a NEW-expression heritage", () => {
    expect(
      defaultExportName(canonical("  class C extends new Base() {}\n")),
    ).toBe("second");
  });

  it("KEEPS authority for a `let`-bound factory -- only `const` is a supported candidate shape", () => {
    expect(
      defaultExportName(
        reproducer("let make = () => 1;\n", "  class C extends make() {}\n"),
      ),
    ).toBe("second");
  });

  it("KEEPS authority for a factory declared inside a BLOCK rather than at module top level", () => {
    expect(
      defaultExportName(
        reproducer(
          "",
          "  {\n    const make = () => 1;\n    class C extends make() {}\n  }\n",
        ),
      ),
    ).toBe("second");
  });

  it("KEEPS authority for a CLASS-NAME shadow -- `class make extends make()` has its own TDZ semantics", () => {
    expect(
      defaultExportName(
        reproducer(
          "function make() {\n  return 1;\n}\n",
          "  class make extends make() {}\n",
        ),
      ),
    ).toBe("second");
  });
});

describe("RWF-022: nested heritage expressions stay at RWF-017's arbitrary-expression boundary", () => {
  const unmodeled: ReadonlyArray<readonly [string, string]> = [
    ["comma sequence", "  class C extends (notAConstructor(), Base) {}\n"],
    ["logical LHS", "  class C extends (notAConstructor() || Base) {}\n"],
    ["logical RHS", "  class C extends (FLAG && notAConstructor()) {}\n"],
    ["conditional", "  class C extends (FLAG ? notAConstructor() : Base) {}\n"],
    ["IIFE returning 1", "  class C extends (() => 1)() {}\n"],
    ["chained call", "  class C extends notAConstructor()() {}\n"],
  ];

  for (const [label, body] of unmodeled) {
    it(`KEEPS authority for a ${label} heritage expression (deliberately unmodeled)`, () => {
      expect(defaultExportName(reproducer(`${BASE}${NOT_A_CTOR}`, body))).toBe(
        "second",
      );
    });
  }
});

describe("RWF-022: every export surface loses authority alike", () => {
  it("withdraws a later PROPERTY export", () => {
    expect(
      namedExportName(
        `${TWO}${NOT_A_CTOR}if (FLAG) {\n  exports.foo = first;\n  class C extends notAConstructor() {}\n}\nexports.foo = second;\n`,
        "foo",
      ),
    ).toBeUndefined();
  });

  it("withdraws a later OBJECT-LITERAL export", () => {
    expect(
      namedExportName(
        `${TWO}${NOT_A_CTOR}if (FLAG) {\n  module.exports = { foo: first };\n  class C extends notAConstructor() {}\n}\nmodule.exports = { foo: second };\n`,
        "foo",
      ),
    ).toBeUndefined();
  });

  it("withdraws a later CLASS target", () => {
    expect(
      defaultExportName(
        `class DangerousClass {}\nclass SafeClass {}\n${NOT_A_CTOR}if (FLAG) {\n  module.exports = DangerousClass;\n  class C extends notAConstructor() {}\n}\nmodule.exports = SafeClass;\n`,
      ),
    ).toBeUndefined();
  });

  it("withdraws a later REQUIRE re-export", () => {
    expect(
      defaultReExportSpecifier(
        `${NOT_A_CTOR}if (FLAG) {\n  module.exports = require("nested-vulnerable");\n  class C extends notAConstructor() {}\n}\nmodule.exports = require("safe-twin");\n`,
      ),
    ).toBeUndefined();
  });

  it("KEEPS a require re-export when the heritage value is VALID", () => {
    expect(
      defaultReExportSpecifier(
        `${MAKE_BASE}if (FLAG) {\n  module.exports = require("nested-vulnerable");\n  class C extends makeBase() {}\n}\nmodule.exports = require("safe-twin");\n`,
      ),
    ).toBe("safe-twin");
  });
});

describe("RWF-022: interaction with the RWF-018/019/020 rules over one class", () => {
  it("refuses on the HERITAGE VALUE alone, even when every element is harmless", () => {
    expect(
      defaultExportName(
        canonical(
          "  class C extends notAConstructor() {\n    [key()] = 1;\n    static x = other();\n  }\n",
        ),
      ),
    ).toBeUndefined();
  });

  it("still refuses via RWF-019 when the heritage VALUE is valid but a computed KEY throws", () => {
    expect(
      defaultExportName(
        reproducer(
          `${MAKE_BASE}function bail() {\n  throw new Error("boom");\n}\n`,
          "  class C extends makeBase() {\n    [bail()] = 1;\n  }\n",
        ),
      ),
    ).toBeUndefined();
  });

  it("still refuses via RWF-018 when the heritage VALUE is valid but a STATIC FIELD throws", () => {
    expect(
      defaultExportName(
        reproducer(
          `${MAKE_BASE}function bail() {\n  throw new Error("boom");\n}\n`,
          "  class C extends makeBase() {\n    static x = bail();\n  }\n",
        ),
      ),
    ).toBeUndefined();
  });

  it("KEEPS authority when heritage value, key and static field are ALL harmless", () => {
    expect(
      defaultExportName(
        reproducer(
          `${MAKE_BASE}function other() {}\nfunction later() {}\n`,
          "  class C extends makeBase() {\n    [later()] = 1;\n    static x = other();\n  }\n",
        ),
      ),
    ).toBe("second");
  });

  it("withdraws for a class nested in an INSTANCE FIELD -- a known traversal over-approximation", () => {
    // At runtime an instance-field initializer is DEFERRED to construction,
    // so the inner class's heritage does not run at module time. The walk in
    // `mayEndModuleEvaluation` descends into class element initializers and
    // does not model that deferral, so authority is withdrawn here even
    // though the later export really is reached.
    //
    // The over-approximation is inherited from RWF-019/020's NESTED-CLASS
    // walk, which already answers the computed-key and throwing-heritage
    // spellings of this same shape the same way on `main` today. It is NOT
    // inherited from RWF-018's instance-field rule: a bare
    // `class Outer { f = bail(); }` is deliberately KEPT, because an
    // instance-field VALUE is not module-time execution. RWF-022 reaches the
    // existing nested-class walk with one more predicate; it does not widen
    // the walk.
    //
    // What this movement costs, stated precisely rather than as "toward
    // UNKNOWN": withdrawing authority here can leave the module's export
    // ambiguous (UNKNOWN) or, once RWF-021's root widening roots both
    // published values, can surface a path and report AFFECTED. Both are
    // precision costs. What it never does is manufacture a negative proof --
    // no branch-attributable false NOT_AFFECTED is created, which is the
    // invariant that actually matters here.
    expect(
      defaultExportName(
        canonical(
          "  class Outer {\n    field = class Inner extends notAConstructor() {};\n  }\n",
        ),
      ),
    ).toBeUndefined();
  });
});

describe("RWF-022: adjacent constructs deliberately left alone", () => {
  it("does not treat a TypeScript `implements` clause as executable", () => {
    const index = indexSourceFile(
      "/pkg/index.ts",
      `${TWO}${NOT_A_CTOR}interface Shape {}\nif (FLAG) {\n  module.exports = first;\n  class C implements Shape {}\n}\nmodule.exports = second;\n`,
    );
    const model = buildModuleModel(index);
    expect(mapExportsToFunctions(index, model).get("default")?.name).toBe(
      "second",
    );
  });

  it("does not treat an INTERFACE's extends clause as executable", () => {
    const index = indexSourceFile(
      "/pkg/index.ts",
      `${TWO}${NOT_A_CTOR}interface A {}\ninterface B extends A {}\nmodule.exports = second;\n`,
    );
    const model = buildModuleModel(index);
    expect(mapExportsToFunctions(index, model).get("default")?.name).toBe(
      "second",
    );
  });

  it("keeps authority for an OBJECT LITERAL's computed key whose call RETURNS normally -- there is no invalid-property-key analogue to this rule", () => {
    // RWF-022 exists because ClassDefinitionEvaluation validates a
    // heritage VALUE against `IsConstructor`, so a call that returns
    // normally can still abort the class. ToPropertyKey, which converts an
    // object literal's computed key, has no comparable failure mode for an
    // ordinary returned value like `1` -- it always succeeds. RWF-024's own
    // rule (isDefinitelyAbruptComputedObjectLiteralKey) asks only whether
    // the KEY CALL is abrupt, exactly as this file's own RWF-016 lineage
    // does, and `notAConstructor()` completes normally, so neither rule
    // fires here.
    expect(
      defaultExportName(
        canonical("  const x = {\n    [notAConstructor()]: 1,\n  };\n"),
      ),
    ).toBe("second");
  });

  it("does not make a non-heritage CALL abrupt just because its value would be invalid", () => {
    expect(
      defaultExportName(canonical("  const x = notAConstructor();\n")),
    ).toBe("second");
  });
});
