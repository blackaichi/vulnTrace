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

/**
 * Task A-5b (docs/tasks/A-5b-receiver-member-writes.md): ADR 0008
 * invariant A2 for a METHOD CALL'S RECEIVER (VT-208, PRM-18) -- a resolved
 * method edge only from a receiver bound once to `new C()` (or a stable
 * class, for a static member), through a chain of plain class
 * declarations, and only while no walked file may write the member. Each
 * case against real Node.
 *
 * One shared LOUD fixture, the one tasks A-0 to A-5a use: `vuln-lib`
 * exports `parse` (the rule's target) and `safe` (its inert sibling), both
 * marked with the `hit()` convention and both declared as bound names, so
 * a fabricated attribution resolves loudly to the wrong one.
 *
 * THE VERDICT. A case whose method resolution the authority now refuses or
 * withdraws is `UNKNOWN`. A precision guard keeps the `AFFECTED` the
 * authority still proves, and its negative control the `NOT_AFFECTED`.
 *
 * THE CONTROLS. The negative control is the same program with `CALL`
 * calling `lib.safe` -- or, where the shape itself is what the fix refuses
 * (so `lib.safe` behind it would be `UNKNOWN` too), the case's own
 * `negative` program, which keeps the classes and drops the refused shape.
 * The positive control is the negative control preceded by one direct
 * `lib.parse("x")`.
 */

export const ADVISORY_ID = "GHSA-a5b-receiver-member-writes";
export const TARGET_MARKER = "parse";

const LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `module.exports = { parse, safe };\n`;

export type Finding = "PRM-18";

export type CaseVerdict = "NOT_AFFECTED" | "AFFECTED" | "UNKNOWN";

export interface A5bCase {
  readonly id: string;
  readonly finding: Finding;
  /** One line: the mechanism. */
  readonly mechanism: string;
  /** The application entry, after the prelude binding `lib`. `CALL` is the vulnerable call. */
  readonly source: string;
  /** The negative control's entry, when it is not `source` with `CALL` calling `lib.safe`. */
  readonly negative?: string;
  /** Further project files, `CALL` substituted as in the source. */
  readonly files?: Readonly<Record<string, string>>;
  /** The controls' further files, when they are not `files` with `CALL` calling `lib.safe`. */
  readonly negativeFiles?: Readonly<Record<string, string>>;
  /** Whether real Node calls the target. */
  readonly called: boolean;
  /**
   * The analyzer's verdict on the base commit, measured before the fix (the
   * task file records it). `UNKNOWN` for a regression guard whose shape the
   * base already failed closed on, for a reason other than the authority it
   * exercises.
   */
  readonly base: CaseVerdict;
  /** The sound verdict. */
  readonly expected: CaseVerdict;
}

const PARSE = `lib.parse("x");`;
const SAFE = `lib.safe("x");`;

function substitute(text: string, call: string): string {
  return text.replaceAll("CALL", call);
}

const ENTRY = "src/index.js";

function project(
  app: string,
  call: string,
  files: Readonly<Record<string, string>>,
): ProjectSpec {
  const extra = Object.fromEntries(
    Object.entries(files).map(([file, text]) => [file, substitute(text, call)]),
  );
  return {
    files: {
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
      ...extra,
      [ENTRY]: `const lib = require("vuln-lib");\n` + app,
      "vulntrace.yml": simpleConfigFile({ entrypoints: [ENTRY] }),
    },
  };
}

export function sourceOf(kase: A5bCase): string {
  return substitute(kase.source, PARSE);
}

export function negativeOf(kase: A5bCase): string {
  return substitute(kase.negative ?? kase.source, SAFE);
}

export function oracleCase(kase: A5bCase): OracleCase {
  const negative = negativeOf(kase);
  const controlFiles = kase.negativeFiles ?? kase.files ?? {};
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
          project: project(`${PARSE}\n${negative}`, SAFE, controlFiles),
        },
        negative: {
          name: "negative-control",
          project: project(negative, SAFE, controlFiles),
        },
      },
    },
    variant: {
      name: "case",
      project: project(sourceOf(kase), PARSE, kase.files ?? {}),
    },
  };
}

/** A class whose `run` is inert. */
const SAFE_CLASS = `class Safe {\n  run(x) { return lib.safe(x); }\n}\n`;
/** A class whose `run` makes the vulnerable call. */
const DANGER_CLASS = `class Danger {\n  run(x) { CALL }\n}\n`;
/** The classes alone: the negative control of a case whose shape the fix refuses. */
const CLASSES_ONLY = SAFE_CLASS + DANGER_CLASS + `lib.safe("x");\n`;

// ---------------------------------------------------------------------------
// PRM-18 -- the checker's static type of the receiver stood for its runtime
// value. The five shapes REMEDIATION-PLAN § 5a ("A-5 split") measured, the
// constructor `return` it could not measure, and the shapes that close the
// same gap from the class side.
// ---------------------------------------------------------------------------

export const MEASURED_CASES: readonly A5bCase[] = [
  {
    id: "receiver.let-reassigned-deferred",
    finding: "PRM-18",
    mechanism:
      "`let inst = new Safe()` is reassigned to `new Danger()` by a deferred write before `inst.run()`",
    source:
      SAFE_CLASS +
      DANGER_CLASS +
      `let inst = new Safe();\nfunction swap() { inst = new Danger(); }\nswap();\ninst.run("x");\n`,
    negative: CLASSES_ONLY,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "receiver.this-overridden-by-subclass",
    finding: "PRM-18",
    mechanism:
      "`this.go()` in a base method runs the override of the subclass that is instantiated",
    source:
      `class Base {\n  start(x) { return this.go(x); }\n  go(x) { return lib.safe(x); }\n}\n` +
      `class Sub extends Base {\n  go(x) { CALL }\n}\n` +
      `const s = new Sub();\ns.start("x");\n`,
    negative:
      `class Base {\n  go(x) { return lib.safe(x); }\n}\n` +
      `class Sub extends Base {\n  go(x) { CALL }\n}\n` +
      `lib.safe("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "receiver.instance-member-assigned",
    finding: "PRM-18",
    mechanism: "`inst.run = () => …` replaces the method before `inst.run()`",
    source:
      SAFE_CLASS +
      `const inst = new Safe();\ninst.run = (x) => { CALL };\ninst.run("x");\n`,
    negative: CLASSES_ONLY,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "receiver.base-field-shadows-method",
    finding: "PRM-18",
    mechanism:
      "a base-class field named `run` is an own property of the instance, shadowing the subclass method",
    source:
      `class Base {\n  run = (x) => { CALL };\n}\n` +
      `class Sub extends Base {\n  run(x) { return lib.safe(x); }\n}\n` +
      `const s = new Sub();\ns.run("x");\n`,
    negative:
      `class Base {\n  go = (x) => { CALL };\n}\n` +
      `class Sub extends Base {\n  run(x) { return lib.safe(x); }\n}\n` +
      `lib.safe("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "receiver.static-overwritten-from-third-file",
    finding: "PRM-18",
    mechanism:
      "a third file assigns `Lib.run` before the entry calls the static method",
    source: `require("./patch.js");\nconst { Lib } = require("./lib.js");\nLib.run("x");\n`,
    files: {
      "src/lib.js":
        `const lib = require("vuln-lib");\n` +
        `class Lib {\n  static run(x) { return lib.safe(x); }\n}\nmodule.exports = { Lib };\n`,
      "src/patch.js":
        `const lib = require("vuln-lib");\nconst { Lib } = require("./lib.js");\n` +
        `Lib.run = (x) => { CALL };\n`,
    },
    negativeFiles: {
      "src/lib.js":
        `const lib = require("vuln-lib");\n` +
        `class Lib {\n  static run(x) { return lib.safe(x); }\n}\nmodule.exports = { Lib };\n`,
      "src/patch.js": `require("./lib.js");\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "receiver.constructor-returns-other-object",
    finding: "PRM-18",
    mechanism:
      "a constructor that returns an object makes `new Safe()` evaluate to that object",
    source:
      DANGER_CLASS +
      `class Safe {\n  constructor() { return new Danger(); }\n  run(x) { return lib.safe(x); }\n}\n` +
      `const inst = new Safe();\ninst.run("x");\n`,
    negative: CLASSES_ONLY,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "receiver.same-class-field-shadows-method",
    finding: "PRM-18",
    mechanism:
      "a field and a method named `run` in one class: the field is an own property and wins",
    source:
      `class Safe {\n  run(x) { return lib.safe(x); }\n  run = (x) => { CALL };\n}\n` +
      `const inst = new Safe();\ninst.run("x");\n`,
    negative: CLASSES_ONLY,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "receiver.static-class-binding-reassigned",
    finding: "PRM-18",
    mechanism: "`Safe = Danger` rebinds the class name before `Safe.run()`",
    source:
      `class Safe {\n  static run(x) { return lib.safe(x); }\n}\n` +
      `class Danger {\n  static run(x) { CALL }\n}\n` +
      `Safe = Danger;\nSafe.run("x");\n`,
    negative:
      `class Safe {\n  static run(x) { return lib.safe(x); }\n}\n` +
      `class Danger {\n  static run(x) { CALL }\n}\n` +
      `lib.safe("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "receiver.extends-binding-reassigned",
    finding: "PRM-18",
    mechanism:
      "`Base = Other` before `class Sub extends Base` makes the chain run through `Other`",
    source:
      `class Base {\n  run(x) { return lib.safe(x); }\n}\n` +
      `class Other {\n  run(x) { CALL }\n}\n` +
      `Base = Other;\nclass Sub extends Base {}\nconst s = new Sub();\ns.run("x");\n`,
    negative:
      `class Base {\n  run(x) { return lib.safe(x); }\n}\n` +
      `class Other {\n  run(x) { CALL }\n}\n` +
      `lib.safe("x");\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
];

// ---------------------------------------------------------------------------
// The member writes the whole-graph check must see, beyond a plain
// assignment: the prototype chain itself, a `with` scope, a dynamic key and
// the reflective mutators.
//
// The `__proto__` and `with` writes hand nothing to a builtin, so the base
// certified the call. Every other write here was already `UNKNOWN` on the
// base, for another reason: the replacement function escapes into a
// builtin (or under a key that may be a protocol member) and gets task
// A-3a's / A-4's edge. They are regression guards for the program; the
// scanner's own recognition of each form is tested at the graph level
// (`call-graph.receiver-authority.test.ts`), where no escape edge stands
// in for it.
// ---------------------------------------------------------------------------

export const WRITE_CASES: readonly A5bCase[] = [
  {
    id: "write.proto-assignment",
    finding: "PRM-18",
    mechanism:
      "`inst.__proto__ = Danger.prototype` replaces the whole prototype chain",
    source:
      SAFE_CLASS +
      DANGER_CLASS +
      `const inst = new Safe();\ninst.__proto__ = Danger.prototype;\ninst.run("x");\n`,
    negative: CLASSES_ONLY,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "write.with-scope",
    finding: "PRM-18",
    mechanism:
      "`with (inst) { run = … }` writes `inst.run` through a bare name",
    source:
      SAFE_CLASS +
      DANGER_CLASS +
      `const inst = new Safe();\nconst d = new Danger();\nwith (inst) { run = d.run; }\ninst.run("x");\n`,
    negative: CLASSES_ONLY,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "write.set-prototype-of",
    finding: "PRM-18",
    mechanism:
      "`Object.setPrototypeOf(inst, Danger.prototype)` replaces the prototype chain",
    source:
      SAFE_CLASS +
      DANGER_CLASS +
      `const inst = new Safe();\nObject.setPrototypeOf(inst, Danger.prototype);\ninst.run("x");\n`,
    negative: CLASSES_ONLY,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "write.define-property-on-prototype",
    finding: "PRM-18",
    mechanism:
      '`Object.defineProperty(Safe.prototype, "run", …)` replaces the method',
    source:
      SAFE_CLASS +
      DANGER_CLASS +
      `const d = new Danger();\nObject.defineProperty(Safe.prototype, "run", { value: d.run });\n` +
      `const inst = new Safe();\ninst.run("x");\n`,
    negative: CLASSES_ONLY,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "write.aliased-define-property",
    finding: "PRM-18",
    mechanism:
      "`const { defineProperty } = Object` is the same mutator under a local name",
    source:
      SAFE_CLASS +
      DANGER_CLASS +
      `const { defineProperty } = Object;\nconst d = new Danger();\n` +
      `defineProperty(Safe.prototype, "run", { value: d.run });\n` +
      `const inst = new Safe();\ninst.run("x");\n`,
    negative: CLASSES_ONLY,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "write.object-assign-prototype",
    finding: "PRM-18",
    mechanism:
      "`Object.assign(Safe.prototype, { run: d.run })` replaces the method",
    source:
      SAFE_CLASS +
      DANGER_CLASS +
      `const d = new Danger();\nObject.assign(Safe.prototype, { run: d.run });\n` +
      `const inst = new Safe();\ninst.run("x");\n`,
    negative: CLASSES_ONLY,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "write.reflect-set",
    finding: "PRM-18",
    mechanism: '`Reflect.set(inst, "run", d.run)` writes the member',
    source:
      SAFE_CLASS +
      DANGER_CLASS +
      `const d = new Danger();\nconst inst = new Safe();\nReflect.set(inst, "run", d.run);\ninst.run("x");\n`,
    negative: CLASSES_ONLY,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "write.dynamic-key",
    finding: "PRM-18",
    mechanism: "`inst[key] = d.run` with a key the analyzer cannot read",
    source:
      SAFE_CLASS +
      DANGER_CLASS +
      `const d = new Danger();\nconst inst = new Safe();\nconst key = ["r", "un"].join("");\ninst[key] = d.run;\ninst.run("x");\n`,
    negative: CLASSES_ONLY,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "write.define-getter",
    finding: "PRM-18",
    mechanism:
      '`inst.__defineGetter__("run", …)` defines an accessor that shadows the method',
    source:
      SAFE_CLASS +
      DANGER_CLASS +
      `const d = new Danger();\nconst inst = new Safe();\ninst.__defineGetter__("run", () => d.run);\ninst.run("x");\n`,
    negative: CLASSES_ONLY,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
];

// ---------------------------------------------------------------------------
// Precision guards: what the authority keeps. Each also has a negative
// control (`CALL` calling `lib.safe`) that must stay NOT_AFFECTED, which
// proves the method edge itself survives -- an unknown edge would make it
// UNKNOWN.
// ---------------------------------------------------------------------------

export const GUARD_CASES: readonly A5bCase[] = [
  {
    id: "guard.const-new-instance",
    finding: "PRM-18",
    mechanism: "`const d = new Danger(); d.run()` (ADV2-021's neighbour)",
    source: DANGER_CLASS + `const d = new Danger();\nd.run("x");\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "guard.static-stable-class",
    finding: "PRM-18",
    mechanism: "`Lib.run()` on a stable class (ADR 0008 § 4, ADV2-021)",
    source: `class Lib {\n  static run(x) { CALL }\n}\nLib.run("x");\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "guard.inherited-method",
    finding: "PRM-18",
    mechanism: "a method inherited through a chain of plain classes (VT-216)",
    source:
      `class Base {\n  run(x) { CALL }\n}\nclass Sub extends Base {}\n` +
      `const s = new Sub();\ns.run("x");\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "guard.imported-class",
    finding: "PRM-18",
    mechanism: "an instance of a class required from another file",
    source: `const { Danger } = require("./danger.js");\nconst d = new Danger();\nd.run("x");\n`,
    files: {
      "src/danger.js":
        `const lib = require("vuln-lib");\n` +
        `class Danger {\n  run(x) { CALL }\n}\nmodule.exports = { Danger };\n`,
    },
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "guard.other-member-written",
    finding: "PRM-18",
    mechanism: "a write to a member of another name does not withdraw the edge",
    source:
      DANGER_CLASS +
      `const d = new Danger();\nconst o = {};\no.other = 1;\nd.run("x");\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
];

// ---------------------------------------------------------------------------
// Task A-5b's independent audit (BLOCKED, two findings, both fixed): a
// `__proto__` key copied by `Object.assign`, and a class export slot
// written through the exports object.
// ---------------------------------------------------------------------------

const STATIC_SAFE_DANGER =
  `class Safe {\n  static run(x) { return lib.safe(x); }\n}\n` +
  `class Danger {\n  static run(x) { CALL }\n}\n` +
  `class Sub extends Safe {}\n`;

const LIB_WITH_EVIL =
  `const lib = require("vuln-lib");\n` +
  `class Lib {\n  static run(x) { return lib.safe(x); }\n}\n` +
  `class Evil {\n  static run(x) { CALL }\n  run(x) { CALL }\n}\n` +
  `function swap() { module.exports.Lib = module.exports.Evil; }\n` +
  `module.exports = { Lib, Evil, swap };\n`;

const LIB_WITHOUT_SWAP =
  `const lib = require("vuln-lib");\n` +
  `class Lib {\n  static run(x) { return lib.safe(x); }\n}\n` +
  `module.exports = { Lib };\n`;

export const AUDIT_CASES: readonly A5bCase[] = [
  {
    id: "audit.assign-computed-proto-key",
    finding: "PRM-18",
    mechanism:
      '`Object.assign(Sub, { ["__proto__"]: Danger })` runs the `__proto__` setter on `Sub`',
    source:
      STATIC_SAFE_DANGER +
      `Object.assign(Sub, { ["__proto__"]: Danger });\nSub.run("x");\n`,
    negative: STATIC_SAFE_DANGER + `lib.safe("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.assign-shorthand-proto-key",
    finding: "PRM-18",
    mechanism:
      "`Object.assign(Sub, { __proto__ })`: a shorthand `__proto__` is an own property, copied through the setter",
    source:
      STATIC_SAFE_DANGER +
      `const __proto__ = Danger;\nObject.assign(Sub, { __proto__ });\nSub.run("x");\n`,
    negative: STATIC_SAFE_DANGER + `lib.safe("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.export-slot-written-same-file",
    finding: "PRM-18",
    mechanism:
      "`m.Lib = m.Evil` replaces the class export before `m.Lib.run()`",
    source: `const m = require("./lib.js");\nm.Lib = m.Evil;\nm.Lib.run("x");\n`,
    files: { "src/lib.js": LIB_WITH_EVIL },
    negative: `const m = require("./lib.js");\nm.Lib.run("x");\n`,
    negativeFiles: { "src/lib.js": LIB_WITHOUT_SWAP },
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "audit.export-slot-written-deferred",
    finding: "PRM-18",
    mechanism:
      "the defining module's `swap()` writes `module.exports.Lib` before `m.Lib.run()`",
    source: `const m = require("./lib.js");\nm.swap();\nm.Lib.run("x");\n`,
    files: { "src/lib.js": LIB_WITH_EVIL },
    negative: `const m = require("./lib.js");\nm.Lib.run("x");\n`,
    negativeFiles: { "src/lib.js": LIB_WITHOUT_SWAP },
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "audit.export-slot-written-destructured",
    finding: "PRM-18",
    mechanism:
      "`swap()` runs before `const { Lib } = require(…)` reads the replaced export",
    source: `require("./lib.js").swap();\nconst { Lib } = require("./lib.js");\nLib.run("x");\n`,
    files: { "src/lib.js": LIB_WITH_EVIL },
    negative: `const { Lib } = require("./lib.js");\nLib.run("x");\n`,
    negativeFiles: { "src/lib.js": LIB_WITHOUT_SWAP },
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "audit.export-slot-written-instance",
    finding: "PRM-18",
    mechanism:
      "an instance of the replaced export: `new Lib()` constructs `Evil`",
    source: `require("./lib.js").swap();\nconst { Lib } = require("./lib.js");\nconst i = new Lib();\ni.run("x");\n`,
    files: { "src/lib.js": LIB_WITH_EVIL },
    negative: `const { Lib } = require("./lib.js");\nLib.run("x");\n`,
    negativeFiles: { "src/lib.js": LIB_WITHOUT_SWAP },
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
];

export const ALL_CASES: readonly A5bCase[] = [
  ...MEASURED_CASES,
  ...WRITE_CASES,
  ...GUARD_CASES,
  ...AUDIT_CASES,
];
