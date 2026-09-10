import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-026: RWF-016 proved that a resolvable local call whose callee can
 * only ever throw ends module evaluation exactly as a literal `throw`
 * would. RWF-017/018/019/020/022/024 then carried that same proof into six
 * more POSITIONS — a declarator's initializer, a class static field's
 * initializer, any class element's computed key, a class's `extends`
 * heritage, an invalid heritage value, an object literal's computed key.
 * Every one of those is a SHAPE TEST on the node that directly holds the
 * call.
 *
 * RWF-026 asks a question no shape test can answer:
 *
 * ```js
 * function bail() { throw new Error("boom"); }
 *
 * if (flag) {
 *   module.exports = dangerousOp;
 *   foo(bail());              // `bail` is not in ANY named slot...
 * }
 * module.exports = safeOp;    // ...and yet real Node never gets here
 * ```
 *
 * Arguments are evaluated before the callee is entered, so reaching that
 * statement necessarily invokes `bail()`. The same holds for a property
 * VALUE, an array element, a template substitution, a spread operand, a
 * member receiver, an index expression, a comma operand, a logical LEFT
 * operand, an assignment's RHS and its target's own sub-expressions, and
 * every statement HEADER — an `if` condition, a `switch` discriminant, a
 * `for` initializer and test, a `for-of`/`for-in` right-hand side, a
 * `while` condition.
 *
 * **What RWF-026 does NOT do.** It does not widen WHICH calls can be proven
 * abrupt: that stays `isDefinitelyAbruptCall`'s exact-local-callee proof
 * (`resolveExactLocalCallable` + `cannotCompleteNormally`), consumed here
 * unchanged and never re-derived. An alias, a member callee, a transitive
 * helper and `new bail()` are all still refused, and a conditionally
 * throwing callee is still not abrupt at all. RWF-026 widens only WHERE an
 * already-proven call is necessarily evaluated.
 *
 * **The soundness rule.** An expression completes normally only if every
 * operand position the language REQUIRES it to evaluate completes normally
 * first — so a required operand that cannot complete normally means the
 * enclosing expression cannot either, with no evaluation-ORDER model
 * needed to conclude it. `safe() + bail()` cannot complete whether or not
 * `safe()` ran. A position is REQUIRED only when the expression cannot
 * complete without it, which is exactly why a `&&`'s right operand, a
 * conditional's arms, a logical assignment's RHS, a loop's update
 * expression, a `do`/`while`'s condition and everything inside a function
 * are refused.
 *
 * Every case below was executed under real `node` v22.11.0 in
 * fixtures/commonjs-circular-import-expression-position-throw-ground-truth/
 * — 45 required positions that throw, 20 conditional/deferred positions
 * that complete, and 13 measured evaluation orders.
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

const TWO = "function first() {}\nfunction second() {}\n";
const BAIL_THROWS = 'function bail() {\n  throw new Error("boom");\n}\n';
/** The supporting cast every case draws on; none of it is abrupt. */
const HELPERS =
  "function safe() {\n  return 1;\n}\n" +
  "function before() {\n  return 1;\n}\n" +
  "function after() {\n  return 1;\n}\n" +
  'function safeKey() {\n  return "k";\n}\n' +
  "function foo(a, b, c) {\n  return 1;\n}\n" +
  "function tag() {\n  return 1;\n}\n" +
  "function Holder(a) {}\n" +
  "const obj = {};\n" +
  "let z = 1;\n";

/**
 * The canonical reproducer: a dangerous export published first inside a
 * conditional, the candidate statement, then a syntactically unconditional
 * later write that real Node cannot reach.
 */
function reproducer(body: string): string {
  return `${TWO}${BAIL_THROWS}${HELPERS}if (FLAG) {\n  module.exports = first;\n  ${body}\n}\nmodule.exports = second;\n`;
}

/** The same, without the conditional wrapper — an UNCONDITIONAL cutoff. */
function unconditional(body: string): string {
  return `${TWO}${BAIL_THROWS}${HELPERS}${body}\nmodule.exports = second;\n`;
}

// ---------------------------------------------------------------------
// REQUIRED positions -- authority must be WITHDRAWN.
// ---------------------------------------------------------------------

/**
 * Every expression position RWF-026 models, grouped by the phase that
 * introduced it. Each entry is the statement written between the two
 * export writes.
 */
const REQUIRED: ReadonlyArray<readonly [string, string]> = [
  // A1 -- object / array / value positions
  ["object property VALUE", "const x = { value: bail() };"],
  ["computed KEY (RWF-024, unregressed)", "const x = { [bail()]: safe() };"],
  ["safe computed KEY + abrupt VALUE", "const x = { [safeKey()]: bail() };"],
  ["NESTED object value", "const x = { a: { b: bail() } };"],
  ["object SPREAD operand", "const x = { ...bail() };"],
  ["array element", "const x = [bail()];"],
  ["array MIDDLE element", "const x = [safe(), bail(), after()];"],
  ["array element after a HOLE", "const x = [, bail()];"],
  ["array element before a later one", "const x = [bail(), after()];"],
  ["array SPREAD operand", "const x = [...bail()];"],

  // A2 -- call / template / spread / access positions
  ["call ARGUMENT", "foo(bail());"],
  ["MULTIPLE call arguments", "foo(before(), bail(), after());"],
  ["call SPREAD operand", "foo(...bail());"],
  ["new-expression ARGUMENT", "const x = new Holder(bail());"],
  ["template substitution", "const x = `${bail()}`;"],
  [
    "template substitution among others",
    "const x = `${before()}-${bail()}-${after()}`;",
  ],
  ["TAGGED template substitution", "const x = tag`${bail()}`;"],
  ["property access RECEIVER", "const x = bail().x;"],
  ["element access INDEX", "const x = obj[bail()];"],
  ["element access RECEIVER", "const x = bail()[safeKey()];"],
  ["optional-chain RECEIVER", "const x = bail()?.x;"],
  ["optional CALL", "bail?.();"],

  // A3 -- operator / assignment positions
  ["sequence LEFT operand", "const x = (bail(), safe());"],
  ["sequence MIDDLE operand", "const x = (safe(), bail(), after());"],
  ["logical || LEFT operand", "const x = bail() || safe();"],
  ["logical && LEFT operand", "const x = bail() && safe();"],
  ["logical ?? LEFT operand", "const x = bail() ?? safe();"],
  ["binary LEFT operand", "const x = bail() + 1;"],
  ["binary RIGHT operand", "const x = safe() + bail();"],
  ["comparison RIGHT operand", "const x = safe() === bail();"],
  ["unary operand", "const x = !bail();"],
  ["typeof operand", "const x = typeof bail();"],
  ["assignment RHS", "z = bail();"],
  ["property-export assignment RHS", "exports.q = bail();"],
  ["compound assignment RHS", "z += bail();"],
  ["assignment target INDEX", "obj[bail()] = safe();"],
  ["assignment target RECEIVER", "bail().x = safe();"],

  // A4 -- statement headers
  ["if CONDITION", "if (bail()) {\n  }"],
  ["switch DISCRIMINANT", "switch (bail()) {\n  }"],
  [
    "for INITIALIZER (declaration)",
    "for (let i = bail(); ; ) {\n    break;\n  }",
  ],
  ["for INITIALIZER (expression)", "for (bail(); ; ) {\n    break;\n  }"],
  ["for TEST", "for (; bail(); ) {\n    break;\n  }"],
  ["for-of RHS", "for (const q of bail()) {\n  }"],
  ["for-in RHS", "for (const q in bail()) {\n  }"],
  ["while CONDITION", "while (bail()) {\n    break;\n  }"],

  // Wrappers that are transparent at runtime
  ["parenthesized", "const x = (bail());"],
  ["doubly parenthesized", "const x = ((bail()));"],
  ["parenthesized inside a required operand", "foo((bail()));"],

  // Class-definition-time positions, reached once the call is NESTED
  [
    "class STATIC FIELD initializer, nested",
    "class C {\n    static f = foo(bail());\n  }",
  ],
  [
    "class STATIC BLOCK, nested",
    "class C {\n    static {\n      foo(bail());\n    }\n  }",
  ],
  ["class COMPUTED KEY, nested", "class C {\n    [foo(bail())] = 1;\n  }"],
  ["class HERITAGE, nested", "class C extends foo(bail()) {}"],
];

describe("RWF-026: a definitely-abrupt call in a REQUIRED expression position withdraws later export authority", () => {
  for (const [label, body] of REQUIRED) {
    it(`withdraws authority for a ${label}`, () => {
      expect(defaultExportName(reproducer(body))).toBeUndefined();
    });
  }

  for (const [label, body] of REQUIRED) {
    it(`withdraws authority for an UNCONDITIONAL ${label}`, () => {
      expect(defaultExportName(unconditional(body))).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------
// REFUSED positions -- authority must be KEPT.
// ---------------------------------------------------------------------

/**
 * The precision half. Every one of these completes under real Node with
 * `bail` either never called or its exception handled, so the later write
 * really is the module's exported value and MUST keep its authority. A
 * regression here is a false AFFECTED / a lost negative proof.
 */
const REFUSED: ReadonlyArray<readonly [string, string]> = [
  // Short-circuiting operands
  ["logical && RIGHT operand", "const x = FLAG && bail();"],
  ["logical || RIGHT operand", "const x = FLAG || bail();"],
  ["logical ?? RIGHT operand", "const x = FLAG ?? bail();"],
  ["conditional TRUE arm", "const x = FLAG ? bail() : safe();"],
  ["conditional FALSE arm", "const x = FLAG ? safe() : bail();"],
  ["both conditional arms abrupt", "const x = FLAG ? bail() : bail();"],
  ["logical assignment ||= RHS", "z ||= bail();"],
  ["logical assignment &&= RHS", "z &&= bail();"],
  ["logical assignment ??= RHS", "z ??= bail();"],

  // Loop positions that need body-completion reasoning
  ["for UPDATE expression", "for (; ; bail()) {\n    break;\n  }"],
  ["do/while CONDITION", "do {\n    break;\n  } while (bail());"],

  // Deferred contexts -- nothing here runs at module time
  ["function DECLARATION body", "function f() {\n    bail();\n  }"],
  ["arrow CONCISE body", "const f = () => bail();"],
  ["arrow body wrapping a call", "const cb = () => foo(bail());"],
  [
    "function EXPRESSION assigned to a property",
    "obj.method = function () {\n    bail();\n  };",
  ],
  ["class METHOD body", "class C {\n    m() {\n      bail();\n    }\n  }"],
  ["class GETTER body", "class C {\n    get g() {\n      bail();\n    }\n  }"],
  ["class SETTER body", "class C {\n    set s(v) {\n      bail();\n    }\n  }"],
  [
    "class CONSTRUCTOR body",
    "class C {\n    constructor() {\n      bail();\n    }\n  }",
  ],
  ["class INSTANCE field initializer", "class C {\n    f = bail();\n  }"],
  ["object METHOD body", "const o = {\n    m() {\n      bail();\n    },\n  };"],
  ["default PARAMETER", "function f(x = bail()) {}"],
  [
    "returned object in an uncalled function",
    "function f() {\n    return { x: bail() };\n  }",
  ],
  ["throwing IIFE", "(() => bail())();"],

  // Optional-chain guarded positions
  ["optional-chain guarded ARGUMENT", "const x = obj?.m(bail());"],
  ["optional-chain guarded INDEX", "const x = obj?.[bail()];"],

  // Caught exceptions
  [
    "call argument caught by try/catch",
    "try {\n    foo(bail());\n  } catch {}",
  ],
  [
    "object value caught by try/catch",
    "try {\n    const q = { value: bail() };\n  } catch {}",
  ],

  // Callee identity refusals -- RWF-028's axis, untouched here
  ["safe local callable", "foo(safe());"],
  ["ALIAS invocation", "const alias = bail;\n  alias();"],
  ["ALIAS in an argument", "const alias = bail;\n  foo(alias());"],
  ["MEMBER invocation", "obj.bail();"],
  [
    "new bail() -- constructor abruptness is not claimed",
    "const x = new bail();",
  ],
  ["destructuring assignment target", "({ [safeKey()]: z } = obj);"],
];

describe("RWF-026: a definitely-abrupt call in a CONDITIONAL or DEFERRED position keeps later export authority", () => {
  for (const [label, body] of REFUSED) {
    it(`keeps authority for a ${label}`, () => {
      expect(defaultExportName(reproducer(body))).toBe("second");
    });
  }
});

// ---------------------------------------------------------------------
// The pairs that make the boundary legible.
// ---------------------------------------------------------------------

describe("RWF-026: the required/conditional boundary, as adjacent pairs", () => {
  const pairs: ReadonlyArray<readonly [string, string, string]> = [
    [
      "logical operand",
      "const x = bail() || safe();",
      "const x = FLAG || bail();",
    ],
    [
      "logical operand (&&)",
      "const x = bail() && safe();",
      "const x = FLAG && bail();",
    ],
    [
      "assignment RHS vs LOGICAL assignment RHS",
      "z = bail();",
      "z ||= bail();",
    ],
    [
      "loop TEST vs loop UPDATE",
      "for (; bail(); ) {\n    break;\n  }",
      "for (; ; bail()) {\n    break;\n  }",
    ],
    [
      "while CONDITION vs do/while CONDITION",
      "while (bail()) {\n    break;\n  }",
      "do {\n    break;\n  } while (bail());",
    ],
    [
      "class STATIC field vs INSTANCE field",
      "class C {\n    static f = bail();\n  }",
      "class C {\n    f = bail();\n  }",
    ],
    [
      "call ARGUMENT vs an argument inside an uncalled arrow",
      "foo(bail());",
      "const cb = () => foo(bail());",
    ],
    [
      "index expression vs OPTIONAL-CHAIN guarded index",
      "const x = obj[bail()];",
      "const x = obj?.[bail()];",
    ],
  ];

  for (const [label, required, refused] of pairs) {
    it(`${label}: the required half withdraws, the conditional half does not`, () => {
      expect(defaultExportName(reproducer(required))).toBeUndefined();
      expect(defaultExportName(reproducer(refused))).toBe("second");
    });
  }
});

// ---------------------------------------------------------------------
// Ordering, mirroring the measured runtime oracle.
// ---------------------------------------------------------------------

describe("RWF-026: source-order cases, mirroring the measured runtime oracle", () => {
  it("withdraws whether the abrupt operand is FIRST, MIDDLE or LAST among call arguments", () => {
    for (const body of [
      "foo(bail(), before(), after());",
      "foo(before(), bail(), after());",
      "foo(before(), after(), bail());",
    ]) {
      expect(defaultExportName(reproducer(body))).toBeUndefined();
    }
  });

  it("withdraws whether the abrupt operand is a KEY or a VALUE, and in either order", () => {
    for (const body of [
      "const x = { [safeKey()]: before(), [bail()]: after() };",
      "const x = { [bail()]: before(), [safeKey()]: after() };",
      "const x = { a: before(), b: bail(), c: after() };",
    ]) {
      expect(defaultExportName(reproducer(body))).toBeUndefined();
    }
  });

  it("withdraws for an abrupt operand on either side of a binary operator", () => {
    for (const body of [
      "const x = bail() + safe();",
      "const x = safe() + bail();",
    ]) {
      expect(defaultExportName(reproducer(body))).toBeUndefined();
    }
  });

  it("withdraws for an abrupt operand in either half of an assignment", () => {
    for (const body of ["obj[bail()] = safe();", "obj[safeKey()] = bail();"]) {
      expect(defaultExportName(reproducer(body))).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------
// Cross-rule interactions.
// ---------------------------------------------------------------------

describe("RWF-026: interaction with RWF-025's reassignment provenance", () => {
  it("an unrelated destructuring computed key does not poison an argument-position proof", () => {
    // RWF-025's rule: `({ [unrelated()]: x } = src)` reassigns `x`, not
    // `unrelated`. The `bail` provenance is untouched, so RWF-026's
    // argument position still proves out.
    expect(
      defaultExportName(
        reproducer("({ [safeKey()]: z } = obj);\n  foo(bail());"),
      ),
    ).toBeUndefined();
  });

  it("a GENUINE reassignment of `bail` still refuses, in every new position", () => {
    for (const body of [
      "foo(bail());",
      "const x = { value: bail() };",
      "if (bail()) {\n  }",
      "const x = [bail()];",
    ]) {
      expect(
        defaultExportName(
          `${TWO}${BAIL_THROWS}${HELPERS}bail = safe;\nif (FLAG) {\n  module.exports = first;\n  ${body}\n}\nmodule.exports = second;\n`,
        ),
      ).toBe("second");
    }
  });
});

describe("RWF-026: interaction with RWF-024's computed-key rule", () => {
  it("keeps the KEY rule and adds the VALUE rule, in the same literal", () => {
    expect(
      defaultExportName(reproducer("const x = { [bail()]: safe() };")),
    ).toBeUndefined();
    expect(
      defaultExportName(reproducer("const x = { [safeKey()]: bail() };")),
    ).toBeUndefined();
    expect(
      defaultExportName(
        reproducer("const x = { [safeKey()]: before(), [bail()]: after() };"),
      ),
    ).toBeUndefined();
  });
});

describe("RWF-026: the callee-identity axis is NOT widened (RWF-027 / RWF-028 stay open)", () => {
  it("does not absorb P0-B: a CONDITIONALLY throwing callee is still not definitely abrupt", () => {
    // `maybe` returns on one path, so `cannotCompleteNormally` refuses it
    // — and RWF-026 only ever consumes that answer, never second-guesses
    // it. These reproducers stay exactly as they are.
    //
    // `class C extends maybe() {}` USED to be a fourth row here, and RWF-027
    // moved it — but NOT by changing this axis. RWF-027 proves something
    // about the CLASS DEFINITION, not about the call: `maybe()` still
    // completes normally with `1`, and the row directly below pins that the
    // very same call in an ordinary statement position is still unproven.
    // See module-model.multipath-class-definition-completion.test.ts.
    const maybe =
      "function maybe(flag) {\n  if (flag) throw new Error();\n  return 1;\n}\n";
    for (const body of [
      "foo(maybe());",
      "const x = { value: maybe() };",
      "if (maybe()) {\n  }",
      "maybe();",
      "const y = maybe();",
    ]) {
      expect(
        defaultExportName(
          `${TWO}${maybe}${HELPERS}if (FLAG) {\n  module.exports = first;\n  ${body}\n}\nmodule.exports = second;\n`,
        ),
      ).toBe("second");
    }
  });

  it("does not absorb P0-E: alias, member, transitive and `new` invocations stay unproven", () => {
    for (const body of [
      "const alias = bail;\n  foo(alias());",
      "const alias = bail;\n  const x = { value: alias() };",
      "obj.bail();",
      "const x = { value: obj.bail() };",
      "function viaHelper() {\n    bail();\n  }\n  foo(viaHelper());",
      "const x = new bail();",
      "const x = { value: new bail() };",
    ]) {
      expect(defaultExportName(reproducer(body))).toBe("second");
    }
  });
});

describe("RWF-026: every export surface loses authority alike", () => {
  it("withdraws a later PROPERTY export", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}${HELPERS}if (FLAG) {\n  exports.q = first;\n  foo(bail());\n}\nexports.q = second;\n`,
        "q",
      ),
    ).toBeUndefined();
  });

  it("withdraws a later OBJECT-LITERAL export", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}${HELPERS}if (FLAG) {\n  module.exports = { q: first };\n  foo(bail());\n}\nmodule.exports = { q: second };\n`,
        "q",
      ),
    ).toBeUndefined();
  });

  it("withdraws the write that IS the abrupt statement -- `module.exports = bail()` never completes", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${HELPERS}module.exports = first;\nmodule.exports = bail();\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-026: nothing below the cutoff, nothing above it", () => {
  it("keeps authority when the abrupt expression is the LAST thing in the file", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${HELPERS}module.exports = second;\nfoo(bail());\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a file with no definitely-abrupt callable at all", () => {
    expect(
      defaultExportName(
        `${TWO}${HELPERS}function bail() {\n  return 1;\n}\nfoo(bail());\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for an ASYNC or GENERATOR callee in a required position", () => {
    for (const decl of [
      'async function bail() {\n  throw new Error("x");\n}\n',
      'function* bail() {\n  throw new Error("x");\n}\n',
    ]) {
      expect(
        defaultExportName(
          `${TWO}${decl}${HELPERS}foo(bail());\nmodule.exports = second;\n`,
        ),
      ).toBe("second");
    }
  });
});

describe("RWF-026: deeply nested required positions still resolve", () => {
  it("withdraws for a call buried several required operands deep", () => {
    expect(
      defaultExportName(
        reproducer("const x = foo([{ a: `${safe() + bail()}` }]);"),
      ),
    ).toBeUndefined();
  });

  it("keeps authority when that same nesting ends in a CONDITIONAL position", () => {
    expect(
      defaultExportName(
        reproducer("const x = foo([{ a: `${safe() + (FLAG && bail())}` }]);"),
      ),
    ).toBe("second");
  });
});

/**
 * The self-review attack matrix, kept permanently. Each row is a way the
 * recursion could have gone wrong in the PERMISSIVE direction -- a
 * conditional branch treated as mandatory, a function body crossed, an
 * instance field or default parameter crossed, an optional-chain guard
 * ignored, a stale binding trusted after reassignment, or one of the two
 * deliberately-open callee axes absorbed. Every one of them must keep the
 * later export's authority; the "still withdraws" rows beside them prove
 * the refusal is targeted rather than blanket.
 */
describe("RWF-026: self-review attacks -- nothing conditional or deferred may withdraw authority", () => {
  const MAYBE =
    "function maybe(f) {\n    if (f) throw new Error();\n    return 1;\n  }\n  ";
  const ASYNC_GEN =
    'async function ab() {\n  throw new Error("x");\n}\nfunction* gb() {\n  throw new Error("x");\n}\n';

  const attacks: ReadonlyArray<readonly [string, string]> = [
    // A conditional branch must never be treated as mandatory, however
    // required-looking the expression nested inside it is.
    [
      "conditional arm holding an object literal",
      "const x = FLAG ? { a: bail() } : 0;",
    ],
    ["conditional arm holding an array", "const x = FLAG ? [bail()] : 0;"],
    [
      "conditional arm holding a call argument",
      "const x = FLAG ? foo(bail()) : 0;",
    ],
    ["conditional arm holding a template", "const x = FLAG ? `${bail()}` : 0;"],
    // A short-circuit operand, likewise, at any nesting depth.
    [
      "logical && RHS holding an object literal",
      "const x = FLAG && { a: bail() };",
    ],
    ["logical || RHS holding a call", "const x = FLAG || foo(bail());"],
    ["logical ?? RHS holding an array", "const x = FLAG ?? [bail()];"],
    // A function boundary is never crossed, even from a required position.
    ["arrow passed as a required ARGUMENT", "foo(() => bail());"],
    [
      "function expression passed as a required ARGUMENT",
      "foo(function () {\n    bail();\n  });",
    ],
    [
      "arrow returning an object, in a required ARGUMENT",
      "foo(() => ({ a: bail() }));",
    ],
    [
      "method body inside a required property VALUE",
      "const x = {\n    m() {\n      bail();\n    },\n  };",
    ],
    [
      "getter body inside a required property VALUE",
      "const x = {\n    get g() {\n      bail();\n    },\n  };",
    ],
    [
      "arrow nested several required operands deep",
      "const x = [{ a: () => foo(bail()) }];",
    ],
    // Instance fields and default parameters stay deferred.
    [
      "class INSTANCE field in a required position",
      "const x = class {\n    f = bail();\n  };",
    ],
    [
      "class INSTANCE field holding an object literal",
      "const x = class {\n    f = { a: bail() };\n  };",
    ],
    [
      "default parameter of a function-expression argument",
      "foo(function (a = bail()) {});",
    ],
    ["default parameter of an arrow argument", "foo((a = bail()) => a);"],
    // Loop positions that need body-completion reasoning, nested.
    [
      "loop UPDATE holding a call argument",
      "for (; ; foo(bail())) {\n    break;\n  }",
    ],
    [
      "do/while CONDITION holding a call argument",
      "do {\n    break;\n  } while (foo(bail()));",
    ],
    // A reassigned binding is never trusted, in any new position.
    ["reassigned callee in a call ARGUMENT", "bail = safe;\n  foo(bail());"],
    [
      "reassigned callee in a property VALUE",
      "bail = safe;\n  const x = { a: bail() };",
    ],
    [
      "reassigned callee in an if CONDITION",
      "bail = safe;\n  if (bail()) {\n  }",
    ],
    [
      "reassigned callee in a for-of RHS",
      "bail = safe;\n  for (const q of bail()) {\n  }",
    ],
    // Optional-chain guards.
    ["optional-chain guarded ARGUMENT, one link", "const x = obj?.m(bail());"],
    ["optional-chain guarded INDEX, one link", "const x = obj?.[bail()];"],
    [
      "optional-chain guarded ARGUMENT, several links",
      "const x = obj?.a.b(bail());",
    ],
    ["optional CALL on an unproven callee", "const x = obj.m?.(bail());"],
    // The two open callee axes stay open.
    [
      "P0-B conditional-throw callee in a required ARGUMENT",
      `${MAYBE}foo(maybe());`,
    ],
    [
      "P0-B conditional-throw callee in a property VALUE",
      `${MAYBE}const x = { a: maybe() };`,
    ],
    [
      "P0-B conditional-throw callee in an if CONDITION",
      `${MAYBE}if (maybe()) {\n  }`,
    ],
    [
      "P0-E alias callee in a required ARGUMENT",
      "const alias = bail;\n  foo(alias());",
    ],
    ["P0-E member callee in a required ARGUMENT", "foo(obj.bail());"],
    ["P0-E new-expression callee in a required ARGUMENT", "foo(new bail());"],
    [
      "P0-E transitive callee in a required ARGUMENT",
      "function via() {\n    bail();\n  }\n  foo(via());",
    ],
    // async / generator exclusions carry into every new position.
    ["ASYNC callee in a required ARGUMENT", "foo(ab());"],
    ["GENERATOR callee in a required ARGUMENT", "foo(gb());"],
    // Caught exceptions, in the new positions.
    [
      "caught call nested several required operands deep",
      "try {\n    foo([{ a: bail() }]);\n  } catch {}",
    ],
    [
      "caught for-of RHS",
      "try {\n    for (const q of bail()) {\n    }\n  } catch {}",
    ],
  ];

  for (const [label, body] of attacks) {
    it(`keeps authority for a ${label}`, () => {
      expect(
        defaultExportName(
          `${TWO}${BAIL_THROWS}${HELPERS}${ASYNC_GEN}if (FLAG) {\n  module.exports = first;\n  ${body}\n}\nmodule.exports = second;\n`,
        ),
      ).toBe("second");
    });
  }

  const stillRequired: ReadonlyArray<readonly [string, string]> = [
    ["a conditional's own CONDITION", "const x = foo(bail()) ? 1 : 0;"],
    [
      "a class STATIC field beside the instance one",
      "const x = class {\n    static f = bail();\n  };",
    ],
    [
      "a for TEST beside the update",
      "for (; foo(bail()); ) {\n    break;\n  }",
    ],
    [
      "an exactly-resolved optional call in an argument",
      "const x = foo(bail?.());",
    ],
    [
      "a call buried under an assignment target index",
      "obj[foo([bail()])] = safe();",
    ],
  ];

  for (const [label, body] of stillRequired) {
    it(`still withdraws authority for ${label}`, () => {
      expect(defaultExportName(reproducer(body))).toBeUndefined();
    });
  }
});
