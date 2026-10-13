import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * BL-066 (RWF-096, RWF-097; BL-067 folded in): the callee summary
 * (`callableAlwaysThrows`) reads a concise body, every position a body
 * statement necessarily evaluates, a `return`'s expression, and the default
 * parameter initializers an invocation runs.
 *
 * Each program declares a throwing `bail`, runs one module-time statement,
 * then writes `module.exports = second`. Every program below was run under
 * real Node v22.11.0 by task BL-066 (the TypeScript ones compiled first):
 * each WITHDRAWN and MAY row throws before the write, each KEPT row
 * completes and writes it (the `async` row's rejection is unhandled only
 * after the module has completed). The end-to-end oracle cases are in
 * `tests/oracle/rwf096-callee-summary.test.ts`. No KEPT row pins a refusal
 * where real Node throws; the summary's known refusals of that kind are
 * RWF-098's open records (`tests/oracle/rwf098-callee-summary-bounds.test.ts`).
 */

function defaultExportName(
  text: string,
  path = "/pkg/index.js",
): string | undefined {
  const index = indexSourceFile(path, text);
  const model = buildModuleModel(index);
  return mapExportsToFunctions(index, model).get("default")?.name;
}

const TWO = "function first() {}\nfunction second() {}\n";
const BAIL = 'function bail() {\n  throw new Error("boom");\n}\n';
const HELPERS =
  "function ok() {\n  return 1;\n}\n" +
  'function safeFn() {\n  return "safe";\n}\n' +
  "const xs = [1, 2];\n";

function mod(body: string): string {
  return `${TWO}${BAIL}${HELPERS}${body}\nmodule.exports = second;\n`;
}

const DP = "function dp(a, b = bail()) {\n  return 1;\n}\n";

/** Authority is WITHDRAWN: the invocation cannot complete normally. */
const WITHDRAWN: ReadonlyArray<readonly [string, string]> = [
  // RWF-096: a concise body is an expression the call must evaluate.
  ["concise arrow call", "const ac = () => bail();\nac();"],
  ["concise arrow as a tag", "const ac = () => bail();\nac`x`;"],
  [
    "concise arrow returning an object literal",
    "const ac = () => ({ a: bail() });\nac();",
  ],
  [
    "concise arrow with a required operand",
    "const ac = (x) => [x, bail()];\nac();",
  ],
  [
    "concise arrow in a block scope",
    "{\n  const ac = () => bail();\n  ac();\n}",
  ],
  [
    "concise arrow as an object member",
    "const h = { ac: () => bail() };\nh.ac();",
  ],
  [
    "wrapper hop through a concise arrow",
    "const ac = () => bail();\nfunction w() {\n  ac();\n}\nw();",
  ],
  // RWF-097: every position a body statement necessarily evaluates.
  ["required argument", "function w() {\n  ok(bail());\n}\nw();"],
  ["required substitution", "function w() {\n  ok`${bail`x`}`;\n}\nw();"],
  [
    "declarator initializer",
    "function w() {\n  const v = bail();\n  return v;\n}\nw();",
  ],
  ["return expression", "function w() {\n  return bail();\n}\nw();"],
  [
    "if condition",
    "function w() {\n  if (bail()) {\n    return 1;\n  }\n  return 2;\n}\nw();",
  ],
  [
    "switch discriminant",
    "function w() {\n  switch (bail()) {\n    default:\n      return 1;\n  }\n}\nw();",
  ],
  [
    "while condition",
    "function w() {\n  while (bail()) {\n    return 1;\n  }\n}\nw();",
  ],
  [
    "for initializer",
    "function w() {\n  for (let i = bail(); ; ) {\n    return i;\n  }\n}\nw();",
  ],
  [
    "for-of right-hand side",
    "function w() {\n  for (const q of bail()) {\n    return q;\n  }\n}\nw();",
  ],
  [
    "assignment right-hand side",
    "let z = 0;\nfunction w() {\n  z = ok() + bail();\n}\nw();",
  ],
  ["labeled statement", "function w() {\n  l: ok(bail());\n}\nw();"],
  [
    "caught and rethrown",
    "function w() {\n  try {\n    ok(bail());\n  } catch (e) {\n    throw e;\n  }\n}\nw();",
  ],
  // RWF-097: the default parameter initializers an invocation runs.
  ["default parameter, no argument", `${DP}dp();`],
  ["default parameter, too few arguments", `${DP}dp(1);`],
  ["default parameter, tagged template (one argument)", `${DP}dp\`x\`;`],
  [
    "default parameter, construction",
    "function DP(a = bail()) {\n  this.a = a;\n}\nnew DP();",
  ],
  [
    "default parameter, construction without parentheses",
    "function DP(a = bail()) {\n  this.a = a;\n}\nnew DP;",
  ],
  [
    "default parameter of a concise arrow",
    "const dpa = (a = bail()) => a;\ndpa();",
  ],
  [
    "default parameter through an object member",
    `${DP}const h = { dp };\nh.dp();`,
  ],
  [
    "default parameter reached from a body",
    `${DP}function w() {\n  dp();\n}\nw();`,
  ],
  ["default parameter in a required operand", `${DP}ok(dp(1));`],
];

/** Authority is KEPT: real Node completes every one of these. */
const KEPT: ReadonlyArray<readonly [string, string]> = [
  [
    "concise arrow whose call is short-circuited away",
    "const m = () => 0 && bail();\nm();",
  ],
  [
    "concise arrow whose call is in an unchosen arm",
    "const m = (x) => (x ? bail() : 1);\nm(0);",
  ],
  ["concise arrow whose call completes", "const ac = () => ok(1);\nac();"],
  [
    "async concise arrow (rejects, never throws)",
    "const aa = async () => bail();\nvoid aa();",
  ],
  ["concise arrow writing a function", "const ac = () => () => bail();\nac();"],
  [
    "concise arrow calling its own parameter",
    "const ac = (bail) => bail();\nac(safeFn);",
  ],
  [
    "body calling its own shadowing binding",
    "function w() {\n  const bail = () => 1;\n  ok(bail());\n}\nw();",
  ],
  ["return before the call", "function w() {\n  return 1;\n  bail();\n}\nw();"],
  [
    "do/while condition after a breaking body",
    "function w() {\n  do {\n    break;\n  } while (bail());\n}\nw();",
  ],
  [
    "for incrementor after a breaking body",
    "function w() {\n  for (; ; bail()) {\n    break;\n  }\n}\nw();",
  ],
  [
    "caught in the body",
    "function w() {\n  try {\n    ok(bail());\n  } catch {}\n}\nw();",
  ],
  ["default parameter supplied", `${DP}dp(1, 2);`],
  ["default parameter, spread argument", `${DP}dp(...xs);`],
  [
    "default parameter naming its own parameter",
    "function sh(bail, b = bail()) {\n  return 1;\n}\nsh(safeFn);",
  ],
  [
    "default parameter writing a function",
    "function dq(a, b = () => bail()) {\n  return 1;\n}\ndq();",
  ],
  ["default parameter of a never-invoked callable", `${DP}void dp;`],
];

describe("BL-066: an invocation the callee summary proves abrupt withdraws later export authority", () => {
  for (const [label, body] of WITHDRAWN) {
    it(`withdraws authority for a ${label}`, () => {
      expect(defaultExportName(mod(body))).toBeUndefined();
    });
  }
});

describe("BL-066: an invocation that completes keeps later export authority", () => {
  for (const [label, body] of KEPT) {
    it(`keeps authority for a ${label}`, () => {
      expect(defaultExportName(mod(body))).toBe("second");
    });
  }
});

describe("BL-066: a TypeScript `this` parameter is erased and shifts no position", () => {
  // `function tp(this: unknown, b = bail())` compiles to
  // `function tp(b = bail())`: `tp(1)` supplies `b`, `tp()` does not.
  const TP =
    "function tp(this: unknown, b: number = bail()) {\n  return b;\n}\n";

  it("keeps authority when the one runtime parameter is supplied", () => {
    expect(defaultExportName(mod(`${TP}tp(1);`), "/pkg/index.ts")).toBe(
      "second",
    );
  });

  it("withdraws authority when it is not", () => {
    expect(
      defaultExportName(mod(`${TP}tp();`), "/pkg/index.ts"),
    ).toBeUndefined();
  });
});

describe("BL-066: BL-063's MAY check reaches the newly proven invocations", () => {
  // `FLAG` is true under real Node and unknowable here: the invocation MAY
  // run at module time, and when it does it cannot complete.
  it("withdraws authority for a default parameter run in a MAY position", () => {
    expect(
      defaultExportName(
        mod(`${DP}const FLAG = !process.env.VT_BL066_OFF;\nFLAG && dp();`),
      ),
    ).toBeUndefined();
  });

  it("withdraws authority for a concise arrow run in a MAY position", () => {
    expect(
      defaultExportName(
        mod(
          "const ac = () => bail();\nconst FLAG = !process.env.VT_BL066_OFF;\nFLAG && ac();",
        ),
      ),
    ).toBeUndefined();
  });
});

describe("BL-066: the callee summary memo stores only exact answers", () => {
  // The per-file gate reads `fn` first (declaration order), and computes
  // `g` at depth 1 INSIDE `fn`, where `g`'s call of `fn` is a recursion
  // refusal: `false` there. The module-scope `w()` needs `g` at depth 1
  // computed afresh, where it is `true` (`fn` reaches its `throw`). Real
  // Node throws: `Z` is `0`, so `fn` throws on its first call.
  const PROGRAM =
    "const Z = 0;\n" +
    'function fn() {\n  if (Z) {\n    g();\n  }\n  throw new Error("x");\n}\n' +
    "function g() {\n  fn();\n}\n" +
    "function w() {\n  g();\n}\n" +
    "w();\n";

  it("withdraws authority although an answer inside a recursion was false", () => {
    expect(
      defaultExportName(`${TWO}${PROGRAM}module.exports = second;\n`),
    ).toBeUndefined();
  });
});
