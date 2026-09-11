import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-028 (P0-E): the permanent matrix for INVOCATION / PROVENANCE
 * soundness.
 *
 * RWF-016 proved a narrow, genuinely sound thing: a bare call to a local,
 * non-reassigned, uniquely-declared function whose own body always throws
 * ends module evaluation, so a later `module.exports = safeOp` is NOT
 * definitely reached and may not be attributed. Everything built on top
 * of it (RWF-017/018/019/020/022/024/026/027) consumes that same
 * callee-side answer.
 *
 * The P0 closure inventory found five confirmed false `NOT_AFFECTED`s in
 * which VulnTrace ALREADY had that callee-side proof and dropped it purely
 * because the INVOCATION SHAPE was not a bare identifier call. Each was
 * independently measured under real `node` v22 as: module evaluation ends,
 * the later safe export never runs, and VulnTrace nevertheless answers
 * NOT_AFFECTED with a COMPLETE Family C proof.
 *
 * ```js
 * const alias = bail; alias();                  // C07
 * function viaHelper() { bail(); } viaHelper(); // C08
 * const h = { bail }; h.bail();                 // C09
 * { const bail = () => { throw }; bail(); }     // C10
 * new bail();                                   // E01
 * ```
 *
 * The fix is deliberately a RESOLUTION widening, not an authority-gate
 * heuristic. "Unresolved callee plus a throwing callable somewhere in the
 * file" would withdraw authority from calls it knows nothing about, and
 * that is a precision catastrophe with a soundness flavour rather than a
 * soundness fix — the CRITICAL FALSE-AFFECTED CONTROL block below pins
 * that this analyzer does not do it. What RWF-028 adds is the ability to
 * name the exact function node an invocation enters, for four bounded
 * provenance shapes, each with an invalidation story:
 *
 * | shape       | invalidated by                                    |
 * |-------------|---------------------------------------------------|
 * | alias       | reassignment of either the alias or the source     |
 * | wrapper     | any surviving normal path; reassignment; recursion |
 * | object      | rebinding, ANY non-read use, spread, computed key  |
 * | shadow      | lexical scope — nearest binding wins, always       |
 *
 * The negative half of this file is the load-bearing half. Every row in
 * the REFUSED tables below is a program that really does COMPLETE
 * normally under real `node`, so proving any of them non-completing would
 * withdraw authority from an export that genuinely gets written — a false
 * AFFECTED invented by this task. See
 * fixtures/commonjs-circular-import-invocation-provenance-ground-truth/
 * for the executed, asserted runtime oracle behind both halves.
 */

function defaultExportName(text: string): string | undefined {
  const index = indexSourceFile("/pkg/index.js", text);
  const model = buildModuleModel(index);
  return mapExportsToFunctions(index, model).get("default")?.name;
}

const TWO = "function first() {}\nfunction second() {}\n";
const BAIL = 'function bail() {\n  throw new Error("boom");\n}\n';
const SAFE = 'function safeFn() {\n  return "safe";\n}\n';

/** The body under test, between a throwing-callable declaration and the later export write. */
function mod(body: string): string {
  return `${TWO}${BAIL}${SAFE}${body}\nmodule.exports = second;\n`;
}

/** The same, with NO throwing callable declared anywhere in the file. */
function modNoThrow(body: string): string {
  return `${TWO}${SAFE}${body}\nmodule.exports = second;\n`;
}

/** Authority must be WITHDRAWN — the invocation is proven non-completing. */
function expectRefused(text: string): void {
  expect(defaultExportName(text)).toBeUndefined();
}

/** Authority must be KEPT — this program completes normally under real node. */
function expectKept(text: string): void {
  expect(defaultExportName(text)).toBe("second");
}

// ---------------------------------------------------------------------
// 1. The direct control, unchanged from RWF-016.
// ---------------------------------------------------------------------

describe("RWF-028 (1): the direct exact call control", () => {
  it("withdraws authority for a bare `bail()` — RWF-016, unmoved", () => {
    expectRefused(mod("bail();"));
  });

  it("keeps authority for a bare call to a SAFE local callable", () => {
    expectKept(mod("safeFn();"));
  });
});

// ---------------------------------------------------------------------
// 2-6. C07 — one-hop const alias.
// ---------------------------------------------------------------------

describe("RWF-028 (2-6): C07, the one-hop immutable local alias", () => {
  it("(2) withdraws authority for `const alias = bail; alias()`", () => {
    expectRefused(mod("const alias = bail;\nalias();"));
  });

  it("(3) keeps authority when the alias names a SAFE callable", () => {
    // The single most important control in this block: an alias is only
    // ever as abrupt as what it aliases.
    expectKept(mod("const alias = safeFn;\nalias();"));
  });

  it("(4) keeps authority when the ALIAS is reassigned (RWF-025 facts win)", () => {
    expectKept(mod("let alias = bail;\nalias = safeFn;\nalias();"));
  });

  it("(5) keeps authority when the SOURCE binding is rebound after capture", () => {
    // Under real `node` this program DOES throw — `alias` captured the
    // original function VALUE, and rebinding `bail` afterwards cannot
    // reach it. VulnTrace refuses anyway: distinguishing "the value this
    // alias captured" from "whatever this name holds now" needs an
    // ordering model over rebinding that this task does not build, and
    // between an unsound proof and a refusal the refusal is the only
    // available answer. Recorded as a remaining limitation in
    // tests/validation/FINDINGS.md, and measured in the ground-truth
    // fixture so the gap is documented by execution rather than by claim.
    expectKept(mod("const alias = bail;\nbail = safeFn;\nalias();"));
  });

  it("(6) keeps authority for a CONDITIONAL alias initializer", () => {
    expectKept(mod("const alias = FLAG ? bail : safeFn;\nalias();"));
  });

  it("keeps authority for the alias forms outside the one-hop bound", () => {
    for (const body of [
      // two hops
      "const alias = bail;\nconst a2 = alias;\na2();",
      // not an identifier initializer
      "const alias = bail.bind(null);\nalias();",
      "const alias = obj.bail;\nalias();",
      "const alias = wrap(bail);\nalias();",
      // let/var bindings are never readable, reassigned or not
      "let alias = bail;\nalias();",
      "var alias = bail;\nalias();",
      // destructured
      "const { bail: alias } = holder;\nalias();",
    ]) {
      expectKept(mod(body));
    }
  });
});

// ---------------------------------------------------------------------
// 7-11. C08 — the bounded local wrapper.
// ---------------------------------------------------------------------

describe("RWF-028 (7-11): C08, the bounded transitive wrapper", () => {
  it("(7) withdraws authority for a one-hop wrapper that ALWAYS reaches the throw", () => {
    expectRefused(mod("function viaHelper() {\n  bail();\n}\nviaHelper();"));
  });

  it("(8) keeps authority when the wrapper has a surviving CONDITIONAL path", () => {
    expectKept(
      mod(
        "function helper(flag) {\n  if (flag) {\n    bail();\n  }\n}\nhelper(FLAG);",
      ),
    );
  });

  it("(8b) keeps authority when the wrapper has a RETURN path after the throw", () => {
    expectKept(
      mod(
        "function helper(flag) {\n  if (flag) {\n    bail();\n  }\n  return 1;\n}\nhelper(FLAG);",
      ),
    );
  });

  it("(9) keeps authority when the wrapper CATCHES the abruptness", () => {
    expectKept(
      mod(
        "function helper() {\n  try {\n    bail();\n  } catch {}\n}\nhelper();",
      ),
    );
  });

  it("(9b) keeps authority when the wrapper only DEFERS the call", () => {
    expectKept(
      mod("function helper() {\n  return () => bail();\n}\nhelper();"),
    );
  });

  it("(10) keeps authority when the wrapper binding is reassigned", () => {
    expectKept(
      mod("function helper() {\n  bail();\n}\nhelper = safeFn;\nhelper();"),
    );
  });

  it("(11) refuses RECURSION rather than summarizing it", () => {
    // `helper()` never completes, but it never THROWS either — it
    // exhausts the stack, which is nontermination reasoning this
    // analyzer deliberately does not do.
    expectKept(modNoThrow("function helper() {\n  helper();\n}\nhelper();"));
    // Mutual recursion, same answer.
    expectKept(
      modNoThrow(
        "function a1() {\n  b1();\n}\nfunction b1() {\n  a1();\n}\na1();",
      ),
    );
    // Recursion that also has a throwing path is still not ALL-paths abrupt.
    expectKept(
      mod(
        "function helper(n) {\n  if (n) {\n    helper(n - 1);\n  }\n}\nhelper(3);",
      ),
    );
  });

  it("supports exactly TWO wrapper hops, and refuses the third (the documented bound)", () => {
    const one = "function w1() {\n  bail();\n}\n";
    const two = `${one}function w2() {\n  w1();\n}\n`;
    const three = `${two}function w3() {\n  w2();\n}\n`;
    expectRefused(mod(`${one}w1();`));
    expectRefused(mod(`${two}w2();`));
    expectKept(mod(`${three}w3();`));
  });
});

// ---------------------------------------------------------------------
// 12-19. C09 — the exact object-literal member.
// ---------------------------------------------------------------------

describe("RWF-028 (12-19): C09, the exact local object-literal member", () => {
  it("(12) withdraws authority for an exact SHORTHAND member call", () => {
    expectRefused(mod("const h = { bail };\nh.bail();"));
  });

  it("(13) withdraws authority for an EXPLICIT property alias (name need not match)", () => {
    expectRefused(mod("const h = { run: bail };\nh.run();"));
  });

  it("(13b) withdraws authority for an inline function-expression property", () => {
    expectRefused(
      modNoThrow(
        'const h = {\n  run: function () {\n    throw new Error("boom");\n  },\n};\nh.run();',
      ),
    );
  });

  it("(14) keeps authority for a SAFE member", () => {
    expectKept(mod("const h = { safeFn };\nh.safeFn();"));
  });

  it("(15) keeps authority when the object BINDING is reassigned", () => {
    expectKept(mod("let h = { bail };\nh = { bail: safeFn };\nh.bail();"));
  });

  it("(16) keeps authority when the PROPERTY is overwritten", () => {
    expectKept(mod("const h = { bail };\nh.bail = safeFn;\nh.bail();"));
  });

  it("(17) keeps authority when a DUPLICATE key makes the last value safe", () => {
    expectKept(mod("const h = { bail, bail: safeFn };\nh.bail();"));
  });

  it("(18) withdraws authority when the duplicate key makes the last value THROWING", () => {
    // Source order is the language's own rule, and it decides both ways.
    expectRefused(mod("const h = { bail: safeFn, bail };\nh.bail();"));
  });

  it("(19) refuses a DYNAMIC / computed member outright", () => {
    for (const body of [
      "const h = { bail };\nh[key]();",
      'const h = { bail };\nh["bail"]();',
      "const h = { bail };\nh?.bail?.();",
    ]) {
      expectKept(mod(body));
    }
  });

  it("refuses a literal whose own text does not determine its properties", () => {
    for (const body of [
      // a spread can contribute or overwrite `bail`
      "const h = { ...other, bail };\nh.bail();",
      "const h = { bail, ...other };\nh.bail();",
      // a computed key can name `bail` at runtime
      "const h = { [k]: safeFn, bail };\nh.bail();",
    ]) {
      expectKept(mod(body));
    }
  });

  it("refuses a member on an object binding that is not CONFINED", () => {
    // Each of these really can complete normally: something other than a
    // plain `h.x` read holds the object and may rewrite the property.
    for (const body of [
      "const h = { bail };\nmutate(h);\nh.bail();",
      "const h = { bail };\nfunction patch() {\n  h.bail = safeFn;\n}\npatch();\nh.bail();",
      "const h = { bail };\nconst g = h;\ng.bail = safeFn;\nh.bail();",
      "const h = { bail };\nmodule.exports.h = h;\nh.bail();",
      "const h = { bail };\ndelete h.bail;\nh.bail();",
    ]) {
      expectKept(mod(body));
    }
  });

  it("refuses non-DATA properties — a method, getter or setter", () => {
    // An object METHOD is a node shape this file's callable machinery
    // does not take, and an accessor RUNS CODE on property read. Both
    // refuse rather than being read through.
    expectKept(
      modNoThrow(
        'const h = {\n  bail() {\n    throw new Error("boom");\n  },\n};\nh.bail();',
      ),
    );
    expectKept(
      mod(
        "const h = {\n  get bail() {\n    return safeFn;\n  },\n};\nh.bail();",
      ),
    );
  });

  it("refuses a member whose receiver is not a local const object literal", () => {
    for (const body of [
      "obj.bail();",
      "const h = makeHolder();\nh.bail();",
      "const h = { inner: { bail } };\nh.inner.bail();",
    ]) {
      expectKept(mod(body));
    }
  });
});

// ---------------------------------------------------------------------
// 20-23. C10 — lexical binding provenance and shadowing.
// ---------------------------------------------------------------------

describe("RWF-028 (20-23): C10, lexical binding provenance", () => {
  const OUTER_SAFE = 'function bail() {\n  return "safe";\n}\n';
  const INNER_THROW =
    '  const bail = () => {\n    throw new Error("boom");\n  };\n';
  const INNER_SAFE = '  const bail = () => "safe";\n';

  it("(20) withdraws authority for a THROWING inner block shadow", () => {
    expectRefused(
      `${TWO}${OUTER_SAFE}{\n${INNER_THROW}  bail();\n}\nmodule.exports = second;\n`,
    );
  });

  it("(21) keeps authority for a SAFE inner block shadow over a THROWING outer", () => {
    // The critical false-AFFECTED control of this block. Resolving this
    // call to the outer, throwing `bail` would be a verdict invented out
    // of a name collision.
    expectKept(
      `${TWO}${BAIL}{\n${INNER_SAFE}  bail();\n}\nmodule.exports = second;\n`,
    );
  });

  it("(22) resolves through NESTED block scopes, nearest binding first", () => {
    // Throwing at depth 2 under a safe outer: proven.
    expectRefused(
      `${TWO}${OUTER_SAFE}{\n  {\n  ${INNER_THROW}    bail();\n  }\n}\nmodule.exports = second;\n`,
    );
    // Safe at depth 2 under a throwing outer AND a throwing depth-1: the
    // nearest binding still wins.
    expectKept(
      `${TWO}${BAIL}{\n${INNER_THROW}  {\n  ${INNER_SAFE}    bail();\n  }\n}\nmodule.exports = second;\n`,
    );
  });

  it("(23) keeps authority when the block binding is reassigned", () => {
    expectKept(
      `${TWO}${BAIL}{\n  let b = bail;\n  b = safeFn;\n  b();\n}\n${SAFE}module.exports = second;\n`,
    );
  });

  it("refuses a shadow this relation cannot read a body out of", () => {
    for (const body of [
      // catch parameter
      "try {\n  noop();\n} catch (bail) {\n  bail();\n}",
      // loop binding
      "for (const bail of list) {\n  bail();\n}",
      // let/var block binding
      "{\n  let bail = () => {\n    throw new Error();\n  };\n  bail();\n}",
      // class declaration
      "{\n  class bail {}\n  bail();\n}",
    ]) {
      expectKept(mod(body));
    }
  });
});

// ---------------------------------------------------------------------
// 24-27. E01 — the new expression.
// ---------------------------------------------------------------------

describe("RWF-028 (24-27): E01, construction of an exact local callable", () => {
  it("(24) withdraws authority for `new bail()` on an exact throwing function", () => {
    expectRefused(mod("new bail();"));
  });

  it("(25) keeps authority for `new C()` on a normal constructor", () => {
    expectKept(modNoThrow("function C() {}\nnew C();"));
  });

  it("(26) keeps authority when the constructor binding is reassigned", () => {
    expectKept(mod("bail = function Safe() {};\nnew bail();"));
  });

  it("(27) withdraws authority for `new` through the alias and member forms", () => {
    expectRefused(mod("const alias = bail;\nnew alias();"));
    expectRefused(mod("const h = { bail };\nnew h.bail();"));
  });

  it("refuses `new` on a NON-CONSTRUCTABLE callable, whatever its body says", () => {
    // All three of these DO end module evaluation under real node — with
    // `TypeError: X is not a constructor`, thrown BEFORE the body runs.
    // That is a proof about constructability, not about the body this
    // relation read, so it is deliberately not claimed here. Refusing
    // costs precision; claiming it would mean reporting a proof that was
    // never performed, and would quietly assert that an arrow's body
    // executed when it provably did not.
    expectKept(
      mod(
        "const arrowBail = () => {\n  throw new Error();\n};\nnew arrowBail();",
      ),
    );
    expectKept(
      mod("async function ab() {\n  throw new Error();\n}\nnew ab();"),
    );
    expectKept(mod("function* gb() {\n  throw new Error();\n}\nnew gb();"));
  });

  it("refuses a CLASS constructor body — outside the callable-summary model", () => {
    expectKept(
      modNoThrow(
        'class C {\n  constructor() {\n    throw new Error("boom");\n  }\n}\nnew C();',
      ),
    );
  });
});

// ---------------------------------------------------------------------
// 28-29. async / generator boundaries, across every new shape.
// ---------------------------------------------------------------------

describe("RWF-028 (28-29): async and generator callees are never synchronously abrupt", () => {
  const ASYNC = 'async function ab() {\n  throw new Error("boom");\n}\n';
  const GEN = 'function* gb() {\n  throw new Error("boom");\n}\n';

  it("(28) keeps authority for an ASYNC callee, direct and through every provenance form", () => {
    // Calling one returns a REJECTED PROMISE; module evaluation continues
    // and the later export really is written.
    for (const body of [
      "ab();",
      "const alias = ab;\nalias();",
      "const h = { ab };\nh.ab();",
      "function w() {\n  ab();\n}\nw();",
    ]) {
      expectKept(`${TWO}${ASYNC}${SAFE}${body}\nmodule.exports = second;\n`);
    }
  });

  it("(29) keeps authority for a GENERATOR callee, direct and through every provenance form", () => {
    // Calling one only CONSTRUCTS a generator; the body never runs.
    for (const body of [
      "gb();",
      "const alias = gb;\nalias();",
      "const h = { gb };\nh.gb();",
      "function w() {\n  gb();\n}\nw();",
    ]) {
      expectKept(`${TWO}${GEN}${SAFE}${body}\nmodule.exports = second;\n`);
    }
  });
});

// ---------------------------------------------------------------------
// 30-32. try/catch, deferred contexts, optional chains.
// ---------------------------------------------------------------------

describe("RWF-028 (30-32): caught, deferred and optional invocations", () => {
  it("(30) keeps authority when the new forms' abruptness is CAUGHT", () => {
    for (const body of [
      "const alias = bail;\ntry {\n  alias();\n} catch {}",
      "const h = { bail };\ntry {\n  h.bail();\n} catch {}",
      "function w() {\n  bail();\n}\ntry {\n  w();\n} catch {}",
      "try {\n  new bail();\n} catch {}",
    ]) {
      expectKept(mod(body));
    }
  });

  it("(31) creates no module-time cutoff for a DEFERRED function body", () => {
    for (const body of [
      "const alias = bail;\nfunction later() {\n  alias();\n}",
      "const h = { bail };\nclass C {\n  method() {\n    new bail();\n  }\n}",
    ]) {
      expectKept(mod(body));
    }
  });

  it("(32) creates no module-time cutoff for a DEFERRED arrow", () => {
    for (const body of [
      "const h = { bail };\nconst cb = () => h.bail();",
      "const alias = bail;\nconst cb = () => alias();",
    ]) {
      expectKept(mod(body));
    }
  });

  it("refuses an optional RECEIVER rather than widening optional-chain analysis", () => {
    // `h?.bail` short-circuits on a nullish `h`. Deciding it would mean
    // proving the RECEIVER non-nullish, which is nullishness analysis
    // this task does not build — so the whole chain is refused, both when
    // the call is optional too and when it is not.
    for (const body of [
      "const h = { bail };\nh?.bail();",
      "const h = { bail };\nh?.bail?.();",
    ]) {
      expectKept(mod(body));
    }
  });

  it("decides an optional CALL on an already-proven callee, exactly as `bail?.()` is decided", () => {
    // `h.bail?.()` short-circuits only on a nullish CALLEE, and the
    // callee here is an exactly-resolved function declaration — which
    // can no more be nullish than `bail` itself can in `bail?.()`, the
    // form RWF-016 has always decided for the identical reason. The
    // optional token changes nothing about whether the call happens.
    expectRefused(mod("const h = { bail };\nh.bail?.();"));
    expectRefused(mod("const alias = bail;\nalias?.();"));
  });
});

// ---------------------------------------------------------------------
// 33-34. Cross-rule interaction.
// ---------------------------------------------------------------------

describe("RWF-028 (33-34): interaction with RWF-026 and RWF-025", () => {
  it("(33) lets RWF-026 propagate the NEW provenance through required positions only", () => {
    // Required: the call is evaluated by reaching the statement.
    for (const body of [
      "const alias = bail;\nfoo(alias());",
      "const alias = bail;\nconst x = { value: alias() };",
      "const h = { bail };\nconst x = [h.bail()];",
      "const alias = bail;\nif (alias()) {\n}",
      "const x = new bail();",
    ]) {
      expectRefused(mod(body));
    }
    // Conditional / deferred: RWF-026's position rules are untouched by a
    // callee suddenly being resolvable.
    for (const body of [
      "const alias = bail;\nFLAG ? alias() : safeFn();",
      "const alias = bail;\nFLAG && alias();",
      "const alias = bail;\nFLAG || alias();",
      "const h = { bail };\nconst x = FLAG ?? h.bail();",
      "const alias = bail;\nconst x = obj?.m(alias());",
    ]) {
      expectKept(mod(body));
    }
  });

  it("(34) keeps RWF-025's genuine-reassignment facts authoritative in every new form", () => {
    for (const body of [
      "bail = safeFn;\nconst alias = bail;\nalias();",
      "bail = safeFn;\nconst h = { bail };\nh.bail();",
      "bail = safeFn;\nfunction w() {\n  bail();\n}\nw();",
      "bail = safeFn;\nnew bail();",
      "({ bail } = holder);\nconst alias = bail;\nalias();",
      "[bail] = list;\nconst h = { bail };\nh.bail();",
    ]) {
      expectKept(mod(body));
    }
  });
});

// ---------------------------------------------------------------------
// The critical false-AFFECTED control.
// ---------------------------------------------------------------------

describe("RWF-028: a throwing callable elsewhere in the file poisons nothing", () => {
  it("keeps authority for UNRELATED calls in a file that also declares a throwing callable", () => {
    // This is the rule RWF-028 was explicitly forbidden to write:
    // "unresolved call + a throwing callable somewhere in the file =>
    // cutoff". Every body here sits in a file whose `bail` always throws,
    // and every one of them completes normally.
    for (const body of [
      "safeFn();",
      "const alias = safeFn;\nalias();",
      "const h = { safeFn };\nh.safeFn();",
      "unknownFn();",
      "obj.unknown();",
      "registry[name]();",
      "new Holder();",
      "function w() {\n  safeFn();\n}\nw();",
    ]) {
      expectKept(mod(body));
    }
  });

  it("resolves invocation identity EXACTLY when several throwing callables exist", () => {
    const many = `${BAIL}function bail2() {\n  throw new Error("b2");\n}\n${SAFE}`;
    // Each alias resolves to its own source, by identity, not by "some
    // throwing callable exists here".
    expectRefused(
      `${TWO}${many}const alias = bail2;\nalias();\nmodule.exports = second;\n`,
    );
    expectKept(
      `${TWO}${many}const alias = safeFn;\nalias();\nmodule.exports = second;\n`,
    );
    expectKept(
      `${TWO}${many}const h = { a: bail, b: safeFn };\nh.b();\nmodule.exports = second;\n`,
    );
    expectRefused(
      `${TWO}${many}const h = { a: bail, b: safeFn };\nh.a();\nmodule.exports = second;\n`,
    );
  });

  it("keeps same-named bindings in different scopes DISTINCT", () => {
    // An unrelated inner `bail` in a function body must not make the
    // module-scope call resolvable, nor vice versa.
    expectKept(
      `${TWO}${SAFE}function other() {\n  const bail = () => {\n    throw new Error();\n  };\n  return bail;\n}\nbail();\nmodule.exports = second;\n`,
    );
  });
});
