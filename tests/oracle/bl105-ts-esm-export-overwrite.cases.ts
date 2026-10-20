import ts from "typescript";
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
import type { CaseVerdict } from "./e1-export-write-set.cases.js";

/**
 * Task BL-105 (docs/tasks/BL-105-ts-esm-export-overwrite.md): a
 * TypeScript ES module's own export overwritten through the module's
 * `exports` object, against real Node (FINDINGS RWF-150).
 *
 * TypeScript compiles a module with ES syntax to CommonJS: an exported
 * declaration is published as `exports.dec = dec` and an importer reads
 * the property at each use (`(0, decs_1.dec)()`). A write the program
 * itself makes onto `exports` -- through a cast (`(exports as any).dec`),
 * an alias (`const e: any = exports; e.dec`), `module.exports` -- replaces
 * what the importer reads. The analyzer bound the import to the declared
 * function (class A, AGENTS.md § F) and collapsed the export's values to
 * it (class C).
 *
 * `src/decs.ts` is the exporting module; `src/impl.ts` imports from it and
 * is loaded by the entrypoint `src/index.ts` (`import "./impl"`), as tasks
 * BL-095's, BL-099's and BL-100's cases are. The loud fixture `vuln-lib`
 * exports `parse` and `safe`; the controls are task A-1's (the positive
 * control's entrypoint calls `lib.parse("x")` first; the negative control
 * is the case with `lib.safe` for `lib.parse`).
 *
 * `base` is the analyzer's verdict on BL-105's base `05996e1` (BL-100's
 * merge), measured. A case with `base: "NOT_AFFECTED"` and `called: true`
 * is a live false `NOT_AFFECTED` this task closes; one with
 * `base: "AFFECTED"` and `called: false` is a fabricated edge it closes.
 * `masked.*` were already `UNKNOWN` on the base through the escape row's
 * possible edge to the stored function, with the fabricated resolved edge
 * to the declared one still in the graph; `cjs.*` were `UNKNOWN` through
 * the cast taken as an un-enumerable reference; `control.*` keep their
 * precision; `cost.*` is precision given up and `gain.*` precision won,
 * measured.
 */
export interface Bl105Case {
  readonly id: string;
  readonly finding: string;
  readonly mechanism: string;
  /** `src/decs.ts` after `import lib = require("vuln-lib");`. */
  readonly decs: (hook: "parse" | "safe") => string;
  /** `src/impl.ts` after `import lib = require("vuln-lib");`. */
  readonly program: string;
  /** Compile with `experimentalDecorators`. */
  readonly legacyDecorators?: true;
  /**
   * Why no negative control can be `NOT_AFFECTED` once the case is sound
   * (task H-0's `ControlsDeclaration`).
   */
  readonly controlsInapplicable?: string;
  readonly called: boolean;
  readonly base: CaseVerdict;
  readonly expected: CaseVerdict;
}

const ADVISORY_ID = "GHSA-bl105-ts-esm-export-overwrite";

const LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `module.exports = { parse, safe };\n`;

function project(
  kase: Bl105Case,
  hook: "parse" | "safe",
  direct: boolean,
): ProjectSpec {
  const lib = `import lib = require("vuln-lib");\n`;
  const decs = `${lib}${kase.decs(hook)}`;
  const impl = `${lib}${kase.program}export {};\n`;
  const index =
    (direct ? `${lib}lib.parse("x");\n` : "") +
    `import "./impl";\nexport {};\n`;
  const legacy = kase.legacyDecorators === true;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    experimentalDecorators: legacy,
  };
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
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "commonjs",
          target: "es2020",
          experimentalDecorators: legacy,
        },
      }),
      "src/index.ts": index,
      "src/impl.ts": impl,
      "src/decs.ts": decs,
      "dist/index.js": compileTypeScript(index, "index.ts", options),
      "dist/impl.js": compileTypeScript(impl, "impl.ts", options),
      "dist/decs.js": compileTypeScript(decs, "decs.ts", options),
      "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.ts"] }),
    },
  };
}

export function bl105OracleCase(kase: Bl105Case): OracleCase {
  return {
    id: kase.id,
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand("dist/index.js"),
    controls:
      kase.controlsInapplicable !== undefined
        ? { kind: "inapplicable", reason: kase.controlsInapplicable }
        : {
            kind: "controls",
            controls: {
              positive: {
                name: "positive-control",
                project: project(kase, "safe", true),
              },
              negative: {
                name: "negative-control",
                project: project(kase, "safe", false),
              },
            },
          },
    variant: { name: "case", project: project(kase, "parse", false) },
  };
}

/** The declared `dec` calls `lib.safe`; the overwriting write `<target>.dec = <value>` stores one that calls `lib.<hook>`. */
const overwrite = (target: string) => (hook: string) =>
  `export function dec(_c?: any): any { lib.safe(1); }\n${target} = function (_c?: any): any { lib.${hook}(1); };\n`;

/**
 * The import of an export the file may overwrite is withdrawn (an
 * unresolved target), whatever either value calls.
 */
const WITHDRAWN =
  "the export the file overwrites is withdrawn, so the import is an unresolved target and the negative control is UNKNOWN too";

/** `impl.ts` calls the imported `dec`. */
const CALL = `import { dec } from "./decs";\ndec();\n`;

export const BL105_CASES: readonly Bl105Case[] = [
  {
    id: "rwf150.cast-overwrite-decorator",
    finding: "RWF-150",
    mechanism:
      "RWF-150's reproduction: `(exports as any).dec = …` replaces the exported decorator with one returning a class whose constructor calls the target; `@dec class C {}; new C()` constructs it",
    decs: (hook) =>
      `export function dec(_c?: any): any { return undefined; }\n(exports as any).dec = function (_c?: any): any {\n  return class { constructor() { lib.${hook}(1); } };\n};\n`,
    program: `import { dec } from "./decs";\n@dec class C {}\nnew C();\n`,
    legacyDecorators: true,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf150.alias-overwrite-decorator",
    finding: "RWF-150",
    mechanism:
      "RWF-150's alias form: `const e: any = exports; e.dec = …` replaces the exported decorator with one returning a class whose constructor calls the target",
    decs: (hook) =>
      `export function dec(_c?: any): any { return undefined; }\nconst e: any = exports;\ne.dec = function (_c?: any): any {\n  return class { constructor() { lib.${hook}(1); } };\n};\n`,
    program: `import { dec } from "./decs";\n@dec class C {}\nnew C();\n`,
    legacyDecorators: true,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "masked.cast-overwrite-call",
    finding: "RWF-150",
    mechanism:
      "`(exports as any).dec = …` replaces the exported function; the importer's `dec()` reads `decs_1.dec`",
    decs: overwrite("(exports as any).dec"),
    program: CALL,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.alias-overwrite-call",
    finding: "RWF-150",
    mechanism:
      "`const e: any = exports; e.dec = …` replaces the exported function through an alias",
    decs: (hook) => `const e: any = exports;\n${overwrite("e.dec")(hook)}`,
    program: CALL,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "cost.plain-overwrite-call",
    finding: "RWF-150",
    mechanism:
      "`exports.dec = …` with no cast: the base attributed the import to the plain write's function (sound here, Node calls it), but its order against TypeScript's emitted `exports.dec = dec` is not the CommonJS walk's, so the name is withdrawn",
    decs: overwrite("exports.dec"),
    program: CALL,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "masked.non-null-overwrite-call",
    finding: "RWF-150",
    mechanism: "`exports!.dec = …`: a non-null assertion",
    decs: overwrite("exports!.dec"),
    program: CALL,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.angle-cast-overwrite-call",
    finding: "RWF-150",
    mechanism: "`(<any>exports).dec = …`: an angle-bracket assertion",
    decs: overwrite("(<any>exports).dec"),
    program: CALL,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.satisfies-overwrite-call",
    finding: "RWF-150",
    mechanism: "`(exports satisfies any).dec = …`",
    decs: overwrite("(exports satisfies any).dec"),
    program: CALL,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.element-cast-overwrite-call",
    finding: "RWF-150",
    mechanism: '`(exports as any)["dec"] = …`',
    decs: overwrite('(exports as any)["dec"]'),
    program: CALL,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.module-exports-cast-overwrite-call",
    finding: "RWF-150",
    mechanism: "`(module.exports as any).dec = …`",
    decs: overwrite("(module.exports as any).dec"),
    program: CALL,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.module-cast-overwrite-call",
    finding: "RWF-150",
    mechanism: "`(module as any).exports.dec = …`",
    decs: overwrite("(module as any).exports.dec"),
    program: CALL,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.define-property-cast-overwrite-call",
    finding: "RWF-150",
    mechanism:
      '`Object.defineProperty(exports as any, "dec", { value: … })` redefines the writable property',
    decs: (hook) =>
      `export function dec(_c?: any): any { lib.safe(1); }\nObject.defineProperty(exports as any, "dec", { value: function (_c?: any): any { lib.${hook}(1); } });\n`,
    program: CALL,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.deferred-cast-overwrite-call",
    finding: "RWF-150",
    mechanism:
      "the overwrite runs inside an exported function the importer calls first",
    decs: (hook) =>
      `export function dec(_c?: any): any { lib.safe(1); }\nexport function swap() { (exports as any).dec = function (_c?: any): any { lib.${hook}(1); }; }\n`,
    program: `import { dec, swap } from "./decs";\nswap();\ndec();\n`,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.const-export-cast-overwrite-call",
    finding: "RWF-150",
    mechanism:
      "`export const dec = …` then `(exports as any).dec = …`: the importer reads the overwritten property",
    decs: (hook) =>
      `export const dec = function (_c?: any): any { lib.safe(1); };\n(exports as any).dec = function (_c?: any): any { lib.${hook}(1); };\n`,
    program: CALL,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "rwf150.cast-overwrite-drops-the-declared-call",
    finding: "RWF-150",
    mechanism:
      "the declared `dec` calls the target, the overwritten one does not: a resolved edge to the declared function is fabricated",
    decs: (hook) =>
      `export function dec(_c?: any): any { lib.${hook}(1); }\n(exports as any).dec = function (_c?: any): any { lib.safe(1); };\n`,
    program: CALL,
    controlsInapplicable: WITHDRAWN,
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "masked.module-exports-cast-replaces-the-object",
    finding: "RWF-150",
    mechanism:
      "`(module as any).exports = { dec }` replaces the exports object the importer reads",
    decs: (hook) =>
      `export function dec(_c?: any): any { lib.safe(1); }\n(module as any).exports = { dec: function (_c?: any): any { lib.${hook}(1); } };\n`,
    program: CALL,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "cost.module-exports-replaces-the-object",
    finding: "RWF-150",
    mechanism:
      "`module.exports = { dec }` (no cast) in an ES module replaces the exports object the importer reads: the base attributed the import to the literal's function (sound here, Node calls it); every ES export of a file that replaces the object is withdrawn",
    decs: (hook) =>
      `export function dec(_c?: any): any { lib.safe(1); }\nmodule.exports = { dec: function (_c?: any): any { lib.${hook}(1); } };\n`,
    program: CALL,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "cjs.cast-overwrite-call",
    finding: "RWF-150",
    mechanism:
      "a CommonJS-syntax TypeScript module: `exports.dec = …` then `(exports as any).dec = …`; the cast write is the effective one, which no binding carries",
    decs: (hook) =>
      `exports.dec = function (_c?: any): any { lib.safe(1); };\n(exports as any).dec = function (_c?: any): any { lib.${hook}(1); };\n`,
    program: `import decs = require("./decs");\ndecs.dec();\n`,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "gain.cjs-cast-write-of-another-name",
    finding: "RWF-150",
    mechanism:
      "a CommonJS-syntax TypeScript module: `(exports as any).other = …` writes another name; the base withdrew every name for the cast reference",
    decs: (hook) =>
      `exports.dec = function (_c?: any): any { lib.${hook}(1); };\n(exports as any).other = function (_c?: any): any { lib.safe(1); };\n`,
    program: `import decs = require("./decs");\ndecs.dec();\n`,
    called: true,
    base: "UNKNOWN",
    expected: "AFFECTED",
  },
  {
    id: "rwf150.self-import-overwrite-decorator",
    finding: "RWF-150",
    mechanism:
      '`import * as self from "./decs"` is this module\'s own exports object (`require("./decs")` in the emit): `(self as any).dec = …` replaces the exported decorator',
    decs: (hook) =>
      `import * as self from "./decs";\nexport function dec(_c?: any): any { return undefined; }\n(self as any).dec = function (_c?: any): any {\n  return class { constructor() { lib.${hook}(1); } };\n};\n`,
    program: `import { dec } from "./decs";\n@dec class C {}\nnew C();\n`,
    legacyDecorators: true,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf150.self-import-default-overwrite-decorator",
    finding: "RWF-150",
    mechanism:
      '`import self = require("./decs")`: the same object, through TypeScript\'s CommonJS import',
    decs: (hook) =>
      `import self = require("./decs");\nexport function dec(_c?: any): any { return undefined; }\n(self as any).dec = function (_c?: any): any {\n  return class { constructor() { lib.${hook}(1); } };\n};\n`,
    program: `import { dec } from "./decs";\n@dec class C {}\nnew C();\n`,
    legacyDecorators: true,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf150.self-import-handed-on-decorator",
    finding: "RWF-150",
    mechanism:
      '`import * as self from "./decs"` handed to a function that writes `o.dec = …`',
    decs: (hook) =>
      `import * as self from "./decs";\nexport function dec(_c?: any): any { return undefined; }\nfunction patch(o: any) { o.dec = function (_c?: any): any { return class { constructor() { lib.${hook}(1); } }; }; }\npatch(self);\n`,
    program: `import { dec } from "./decs";\n@dec class C {}\nnew C();\n`,
    legacyDecorators: true,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf150.self-import-alias-decorator",
    finding: "RWF-150",
    mechanism:
      '`import * as self from "./decs"` bound to a local: `const o: any = self; o.dec = …`',
    decs: (hook) =>
      `import * as self from "./decs";\nexport function dec(_c?: any): any { return undefined; }\nconst o: any = self;\no.dec = function (_c?: any): any { return class { constructor() { lib.${hook}(1); } }; };\n`,
    program: `import { dec } from "./decs";\n@dec class C {}\nnew C();\n`,
    legacyDecorators: true,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.self-import-named-binding-assigned",
    finding: "RWF-150",
    mechanism:
      "BL-105's independent audit, finding 1: `import { dec as d2 } from \"./decs\"; d2 = …` compiles to `decs_1.dec = …`, a write onto this module's own exports",
    decs: (hook) =>
      `import { dec as d2 } from "./decs";\nexport function dec(_c?: any): any { lib.safe(1); }\n// @ts-ignore\nd2 = function (_c?: any): any { lib.${hook}(1); };\n`,
    program: CALL,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.self-import-named-binding-assigned-later",
    finding: "RWF-150",
    mechanism:
      "the same assignment inside an exported `init()` the importer calls first",
    decs: (hook) =>
      `import { dec as d2 } from "./decs";\nexport function dec(_c?: any): any { lib.safe(1); }\nexport function init() {\n  // @ts-ignore\n  d2 = function (_c?: any): any { lib.${hook}(1); };\n}\n`,
    program: `import { dec, init } from "./decs";\ninit();\ndec();\n`,
    controlsInapplicable: WITHDRAWN,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "control.cast-read-of-exports",
    finding: "RWF-150",
    mechanism:
      "`(exports as any).other` only tested: a read, which writes nothing",
    decs: (hook) =>
      `export function dec(_c?: any): any { lib.${hook}(1); }\nif ((exports as any).other) { lib.safe(1); }\n`,
    program: CALL,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "control.cast-write-of-another-name",
    finding: "RWF-150",
    mechanism:
      "`(exports as any).other = …` writes a name the importer does not use: `dec` stays the declared function",
    decs: (hook) =>
      `export function dec(_c?: any): any { lib.${hook}(1); }\n(exports as any).other = function (_c?: any): any { lib.safe(1); };\n`,
    program: CALL,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "control.declared-export-only",
    finding: "RWF-150",
    mechanism: "no write onto `exports`: the import is the declared function",
    decs: (hook) => `export function dec(_c?: any): any { lib.${hook}(1); }\n`,
    program: CALL,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
];
