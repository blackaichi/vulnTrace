import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-025: which LOCAL BINDINGS an assignment TARGET rebinds.
 *
 * RWF-016 proved that a resolvable local call whose callee can only ever
 * throw ends module evaluation, and RWF-017/018/019/020/022/024 carried
 * that proof into the other positions the language evaluates during module
 * evaluation. Every one of those cutoffs depends on the SAME callee-identity
 * question: is the name `bail` still the module-top-level `function bail`
 * this file can read a body out of, or was it reassigned somewhere module
 * evaluation can reach?
 *
 * That question is answered by a per-source-file set of reassigned names.
 * Its collector used to fall back to `ts.forEachChild` over an assignment
 * target, recording EVERY identifier underneath it. But an assignment
 * target's AST also contains expressions that are merely EVALUATED while
 * the target is resolved and that bind nothing:
 *
 * ```js
 * ({ [bail()]: x } = HOLDER);   // `x` is rebound; `bail` is CALLED
 * ```
 *
 * `bail` was therefore recorded as locally reassigned. Because the set is
 * cached per SOURCE FILE, one such statement ANYWHERE in a file — nowhere
 * near the vulnerable path, and semantically unrelated to it — withdrew
 * every abrupt-completion cutoff above for that name across the WHOLE
 * file, turning a sound UNKNOWN back into a false NOT_AFFECTED.
 *
 * This file pins both halves of the rule:
 *
 * - an identifier that is only EVALUATED during target resolution (a
 *   computed key, a default initializer, an element-access index, the
 *   object of a property/element access) is NOT reassigned; and
 * - every identifier that genuinely IS an assignment destination — through
 *   shorthand, aliasing, nesting, rest, array patterns, defaults, compound
 *   assignment, update expressions and `for..in`/`for..of` — still is.
 *
 * Nothing about callee identity, callee-body proof or any cutoff's own
 * position rule is re-derived here (`resolveExactLocalCallable`,
 * `cannotCompleteNormally`, RWF-016/017/019/020/022/024): those are used
 * as the INSTRUMENT that makes the reassigned-name set observable.
 */

function modelOf(text: string) {
  const index = indexSourceFile("/pkg/index.js", text);
  return { index, model: buildModuleModel(index) };
}

/** The name the whole-module export resolves to, or `undefined`. */
function defaultExportName(text: string): string | undefined {
  const { index, model } = modelOf(text);
  return mapExportsToFunctions(index, model).get("default")?.name;
}

const TWO = "function first() {}\nfunction second() {}\n";
const BAIL_THROWS = 'function bail() {\n  throw new Error("boom");\n}\n';
const HOLDER = "const HOLDER = { k: 1 };\nlet x;\nlet rest;\n";
const FALLBACK = 'function fallback() {\n  return "f";\n}\n';
const OTHER_KEY = 'function otherKey() {\n  return "k";\n}\n';

/**
 * The observation instrument: RWF-016's canonical reproducer. `second` is
 * only reachable as the module's export if `bail()` did NOT cut module
 * evaluation off — which happens exactly when `bail`'s identity was
 * refused, i.e. when `bail` is in the reassigned-name set.
 */
function withBailCutoff(trailing: string): string {
  return `${TWO}${BAIL_THROWS}${HOLDER}if (FLAG) {\n  module.exports = first;\n  bail();\n}\nmodule.exports = second;\n${trailing}`;
}

/** `bail` was treated as REASSIGNED: the cutoff was withdrawn. */
function bailWasReassigned(trailing: string): boolean {
  return defaultExportName(withBailCutoff(trailing)) === "second";
}

describe("RWF-025: identifiers merely EVALUATED while an assignment target is resolved are not reassigned", () => {
  it("does not mark `bail` for a destructuring COMPUTED KEY -- `({ [bail()]: x } = HOLDER)`", () => {
    expect(bailWasReassigned("({ [bail()]: x } = HOLDER);\n")).toBe(false);
  });

  it("marks the TARGET of a computed-key property -- `({ [otherKey()]: bail } = HOLDER)`", () => {
    expect(
      bailWasReassigned(`${OTHER_KEY}({ [otherKey()]: bail } = HOLDER);\n`),
    ).toBe(true);
  });

  it("marks `bail` when it is BOTH the computed key's callee AND the target -- `({ [bail()]: bail } = HOLDER)`", () => {
    // The roles are distinguished rather than suppressed wholesale: the KEY
    // occurrence contributes nothing, the VALUE occurrence contributes the
    // mark, and the mark still wins.
    expect(bailWasReassigned("({ [bail()]: bail } = HOLDER);\n")).toBe(true);
  });

  it("does not mark `bail` for a DEFAULT initializer -- `({ x = bail() } = HOLDER)`", () => {
    expect(bailWasReassigned("({ x = bail() } = HOLDER);\n")).toBe(false);
  });

  it("marks the defaulted TARGET, not the default's callee -- `({ bail = fallback() } = HOLDER)`", () => {
    expect(
      bailWasReassigned(`${FALLBACK}({ bail = fallback() } = HOLDER);\n`),
    ).toBe(true);
  });

  it("does not mark `bail` for an aliased DEFAULT target -- `({ k: x = bail() } = HOLDER)`", () => {
    expect(bailWasReassigned("({ k: x = bail() } = HOLDER);\n")).toBe(false);
  });

  it("marks the aliased defaulted TARGET -- `({ k: bail = fallback() } = HOLDER)`", () => {
    expect(
      bailWasReassigned(`${FALLBACK}({ k: bail = fallback() } = HOLDER);\n`),
    ).toBe(true);
  });

  it("does not mark `bail` inside an ARRAY pattern's element-access target -- `[HOLDER[bail()]] = [1]`", () => {
    expect(bailWasReassigned("[HOLDER[bail()]] = [1];\n")).toBe(false);
  });

  it("does not mark `bail` for a plain ELEMENT-ACCESS target -- `HOLDER[bail()] = 1`", () => {
    expect(bailWasReassigned("HOLDER[bail()] = 1;\n")).toBe(false);
  });

  it("does not mark the OBJECT of a property-access target -- `bail.prop = 1`", () => {
    // Mutating a property of `bail` does not rebind the name `bail`.
    expect(bailWasReassigned("bail.prop = 1;\n")).toBe(false);
  });

  it("does not mark the OBJECT of an element-access target -- `bail[0] = 1`", () => {
    expect(bailWasReassigned("bail[0] = 1;\n")).toBe(false);
  });

  it("does not mark `bail` for an array DEFAULT -- `[x = bail()] = [1]`", () => {
    expect(bailWasReassigned("[x = bail()] = [1];\n")).toBe(false);
  });

  it("does not mark `bail` for a NESTED computed key -- `({ k: { [bail()]: x } } = HOLDER)`", () => {
    expect(bailWasReassigned("({ k: { [bail()]: x } } = HOLDER);\n")).toBe(
      false,
    );
  });

  it("does not mark `bail` for a computed key inside an ARRAY pattern -- `[{ [bail()]: x }] = [HOLDER]`", () => {
    expect(bailWasReassigned("[{ [bail()]: x }] = [HOLDER];\n")).toBe(false);
  });

  it("does not mark `bail` for a computed key in a `for..of` target -- `for ({ [bail()]: x } of [])`", () => {
    expect(bailWasReassigned("for ({ [bail()]: x } of []) {\n}\n")).toBe(false);
  });
});

describe("RWF-025: every genuine assignment DESTINATION is still marked reassigned", () => {
  const genuine: ReadonlyArray<readonly [string, string]> = [
    ["direct assignment", 'bail = () => "safe";\n'],
    ["shorthand destructuring", "({ bail } = HOLDER);\n"],
    ["aliased destructuring", "({ k: bail } = HOLDER);\n"],
    ["nested destructuring", "({ outer: { bail } } = HOLDER);\n"],
    [
      "deeply nested destructuring",
      "({ a: { b: [{ c: bail }] } } = HOLDER);\n",
    ],
    ["object rest", "({ ...bail } = HOLDER);\n"],
    ["array pattern", "[bail] = [1];\n"],
    ["array pattern with a hole", "[, bail] = [1, 2];\n"],
    ["array rest", "[...bail] = [1];\n"],
    ["array nested object pattern", "[{ k: bail }] = [HOLDER];\n"],
    ["compound assignment", "bail += 1;\n"],
    ["logical-or assignment", 'bail ||= "safe";\n'],
    ["logical-and assignment", 'bail &&= "safe";\n'],
    ["nullish assignment", 'bail ??= "safe";\n'],
    ["postfix increment", "bail++;\n"],
    ["prefix decrement", "--bail;\n"],
    ["for..of loop variable", "for (bail of []) {\n}\n"],
    ["for..in loop variable", "for (bail in HOLDER) {\n}\n"],
    ["for..of destructuring target", "for ({ bail } of []) {\n}\n"],
    ["for..of array destructuring target", "for ([bail] of []) {\n}\n"],
    ["parenthesized target", '(bail) = "safe";\n'],
    ["parenthesized destructuring target", "({ k: (bail) } = HOLDER);\n"],
  ];

  for (const [label, trailing] of genuine) {
    it(`still refuses the final write after a ${label}`, () => {
      expect(bailWasReassigned(trailing)).toBe(true);
    });
  }

  it("still refuses a stale callable proof when the REAL reassignment sits beside an unrelated computed-key destructuring", () => {
    // The false-AFFECTED attack: removing the spurious marks must not also
    // remove the genuine one standing right next to them.
    expect(
      bailWasReassigned(
        `${OTHER_KEY}bail = second;\n({ [otherKey()]: x } = HOLDER);\n`,
      ),
    ).toBe(true);
  });

  it("still refuses when a genuine destructuring rebind sits beside an unrelated computed-key destructuring", () => {
    expect(
      bailWasReassigned(
        `${OTHER_KEY}({ [otherKey()]: x } = HOLDER);\n({ bail } = HOLDER);\n`,
      ),
    ).toBe(true);
  });

  it("still refuses when the computed key and the genuine rebind are the SAME statement", () => {
    expect(bailWasReassigned("({ [bail()]: x, k: bail } = HOLDER);\n")).toBe(
      true,
    );
  });
});

describe("RWF-025: a reassignment inside a FUNCTION BODY is still out of the module-evaluation reach model", () => {
  it("does not mark `bail` for a destructuring rebind deferred inside a function", () => {
    // Unchanged from before this branch, and deliberately so: the reach
    // model is RWF-016's, and this branch narrows WHICH identifiers a
    // target contributes, never WHERE the walk looks.
    expect(
      bailWasReassigned("function later() {\n  ({ bail } = HOLDER);\n}\n"),
    ).toBe(false);
  });
});

/**
 * The six C1 reproducers from the P0 closure inventory. Each pairs an
 * already-merged abrupt-completion cutoff with an UNRELATED destructuring
 * statement elsewhere in the same file. Before this branch every poisoned
 * one resolved to `second` — a false NOT_AFFECTED — while its
 * poison-free control correctly resolved to nothing.
 */
describe("RWF-025: an unrelated destructuring statement no longer withdraws a merged cutoff (C01-C06)", () => {
  const POISON = "({ [bail()]: x } = HOLDER);\n";
  const POISON_ARRAY = "[HOLDER[bail()]] = [1];\n";

  /** The canonical export-authority reproducer, parameterised over the guarded body. */
  function scenario(body: string, before = "", after = ""): string {
    return `${TWO}${BAIL_THROWS}${HOLDER}${before}if (FLAG) {\n  module.exports = first;\n${body}}\nmodule.exports = second;\n${after}`;
  }

  const RWF016 = "  bail();\n";
  const RWF017 = "  const v = bail();\n  void v;\n";
  const RWF024 = "  const o = {\n    [bail()]: 1,\n  };\n  void o;\n";

  it("C01: poison BEFORE the export-authority scenario", () => {
    expect(defaultExportName(scenario(RWF016, POISON))).toBeUndefined();
  });

  it("C02: RWF-024 object-literal computed key, poison AFTER the final write", () => {
    expect(defaultExportName(scenario(RWF024, "", POISON))).toBeUndefined();
  });

  it("C03: RWF-016 bare throwing call, poison AFTER the final write", () => {
    expect(defaultExportName(scenario(RWF016, "", POISON))).toBeUndefined();
  });

  it("C04: RWF-017 variable initializer, poison AFTER the final write", () => {
    expect(defaultExportName(scenario(RWF017, "", POISON))).toBeUndefined();
  });

  it("C05: array/element-access poison variant `[HOLDER[bail()]] = [1]`", () => {
    expect(
      defaultExportName(scenario(RWF016, "", POISON_ARRAY)),
    ).toBeUndefined();
  });

  it("C06 control: the same cutoff with no destructuring statement at all", () => {
    expect(defaultExportName(scenario(RWF016))).toBeUndefined();
  });

  it("C06 control: poison-free RWF-024 and RWF-017 agree with their poisoned twins", () => {
    expect(defaultExportName(scenario(RWF024))).toBeUndefined();
    expect(defaultExportName(scenario(RWF017))).toBeUndefined();
  });
});

/**
 * The poisoning was FILE-WIDE, so every merged cutoff that depends on
 * `resolveExactLocalCallable` regressed with it. One representative case
 * per merged rule, each with the unrelated destructuring statement present.
 */
describe("RWF-025: each merged abrupt-completion cutoff survives an unrelated computed-key destructuring", () => {
  const POISON = "({ [bail()]: x } = HOLDER);\n";
  const NOT_A_CTOR = "function notAConstructor() {\n  return 1;\n}\n";
  const POISON_CTOR = "({ [notAConstructor()]: x } = HOLDER);\n";

  function scenario(decls: string, body: string, after: string): string {
    return `${TWO}${decls}${HOLDER}if (FLAG) {\n  module.exports = first;\n${body}}\nmodule.exports = second;\n${after}`;
  }

  it("RWF-016: a bare `bail();` statement", () => {
    expect(
      defaultExportName(scenario(BAIL_THROWS, "  bail();\n", POISON)),
    ).toBeUndefined();
  });

  it("RWF-017: a `const v = bail();` initializer", () => {
    expect(
      defaultExportName(
        scenario(BAIL_THROWS, "  const v = bail();\n  void v;\n", POISON),
      ),
    ).toBeUndefined();
  });

  it("RWF-018: a class STATIC FIELD initializer", () => {
    expect(
      defaultExportName(
        scenario(
          BAIL_THROWS,
          "  class C {\n    static f = bail();\n  }\n",
          POISON,
        ),
      ),
    ).toBeUndefined();
  });

  it("RWF-019: a class element's COMPUTED KEY", () => {
    expect(
      defaultExportName(
        scenario(BAIL_THROWS, "  class C {\n    [bail()] = 1;\n  }\n", POISON),
      ),
    ).toBeUndefined();
  });

  it("RWF-020: an `extends` HERITAGE call", () => {
    expect(
      defaultExportName(
        scenario(BAIL_THROWS, "  class C extends bail() {}\n", POISON),
      ),
    ).toBeUndefined();
  });

  it("RWF-022: an INVALID heritage VALUE", () => {
    expect(
      defaultExportName(
        scenario(
          NOT_A_CTOR,
          "  class C extends notAConstructor() {}\n",
          POISON_CTOR,
        ),
      ),
    ).toBeUndefined();
  });

  it("RWF-024: an OBJECT LITERAL's computed key", () => {
    expect(
      defaultExportName(
        scenario(
          BAIL_THROWS,
          "  const o = {\n    [bail()]: 1,\n  };\n  void o;\n",
          POISON,
        ),
      ),
    ).toBeUndefined();
  });
});

/**
 * The still-open P0 gaps are deliberately NOT closed here. What this
 * branch owes them is only that the poisoning no longer changes their
 * answer: with and without the unrelated destructuring statement they must
 * agree, whatever that shared answer is.
 */
describe("RWF-025: still-open gaps answer identically with and without the poison", () => {
  const POISON = "({ [bail()]: x } = HOLDER);\n";

  function scenario(body: string, after: string): string {
    return `${TWO}${BAIL_THROWS}${HOLDER}if (FLAG) {\n  module.exports = first;\n${body}}\nmodule.exports = second;\n${after}`;
  }

  const gaps: ReadonlyArray<readonly [string, string]> = [
    // P0-A: the throwing call is an ARGUMENT, so the call expression as a
    // whole is not yet proved definitely abrupt (RWF-026's own work).
    ["P0-A argument position", "  foo(bail());\n"],
    ["P0-A binary operand", "  const v = 1 + bail();\n  void v;\n"],
    // P0-E: an ALIAS and a MEMBER callee, neither resolved by the exact
    // local-callee model (RWF-028's own work).
    ["P0-E alias callee", "  const alias = bail;\n  alias();\n"],
    ["P0-E member callee", "  const holder = { bail };\n  holder.bail();\n"],
  ];

  for (const [label, body] of gaps) {
    it(`${label} is unaffected by the poison`, () => {
      expect(defaultExportName(scenario(body, POISON))).toBe(
        defaultExportName(scenario(body, "")),
      );
    });
  }
});
