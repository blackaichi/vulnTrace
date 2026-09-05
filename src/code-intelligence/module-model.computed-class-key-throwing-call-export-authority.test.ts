import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-019: RWF-016 proved that a resolvable local call whose callee can
 * only ever throw ends module evaluation exactly as a literal `throw`
 * would; RWF-017 proved the call's syntactic POSITION does not change that;
 * RWF-018 carried it into a class STATIC FIELD's initializer, which the
 * language evaluates as part of evaluating the class DEFINITION. All three
 * read the call out of a VALUE position. A class element's COMPUTED KEY is
 * a different position with the same execution time, and — decisively —
 * with a different SCOPE:
 *
 * ```js
 * function dangerousOp() { ... }
 * function bail() { throw new Error("boom"); }
 *
 * if (flag) {
 *   module.exports = dangerousOp;
 *   class C { [bail()] = 1; }   // NOT static -- and still throws at definition time
 * }
 * module.exports = safeOp;      // syntactically unconditional -- not always run
 * ```
 *
 * A computed property name is evaluated by ClassDefinitionEvaluation, in
 * declaration order, as each element is defined — the key has to exist
 * before the element can be installed on the class or its prototype. That
 * is true of every element form, because installing any of them needs a
 * property key: static field, instance field, method, getter, setter,
 * `async` method, generator method. So all six of the forms this file
 * exercises abort the class definition, `C` is never bound, and nothing
 * below the class runs.
 *
 * That is why RWF-019 is a different rule and not a widening of RWF-018,
 * and this file's central pair of cases is the proof:
 *
 * ```js
 * class C { x = bail(); }      // completes -- an instance field VALUE is per-instance
 * class C { [bail()] = 1; }    // throws    -- the same element's KEY is definition-time
 * ```
 *
 * Both are proven in one real `node` process in
 * fixtures/commonjs-circular-import-computed-class-key-throw-ground-truth/.
 *
 * Everything about CALLEE identity and callee-body proof is RWF-016's,
 * unchanged and deliberately not re-derived here
 * (`resolveExactLocalCallable`, `cannotCompleteNormally`); this file's
 * cases are about the CALL SITE being a computed key.
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

/** The canonical reproducer, parameterised over the class BODY. */
function reproducer(classBody: string): string {
  return `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n${classBody}}\nmodule.exports = second;\n`;
}

describe("RWF-019: a computed class-element KEY that throws invalidates later export authority, for EVERY element form", () => {
  // Every one of these was executed under real `node` v26 and every one
  // threw during class definition; see the ground-truth fixture's README.
  const forms: ReadonlyArray<readonly [string, string]> = [
    ["static computed FIELD", "  class C {\n    static [bail()] = 1;\n  }\n"],
    ["instance computed FIELD", "  class C {\n    [bail()] = 1;\n  }\n"],
    ["computed instance METHOD", "  class C {\n    [bail()]() {}\n  }\n"],
    ["computed static METHOD", "  class C {\n    static [bail()]() {}\n  }\n"],
    ["computed GETTER", "  class C {\n    get [bail()]() {}\n  }\n"],
    ["computed SETTER", "  class C {\n    set [bail()](v) {}\n  }\n"],
    ["computed ASYNC method", "  class C {\n    async [bail()]() {}\n  }\n"],
    ["computed GENERATOR method", "  class C {\n    *[bail()]() {}\n  }\n"],
    [
      "computed static ASYNC method",
      "  class C {\n    static async [bail()]() {}\n  }\n",
    ],
    [
      "computed static GETTER",
      "  class C {\n    static get [bail()]() {}\n  }\n",
    ],
  ];

  for (const [label, body] of forms) {
    it(`refuses the final write for a ${label}`, () => {
      expect(defaultExportName(reproducer(body))).toBeUndefined();
    });
  }

  it("refuses the final write for the CLASS EXPRESSION form -- computed keys run when the expression is evaluated", () => {
    expect(
      defaultExportName(
        reproducer("  const C = class {\n    [bail()] = 1;\n  };\n"),
      ),
    ).toBeUndefined();
  });

  it("refuses the final write for an anonymous class expression passed nowhere but evaluated", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  const C = class Named {\n    [bail()]() {}\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a final write preceded by an UNCONDITIONAL computed-key class", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}class C {\n  [bail()] = 1;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a final write bypassable by a CONDITIONAL computed-key class", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  class C {\n    [bail()] = 1;\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority when the computed-key class is the LAST thing in the file (nothing below it to invalidate)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}module.exports = second;\nclass C {\n  [bail()] = 1;\n}\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-019: the KEY is definition-time even where the VALUE or BODY is deferred -- the RWF-018 boundary held exactly", () => {
  it("keeps authority for a non-computed INSTANCE FIELD initializer -- `x = bail()` runs per-instance (RWF-018's line, unmoved)", () => {
    expect(
      defaultExportName(reproducer("  class C {\n    x = bail();\n  }\n")),
    ).toBe("second");
  });

  it("refuses for the SAME element's computed key -- `[bail()] = 1` runs at definition time", () => {
    // The pair above and below is the whole of RWF-019: identical element,
    // identical callee, two different expression POSITIONS on it, and the
    // language evaluates exactly one of them while defining the class.
    expect(
      defaultExportName(reproducer("  class C {\n    [bail()] = 1;\n  }\n")),
    ).toBeUndefined();
  });

  it("keeps authority for a non-computed METHOD BODY that calls bail -- a body runs only when called", () => {
    expect(
      defaultExportName(
        reproducer("  class C {\n    m() {\n      bail();\n    }\n  }\n"),
      ),
    ).toBe("second");
  });

  it("keeps authority for a non-computed GETTER BODY that calls bail", () => {
    expect(
      defaultExportName(
        reproducer("  class C {\n    get x() {\n      bail();\n    }\n  }\n"),
      ),
    ).toBe("second");
  });

  it("keeps authority for a non-computed SETTER BODY that calls bail", () => {
    expect(
      defaultExportName(
        reproducer("  class C {\n    set x(v) {\n      bail();\n    }\n  }\n"),
      ),
    ).toBe("second");
  });

  it("refuses for a computed key whose METHOD BODY also calls bail -- the key alone already decides it", () => {
    expect(
      defaultExportName(
        reproducer(
          "  class C {\n    [bail()]() {\n      bail();\n    }\n  }\n",
        ),
      ),
    ).toBeUndefined();
  });

  it("keeps authority for a method whose NAME merely spells `bail` -- an ordinary identifier name is not a computed key", () => {
    expect(
      defaultExportName(reproducer("  class C {\n    bail() {}\n  }\n")),
    ).toBe("second");
  });

  it("keeps authority for a STRING-LITERAL element name that merely contains bracket text", () => {
    // Detection is a `ts.ComputedPropertyName` node check, never a text
    // test: `"[bail()]"` is a string key, and nothing is evaluated.
    expect(
      defaultExportName(reproducer('  class C {\n    "[bail()]" = 1;\n  }\n')),
    ).toBe("second");
  });

  it("keeps authority for a numeric element name", () => {
    expect(
      defaultExportName(reproducer("  class C {\n    0 = 1;\n  }\n")),
    ).toBe("second");
  });

  it("keeps authority for a computed key that is NOT a call", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const KEY = "k";\nif (FLAG) {\n  module.exports = first;\n  class C {\n    [KEY] = 1;\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for an OBJECT LITERAL's computed key -- not a class element (documented boundary)", () => {
    // Evaluated at runtime just as a class's key is, but an object literal
    // is an ordinary expression: recognising it belongs to the
    // arbitrary-expression-evaluation boundary RWF-017 recorded, not to
    // class evaluation. `MethodDeclaration` is the same node KIND in both,
    // which is exactly why the predicate checks the PARENT is a class.
    expect(
      defaultExportName(reproducer("  const o = { [bail()]: 1 };\n")),
    ).toBe("second");
  });

  it("keeps authority for an OBJECT LITERAL's computed METHOD key -- same node kind, different parent", () => {
    expect(
      defaultExportName(reproducer("  const o = { [bail()]() {} };\n")),
    ).toBe("second");
  });
});

describe("RWF-019: computed keys evaluate in declaration order, so position within the class cannot matter", () => {
  it("refuses when the abrupt computed key is FIRST", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}class C {\n  [bail()] = 1;\n  [other()] = 2;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the abrupt computed key is in the MIDDLE", () => {
    // `[other()]` either completed normally (so `[bail()]` is reached and
    // throws) or was itself abrupt -- either way `[later()]` never
    // evaluates and the class definition never completes. Confirmed under
    // real `node`: only `other` and `bail` ran, `later` never did.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}class C {\n  [other()] = 1;\n  [bail()] = 2;\n  [later()] = 3;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the abrupt computed key is LAST", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}class C {\n  [other()] = 1;\n  [bail()] = 2;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the abrupt computed key follows a static BLOCK -- the two evaluate together", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}class C {\n  static {\n    other();\n  }\n  [bail()] = 1;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the abrupt computed key precedes a deferred instance field", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}class C {\n  [bail()] = 1;\n  y = later();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority when NO computed key is a proven-abrupt call", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}class C {\n  [other()] = 1;\n  [later()] = 2;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-019: transparent key shapes", () => {
  it("refuses for a PARENTHESIZED call -- parentheses do not change evaluation", () => {
    expect(
      defaultExportName(reproducer("  class C {\n    [(bail())] = 1;\n  }\n")),
    ).toBeUndefined();
  });

  it("refuses for a doubly parenthesized call", () => {
    expect(
      defaultExportName(
        reproducer("  class C {\n    [((bail()))]() {}\n  }\n"),
      ),
    ).toBeUndefined();
  });

  it("refuses for an OPTIONAL call `[bail?.()]` -- the callee this relation resolves can never be nullish", () => {
    // Confirmed under real `node`: `class C { [bail?.()] = 1; }` throws.
    // This needs no special case; see `isDefinitelyAbruptCall`'s own note.
    expect(
      defaultExportName(reproducer("  class C {\n    [bail?.()] = 1;\n  }\n")),
    ).toBeUndefined();
  });
});

describe("RWF-019: the callee body still decides, exactly as under RWF-016", () => {
  it("keeps authority: the key's callee only throws CONDITIONALLY", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  if (FLAG) throw new Error("x");\n}\nclass C {\n  [bail()] = 1;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the key's callee just RETURNS", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  return "x";\n}\nclass C {\n  [bail()] = 1;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: an ASYNC throwing callee rejects a promise rather than throwing synchronously", () => {
    expect(
      defaultExportName(
        `${TWO}async function bail() {\n  throw new Error("x");\n}\nclass C {\n  [bail()] = 1;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: a GENERATOR callee does not run its body when called", () => {
    expect(
      defaultExportName(
        `${TWO}function* bail() {\n  throw new Error("x");\n}\nclass C {\n  [bail()] = 1;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: an ASYNC callee is refused even where the ELEMENT is an async method", () => {
    // The `async` that matters is the CALLEE's, never the element's -- an
    // `async [bail()]() {}` with a synchronously-throwing `bail` really
    // does abort the class definition, and is refused here only because
    // THIS `bail` is async.
    expect(
      defaultExportName(
        `${TWO}async function bail() {\n  throw new Error("x");\n}\nclass C {\n  async [bail()]() {}\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses: a const arrow-function callee whose body always throws", () => {
    expect(
      defaultExportName(
        `${TWO}const bail = () => {\n  throw new Error("x");\n};\nclass C {\n  [bail()] = 1;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority: `new bail()` in the key is a NewExpression, not a call this relation models", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}class C {\n  [new bail()] = 1;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-019: try/catch around the class definition", () => {
  it("keeps authority: the class-evaluation throw is CAUGHT", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  class C {\n    [bail()] = 1;\n  }\n} catch (e) {\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: a caught computed-key METHOD throw", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  class C {\n    [bail()]() {}\n  }\n} catch (e) {\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses: the catch clause RETHROWS", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  class C {\n    [bail()] = 1;\n  }\n} catch (e) {\n  throw e;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses: try/FINALLY with no catch does not stop the exception", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  class C {\n    [bail()] = 1;\n  }\n} finally {\n  cleanup();\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses: the class sits in the CATCH clause, which its own try does not protect", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}try {\n  risky();\n} catch (e) {\n  class C {\n    [bail()] = 1;\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-019: the class must be EVALUATED during module initialization", () => {
  it("keeps authority: the class declaration sits inside a DEFERRED function body", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}function configure() {\n  class C {\n    [bail()] = 1;\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the class EXPRESSION sits inside a deferred arrow body", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const make = () => class {\n  [bail()] = 1;\n};\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the class sits inside a callback, not evaluated directly", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}[1, 2, 3].forEach(function () {\n  class C {\n    [bail()] = 1;\n  }\n});\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the class sits inside a METHOD's body", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}class Outer {\n  m() {\n    class C {\n      [bail()] = 1;\n    }\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the class sits inside a static METHOD's body", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}class Outer {\n  static m() {\n    class C {\n      [bail()] = 1;\n    }\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the class sits inside a computed-key METHOD's own deferred body", () => {
    // The outer element's key is an ordinary name, so nothing runs at
    // definition time; the inner class is behind a function body.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}class Outer {\n  m() {\n    return class {\n      [bail()]() {}\n    };\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("REFUSES a nested class with an abrupt computed key inside an INSTANCE field initializer -- the one over-approximation, matching what `main` already does for the static-field spelling", () => {
    // At runtime the outer instance field never evaluates at
    // class-definition time (confirmed under real `node`), so the inner
    // class is never evaluated and `second` really is reached -- this
    // cutoff is an over-approximation. It is pinned deliberately and is
    // NOT new behaviour: `main` already answers both the static-BLOCK and
    // the static-FIELD spellings of this exact shape the same way, and
    // RWF-019 declines to make it worse by giving computed keys a second,
    // different traversal model. Erring toward UNKNOWN is the sound
    // direction; see tests/validation/FINDINGS.md's RWF-019 limitations.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}class C {\n  x = class {\n    [bail()] = 1;\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-019: nested module-evaluation positions reuse RWF-015's statement reachability", () => {
  it("refuses when the class sits in a nested BLOCK", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  {\n    class C {\n      [bail()] = 1;\n    }\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the class sits in a SWITCH case", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}switch (K) {\n  case 1: {\n    class C {\n      [bail()]() {}\n    }\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the class sits in a LOOP body", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}for (const k of LIST) {\n  class C {\n    get [bail()]() {}\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-019: scope, shadowing and aliasing must not be guessed at", () => {
  it("keeps authority when the class's enclosing block declares a shadowing, harmless bail", () => {
    // Real JS lexical scoping resolves this call to the INNER `bail`,
    // which returns -- so `second` really is reached (confirmed under real
    // `node`). RWF-019 must not reach past the shadow to the outer
    // throwing declaration.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  function bail() {}\n  class C {\n    [bail()] = 1;\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("is unaffected by an unrelated same-name decoy inside a never-called sibling function", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}function configure() {\n  function bail() {}\n  const y = bail();\n}\nclass C {\n  [bail()] = 1;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority when the callee name is REASSIGNED elsewhere -- no stale abrupt summary", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  throw new Error("x");\n}\nbail = function () {};\nclass C {\n  [bail()] = 1;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for an ALIASED callee -- one hop only, exactly as RWF-016 has it", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const alias = bail;\nclass C {\n  [alias()] = 1;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a MEMBER callee -- not a plain identifier", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const obj = { bail };\nclass C {\n  [obj.bail()] = 1;\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-019: every export surface loses authority the same way", () => {
  it("withdraws authority from a later PROPERTY export write", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  exports.foo = first;\n  class C {\n    [bail()] = 1;\n  }\n}\nexports.foo = second;\n`,
        "foo",
      ),
    ).toBeUndefined();
  });

  it("withdraws authority from a later PROPERTY export write behind a computed METHOD key", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  exports.foo = first;\n  class C {\n    [bail()]() {}\n  }\n}\nexports.foo = second;\n`,
        "foo",
      ),
    ).toBeUndefined();
  });

  it("withdraws authority from a later OBJECT-LITERAL whole-module export", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = { foo: first };\n  class C {\n    [bail()] = 1;\n  }\n}\nmodule.exports = { foo: second };\n`,
        "foo",
      ),
    ).toBeUndefined();
  });

  it("withdraws authority from a later CLASS target export", () => {
    expect(
      defaultExportName(
        `class DangerousClass {}\nclass SafeClass {}\n${BAIL_THROWS}if (FLAG) {\n  module.exports = DangerousClass;\n  class C {\n    [bail()] = 1;\n  }\n}\nmodule.exports = SafeClass;\n`,
      ),
    ).toBeUndefined();
  });

  it("withdraws authority from a later REQUIRE RE-EXPORT -- the safe twin must not replace the vulnerable one", () => {
    expect(
      defaultReExportSpecifier(
        `${BAIL_THROWS}if (FLAG) {\n  module.exports = require("nested-vulnerable");\n  class C {\n    [bail()] = 1;\n  }\n}\nmodule.exports = require("safe-twin");\n`,
      ),
    ).toBeUndefined();
  });

  it("withdraws authority from a later require re-export behind a NON-STATIC computed method key", () => {
    expect(
      defaultReExportSpecifier(
        `${BAIL_THROWS}if (FLAG) {\n  module.exports = require("nested-vulnerable");\n  class C {\n    [bail()]() {}\n  }\n}\nmodule.exports = require("safe-twin");\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps a class target attributable when the element's key is an ordinary name", () => {
    expect(
      defaultExportName(
        `class DangerousClass {}\nclass SafeClass {}\n${BAIL_THROWS}if (FLAG) {\n  module.exports = DangerousClass;\n  class C {\n    x = bail();\n  }\n}\nmodule.exports = SafeClass;\n`,
      ),
    ).toBe("SafeClass");
  });
});

describe("RWF-019: RWF-015/016/017/018 regressions -- no parallel model, no lost coverage", () => {
  it("still refuses for a literal top-level `throw` (RWF-015)", () => {
    expect(
      defaultExportName(
        `${TWO}if (FLAG) {\n  module.exports = first;\n  throw new Error("x");\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("still refuses for a bare `bail();` expression statement (RWF-016)", () => {
    expect(defaultExportName(reproducer("  bail();\n"))).toBeUndefined();
  });

  it("still refuses for `const q = bail();` (RWF-017)", () => {
    expect(
      defaultExportName(reproducer("  const q = bail();\n")),
    ).toBeUndefined();
  });

  it("still refuses for a class STATIC FIELD initializer (RWF-018)", () => {
    expect(
      defaultExportName(
        reproducer("  class C {\n    static x = bail();\n  }\n"),
      ),
    ).toBeUndefined();
  });

  it("still refuses for a static BLOCK calling bail (RWF-016 inside a class)", () => {
    expect(
      defaultExportName(
        reproducer("  class C {\n    static {\n      bail();\n    }\n  }\n"),
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

  it("keeps authority for a file whose only `class` is an ordinary one with no definition-time evaluation", () => {
    // The gate widened from `static` to `class` (see
    // `mayContainClassDefinitionTimeEvaluation`), so an ordinary class now
    // pays for the full expression walk. It must still change no answer.
    expect(
      defaultExportName(
        `${TWO}class C {\n  helper() {\n    return 1;\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a file containing NO class at all -- the cheap statement walk stays complete", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const cfg = { a: 1 };\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority when the word `class` appears only in a string", () => {
    expect(
      defaultExportName(
        `${TWO}const label = "class";\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-019: key expressions the call is merely NESTED in stay OUT of scope", () => {
  // Under real `node` the first five of these DO throw during class
  // definition and the last two do NOT (the call may never happen at
  // all) -- which is exactly why guessing past the shape test is not
  // available. Recognising the first five means an evaluation-order model
  // over arbitrary expression trees, the boundary
  // `isDefinitelyAbruptCall` already draws for RWF-016/017/018. All are
  // pinned so a later change to that boundary is deliberate, and all are
  // recorded as follow-ups in tests/validation/FINDINGS.md.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["argument position", "class C {\n  [wrap(bail())] = 1;\n}"],
    ["comma expression", 'class C {\n  [(bail(), "x")] = 1;\n}'],
    ["array element", "class C {\n  [[bail()]] = 1;\n}"],
    ["object property", "class C {\n  [{ v: bail() }] = 1;\n}"],
    ["template hole", "class C {\n  [`v${bail()}`] = 1;\n}"],
    ["logical LHS", 'class C {\n  [bail() || "x"] = 1;\n}'],
    [
      "logical RHS (conditional at runtime)",
      "class C {\n  [FLAG && bail()] = 1;\n}",
    ],
    [
      "ternary branch (conditional at runtime)",
      'class C {\n  [FLAG ? bail() : "x"] = 1;\n}',
    ],
    [
      "throwing IIFE",
      'class C {\n  [(() => {\n    throw new Error("x");\n  })()] = 1;\n}',
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

  it("refuses authority for a heritage clause `class C extends bail() {}` -- the separate P0 RWF-019 recorded here, since fixed by RWF-020", () => {
    // `class C extends bail() {}` DOES throw at class-definition time
    // under real `node`. RWF-019 recorded it as a separate open P0 rather
    // than absorbing it silently, because it is a different expression
    // position: the heritage clause, evaluated BEFORE any element exists,
    // so a computed-key rule handed a `ClassElement` can never see it.
    // RWF-020 closed it with its own predicate
    // (`isDefinitelyAbruptClassHeritage`); this case stays here, with its
    // assertion flipped, as the cross-check that the two rules agree.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}class C extends bail() {}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when a heritage clause sits alongside an abrupt computed KEY -- RWF-019 does not break extends handling", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}function base() {\n  return Object;\n}\nclass C extends base() {\n  [bail()] = 1;\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority for a CLASS-NAME shadow -- unchanged from `main`, and identical for RWF-018's shape", () => {
    // `class bail { [bail()] = 1; }` throws a ReferenceError under real
    // `node` (the class binding shadows the outer function and is in TDZ),
    // so keeping `second` here is a pre-existing false attribution. It is
    // NOT computed-key specific: `class bail { static x = bail(); }`
    // behaves identically on `main` and on this branch. Fixing it means
    // changing `scopeDeclares`' lexical model, which RWF-019 is scoped not
    // to touch; recorded in tests/validation/FINDINGS.md.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  class bail {\n    [bail()] = 1;\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});
