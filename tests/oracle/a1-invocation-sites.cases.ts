import type ts from "typescript";
import type { OracleCase } from "../../src/testing/oracle/case.js";
import {
  simpleConfigFile,
  simplePackageFiles,
  simpleRuleFile,
} from "../../src/testing/oracle/config-files.js";
import { nodeEntryCommand } from "../../src/testing/oracle/ground-truth.js";
import {
  HIT_HELPER_SOURCE,
  hitFunction,
} from "../../src/testing/oracle/hit.js";
import type { ProjectSpec } from "../../src/testing/oracle/project.js";
import { syntheticProvider } from "../../src/testing/oracle/provider.js";
import { compileTypeScript } from "../../src/testing/oracle/typescript-compile.js";

/**
 * Task A-1 (docs/tasks/A-1-invocation-account.md): the three
 * invocation-capable sites ADR 0008 § 8 assigns to A-1 -- tagged templates
 * (PRM-37), implicit `super` from a derived class with no constructor
 * (PRM-19) and decorators (PRM-115) -- reproduced against real Node.
 *
 * One shared LOUD fixture, the same one task A-0 uses: `vuln-lib` exports
 * `parse` (the rule's target) and `safe` (its inert sibling), both marked
 * with the `hit()` convention, and every case declares both as bound
 * names, so a fabricated attribution resolves loudly to a wrong target
 * instead of degrading to UNKNOWN.
 *
 * THE CONTROLS. Every case has both, derived the same way:
 *
 * - positive control: the negative control preceded by one direct
 *   top-level `lib.parse("x")` call, proving the rule, target and
 *   entrypoint wiring of this exact project produce AFFECTED (preceded,
 *   not followed: a standard decorator that returns a non-function throws
 *   at class definition, and a trailing call would never run);
 * - negative control: `negative`, which real Node must run without ever
 *   calling the target, and which the analyzer must answer NOT_AFFECTED.
 *
 * For a case whose expected verdict is AFFECTED or NOT_AFFECTED the
 * negative control is the case with the hook calling `lib.safe` instead
 * of `lib.parse` -- the only difference is which export the hook calls.
 * For a FAIL-CLOSED case (expected UNKNOWN: the invocation is accounted
 * for by an unknown edge), that construction cannot work: an unknown edge
 * blocks the negative proof whichever export the hook calls, so the
 * `lib.safe` variant is UNKNOWN too, and the harness requires its
 * negative control to be exactly NOT_AFFECTED. The negative control of a
 * fail-closed case is therefore the case with its TRIGGER removed and
 * every definition kept, so it still shows that nothing but the trigger
 * can reach the target.
 */

export const ADVISORY_ID = "GHSA-a1-invocation-sites";
export const TARGET_MARKER = "parse";

const LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `module.exports = { parse, safe };\n`;

const JS_PRELUDE = `const lib = require("vuln-lib");\n`;
const TS_PRELUDE = `import lib = require("vuln-lib");\n`;

export type Language = "js" | "ts-legacy-decorators" | "ts-standard-decorators";

export type Finding = "PRM-37" | "PRM-19" | "PRM-115";

export interface A1Case {
  /** Stable case id, e.g. `tagged-template.import-member`. */
  readonly id: string;
  readonly finding: Finding;
  /** One line: the mechanism. */
  readonly mechanism: string;
  readonly language: Language;
  /** The case program, after the prelude. */
  readonly source: string;
  /** The negative control's program, after the prelude (see the module comment). */
  readonly negative: string;
  /**
   * The only sound verdict for the case once A-1 accounts for its site.
   * AFFECTED needs the language to guarantee the invocation AND the target
   * to be attributable (ADR 0008 § 4: "Decorators and implicit `super`:
   * resolved, because the language guarantees the call"); UNKNOWN is the
   * fail-closed account of an invocation whose callee is not attributable
   * (§ 3); NOT_AFFECTED is a precision control whose site never runs.
   */
  readonly expected: "AFFECTED" | "UNKNOWN" | "NOT_AFFECTED";
  /**
   * Only for an UNKNOWN case: set to `false` when real Node never calls
   * the target, and UNKNOWN is the sound precision cost of an invocation
   * that may or may not happen (a site in an accessor body, which has no
   * node of its own until task A-4). Otherwise an UNKNOWN case is a
   * fail-closed account of a call that does happen.
   */
  readonly realNodeCalls?: false;
}

const TS_OPTIONS: Record<Exclude<Language, "js">, ts.CompilerOptions> = {
  "ts-legacy-decorators": { experimentalDecorators: true },
  "ts-standard-decorators": {},
};

function project(language: Language, body: string): ProjectSpec {
  const common = {
    ...simplePackageFiles("app", "vuln-lib", "1.0.0"),
    "node_modules/vuln-lib/package.json": JSON.stringify({
      name: "vuln-lib",
      version: "1.0.0",
      main: "index.js",
    }),
    "node_modules/vuln-lib/index.js": LIB_SOURCE,
    "rules.yml": simpleRuleFile({
      id: ADVISORY_ID,
      packageName: "vuln-lib",
      exportName: "parse",
    }),
  };
  if (language === "js") {
    return {
      files: {
        ...common,
        "src/index.js": JS_PRELUDE + body,
        "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.js"] }),
      },
    };
  }
  // TypeScript: Node cannot run decorators natively, so the ground truth
  // runs the source compiled by the repository's own TypeScript
  // (src/testing/oracle/typescript-compile.ts), with the same decorator
  // mode the project's tsconfig.json declares.
  const source = TS_PRELUDE + body + `export {};\n`;
  const options = TS_OPTIONS[language];
  return {
    files: {
      ...common,
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "commonjs", target: "es2022", ...options },
      }),
      "src/index.ts": source,
      "dist/index.js": compileTypeScript(source, "index.ts", options),
      "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.ts"] }),
    },
  };
}

export function oracleCase(kase: A1Case): OracleCase {
  return {
    id: kase.id,
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand(
      kase.language === "js" ? "src/index.js" : "dist/index.js",
    ),
    controls: {
      kind: "controls",
      controls: {
        positive: {
          name: "positive-control",
          project: project(kase.language, `lib.parse("x");\n` + kase.negative),
        },
        negative: {
          name: "negative-control",
          project: project(kase.language, kase.negative),
        },
      },
    },
    variant: { name: "case", project: project(kase.language, kase.source) },
  };
}

/** A case whose negative control is the case with the hook calling `safe`. */
function hooked(
  base: Omit<A1Case, "source" | "negative">,
  program: (fn: "parse" | "safe") => string,
): A1Case {
  return { ...base, source: program("parse"), negative: program("safe") };
}

// ---------------------------------------------------------------------------
// PRM-37 -- tagged templates
// ---------------------------------------------------------------------------

export const TAGGED_TEMPLATES: readonly A1Case[] = [
  hooked(
    {
      id: "tagged-template.import-member",
      finding: "PRM-37",
      mechanism: "the tag is a member of a required module",
      language: "js",
      expected: "AFFECTED",
    },
    (fn) => `lib.${fn}\`x\`;\n`,
  ),
  hooked(
    {
      id: "tagged-template.local-function",
      finding: "PRM-37",
      mechanism: "the tag is a same-file function declaration",
      language: "js",
      expected: "AFFECTED",
    },
    (fn) =>
      `function tag(strings) { return lib.${fn}(strings[0]); }\ntag\`x\`;\n`,
  ),
  hooked(
    {
      id: "tagged-template.destructured-import",
      finding: "PRM-37",
      mechanism: "the tag is a destructured named import",
      language: "js",
      expected: "AFFECTED",
    },
    (fn) => `const { ${fn}: tag } = require("vuln-lib");\ntag\`x\`;\n`,
  ),
  hooked(
    {
      id: "tagged-template.substitution-call",
      finding: "PRM-37",
      mechanism:
        "a call inside a substitution runs whatever the tag is (control for the existing call edge)",
      language: "js",
      expected: "AFFECTED",
    },
    (fn) => `String.raw\`a\${lib.${fn}("x")}\`;\n`,
  ),
  {
    id: "tagged-template.unattributable-tag",
    finding: "PRM-37",
    mechanism: "the tag is an indexed read the analyzer cannot attribute",
    language: "js",
    expected: "UNKNOWN",
    source: `const tags = [(s) => lib.parse(s[0])];\ntags[0]\`x\`;\n`,
    negative: `const tags = [(s) => lib.parse(s[0])];\n`,
  },
  {
    id: "tagged-template.vm-tag",
    finding: "PRM-37",
    mechanism:
      "vm.runInThisContext as a tag compiles and runs the template text (loader classification applies to a tag)",
    language: "js",
    expected: "UNKNOWN",
    source:
      `const vm = require("vm");\n` +
      `vm.runInThisContext\`process.mainModule.require("vuln-lib").parse("x")\`;\n`,
    negative: `const vm = require("vm");\n`,
  },
];

/**
 * Task A-1 audit, finding 2: a site A-1 added is attributed to the owner
 * that EVALUATES it. An instance field's initializer is evaluated by the
 * class's constructor, not by the owner of the class definition.
 */
export const TAGGED_TEMPLATES_DEFERRED: readonly A1Case[] = [
  hooked(
    {
      id: "tagged-template.instance-field-never-constructed",
      finding: "PRM-37",
      mechanism:
        "precision control: the tag is in an instance field initializer of a class never constructed",
      language: "js",
      expected: "NOT_AFFECTED",
    },
    (fn) =>
      `function tag(s) { return lib.${fn}(s[0]); }\n` +
      `class A { f = tag\`x\`; }\n`,
  ),
  hooked(
    {
      id: "tagged-template.instance-field-constructed",
      finding: "PRM-37",
      mechanism:
        "the tag is in an instance field initializer, run by the constructor",
      language: "js",
      expected: "AFFECTED",
    },
    (fn) =>
      `function tag(s) { return lib.${fn}(s[0]); }\n` +
      `class A { f = tag\`x\`; }\nnew A();\n`,
  ),
];

// ---------------------------------------------------------------------------
// PRM-19 -- implicit `super` from a derived class with no constructor
// ---------------------------------------------------------------------------

export const IMPLICIT_SUPER: readonly A1Case[] = [
  hooked(
    {
      id: "implicit-super.local-base",
      finding: "PRM-19",
      mechanism:
        "new Sub() runs Base's constructor through Sub's implicit constructor",
      language: "js",
      expected: "AFFECTED",
    },
    (fn) =>
      `class Base { constructor() { lib.${fn}("x"); } }\n` +
      `class Sub extends Base {}\nnew Sub();\n`,
  ),
  hooked(
    {
      id: "implicit-super.chain",
      finding: "PRM-19",
      mechanism: "two implicit constructors in a row",
      language: "js",
      expected: "AFFECTED",
    },
    (fn) =>
      `class Base { constructor() { lib.${fn}("x"); } }\n` +
      `class Mid extends Base {}\nclass Leaf extends Mid {}\nnew Leaf();\n`,
  ),
  hooked(
    {
      id: "implicit-super.never-constructed",
      finding: "PRM-19",
      mechanism:
        "precision control: the derived class is never constructed, so its implicit constructor never runs",
      language: "js",
      expected: "NOT_AFFECTED",
    },
    (fn) =>
      `class Base { constructor() { lib.${fn}("x"); } }\n` +
      `class Sub extends Base {}\n`,
  ),
  {
    id: "implicit-super.unattributable-base",
    finding: "PRM-19",
    mechanism: "the base is an indexed read the analyzer cannot attribute",
    language: "js",
    expected: "UNKNOWN",
    source:
      `const bases = [class { constructor() { lib.parse("x"); } }];\n` +
      `class Sub extends bases[0] {}\nnew Sub();\n`,
    negative:
      `const bases = [class { constructor() { lib.parse("x"); } }];\n` +
      `class Sub extends bases[0] {}\n`,
  },
];

// ---------------------------------------------------------------------------
// PRM-115 -- decorators (TypeScript legacy and standard)
// ---------------------------------------------------------------------------

const logged = (fn: string) =>
  `function logged(...args: any[]) { lib.${fn}("x"); return undefined; }\n`;

function decoratorCases(language: Exclude<Language, "js">): A1Case[] {
  const mode = language === "ts-legacy-decorators" ? "legacy" : "standard";
  const cases: A1Case[] = [
    hooked(
      {
        id: `decorator.${mode}.class`,
        finding: "PRM-115",
        mechanism: "a class decorator runs at class definition",
        language,
        expected: "AFFECTED",
      },
      (fn) => logged(fn) + `@logged\nclass X {}\n`,
    ),
    hooked(
      {
        id: `decorator.${mode}.method`,
        finding: "PRM-115",
        mechanism:
          "a method decorator runs at class definition, not when the method is called (the method never is)",
        language,
        expected: "AFFECTED",
      },
      (fn) => logged(fn) + `class X {\n  @logged\n  m() {}\n}\n`,
    ),
    hooked(
      {
        id: `decorator.${mode}.static-method`,
        finding: "PRM-115",
        mechanism: "a static method decorator runs at class definition",
        language,
        expected: "AFFECTED",
      },
      (fn) => logged(fn) + `class X {\n  @logged\n  static m() {}\n}\n`,
    ),
    hooked(
      {
        id: `decorator.${mode}.field`,
        finding: "PRM-115",
        mechanism:
          "a field decorator runs at class definition (the class is never constructed)",
        language,
        expected: "AFFECTED",
      },
      (fn) => logged(fn) + `class X {\n  @logged\n  f = 1;\n}\n`,
    ),
    hooked(
      {
        id: `decorator.${mode}.imported`,
        finding: "PRM-115",
        mechanism: "the decorator is the target export itself",
        language,
        expected: "AFFECTED",
      },
      (fn) => `@lib.${fn}\nclass X {}\n`,
    ),
    hooked(
      {
        id: `decorator.${mode}.inside-uncalled-function`,
        finding: "PRM-115",
        mechanism:
          "precision control: the decorated class is defined inside a function that never runs",
        language,
        expected: "NOT_AFFECTED",
      },
      (fn) =>
        logged(fn) +
        `function never() {\n  @logged\n  class X {}\n  return X;\n}\n`,
    ),
    hooked(
      {
        id: `decorator.${mode}.method-inside-uncalled-function`,
        finding: "PRM-115",
        mechanism:
          "precision control: a method decorator of a class defined inside a function that never runs",
        language,
        expected: "NOT_AFFECTED",
      },
      (fn) =>
        logged(fn) +
        `function never() {\n  class X {\n    @logged\n    m() {}\n  }\n  return X;\n}\n`,
    ),
    {
      id: `decorator.${mode}.factory`,
      finding: "PRM-115",
      mechanism:
        "a decorator factory: the call's result is the decorator, and it is not attributable",
      language,
      expected: "UNKNOWN",
      source:
        `function make() { return function (...args: any[]) { lib.parse("x"); return undefined; }; }\n` +
        `@make()\nclass X {}\n`,
      negative: `function make() { return function (...args: any[]) { lib.parse("x"); return undefined; }; }\n`,
    },
  ];
  if (language === "ts-legacy-decorators") {
    // Parameter decorators exist only in the legacy form.
    cases.push(
      hooked(
        {
          id: "decorator.legacy.constructor-parameter",
          finding: "PRM-115",
          mechanism:
            "a constructor parameter decorator runs at class definition, not at construction (the class is never constructed)",
          language,
          expected: "AFFECTED",
        },
        (fn) => logged(fn) + `class X {\n  constructor(@logged a: any) {}\n}\n`,
      ),
      hooked(
        {
          id: "decorator.legacy.method-parameter",
          finding: "PRM-115",
          mechanism:
            "a method parameter decorator runs at class definition (the method is never called)",
          language,
          expected: "AFFECTED",
        },
        (fn) => logged(fn) + `class X {\n  m(@logged a: any) {}\n}\n`,
      ),
    );
  }
  return cases;
}

/**
 * Task A-1 audit, finding 1: TypeScript ERASES a decorator in some
 * positions -- the compiled program never calls it -- and those are not
 * sites. Each is valid TypeScript in the mode used, and real Node, running
 * the compiled output, never calls the target.
 *
 * Task A-1 audit, finding 2: a decorator is attributed to the owner that
 * evaluates its class's definition, which for a class written in an
 * instance field initializer is the enclosing class's constructor, and for
 * one written in an accessor body is the accessor (no node yet: UNKNOWN).
 */
export const DECORATORS_AUDIT: readonly A1Case[] = [
  hooked(
    {
      id: "decorator.legacy.erased-declare-class",
      finding: "PRM-115",
      mechanism:
        "precision control: a decorator on a `declare` class is erased",
      language: "ts-legacy-decorators",
      expected: "NOT_AFFECTED",
    },
    (fn) => logged(fn) + `@logged\ndeclare class X {}\n`,
  ),
  hooked(
    {
      id: "decorator.legacy.erased-setter-parameter",
      finding: "PRM-115",
      mechanism:
        "precision control: a decorator on a setter's parameter is erased",
      language: "ts-legacy-decorators",
      expected: "NOT_AFFECTED",
    },
    (fn) => logged(fn) + `class X {\n  set s(@logged v: any) {}\n}\n`,
  ),
  hooked(
    {
      id: "decorator.standard.erased-overload-signature",
      finding: "PRM-115",
      mechanism:
        "precision control: a decorator on an overload signature (not the implementation) is erased",
      language: "ts-standard-decorators",
      expected: "NOT_AFFECTED",
    },
    (fn) =>
      logged(fn) + `class X {\n  @logged\n  m(): void;\n  m(a?: any) {}\n}\n`,
  ),
  hooked(
    {
      id: "decorator.standard.erased-abstract-method",
      finding: "PRM-115",
      mechanism:
        "precision control: a decorator on an abstract method is erased",
      language: "ts-standard-decorators",
      expected: "NOT_AFFECTED",
    },
    (fn) =>
      logged(fn) + `abstract class X {\n  @logged\n  abstract m(): void;\n}\n`,
  ),
  hooked(
    {
      id: "decorator.standard.instance-field-class-never-constructed",
      finding: "PRM-115",
      mechanism:
        "precision control: the decorated class is written in an instance field initializer of a class never constructed",
      language: "ts-standard-decorators",
      expected: "NOT_AFFECTED",
    },
    (fn) =>
      logged(fn) +
      `class A {\n  f = class {\n    @logged\n    m() {}\n  };\n}\n`,
  ),
  hooked(
    {
      id: "decorator.standard.instance-field-class-constructed",
      finding: "PRM-115",
      mechanism:
        "the decorated class is written in an instance field initializer, evaluated by the constructor",
      language: "ts-standard-decorators",
      expected: "AFFECTED",
    },
    (fn) =>
      logged(fn) +
      `class A {\n  f = class {\n    @logged\n    m() {}\n  };\n}\nnew A();\n`,
  ),
  {
    id: "decorator.standard.getter-body-class-never-read",
    finding: "PRM-115",
    mechanism:
      "the decorated class is written in a getter body that is never read: UNKNOWN until an accessor is its own owner (A-4)",
    language: "ts-standard-decorators",
    expected: "UNKNOWN",
    realNodeCalls: false,
    source:
      logged("parse") +
      `class A {\n  get g() {\n    class B {\n      @logged\n      m() {}\n    }\n    return B;\n  }\n}\n`,
    negative:
      logged("parse") + `class A {\n  get g() {\n    return 1;\n  }\n}\n`,
  },
];

export const DECORATORS: readonly A1Case[] = [
  ...decoratorCases("ts-legacy-decorators"),
  ...decoratorCases("ts-standard-decorators"),
];

export const ALL_CASES: readonly A1Case[] = [
  ...TAGGED_TEMPLATES,
  ...TAGGED_TEMPLATES_DEFERRED,
  ...IMPLICIT_SUPER,
  ...DECORATORS,
  ...DECORATORS_AUDIT,
];
