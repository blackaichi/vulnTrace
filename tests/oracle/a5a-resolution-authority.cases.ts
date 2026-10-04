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
import type { VerdictObservation } from "../../src/testing/open-soundness-defect.js";

/**
 * Task A-5a (docs/tasks/A-5a-resolution-authority.md): ADR 0008 invariant
 * A2 on the call-graph side -- a RESOLVED edge only from an authority that
 * proves the callee denotes exactly one function at that site on every
 * execution -- and the two no-edge branches A-1 left unproven. Each case
 * against real Node.
 *
 * One shared LOUD fixture, the one tasks A-0 to A-4 use: `vuln-lib`
 * exports `parse` (the rule's target) and `safe` (its inert sibling), both
 * marked with the `hit()` convention and both declared as bound names, so
 * a fabricated attribution resolves loudly to the wrong one.
 *
 * THE VERDICT. A case whose resolution an authority now refuses is
 * `UNKNOWN` (an unknown edge stands where the false resolved one was). A
 * case whose branch or callee the base dropped and the fix restores with a
 * proven resolved edge (`==` across types, a shadowed `require`) is
 * `AFFECTED`. A precision guard keeps the verdict an authority still
 * proves.
 *
 * THE CONTROLS. The negative control is the same program with `CALL`
 * calling `lib.safe` -- or, where the shape itself is what the fix refuses
 * (so `lib.safe` behind it would be `UNKNOWN` too), the case's own
 * `negative` program, which keeps the code and drops the refused shape.
 * The positive control is the negative control preceded by one direct
 * `lib.parse("x")`.
 */

export const ADVISORY_ID = "GHSA-a5a-resolution-authority";
export const TARGET_MARKER = "parse";

const LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `module.exports = { parse, safe };\n`;

export type Finding =
  | "PRM-13"
  | "PRM-14"
  | "PRM-15"
  | "PRM-16"
  | "PRM-17"
  | "RWF-071"
  | "RWF-072"
  | "PRM-104";

export type CaseVerdict = "NOT_AFFECTED" | "AFFECTED" | "UNKNOWN";

export interface A5Case {
  readonly id: string;
  readonly finding: Finding;
  /** One line: the mechanism. */
  readonly mechanism: string;
  /** The application entry, after the prelude binding `lib`. `CALL` is the vulnerable call. */
  readonly source: string;
  /** The negative control's entry, when it is not `source` with `CALL` calling `lib.safe`. */
  readonly negative?: string;
  /** The entry file (default `src/index.js`); an `.mjs` entry binds `lib` with `import`. */
  readonly entry?: string;
  /** Further project files, `CALL` substituted as in the source. */
  readonly files?: Readonly<Record<string, string>>;
  /** The controls' further files, when they are not `files` with `CALL` calling `lib.safe`. */
  readonly negativeFiles?: Readonly<Record<string, string>>;
  /**
   * Set when the analyzer's live verdict is still wrong, for a reason this
   * task does not own: an open-soundness-defect record, never an
   * expectation (`expected` stays standing).
   */
  readonly openDefect?: {
    readonly rwf: string;
    readonly observed: VerdictObservation;
  };
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

function project(
  kase: A5Case,
  app: string,
  call: string,
  files: Readonly<Record<string, string>> = kase.files ?? {},
): ProjectSpec {
  const entry = kase.entry ?? "src/index.js";
  const prelude = entry.endsWith(".mjs")
    ? `import lib from "vuln-lib";\n`
    : `const lib = require("vuln-lib");\n`;
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
      [entry]: prelude + app,
      "vulntrace.yml": simpleConfigFile({ entrypoints: [entry] }),
    },
  };
}

export function sourceOf(kase: A5Case): string {
  return substitute(kase.source, PARSE);
}

export function negativeOf(kase: A5Case): string {
  return substitute(kase.negative ?? kase.source, SAFE);
}

export function oracleCase(kase: A5Case): OracleCase {
  const negative = negativeOf(kase);
  const controlFiles = kase.negativeFiles ?? kase.files;
  return {
    id: kase.id,
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand(kase.entry ?? "src/index.js"),
    controls: {
      kind: "controls",
      controls: {
        positive: {
          name: "positive-control",
          project: project(kase, `${PARSE}\n${negative}`, SAFE, controlFiles),
        },
        negative: {
          name: "negative-control",
          project: project(kase, negative, SAFE, controlFiles),
        },
      },
    },
    variant: { name: "case", project: project(kase, sourceOf(kase), PARSE) },
  };
}

// ---------------------------------------------------------------------------
// PRM-13 -- VT-213: one inline callback displaced an unattributable
// callee's unknown edge with a resolved edge to the callback
// ---------------------------------------------------------------------------

const PICK = `function pick() { return lib; }\n`;

export const VT213_CASES: readonly A5Case[] = [
  {
    id: "vt213.unattributable-callee-displaced",
    finding: "PRM-13",
    mechanism:
      "a call result's member is called with one inline callback; the callee is the target",
    source: PICK + `pick().parse("x", () => 0);\n`,
    negative: PICK + `pick();\nlib.safe("x", () => 0);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "vt213.parameter-callee-displaced",
    finding: "PRM-13",
    mechanism:
      "a parameter is called with one inline callback; the argument passed for it is the target",
    source: `function run(cb) { return cb(() => 0); }\nrun(lib.parse);\n`,
    negative: `function run(cb) { return 0; }\nrun(lib.safe);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "vt213.callback-never-called",
    finding: "PRM-13",
    mechanism:
      "the one inline callback is handed to a callee that never calls it (a fabricated resolved edge)",
    source: `function run(cb) { cb(() => { CALL }); }\nrun(function never(f) {});\n`,
    negative: `function run(cb) { return 0; }\nrun(function never(f) {});\n`,
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
];

// ---------------------------------------------------------------------------
// PRM-14 -- VT-211: loose equality folded as strict, a live branch pruned
// ---------------------------------------------------------------------------

export const FOLDING_CASES: readonly A5Case[] = [
  {
    id: "fold.loose-equality-cross-type",
    finding: "PRM-14",
    mechanism: '`1 == "1"` is true; the base folded it as `1 === "1"`',
    source: `if (1 == "1") {\n  CALL\n}\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "fold.loose-inequality-cross-type",
    finding: "PRM-14",
    mechanism: '`1 != "1"` is false, so the else branch runs',
    source: `if (1 != "1") {\n  lib.safe("y");\n} else {\n  CALL\n}\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "fold.loose-equality-empty-string",
    finding: "PRM-14",
    mechanism: '`0 == ""` is true (ToNumber of the empty string)',
    source: `if (0 == "") {\n  CALL\n}\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "fold.strict-same-type-pruned",
    finding: "PRM-14",
    mechanism:
      "precision guard: `1 === 2` is a proof, the branch is still pruned",
    source: `if (1 === 2) {\n  CALL\n}\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "fold.loose-same-type-pruned",
    finding: "PRM-14",
    mechanism:
      'precision guard: `"a" == "b"` on two strings is strict equality, a proof',
    source: `if ("a" == "b") {\n  CALL\n}\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
];

// ---------------------------------------------------------------------------
// PRM-15 -- a static `require("x")` recognised by spelling
// ---------------------------------------------------------------------------

const UTIL_EMPTY = { "src/util.js": `module.exports = {};\n` };

export const REQUIRE_CASES: readonly A5Case[] = [
  {
    id: "require.local-function-shadow",
    finding: "PRM-15",
    mechanism:
      "a function-local `function require` is called with a literal; it calls the target",
    source: `function main() {\n  function require(name) { CALL return name; }\n  return require("./util.js");\n}\nmain();\n`,
    files: UTIL_EMPTY,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "require.local-const-shadow",
    finding: "PRM-15",
    mechanism: "a block-scoped `const require` arrow, called with a literal",
    source: `function main() {\n  const require = (name) => { CALL return name; };\n  return require("./util.js");\n}\nmain();\n`,
    files: UTIL_EMPTY,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "require.parameter-shadow",
    finding: "PRM-15",
    mechanism:
      "a parameter named `require` holds the target and is called with a literal",
    source: `function load(require) { return require("./util.js"); }\nload(lib.parse);\n`,
    negative: `function load(require) { return 0; }\nload(lib.safe);\n`,
    files: UTIL_EMPTY,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "require.shadow-binding",
    finding: "PRM-15",
    mechanism:
      '`const m = require("./util.js")` through a local `require` that returns `lib`: `m.parse` is the target, not util.js\'s export',
    source: `function main() {\n  function require(name) { return lib; }\n  const m = require("./util.js");\n  m.parse("x");\n}\nmain();\n`,
    negative: `function main() {\n  function require(name) { return lib; }\n  const m = require("./util.js");\n  return m;\n}\nmain();\n`,
    files: {
      "src/util.js": `function parse(x) { return "local"; }\nfunction safe(x) { return "local"; }\nmodule.exports = { parse, safe };\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];

// ---------------------------------------------------------------------------
// PRM-16 / PRM-17 -- VT-210: a higher-order parameter's every call site
// ---------------------------------------------------------------------------

const HELPER = `function helper(x) { return lib.safe(x); }\n`;
const EACH = `function each(fn, x) { return fn(x); }\n`;

export const VT210_CASES: readonly A5Case[] = [
  {
    id: "vt210.exported-commonjs",
    finding: "PRM-16",
    mechanism:
      "an exported higher-order function, called once in its own file; another file passes the target",
    source: `const u = require("./util.js");\nu.each(lib.parse, "x");\n`,
    negative: `const u = require("./util.js");\n`,
    files: {
      "src/util.js": `const lib = require("vuln-lib");\n${HELPER}${EACH}function init() { return each(helper, 1); }\ninit();\nmodule.exports = { each, init };\n`,
    },
    negativeFiles: {
      "src/util.js": `const lib = require("vuln-lib");\n${HELPER}${EACH}function init() { return each(helper, 1); }\nmodule.exports = { each, init };\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "vt210.exported-esm",
    finding: "PRM-16",
    mechanism: "an `export function` higher-order function, the same shape",
    entry: "src/index.mjs",
    source: `import { each } from "./util.mjs";\neach(lib.parse, "x");\n`,
    negative: `import { each } from "./util.mjs";\n`,
    files: {
      "src/util.mjs": `import lib from "vuln-lib";\n${HELPER}export ${EACH}each(helper, 1);\n`,
    },
    negativeFiles: {
      "src/util.mjs": `import lib from "vuln-lib";\n${HELPER}export ${EACH}`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "vt210.aliased-value",
    finding: "PRM-16",
    mechanism:
      "the function escapes as a value (`const g = each`) and is called through the alias",
    source: `${HELPER}${EACH}each(helper, 1);\nconst g = each;\ng(lib.parse, "x");\n`,
    negative: `${HELPER}${EACH}each(helper, 1);\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "vt210.call-method",
    finding: "PRM-16",
    mechanism:
      "the function is called through `.call`, which is not a call site of its name",
    source: `${HELPER}${EACH}each(helper, 1);\neach.call(null, lib.parse, "x");\n`,
    negative: `${HELPER}${EACH}each(helper, 1);\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "vt210.reassigned-default-by-or",
    finding: "PRM-17",
    mechanism: "`fn = fn || lib.parse` inside the body, one call omits it",
    source: `${HELPER}function invoke(fn) { fn = fn || lib.parse; return fn("x"); }\ninvoke(helper);\ninvoke();\n`,
    negative: `${HELPER}function invoke(fn) { return fn("x"); }\ninvoke(helper);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "vt210.reassigned-plain",
    finding: "PRM-17",
    mechanism: "`fn = lib.parse` inside the body",
    source: `${HELPER}function invoke(fn) { fn = lib.parse; return fn("x"); }\ninvoke(helper);\n`,
    negative: `${HELPER}function invoke(fn) { return fn("x"); }\ninvoke(helper);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "vt210.reassigned-in-closure",
    finding: "PRM-17",
    mechanism: "a closure in the body writes the parameter before the call",
    source: `${HELPER}function invoke(fn) { (() => { fn = lib.parse; })(); return fn("x"); }\ninvoke(helper);\n`,
    negative: `${HELPER}function invoke(fn) { return fn("x"); }\ninvoke(helper);\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "vt210.reassigned-by-destructuring",
    finding: "PRM-17",
    mechanism: "`[fn] = [lib.parse]` inside the body",
    source: `${HELPER}function invoke(fn) { [fn] = [lib.parse]; return fn("x"); }\ninvoke(helper);\n`,
    negative: `${HELPER}function invoke(fn) { return fn("x"); }\ninvoke(helper);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "vt210.arguments-alias",
    finding: "PRM-17",
    mechanism:
      "sloppy-mode `arguments[0] = lib.parse` rewrites the parameter it aliases",
    source: `${HELPER}function invoke(a) { arguments[0] = lib.parse; return a("x"); }\ninvoke(helper);\n`,
    negative: `${HELPER}function invoke(a) { return a("x"); }\ninvoke(helper);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "vt210.unique-local-caller",
    finding: "PRM-16",
    mechanism:
      "precision guard: a file-local function, every call site passing the same imported function, no write",
    source: `const { parse: target } = require("vuln-lib");\nfunction invoke(fn) { return fn("x"); }\ninvoke(target);\n`,
    negative: `const { safe: target } = require("vuln-lib");\nfunction invoke(fn) { return fn("x"); }\ninvoke(target);\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "vt210.spread-before-position",
    finding: "RWF-071",
    mechanism:
      "a spread argument before the parameter's position shifts it: `fn` is the spread's second element, not the identifier written second",
    source: `${HELPER}function each(x, fn) { return fn(x); }\neach(...["x", lib.parse], helper);\n`,
    negative: `${HELPER}function each(x, fn) { return fn(x); }\neach("x", helper);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];

// ---------------------------------------------------------------------------
// PRM-104 -- a reassigned `function` declaration resolved to its stale body
// ---------------------------------------------------------------------------

const RUN_SAFE = `function run(x) { return lib.safe(x); }\n`;

export const FUNCTION_DECLARATION_CASES: readonly A5Case[] = [
  {
    id: "function-declaration.reassigned",
    finding: "PRM-104",
    mechanism: "`run = lib.parse` before `run(...)`",
    source: `${RUN_SAFE}run = lib.parse;\nrun("x");\n`,
    negative: `${RUN_SAFE}run("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "function-declaration.deferred-write",
    finding: "PRM-104",
    mechanism: "a function called before `run(...)` reassigns it",
    source: `${RUN_SAFE}function setup() { run = lib.parse; }\nsetup();\nrun("x");\n`,
    negative: `${RUN_SAFE}function setup() { return 0; }\nsetup();\nrun("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "function-declaration.exported-reassigned",
    finding: "PRM-104",
    mechanism:
      "a reassigned function declaration exported by name and called from another file",
    source: `const m = require("./util.js");\nm.run("x");\n`,
    files: {
      "src/util.js": `const lib = require("vuln-lib");\n${RUN_SAFE}run = lib.parse;\nmodule.exports = { run };\n`,
    },
    negativeFiles: {
      "src/util.js": `const lib = require("vuln-lib");\n${RUN_SAFE}module.exports = { run };\n`,
    },
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
];

// ---------------------------------------------------------------------------
// ADR 0008 § 4's receiver-bound documented invoking builtins (the project
// owner's decision of 2026-10-04): a resolved edge only where the receiver
// is proven. VT-213 covered these shapes on no authority, so its deletion
// alone turned ADV2-018 / ADV2-024 into UNKNOWN, and on the base it also
// fabricated AFFECTED for a callback the builtin never runs.
// ---------------------------------------------------------------------------

export const RECEIVER_BOUND_CASES: readonly A5Case[] = [
  {
    id: "receiver.array-literal-map-inline",
    finding: "PRM-13",
    mechanism:
      "precision guard (ADV2-018's shape): a non-empty array literal's map runs its inline callback",
    source: `[1, 2, 3].map(() => { CALL });\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "receiver.array-literal-forEach-named",
    finding: "PRM-13",
    mechanism:
      "a non-empty array literal's forEach runs a named callback (an unknown edge on the base)",
    source: `function cb(x) { CALL return x; }\n[1].forEach(cb);\n`,
    called: true,
    base: "UNKNOWN",
    expected: "AFFECTED",
  },
  {
    id: "receiver.array-literal-empty",
    finding: "PRM-13",
    mechanism: "an EMPTY array literal's map never runs its callback",
    source: `[].map(() => { CALL });\n`,
    negative: `const kept = () => { CALL };\n`,
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "receiver.array-literal-hole",
    finding: "PRM-13",
    mechanism: "map skips a hole: `[,].map(cb)` never runs cb",
    source: `[,].map(() => { CALL });\n`,
    negative: `const kept = () => { CALL };\n`,
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "receiver.array-literal-reduce-single",
    finding: "PRM-13",
    mechanism:
      "reduce on one element with no initial value returns it without a call",
    source: `[1].reduce(() => { CALL });\n`,
    negative: `const kept = () => { CALL };\n`,
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "receiver.array-literal-map-patched-in-file",
    finding: "PRM-13",
    mechanism:
      "the file replaces Array.prototype.map with one that never runs its callback",
    source: `Array.prototype.map = function () { return []; };\n[1].map(() => { CALL });\n`,
    negative: `const kept = () => { CALL };\n`,
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "receiver.promise-resolve-then",
    finding: "PRM-13",
    mechanism:
      "precision guard (ADV2-024's shape): Promise.resolve().then runs its callback",
    source: `Promise.resolve().then(() => { CALL });\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "receiver.promise-resolve-catch",
    finding: "PRM-13",
    mechanism: "a fulfilled promise never runs catch's callback",
    source: `Promise.resolve().catch(() => { CALL });\n`,
    negative: `const kept = () => { CALL };\n`,
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "receiver.promise-resolve-thenable",
    finding: "PRM-13",
    mechanism:
      "Promise.resolve of a thenable that never settles: then's callback never runs",
    source: `Promise.resolve({ then() {} }).then(() => { CALL });\n`,
    negative: `const kept = () => { CALL };\n`,
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "receiver.promise-reject-catch",
    finding: "PRM-13",
    mechanism: "Promise.reject(…).catch runs its callback",
    source: `Promise.reject(1).catch(() => { CALL });\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
];

// ---------------------------------------------------------------------------
// Task A-5a's independent audit: forms the first version's refusals missed
// ---------------------------------------------------------------------------

export const AUDIT_CASES: readonly A5Case[] = [
  {
    id: "audit.parenthesized-parameter-write",
    finding: "PRM-17",
    mechanism: "`(fn) = lib.parse` writes the parameter through parentheses",
    source: `${HELPER}function invoke(fn) { (fn) = lib.parse; return fn("x"); }\ninvoke(helper);\n`,
    negative: `${HELPER}function invoke(fn) { return fn("x"); }\ninvoke(helper);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.parenthesized-destructuring-parameter-write",
    finding: "PRM-17",
    mechanism: "`[(fn)] = [lib.parse]`",
    source: `${HELPER}function invoke(fn) { [(fn)] = [lib.parse]; return fn("x"); }\ninvoke(helper);\n`,
    negative: `${HELPER}function invoke(fn) { return fn("x"); }\ninvoke(helper);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.parenthesized-function-declaration-write",
    finding: "PRM-104",
    mechanism: "`(run) = lib.parse` reassigns a function declaration",
    source: `${RUN_SAFE}(run) = lib.parse;\nrun("x");\n`,
    negative: `${RUN_SAFE}run("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.wrapper-arguments-rebinds-require",
    finding: "PRM-15",
    mechanism:
      "`arguments[1] = f` in the CommonJS module scope rebinds the wrapper's require",
    source: `arguments[1] = function () { return lib; };\nconst m = require("./util.js");\nm.parse("x");\n`,
    negative: `const m = require("./util.js");\nm.parse("x");\n`,
    files: {
      "src/util.js": `function parse(x) { return "local"; }\nfunction safe(x) { return "local"; }\nmodule.exports = { parse, safe };\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.esm-global-require",
    finding: "PRM-15",
    mechanism:
      "in an ES module a bare require is a global lookup another module sets",
    entry: "src/index.mjs",
    source: `import "./setup.mjs";\nimport "./b.mjs";\n`,
    files: {
      "src/setup.mjs": `import lib from "vuln-lib";\nglobalThis.require = function () { return lib; };\n`,
      "src/b.mjs": `const m = require("./util.cjs");\nm.parse("x");\n`,
      "src/util.cjs": `function parse(x) { return "local"; }\nfunction safe(x) { return "local"; }\nmodule.exports = { parse, safe };\n`,
    },
    negativeFiles: {
      "src/setup.mjs": `import lib from "vuln-lib";\nexport const kept = lib;\n`,
      "src/b.mjs": `export const b = 1;\n`,
      "src/util.cjs": `module.exports = {};\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.top-level-await-global-require",
    finding: "PRM-15",
    mechanism:
      "a .js file with a top-level await runs as an ES module (syntax detection): its bare require is a global lookup",
    entry: "src/index.mjs",
    source: `import "./setup.mjs";\nimport "./b.js";\n`,
    files: {
      "src/setup.mjs": `import lib from "vuln-lib";\nglobalThis.require = function () { return lib; };\n`,
      "src/b.js": `await 0;\nconst m = require("./util.js");\nm.parse("x");\n`,
      "src/util.js": `function parse(x) { return "local"; }\nfunction safe(x) { return "local"; }\nmodule.exports = { parse, safe };\n`,
    },
    negativeFiles: {
      "src/setup.mjs": `import lib from "vuln-lib";\nexport const kept = lib;\n`,
      "src/b.js": `await 0;\n`,
      "src/util.js": `module.exports = {};\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.wrapper-redeclaration-global-require",
    finding: "PRM-15",
    mechanism:
      "a top-level `const module` is a redeclaration error in the CommonJS wrapper, so Node runs the .js file as an ES module: its bare require is a global lookup",
    entry: "src/index.mjs",
    source: `import "./setup.mjs";\nimport "./b.js";\n`,
    files: {
      "src/setup.mjs": `import lib from "vuln-lib";\nglobalThis.require = function () { return lib; };\n`,
      "src/b.js": `const module = 1;\nconst m = require("./util.js");\nm.parse("x");\n`,
      "src/util.js": `function parse(x) { return "local"; }\nfunction safe(x) { return "local"; }\nmodule.exports = { parse, safe };\n`,
    },
    negativeFiles: {
      "src/setup.mjs": `import lib from "vuln-lib";\nexport const kept = lib;\n`,
      "src/b.js": `const module = 1;\n`,
      "src/util.js": `module.exports = {};\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];

export const MEMBER_WRITE_CASES: readonly A5Case[] = [
  {
    id: "member-write.destructuring-target",
    finding: "RWF-072",
    mechanism:
      "`[o.run] = [lib.parse]` writes the member VT-214 resolves `o.run()` from",
    source: `${HELPER}const o = { run: helper };\n[o.run] = [lib.parse];\no.run("x");\n`,
    negative: `${HELPER}const o = { run: helper };\no.run("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "member-write.for-of-target",
    finding: "RWF-072",
    mechanism: "`for (o.run of [lib.parse])` writes the member",
    source: `${HELPER}const o = { run: helper };\nfor (o.run of [lib.parse]) {}\no.run("x");\n`,
    negative: `${HELPER}const o = { run: helper };\no.run("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];

export const ALL_CASES: readonly A5Case[] = [
  ...VT213_CASES,
  ...FOLDING_CASES,
  ...REQUIRE_CASES,
  ...VT210_CASES,
  ...FUNCTION_DECLARATION_CASES,
  ...RECEIVER_BOUND_CASES,
  ...AUDIT_CASES,
  ...MEMBER_WRITE_CASES,
];
