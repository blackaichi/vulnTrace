import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-024: RWF-016 proved that a resolvable local call whose callee can
 * only ever throw ends module evaluation exactly as a literal `throw`
 * would; RWF-017 proved the call's syntactic POSITION does not change that;
 * RWF-018/019/020/022 carried it into a class's static field initializer,
 * any class element's computed key, its `extends` heritage expression and
 * an invalid heritage VALUE. All five are about a CLASS. An OBJECT
 * LITERAL's own computed property name is evaluated by a different
 * ECMAScript abstract operation entirely — constructing an object, not
 * defining a class — but it runs at exactly the same time relative to the
 * surrounding statement: immediately, while the literal is evaluated.
 *
 * ```js
 * function dangerousOp() { ... }
 * function bail() { throw new Error("boom"); }
 *
 * if (flag) {
 *   module.exports = dangerousOp;
 *   const o = { [bail()]: 1 };   // throws while the object literal is built
 * }
 * module.exports = safeOp;       // syntactically unconditional -- not always run
 * ```
 *
 * RWF-019's own test suite already recorded, as a documented boundary, that
 * an object literal's computed key was deliberately excluded from its
 * class-element rule (see
 * module-model.computed-class-key-throwing-call-export-authority.test.ts's
 * "the KEY is definition-time..." block, and FINDINGS.md's RWF-019 entry).
 * This file is that boundary's own fix: a SEPARATE, narrow predicate,
 * {@link isDefinitelyAbruptComputedObjectLiteralKey}, structurally
 * distinguished from RWF-019's by checking the element's PARENT is an
 * `ObjectLiteralExpression` rather than a class.
 *
 * Everything about CALLEE identity and callee-body proof is RWF-016's,
 * unchanged and deliberately not re-derived here (`resolveExactLocalCallable`,
 * `cannotCompleteNormally`); this file's cases are about the CALL SITE being
 * an object literal's computed key.
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

/** The canonical reproducer, parameterised over the statement(s) after the first export. */
function reproducer(body: string): string {
  return `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n${body}}\nmodule.exports = second;\n`;
}

describe("RWF-024: an object literal's computed KEY that throws invalidates later export authority, for EVERY element form", () => {
  const forms: ReadonlyArray<readonly [string, string]> = [
    ["PropertyAssignment", "  const o = {\n    [bail()]: 1,\n  };\n"],
    ["MethodDeclaration", "  const o = {\n    [bail()]() {},\n  };\n"],
    ["GetAccessor", "  const o = {\n    get [bail()]() {},\n  };\n"],
    ["SetAccessor", "  const o = {\n    set [bail()](v) {},\n  };\n"],
    [
      "async MethodDeclaration",
      "  const o = {\n    async [bail()]() {},\n  };\n",
    ],
    [
      "generator MethodDeclaration",
      "  const o = {\n    *[bail()]() {},\n  };\n",
    ],
  ];

  for (const [label, body] of forms) {
    it(`refuses the final write for a ${label}`, () => {
      expect(defaultExportName(reproducer(body))).toBeUndefined();
    });
  }

  it("refuses a final write preceded by an UNCONDITIONAL computed-key object literal", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const o = {\n  [bail()]: 1,\n};\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses a final write bypassable by a CONDITIONAL computed-key object literal", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  const o = {\n    [bail()]: 1,\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority when the computed-key object literal is the LAST thing in the file (nothing below it to invalidate)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}module.exports = second;\nconst o = {\n  [bail()]: 1,\n};\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-024: key-before-value ordering and source-order cutoff", () => {
  it("refuses when the abrupt key precedes its OWN property's value -- the key throws before the value is ever evaluated", () => {
    // `[bail()]: dangerousValue()` -- if the analyzer mistakenly modeled
    // the VALUE instead of the KEY it would still refuse here (dangerousValue
    // is not this rule's concern either way), but the point pinned is that
    // the KEY ALONE already decides it.
    expect(
      defaultExportName(
        reproducer("  const o = {\n    [bail()]: other(),\n  };\n"),
      ),
    ).toBeUndefined();
  });

  it("refuses when an EARLIER ordinary property exists -- it still runs, but does not save the later abrupt key", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}if (FLAG) {\n  module.exports = first;\n  const o = {\n    before: other(),\n    [bail()]: 1,\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when a LATER ordinary property exists after the abrupt key -- it is never reached", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}if (FLAG) {\n  module.exports = first;\n  const o = {\n    [bail()]: 1,\n    after: later(),\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the abrupt computed key is FIRST among several computed keys", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}if (FLAG) {\n  module.exports = first;\n  const o = {\n    [bail()]: 1,\n    [other()]: 2,\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the abrupt computed key is in the MIDDLE of several computed keys", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}if (FLAG) {\n  module.exports = first;\n  const o = {\n    [other()]: 1,\n    [bail()]: 2,\n    [later()]: 3,\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses when the abrupt computed key is LAST among several computed keys", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}if (FLAG) {\n  module.exports = first;\n  const o = {\n    [other()]: 1,\n    [bail()]: 2,\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority when NO computed key is a proven-abrupt call", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}if (FLAG) {\n  module.exports = first;\n  const o = {\n    [other()]: 1,\n    [later()]: 2,\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-024: the KEY is object-construction time even where the VALUE or BODY is deferred", () => {
  // RWF-026 CLOSED this. A property VALUE is evaluated while the literal
  // is constructed, exactly as its computed key is, so real Node never
  // reaches the later write. RWF-024's own KEY rule is untouched -- the
  // value is now covered by the separate expression-position relation.
  it("refuses authority for a non-computed property VALUE that calls bail (RWF-026)", () => {
    expect(
      defaultExportName(reproducer("  const o = {\n    x: bail(),\n  };\n")),
    ).toBeUndefined();
  });

  it("keeps authority for a non-computed METHOD BODY that calls bail -- a body runs only when called", () => {
    expect(
      defaultExportName(
        reproducer("  const o = {\n    m() {\n      bail();\n    },\n  };\n"),
      ),
    ).toBe("second");
  });

  it("keeps authority for a non-computed GETTER BODY that calls bail", () => {
    expect(
      defaultExportName(
        reproducer(
          "  const o = {\n    get x() {\n      bail();\n    },\n  };\n",
        ),
      ),
    ).toBe("second");
  });

  it("keeps authority for a non-computed SETTER BODY that calls bail", () => {
    expect(
      defaultExportName(
        reproducer(
          "  const o = {\n    set x(v) {\n      bail();\n    },\n  };\n",
        ),
      ),
    ).toBe("second");
  });

  it("refuses for a computed key whose METHOD BODY also calls bail -- the key alone already decides it", () => {
    expect(
      defaultExportName(
        reproducer(
          "  const o = {\n    [bail()]() {\n      bail();\n    },\n  };\n",
        ),
      ),
    ).toBeUndefined();
  });

  it("keeps authority for a method whose NAME merely spells `bail` -- an ordinary identifier name is not a computed key", () => {
    expect(
      defaultExportName(reproducer("  const o = {\n    bail() {},\n  };\n")),
    ).toBe("second");
  });

  it("keeps authority for a STRING-LITERAL property name that merely contains bracket text", () => {
    // Detection is a `ts.ComputedPropertyName` node check, never a text
    // test: `"[bail()]"` is a string key, and nothing is evaluated.
    expect(
      defaultExportName(
        reproducer('  const o = {\n    "[bail()]": 1,\n  };\n'),
      ),
    ).toBe("second");
  });

  it("keeps authority for a numeric property name", () => {
    expect(
      defaultExportName(reproducer("  const o = {\n    0: 1,\n  };\n")),
    ).toBe("second");
  });

  it("keeps authority for SHORTHAND property syntax -- never a computed key", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  const bail2 = 1;\n  const o = { bail2 };\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a computed key that is NOT a call", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const KEY = "k";\nif (FLAG) {\n  module.exports = first;\n  const o = {\n    [KEY]: 1,\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority for a CLASS element's identically-kinded computed key -- not this rule's shape (RWF-019's own rule handles it, and still does)", () => {
    expect(
      defaultExportName(reproducer("  class C {\n    [bail()] = 1;\n  }\n")),
    ).toBeUndefined();
  });
});

describe("RWF-024: property-VALUE abrupt calls, the adjacent gap RWF-026 closed", () => {
  it("refuses authority when only the VALUE of a safely-KEYED property is abrupt (RWF-026)", () => {
    // `{ [safeKey()]: bail() }` -- RWF-024's KEY predicate still never
    // fires here, and that is the point: the withdrawal now comes from
    // RWF-026's expression-position relation, which models a property
    // VALUE as a required evaluation. The two rules stay separate; the
    // gap the RWF-024 FINDINGS entry recorded is the one that closed.
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}function safeKey() {\n  return "k";\n}\nif (FLAG) {\n  module.exports = first;\n  const o = {\n    [safeKey()]: bail(),\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-024: try/catch around the object literal", () => {
  it("keeps authority: the object-literal-evaluation throw is CAUGHT", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  try {\n    const o = {\n      [bail()]: 1,\n    };\n  } catch {}\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("refuses: the catch clause RETHROWS", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  try {\n    const o = {\n      [bail()]: 1,\n    };\n  } catch (err) {\n    throw err;\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses: try/FINALLY with no catch does not stop the exception", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}if (FLAG) {\n  module.exports = first;\n  try {\n    const o = {\n      [bail()]: 1,\n    };\n  } finally {\n    other();\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });
});

describe("RWF-024: the object literal must be EVALUATED during module initialization", () => {
  it("keeps authority: the object literal sits inside a DEFERRED function body", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  function configure() {\n    const o = {\n      [bail()]: 1,\n    };\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the object literal sits inside a deferred ARROW body", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  const configure = () => ({\n    [bail()]: 1,\n  });\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the object literal sits inside a CALLBACK, not evaluated directly", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  [1, 2, 3].forEach(function () {\n    const o = {\n      [bail()]: 1,\n    };\n  });\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the object literal sits inside a METHOD's body", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  class Outer {\n    m() {\n      const o = {\n        [bail()]: 1,\n      };\n    }\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the object literal sits inside a GETTER's body", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  class Outer {\n    get x() {\n      return {\n        [bail()]: 1,\n      };\n    }\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority: the object literal sits inside a CONSTRUCTOR's body", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  class Outer {\n    constructor() {\n      const o = {\n        [bail()]: 1,\n      };\n    }\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("REFUSES an object literal with an abrupt computed key inside an INSTANCE field initializer -- the one over-approximation, matching what `main` already does for a nested class in the same position", () => {
    // At runtime the outer instance field never evaluates at
    // class-definition time, so the object literal is never evaluated.
    // VulnTrace nonetheless reports a cutoff here -- see the identical,
    // already-accepted RWF-019 over-approximation (a nested class in an
    // instance field) and the RWF-024 FINDINGS entry. Erring toward UNKNOWN
    // is the sound direction.
    expect(
      defaultExportName(
        reproducer("  class C {\n    x = {\n      [bail()]: 1,\n    };\n  }\n"),
      ),
    ).toBeUndefined();
  });
});

describe("RWF-024: nested and surrounding expression positions", () => {
  it("refuses for a NESTED object literal's computed key", () => {
    expect(
      defaultExportName(
        reproducer(
          "  const o = {\n    outer: {\n      [bail()]: 1,\n    },\n  };\n",
        ),
      ),
    ).toBeUndefined();
  });

  it("refuses for an object literal's computed key inside an ARRAY literal", () => {
    expect(
      defaultExportName(
        reproducer(
          "  const arr = [\n    {\n      [bail()]: 1,\n    },\n  ];\n",
        ),
      ),
    ).toBeUndefined();
  });

  it("refuses for an object literal's computed key passed as a CALL ARGUMENT", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}if (FLAG) {\n  module.exports = first;\n  other({\n    [bail()]: 1,\n  });\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority for a throwing IIFE returning the object literal (documented IIFE boundary, unchanged from RWF-015)", () => {
    expect(
      defaultExportName(
        reproducer("  (() => ({\n    [bail()]: 1,\n  }))();\n"),
      ),
    ).toBe("second");
  });
});

describe("RWF-024: conditional / non-call key expressions stay OUT of scope", () => {
  it('keeps authority for an unmodeled CONDITIONAL key (`flag ? bail() : "x"`) -- genuinely may not call bail', () => {
    expect(
      defaultExportName(
        reproducer('  const o = {\n    [FLAG ? bail() : "x"]: 1,\n  };\n'),
      ),
    ).toBe("second");
  });

  it("keeps authority for an unmodeled LOGICAL key (`flag && bail()`) -- genuinely may not call bail", () => {
    expect(
      defaultExportName(
        reproducer("  const o = {\n    [FLAG && bail()]: 1,\n  };\n"),
      ),
    ).toBe("second");
  });

  it("refuses for a NESTED-call key (`other(bail())`) -- the argument is required (RWF-026)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}${OTHERS}if (FLAG) {\n  module.exports = first;\n  const o = {\n    [other(bail())]: 1,\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("refuses for a TEMPLATE key -- every substitution is required (RWF-026)", () => {
    expect(
      defaultExportName(
        reproducer("  const o = {\n    [`${bail()}`]: 1,\n  };\n"),
      ),
    ).toBeUndefined();
  });

  it("refuses for a PARENTHESIZED call key -- parentheses are transparent, exactly as RWF-019's own normalization handles", () => {
    expect(
      defaultExportName(
        reproducer("  const o = {\n    [(bail())]: 1,\n  };\n"),
      ),
    ).toBeUndefined();
  });

  it("refuses for an OPTIONAL call key on an exact non-nullish local callable", () => {
    expect(
      defaultExportName(
        reproducer("  const o = {\n    [bail?.()]: 1,\n  };\n"),
      ),
    ).toBeUndefined();
  });
});

describe("RWF-024: scope, shadowing and aliasing must not be guessed at", () => {
  it("keeps authority when an inner shadowing `bail` is harmless", () => {
    expect(
      defaultExportName(
        `${TWO}function bail() {\n  throw new Error("outer");\n}\nif (FLAG) {\n  module.exports = first;\n  {\n    function bail() {\n      return "safe";\n    }\n    const o = {\n      [bail()]: 1,\n    };\n  }\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("keeps authority when the callee name is REASSIGNED elsewhere -- no stale abrupt summary", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}bail = () => "safe";\nif (FLAG) {\n  module.exports = first;\n  const o = {\n    [bail()]: 1,\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });

  it("RESOLVES a one-hop ALIASED callee (RWF-028 closed this)", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}const alias = bail;\nif (FLAG) {\n  module.exports = first;\n  const o = {\n    [alias()]: 1,\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps authority for a MEMBER callee -- not a plain identifier", () => {
    expect(
      defaultExportName(
        `${TWO}const helpers = {\n  bail() {\n    throw new Error("boom");\n  },\n};\nif (FLAG) {\n  module.exports = first;\n  const o = {\n    [helpers.bail()]: 1,\n  };\n}\nmodule.exports = second;\n`,
      ),
    ).toBe("second");
  });
});

describe("RWF-024: every export surface loses authority the same way", () => {
  it("withdraws authority from a later PROPERTY export write", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  exports.fn = first;\n  const o = {\n    [bail()]: 1,\n  };\n}\nexports.fn = second;\n`,
        "fn",
      ),
    ).toBeUndefined();
  });

  it("withdraws authority from a later OBJECT-LITERAL whole-module export", () => {
    expect(
      namedExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = { fn: first };\n  const o = {\n    [bail()]: 1,\n  };\n}\nmodule.exports = { fn: second };\n`,
        "fn",
      ),
    ).toBeUndefined();
  });

  it("withdraws authority from a later CLASS target export", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  const o = {\n    [bail()]: 1,\n  };\n}\nclass Second {}\nmodule.exports = Second;\n`,
      ),
    ).toBeUndefined();
  });

  it("withdraws authority from a later REQUIRE RE-EXPORT -- the safe twin must not replace the vulnerable one", () => {
    expect(
      defaultReExportSpecifier(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  const o = {\n    [bail()]: 1,\n  };\n}\nmodule.exports = require("safe-lib");\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps a class target attributable when the object literal's key is an ordinary name", () => {
    expect(
      defaultExportName(
        `${TWO}${BAIL_THROWS}if (FLAG) {\n  module.exports = first;\n  const o = {\n    x: 1,\n  };\n}\nclass Second {}\nmodule.exports = Second;\n`,
      ),
    ).toBe("Second");
  });
});

describe("RWF-024: RWF-015/016/017/018/019/020/022 regressions -- no parallel model, no lost coverage", () => {
  it("still refuses for a literal top-level `throw` (RWF-015)", () => {
    expect(
      defaultExportName(
        `${TWO}if (FLAG) {\n  module.exports = first;\n  throw new Error("boom");\n}\nmodule.exports = second;\n`,
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

  it("still refuses for a class element's COMPUTED KEY (RWF-019)", () => {
    expect(
      defaultExportName(reproducer("  class C {\n    [bail()] = 1;\n  }\n")),
    ).toBeUndefined();
  });

  it("still refuses for a class `extends` HERITAGE expression (RWF-020)", () => {
    expect(
      defaultExportName(reproducer("  class C extends bail() {}\n")),
    ).toBeUndefined();
  });

  it("still refuses for an invalid class heritage VALUE (RWF-022)", () => {
    expect(
      defaultExportName(
        `${TWO}function notAConstructor() {\n  return 1;\n}\n${reproducer("  class C extends notAConstructor() {}\n")}`,
      ),
    ).toBeUndefined();
  });

  it("keeps a genuinely definitely-reached final write attributable (the Family C control)", () => {
    expect(
      defaultExportName(`${TWO}${BAIL_THROWS}module.exports = second;\n`),
    ).toBe("second");
  });

  it("keeps authority for a file whose only `[` is an ordinary ARRAY literal -- the cheap statement walk stays complete once it does have to widen", () => {
    expect(defaultExportName(reproducer("  const arr = [1, 2, 3];\n"))).toBe(
      "second",
    );
  });

  it("keeps authority for a file containing NO `[` at all -- the gate stays narrow", () => {
    expect(defaultExportName(reproducer("  const x = 1;\n"))).toBe("second");
  });
});
