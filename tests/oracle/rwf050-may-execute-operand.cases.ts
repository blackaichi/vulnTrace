import type { OracleCase } from "../../src/testing/oracle/case.js";
import {
  simpleConfigFile,
  simpleRuleFile,
} from "../../src/testing/oracle/config-files.js";
import { nodeEntryCommand } from "../../src/testing/oracle/ground-truth.js";
import {
  HIT_HELPER_SOURCE,
  hitFunction,
} from "../../src/testing/oracle/hit.js";
import type { ProjectSpec } from "../../src/testing/oracle/project.js";
import { syntheticProvider } from "../../src/testing/oracle/provider.js";

/**
 * Task RWF-050-repro (docs/tasks/RWF-050-repro-may-execute-operand.md):
 * RWF-026's inherited MAY-execute conditional/logical abrupt-operand gap,
 * reproduced end to end against real Node.
 *
 * THE MECHANISM. Every CommonJS export-provenance fact reads a
 * last-write-wins map gated on `isDefinitelyReachedModuleScopeStatement`
 * (`module-model.ts`), whose cutoff is the first top-level statement
 * `mayEndModuleEvaluation` says can end module evaluation. That walk
 * descends into statement containers, so `if (FLAG) bail();` is a cutoff
 * (MAY, like an `if` body); it reaches a `bail()` in an expression only in
 * RWF-026's REQUIRED positions, so `FLAG && bail();` -- the same program --
 * is not. The later `exports.run = safeOp` then stays authoritative.
 *
 * HOW REAL NODE OBSERVES IT. An uncaught module-scope throw removes the
 * module from `require.cache`, so the value is visible only to a module
 * that already holds the exports OBJECT: `wrap/b.js`, required in a cycle
 * from `wrap/index.js` BEFORE either write of `run`, keeps that object and
 * reads `.run` only when `later` is called. The entry catches the throw
 * from `require("wrap")`, then calls `require("wrap/b").later(...)`: on a
 * load the abrupt operand cut short, `.run` is still `dangerousOp`, which
 * calls `vuln-lib`'s `parse`. Real Node evaluates `FLAG` true (the
 * variable is unset in the harness).
 *
 * WHY THE CYCLE COMES FIRST. A `require` that can re-enter this module
 * BETWEEN the two writes is ADR 0009 § 1 clause 4's observation point,
 * which lane E withdraws attribution for whatever RWF-050's fix does. With
 * the cycle before both writes, only the abrupt-completion machinery
 * (clause 3) decides: these cases isolate RWF-050.
 *
 * LOUD FIXTURE. `vuln-lib` exports `parse` (the rule's target) and `safe`,
 * both functions; `wrap/index.js`'s `dangerousOp` calls `parse` and its
 * `safeOp` calls `safe`.
 *
 * THE CONTROLS. The negative control is the same program with the abrupt
 * line removed: `.run` is `safeOp` on every load (family C,
 * `NOT_AFFECTED`, and real Node never calls `parse`). The positive control
 * adds one direct call of `parse` to the entry.
 */

export const ADVISORY_ID = "GHSA-rwf050-may-execute-operand";
export const TARGET_MARKER = "parse";

export type CaseVerdict = "NOT_AFFECTED" | "AFFECTED" | "UNKNOWN";

export interface Rwf050Case {
  readonly id: string;
  /** One line: the spelling. */
  readonly mechanism: string;
  /** The top-level statement(s) between the two writes of `exports.run`. */
  readonly abrupt: string;
  /** Extra top-level declarations before the first write (a `let` a logical assignment reads). */
  readonly prelude?: string;
  /** Whether real Node calls the target. */
  readonly called: boolean;
  /** The analyzer's verdict on the base commit, measured. */
  readonly base: CaseVerdict;
  /** The sound verdict, asserted. */
  readonly expected: CaseVerdict;
}

const ENTRY = "src/index.js";

const LIB: Readonly<Record<string, string>> = {
  "node_modules/vuln-lib/package.json": JSON.stringify({
    name: "vuln-lib",
    version: "1.0.0",
    main: "index.js",
  }),
  "node_modules/vuln-lib/index.js":
    HIT_HELPER_SOURCE +
    hitFunction("parse", '"p"') +
    hitFunction("safe", '"s"') +
    `module.exports = { parse, safe };\n`,
};

/** `wrap/index.js` with `abrupt` between the dangerous and the safe write. */
function wrapIndex(abrupt: string, prelude = ""): string {
  return (
    `const lib = require("vuln-lib");\n` +
    `function dangerousOp(x) { return lib.parse(x); }\n` +
    `function safeOp(x) { return lib.safe(x); }\n` +
    `function bail() { throw new Error("bail"); }\n` +
    `const FLAG = !process.env.VT_RWF050_OFF;\n` +
    prelude +
    `exports.b = require("./b");\n` +
    `exports.run = dangerousOp;\n` +
    abrupt +
    `exports.run = safeOp;\n`
  );
}

/** Holds the partially-built exports object of `./index` and reads `.run` late. */
const WRAP_B =
  `const w = require("./index");\n` +
  `exports.later = function later(x) { return w.run(x); };\n`;

function wrapFiles(
  abrupt: string,
  prelude?: string,
): Readonly<Record<string, string>> {
  return {
    "node_modules/wrap/package.json": JSON.stringify({
      name: "wrap",
      version: "1.0.0",
      main: "index.js",
    }),
    "node_modules/wrap/index.js": wrapIndex(abrupt, prelude),
    "node_modules/wrap/b.js": WRAP_B,
  };
}

const APP =
  `try {\n  require("wrap");\n} catch (e) {\n  // the load may throw; b.js already holds wrap's exports object\n}\n` +
  `const b = require("wrap/b");\n` +
  `b.later("x");\n`;

const POSITIVE_APP =
  APP + `const lib = require("vuln-lib");\nlib.parse("x");\n`;

function packageFiles(): Readonly<Record<string, string>> {
  const dependencies = { "vuln-lib": "1.0.0", wrap: "1.0.0" };
  return {
    "package.json": JSON.stringify(
      { name: "app", version: "1.0.0", dependencies },
      null,
      2,
    ),
    "package-lock.json": JSON.stringify(
      {
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "app", version: "1.0.0", dependencies },
          "node_modules/vuln-lib": { version: "1.0.0" },
          "node_modules/wrap": { version: "1.0.0" },
        },
      },
      null,
      2,
    ),
  };
}

function project(
  wrap: Readonly<Record<string, string>>,
  app: string,
): ProjectSpec {
  return {
    files: {
      ...packageFiles(),
      ...LIB,
      ...wrap,
      [ENTRY]: app,
      "rules.yml": simpleRuleFile({
        id: ADVISORY_ID,
        packageName: "vuln-lib",
        exportName: "parse",
      }),
      "vulntrace.yml": simpleConfigFile({ entrypoints: [ENTRY] }),
    },
  };
}

export function oracleCase(kase: Rwf050Case): OracleCase {
  return {
    id: kase.id,
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand(ENTRY),
    controls: {
      kind: "controls",
      controls: {
        positive: {
          name: "positive-control",
          project: project(wrapFiles(""), POSITIVE_APP),
        },
        negative: {
          name: "negative-control",
          project: project(wrapFiles(""), APP),
        },
      },
    },
    variant: {
      name: "case",
      project: project(wrapFiles(kase.abrupt, kase.prelude), APP),
    },
  };
}

export const ALL_CASES: readonly Rwf050Case[] = [
  // The statement spelling the walk already handles: the contrast.
  {
    id: "stmt.if",
    mechanism: "`if (FLAG) bail();` (statement form, already a cutoff)",
    abrupt: `if (FLAG) bail();\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "op.and",
    mechanism: "`FLAG && bail();`",
    abrupt: `FLAG && bail();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "op.or",
    mechanism: "`!FLAG || bail();`",
    abrupt: `!FLAG || bail();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "op.nullish",
    mechanism: "`(FLAG ? null : 0) ?? bail();`",
    abrupt: `(FLAG ? null : 0) ?? bail();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "op.conditional-then",
    mechanism: "`FLAG ? bail() : 0;`",
    abrupt: `FLAG ? bail() : 0;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "op.conditional-else",
    mechanism: "`!FLAG ? 0 : bail();`",
    abrupt: `!FLAG ? 0 : bail();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "op.and-assign",
    mechanism: "`z &&= bail();` with `let z = FLAG;`",
    prelude: `let z = FLAG;\n`,
    abrupt: `z &&= bail();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "op.or-assign",
    mechanism: "`z ||= bail();` with `let z = !FLAG;`",
    prelude: `let z = !FLAG;\n`,
    abrupt: `z ||= bail();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "op.nullish-assign",
    mechanism: "`z ??= bail();` with `let z = FLAG ? null : 0;`",
    prelude: `let z = FLAG ? null : 0;\n`,
    abrupt: `z ??= bail();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "decl.and",
    mechanism: "`const g = FLAG && bail();` (a declarator's initializer)",
    abrupt: `const g = FLAG && bail();\nvoid g;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "arg.and",
    mechanism: "`void [FLAG && bail()];` (inside a required position)",
    abrupt: `void [FLAG && bail()];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // RWF-026's other refused (MAY) positions, measured alongside.
  {
    id: "other.optional-chain-arg",
    mechanism: "`Math?.max(bail());` (an optional-chain-guarded argument)",
    abrupt: `Math?.max(bail());\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "other.do-while-condition",
    mechanism: "`do {} while (bail());`",
    abrupt: `do {} while (bail());\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "other.for-incrementor",
    mechanism: "`for (let i = 0; i < 1; bail()) {}`",
    abrupt: `for (let i = 0; i < 1; bail()) {}\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Task BL-063: the other module-time MAY positions the MAY cutoff
  // reaches -- class-definition time, a construction, a `switch` case
  // test, a `try` with no `catch` -- each measured against real Node.
  {
    id: "bl063.static-field",
    mechanism: "`class S { static x = FLAG && bail(); }`",
    abrupt: `class S { static x = FLAG && bail(); }\nvoid S;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl063.static-block",
    mechanism: "`class S { static { FLAG && bail(); } }`",
    abrupt: `class S { static { FLAG && bail(); } }\nvoid S;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl063.class-field-key",
    mechanism:
      "`class K { [FLAG && bail()] = 1; }` (an instance field's computed KEY runs at definition time)",
    abrupt: `class K { [FLAG && bail()] = 1; }\nvoid K;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl063.class-method-key",
    mechanism: '`class K { [FLAG ? bail() : "m"]() {} }`',
    abrupt: `class K { [FLAG ? bail() : "m"]() {} }\nvoid K;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl063.object-key",
    mechanism: "`void { [FLAG && bail()]: 1 };`",
    abrupt: `void { [FLAG && bail()]: 1 };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl063.heritage",
    mechanism: "`class H extends (FLAG ? bail() : Object) {}`",
    abrupt: `class H extends (FLAG ? bail() : Object) {}\nvoid H;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl063.new",
    mechanism: "`FLAG && new Bail();` (a construction RWF-028 proves abrupt)",
    prelude: `function Bail() { throw new Error("bail"); }\n`,
    abrupt: `FLAG && new Bail();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl063.switch-case-test",
    mechanism: "`switch (0) { case FLAG && bail(): break; }`",
    abrupt: `switch (0) { case FLAG && bail(): break; }\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl063.try-finally",
    mechanism: "`try { FLAG && bail(); } finally {}` (no `catch`: not caught)",
    abrupt: `try { FLAG && bail(); } finally {}\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Task BL-063: precision controls. Real Node never reaches `bail` at
  // module time here, so `.run` is `safeOp` on every load and the later
  // write keeps its authority.
  {
    id: "bl063.control.function-body",
    mechanism: "`function f() { FLAG && bail(); }` (never called)",
    abrupt: `function f() { FLAG && bail(); }\nvoid f;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl063.control.arrow-body",
    mechanism: "`const f = () => FLAG && bail();` (never called)",
    abrupt: `const f = () => FLAG && bail();\nvoid f;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl063.control.instance-field",
    mechanism:
      "`class I { f = FLAG && bail(); }` (an instance initializer runs per construction; never constructed)",
    abrupt: `class I { f = FLAG && bail(); }\nvoid I;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl063.control.caught",
    mechanism:
      "`try { FLAG && bail(); } catch {}` (caught within the statement)",
    abrupt: `try { FLAG && bail(); } catch {}\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl063.control.for-break",
    mechanism:
      "`for (;; bail()) { break; }` (the incrementor runs only after the body completes; the body always breaks)",
    abrupt: `for (;; bail()) { break; }\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl063.control.do-break",
    mechanism:
      "`do { break; } while (bail());` (the condition runs only after the body completes; the body always breaks)",
    abrupt: `do { break; } while (bail());\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
];
