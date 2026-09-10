import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-027: a class's `extends` heritage can be fatal on EVERY path without
 * any single existing rule being able to say so.
 *
 * RWF-020 withdraws a later export's authority when evaluating the heritage
 * expression can only ever THROW. RWF-022 withdraws it when the heritage
 * expression definitely produces a value that is not a valid base. Both ask
 * about ONE ending. A callable can have several:
 *
 * ```js
 * function maybe(flag) {
 *   if (flag) { throw new Error("boom"); }   // ending 1: throws
 *   return 1;                                // ending 2: returns 1
 * }
 *
 * if (FLAG) {
 *   module.exports = dangerousOp;
 *   class C extends maybe(FLAG) {}
 * }
 * module.exports = safeOp;                   // NOT definitely reached
 * ```
 *
 * `maybe` never "always throws", so RWF-020 declines; it has no single
 * unconditional return, so RWF-022 declines. Yet measured under real
 * `node` v22.11.0, BOTH flag values abort the class definition — truthy
 * with `Error: boom` before ClassDefinitionEvaluation is entered, falsy
 * with `TypeError: Class extends value 1 is not a constructor or null`
 * inside it. The later `module.exports = safeOp` runs on neither path, a
 * cyclic importer keeps `dangerousOp`, and treating `safeOp` as
 * authoritative is a false NOT_AFFECTED.
 *
 * **The distinction this file exists to hold, stated once.** RWF-027 does
 * NOT prove "this call cannot complete normally" — with a falsy `FLAG` the
 * call completes perfectly normally and returns `1`. It proves the narrower
 * and different claim that "evaluating THIS CLASS HERITAGE cannot lead to a
 * normally completed class definition". The two readings come apart
 * exactly where it matters, and `the plain-call boundary` block below pins
 * that `maybe(FLAG);` as an ordinary statement is untouched.
 *
 * **The controls are the load-bearing half.** A withdrawn export costs
 * precision; a WRONGLY withdrawn export is an overreach that reports a
 * completable class definition as fatal. Every combination that keeps one
 * good path — a `null` return, a constructable return, an unclassifiable
 * return — has an explicit control here, and each analyzer answer below was
 * executed under real `node` v22.11.0 across all relevant flag values.
 */

function defaultExportName(text: string): string | undefined {
  const index = indexSourceFile("/pkg/index.js", text);
  const model = buildModuleModel(index);
  return mapExportsToFunctions(index, model).get("default")?.name;
}

const PRELUDE =
  "function dangerousOp() {}\nfunction safeOp() {}\nclass Base {}\n";

/**
 * The canonical integrated shape: an earlier dangerous export, a class
 * whose heritage is `<heritageExpression>`, and a later safe export whose
 * authority is only legitimate if the class definition can complete.
 */
function moduleWithHeritage(
  declarations: string,
  heritageExpression: string,
): string {
  return (
    PRELUDE +
    declarations +
    "if (FLAG) {\n" +
    "  module.exports = dangerousOp;\n" +
    `  class C extends ${heritageExpression} {}\n` +
    "}\n" +
    "module.exports = safeOp;\n"
  );
}

/** The later export keeps authority: the class definition CAN complete. */
function expectLaterExportKeepsAuthority(
  declarations: string,
  heritageExpression: string,
): void {
  expect(
    defaultExportName(moduleWithHeritage(declarations, heritageExpression)),
  ).toBe("safeOp");
}

/** The later export loses authority: no path completes the class definition. */
function expectLaterExportWithdrawn(
  declarations: string,
  heritageExpression: string,
): void {
  expect(
    defaultExportName(moduleWithHeritage(declarations, heritageExpression)),
  ).toBeUndefined();
}

describe("RWF-027: multi-path class-definition completion", () => {
  describe("every analyzable ending is class-definition-fatal", () => {
    it("B01 -- throws on one path and returns an invalid base on the other", () => {
      // node: FLAG truthy -> Error: boom; FLAG falsy -> TypeError: Class
      // extends value 1 is not a constructor or null. safeOp runs on neither.
      expectLaterExportWithdrawn(
        "function maybe(flag) {\n  if (flag) {\n    throw new Error('boom');\n  }\n  return 1;\n}\n",
        "maybe(FLAG)",
      );
    });

    it("B02 -- both return values are invalid bases", () => {
      // node: TypeError on both flag values ("value 1" / "value 2").
      expectLaterExportWithdrawn(
        "function twoBad(flag) {\n  if (flag) {\n    return 1;\n  }\n  return 2;\n}\n",
        "twoBad(FLAG)",
      );
    });

    it("mixes invalid value KINDS across paths", () => {
      expectLaterExportWithdrawn(
        "function f(flag) {\n  if (flag) return 1;\n  return 'x';\n}\n",
        "f(FLAG)",
      );
      expectLaterExportWithdrawn(
        "function f(flag) {\n  if (flag) return {};\n  return true;\n}\n",
        "f(FLAG)",
      );
    });

    it("returns invalid on one path and throws on the FALL-OFF path", () => {
      expectLaterExportWithdrawn(
        "function f(flag) {\n  if (flag) {\n    return 1;\n  }\n  throw new Error('boom');\n}\n",
        "f(FLAG)",
      );
    });

    it("handles an explicit else arm", () => {
      expectLaterExportWithdrawn(
        "function f(flag) {\n  if (flag) {\n    return 1;\n  } else {\n    throw new Error();\n  }\n}\n",
        "f(FLAG)",
      );
    });

    it("looks past statements that cannot leave the callable", () => {
      // A leading expression statement can only fall through or THROW, and a
      // throw is itself fatal -- so it never hides an ending.
      expectLaterExportWithdrawn(
        "function f(flag) {\n  log();\n  if (flag) return 1;\n  return 2;\n}\n",
        "f(FLAG)",
      );
    });

    it("summarises a nested if whose every leaf is fatal", () => {
      // node, all four (a, b) combinations: TypeError / Error / TypeError /
      // TypeError. No combination completes the class definition.
      expectLaterExportWithdrawn(
        "function f(a, b) {\n  if (a) {\n    if (b) return 1;\n    throw new Error();\n  }\n  return 2;\n}\n",
        "f(A, B)",
      );
    });

    it("summarises a block-bodied arrow the same way", () => {
      expectLaterExportWithdrawn(
        "const f = (flag) => {\n  if (flag) return 1;\n  return 2;\n};\n",
        "f(FLAG)",
      );
    });
  });

  describe("the implicit ending is a PATH, never an absent one", () => {
    it("counts running off the end of the body as `return undefined`", () => {
      // `if (flag) return 1;` has TWO endings: `1` and the implicit
      // `undefined`. node aborts the class definition on both. A model that
      // recorded only the written `return` would see one path where there
      // are two -- which is the failure this case exists to prevent.
      expectLaterExportWithdrawn(
        "function f(flag) {\n  if (flag) return 1;\n}\n",
        "f(FLAG)",
      );
    });

    it("counts a bare `return;` as `undefined`", () => {
      expectLaterExportWithdrawn(
        "function f(flag) {\n  if (flag) return;\n  return 1;\n}\n",
        "f(FLAG)",
      );
    });

    it("keeps the empty body fatal (RWF-022 already owned it)", () => {
      expectLaterExportWithdrawn("function f() {}\n", "f()");
    });

    it("refuses when the implicit ending is the only fatal one and a real path is valid", () => {
      // Endings: `Base` (unknown -- may be a constructor) and implicit
      // `undefined`. One unknown ending refuses the whole summary.
      expectLaterExportKeepsAuthority(
        "function f(flag) {\n  if (flag) return Base;\n}\n",
        "f(FLAG)",
      );
    });
  });

  describe("one surviving good path always refuses", () => {
    it("B04 -- throw + constructable keeps authority", () => {
      // node, FLAG falsy: the class definition COMPLETES and safeOp runs.
      expectLaterExportKeepsAuthority(
        "function maybe(flag) {\n  if (flag) {\n    throw new Error();\n  }\n  return Base;\n}\n",
        "maybe(FLAG)",
      );
    });

    it("B05 -- invalid + constructable keeps authority", () => {
      expectLaterExportKeepsAuthority(
        "function maybe(flag) {\n  if (flag) {\n    return 1;\n  }\n  return Base;\n}\n",
        "maybe(FLAG)",
      );
    });

    it("invalid + `null` keeps authority -- `class C extends null {}` is LEGAL", () => {
      // node, FLAG falsy: COMPLETED. `null` is a valid base and must never
      // be folded in with the non-constructable values.
      expectLaterExportKeepsAuthority(
        "function f(flag) {\n  if (flag) {\n    return 1;\n  }\n  return null;\n}\n",
        "f(FLAG)",
      );
    });

    it("throw + `null` keeps authority", () => {
      expectLaterExportKeepsAuthority(
        "function f(flag) {\n  if (flag) {\n    throw new Error();\n  }\n  return null;\n}\n",
        "f(FLAG)",
      );
    });

    it("keeps authority when an else arm returns `null`", () => {
      expectLaterExportKeepsAuthority(
        "function f(flag) {\n  if (flag) {\n    return null;\n  } else {\n    throw new Error();\n  }\n}\n",
        "f(FLAG)",
      );
    });

    it("keeps authority when a nested-if LEAF is constructable", () => {
      // node, (a=true, b=true): COMPLETED. The valid leaf is two levels
      // down and must not be lost by the descent.
      expectLaterExportKeepsAuthority(
        "function f(a, b) {\n  if (a) {\n    if (b) return Base;\n    throw new Error();\n  }\n  return 2;\n}\n",
        "f(A, B)",
      );
    });
  });

  describe("one UNKNOWN ending always refuses", () => {
    it("refuses unknown + invalid", () => {
      expectLaterExportKeepsAuthority(
        "function f(flag) {\n  if (flag) return 1;\n  return unknownValue();\n}\n",
        "f(FLAG)",
      );
    });

    it("refuses unknown + throw", () => {
      expectLaterExportKeepsAuthority(
        "function f(flag) {\n  if (flag) throw new Error();\n  return unknownValue();\n}\n",
        "f(FLAG)",
      );
    });

    it("refuses an identifier return, which may name a class", () => {
      expectLaterExportKeepsAuthority(
        "function f(flag) {\n  if (flag) return 1;\n  return Base;\n}\n",
        "f(FLAG)",
      );
    });
  });

  describe("unmodeled control flow poisons the whole summary", () => {
    // Each of these has endings that ARE all fatal as written. The point is
    // that the collector refuses rather than guessing at control flow it
    // does not model -- a lost path is unrecoverable, a refusal is not.
    it("refuses a loop", () => {
      expectLaterExportKeepsAuthority(
        "function f(flag) {\n  while (flag) {\n    return 1;\n  }\n  return 2;\n}\n",
        "f(FLAG)",
      );
    });

    it("refuses a switch", () => {
      expectLaterExportKeepsAuthority(
        "function f(flag) {\n  switch (flag) {\n    case 1:\n      return 1;\n  }\n  return 2;\n}\n",
        "f(FLAG)",
      );
    });

    it("refuses try/catch -- exception flow is out of scope", () => {
      expectLaterExportKeepsAuthority(
        "function f(flag) {\n  try {\n    return 1;\n  } catch (e) {\n    return 2;\n  }\n}\n",
        "f(FLAG)",
      );
    });

    it("refuses a concise-bodied arrow with a conditional", () => {
      // No conditional-EXPRESSION path model is added by RWF-027.
      expectLaterExportKeepsAuthority(
        "const f = (flag) => (flag ? 1 : 2);\n",
        "f(FLAG)",
      );
    });
  });

  describe("the function-scope boundary", () => {
    it("ignores a nested function's `return` when summarising the outer callable", () => {
      // `inner`'s `return Base` is NOT an ending of `f`. f's own endings are
      // `1` and `2`, both invalid -- node aborts on both flag values.
      expectLaterExportWithdrawn(
        "function f(flag) {\n  function inner() {\n    return Base;\n  }\n  if (flag) return 1;\n  return 2;\n}\n",
        "f(FLAG)",
      );
    });

    it("does not let a nested function's invalid return make the outer callable fatal", () => {
      expectLaterExportKeepsAuthority(
        "function f(flag) {\n  function inner() {\n    return 1;\n  }\n  if (flag) return Base;\n  return 2;\n}\n",
        "f(FLAG)",
      );
    });

    it("ignores a `return` inside a nested class method", () => {
      expectLaterExportWithdrawn(
        "function f(flag) {\n  class K {\n    m() {\n      return Base;\n    }\n  }\n  if (flag) return 1;\n  return 2;\n}\n",
        "f(FLAG)",
      );
    });
  });

  describe("the plain-call boundary -- RWF-027 is about the CLASS, not the call", () => {
    it("leaves an ordinary call statement of the same callable untouched", () => {
      // `maybe(FLAG)` returns 1 normally when FLAG is falsy. Module
      // evaluation does NOT end here, and RWF-027 must not say it does
      // merely because the same callable is fatal in a heritage position.
      const text =
        PRELUDE +
        "function maybe(flag) {\n  if (flag) throw new Error();\n  return 1;\n}\n" +
        "if (FLAG) {\n  module.exports = dangerousOp;\n  maybe(FLAG);\n}\n" +
        "module.exports = safeOp;\n";
      expect(defaultExportName(text)).toBe("safeOp");
    });

    it("leaves the same callable in an ordinary initializer untouched", () => {
      const text =
        PRELUDE +
        "function maybe(flag) {\n  if (flag) throw new Error();\n  return 1;\n}\n" +
        "if (FLAG) {\n  module.exports = dangerousOp;\n  const v = maybe(FLAG);\n}\n" +
        "module.exports = safeOp;\n";
      expect(defaultExportName(text)).toBe("safeOp");
    });
  });

  describe("class EXPRESSION heritage is treated identically", () => {
    it("withdraws for an all-fatal class-expression heritage", () => {
      // node: the class EXPRESSION aborts with the same TypeError.
      const text =
        PRELUDE +
        "function f(flag) {\n  if (flag) return 1;\n  return 2;\n}\n" +
        "if (FLAG) {\n  module.exports = dangerousOp;\n  const K = class extends f(FLAG) {};\n}\n" +
        "module.exports = safeOp;\n";
      expect(defaultExportName(text)).toBeUndefined();
    });

    it("keeps authority for a class expression with a valid heritage path", () => {
      const text =
        PRELUDE +
        "function f(flag) {\n  if (flag) return 1;\n  return Base;\n}\n" +
        "if (FLAG) {\n  module.exports = dangerousOp;\n  const K = class extends f(FLAG) {};\n}\n" +
        "module.exports = safeOp;\n";
      expect(defaultExportName(text)).toBe("safeOp");
    });
  });

  describe("a DEFERRED class definition creates no module-time cutoff", () => {
    it("keeps authority when the fatal class definition is inside an uncalled function", () => {
      const text =
        PRELUDE +
        "function f(flag) {\n  if (flag) return 1;\n  return 2;\n}\n" +
        "function make() {\n  class C extends f(FLAG) {}\n}\n" +
        "module.exports = safeOp;\n";
      expect(defaultExportName(text)).toBe("safeOp");
    });
  });

  describe("callee identity is RWF-013/016/025's, unchanged", () => {
    it("RWF-025: refuses a heritage callee that is genuinely reassigned", () => {
      // `f = () => Base;` makes the declaration summary stale. Trusting it
      // would withdraw an export whose class definition completes.
      expectLaterExportKeepsAuthority(
        "function f(flag) {\n  if (flag) throw new Error();\n  return 1;\n}\nf = () => Base;\n",
        "f(FLAG)",
      );
    });

    it("P0-E: refuses an aliased callee", () => {
      expectLaterExportKeepsAuthority(
        "function f(flag) {\n  if (flag) return 1;\n  return 2;\n}\nconst alias = f;\n",
        "alias(FLAG)",
      );
    });

    it("P0-E: refuses a member callee", () => {
      expectLaterExportKeepsAuthority(
        "function f(flag) {\n  if (flag) return 1;\n  return 2;\n}\n",
        "obj.f(FLAG)",
      );
    });

    it("refuses a callee shadowed by an inner declaration", () => {
      const text =
        PRELUDE +
        "function f(flag) {\n  if (flag) return 1;\n  return 2;\n}\n" +
        "if (FLAG) {\n  module.exports = dangerousOp;\n" +
        "  function f(flag) {\n    return Base;\n  }\n" +
        "  class C extends f(FLAG) {}\n}\n" +
        "module.exports = safeOp;\n";
      expect(defaultExportName(text)).toBe("safeOp");
    });
  });

  describe("RWF-020 and RWF-022 answer exactly as they did", () => {
    it("RWF-020: a single always-throwing heritage callee still withdraws", () => {
      expectLaterExportWithdrawn(
        "function f() {\n  throw new Error();\n}\n",
        "f()",
      );
    });

    it("RWF-020: throw + throw still withdraws, with the same answer", () => {
      expectLaterExportWithdrawn(
        "function f(flag) {\n  if (flag) {\n    throw new Error();\n  }\n  throw new Error();\n}\n",
        "f(FLAG)",
      );
    });

    it("RWF-022: a single unconditional invalid return still withdraws", () => {
      expectLaterExportWithdrawn("function f() {\n  return 1;\n}\n", "f()");
    });

    it("RWF-022: an async callee is still decided by identity, not by its body", () => {
      // Calling an `async` function returns a Promise on EVERY path, whatever
      // the body says. This stays RWF-022's answer; RWF-027 declines it.
      expectLaterExportWithdrawn(
        "async function f(flag) {\n  if (flag) return 1;\n  return Base;\n}\n",
        "f(FLAG)",
      );
    });

    it("RWF-022: a directly-written invalid heritage value still withdraws", () => {
      expectLaterExportWithdrawn("", "1");
    });

    it("RWF-022: `class C extends null {}` still keeps authority", () => {
      expectLaterExportKeepsAuthority("", "null");
    });
  });
});
