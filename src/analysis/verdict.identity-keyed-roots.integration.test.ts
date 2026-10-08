import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import type { ConfiguredEntrypoint } from "./entrypoints.js";
import { discoverEntrypoints } from "./entrypoints.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { buildFindingForTest } from "../testing/finding.js";

/**
 * Task V-3 (docs/tasks/V-3-identity-keyed-roots.md), ADR 0011 predicate 4:
 * every entrypoint root is materialized by DECLARATION POSITION, and a
 * configured `symbol` that does not materialize is root incompleteness.
 *
 * Through the production `buildFinding`, over real files and a real call
 * graph. The real-Node ground truth for the PRM-25 and PRM-31 shapes is
 * `tests/oracle/v3-identity-keyed-roots.test.ts`; this file adds the shapes
 * the identity rule must keep precise (an overload set, an ESM specifier
 * alias, a class) and the ones it must refuse (`export *`, an opaque
 * whole-module export, a symbol nothing exports).
 *
 * LOUD FIXTURE. `vuln-lib` exports `vulnerable` (the rule's target) and
 * `safe`.
 */

const vulnerability: Vulnerability = {
  id: "GHSA-v3-roots",
  aliases: [],
  package: "vuln-lib",
  ecosystem: "npm",
  affectedVersions: [{ introduced: "0" }],
  fixedVersions: [],
  references: [],
};

const rule: VulnerableSymbolRule = {
  id: "GHSA-v3-roots",
  package: { name: "vuln-lib" },
  targets: [{ module: "vuln-lib", export: "vulnerable", kind: "function" }],
};

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function write(root: string, relative: string, content: string): string {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

/** Scans `files` (entry `src/index.<ext>`) with one configured entrypoint. */
async function scan(
  files: Readonly<Record<string, string>>,
  entry: string,
  configured: ConfiguredEntrypoint,
) {
  const root = mkdtempSync(path.join(tmpdir(), "vulntrace-v3-roots-"));
  tmpDir = root;
  write(
    root,
    "node_modules/vuln-lib/package.json",
    JSON.stringify({ name: "vuln-lib", version: "1.0.0", main: "index.js" }),
  );
  write(
    root,
    "node_modules/vuln-lib/index.js",
    "function vulnerable() { return 'v'; }\n" +
      "function safe() { return 's'; }\n" +
      "module.exports = { vulnerable, safe };\n",
  );
  write(root, "package.json", JSON.stringify({ name: "app" }));
  for (const [relative, content] of Object.entries(files)) {
    write(root, relative, content);
  }
  const resolver = createModuleResolver(loadTsProject(root));
  const [graph, entrypointsResult] = await Promise.all([
    buildCallGraph({ entryFiles: [path.join(root, entry)], resolver }),
    discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: [configured],
    }),
  ]);
  return buildFindingForTest({
    vulnerability,
    packageName: "vuln-lib",
    packageVersion: "1.0.0",
    matchResult: "affected",
    rule,
    graph,
    entrypoints: entrypointsResult.entrypoints,
    resolver,
    projectRoot: root,
  });
}

const LIB = `const lib = require("vuln-lib");\n`;
const SYMBOL = { file: "src/index.js", symbol: "main" } as const;

function reasonsOf(
  finding: Awaited<ReturnType<typeof scan>>,
): readonly string[] {
  return finding?.unknownReasons?.map((r) => r.reason) ?? [];
}

describe("V-3: a configured symbol is rooted at the declaration its export binds to (PRM-25)", () => {
  it("roots `main` published under another local name (`{ main: run }`): AFFECTED", async () => {
    const finding = await scan(
      {
        "src/index.js":
          LIB +
          `function run() { return lib.vulnerable(); }\n` +
          `module.exports = { main: run };\n`,
      },
      "src/index.js",
      SYMBOL,
    );
    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("never roots a nested function spelled like the symbol: the decoy's call is not AFFECTED", async () => {
    const finding = await scan(
      {
        "src/index.js":
          LIB +
          `function helper() { function main() { return lib.vulnerable(); } return main; }\n` +
          `function run() { return lib.safe(); }\n` +
          `module.exports = { main: run, helper };\n`,
      },
      "src/index.js",
      SYMBOL,
    );
    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeDefined();
  });

  it("refuses a symbol nothing in the file publishes: UNKNOWN, entrypoint_root_incomplete", async () => {
    const finding = await scan(
      {
        "src/index.js":
          LIB +
          `function main() { return lib.safe(); }\n` +
          `function run() { return lib.vulnerable(); }\n` +
          `function makeApi() { return { main: run }; }\n` +
          `module.exports = makeApi();\n`,
      },
      "src/index.js",
      SYMBOL,
    );
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(reasonsOf(finding)).toContain("entrypoint_root_incomplete");
  });

  it("refuses a symbol an `export *` may publish: UNKNOWN, entrypoint_root_incomplete", async () => {
    const finding = await scan(
      {
        "src/index.mjs":
          `import lib from "vuln-lib";\n` +
          `export function other() { return lib.safe(); }\n` +
          `export * from "./impl.mjs";\n`,
        "src/impl.mjs":
          `import lib from "vuln-lib";\n` +
          `export function main() { return lib.vulnerable(); }\n`,
      },
      "src/index.mjs",
      { file: "src/index.mjs", symbol: "main" },
    );
    expect(finding?.verdict).not.toBe("NOT_AFFECTED");
    expect(reasonsOf(finding)).toContain("entrypoint_root_incomplete");
  });

  it("applies an export-object mutation that names no export to the symbol, even when the file binds it: UNKNOWN", async () => {
    // `extend` runs after `exports.main = main` and copies impl's `main`,
    // which calls the target, over it: the binding is not the value.
    const finding = await scan(
      {
        "src/index.js":
          LIB +
          `function extend(target, source) { target.main = source.main; }\n` +
          `function main() { return lib.safe(); }\n` +
          `exports.main = main;\n` +
          `extend(module.exports, require("./impl.js"));\n`,
        "src/impl.js":
          LIB + `exports.main = function () { return lib.vulnerable(); };\n`,
      },
      "src/index.js",
      SYMBOL,
    );
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(reasonsOf(finding)).toContain("entrypoint_root_incomplete");
  });

  it("ignores an incompleteness that names ANOTHER export: family C stands", async () => {
    // `other` is a CommonJS property re-export, an incompleteness that
    // names `other`: the symbol `main` cannot be what it publishes. As a
    // FILE entrypoint, which roots `other` too, the same project is
    // UNKNOWN -- the gap is real, and only the symbol excludes it.
    const files = {
      "src/index.js":
        LIB +
        `function main() { return lib.safe(); }\n` +
        `exports.main = main;\n` +
        `exports.other = require("./impl.js").helper;\n`,
      "src/impl.js": `exports.helper = function () { return 0; };\n`,
    };
    const asFile = await scan(files, "src/index.js", "src/index.js");
    expect(reasonsOf(asFile)).toContain("entrypoint_root_incomplete");
    rmSync(tmpDir ?? "", { recursive: true, force: true });
    const finding = await scan(
      {
        "src/index.js":
          LIB +
          `function main() { return lib.safe(); }\n` +
          `exports.main = main;\n` +
          `exports.other = require("./impl.js").helper;\n`,
        "src/impl.js": `exports.helper = function () { return 0; };\n`,
      },
      "src/index.js",
      SYMBOL,
    );
    expect(finding?.verdict).toBe("NOT_AFFECTED");
  });

  it("roots an ESM specifier alias (`export { run as main }`) at `run`'s declaration", async () => {
    const finding = await scan(
      {
        "src/index.mjs":
          `import lib from "vuln-lib";\n` +
          `function helper() { function run() { return 0; } return run; }\n` +
          `function run() { return lib.vulnerable(); }\n` +
          `export { run as main, helper };\n`,
      },
      "src/index.mjs",
      { file: "src/index.mjs", symbol: "main" },
    );
    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("roots a TypeScript overload set at its implementation", async () => {
    const finding = await scan(
      {
        "src/index.ts":
          `import lib = require("vuln-lib");\n` +
          `export function main(x: string): string;\n` +
          `export function main(x: number): string;\n` +
          `export function main(x: unknown): string { return lib.vulnerable(); }\n`,
      },
      "src/index.ts",
      { file: "src/index.ts", symbol: "main" },
    );
    expect(finding?.verdict).toBe("AFFECTED");
  });
});

describe("V-3: a file entrypoint's roots are materialized by position (PRM-31)", () => {
  it("roots the module-scope `run` an export binds, not a nested `run`: AFFECTED", async () => {
    const finding = await scan(
      {
        "src/index.js":
          LIB +
          `function helper() { function run() { return 0; } return run; }\n` +
          `function run() { return lib.vulnerable(); }\n` +
          `module.exports = { main: run, helper };\n`,
      },
      "src/index.js",
      "src/index.js",
    );
    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("satisfies no requirement with the EXPORTED name, which is no provenance for a local (RWF-011): UNKNOWN", async () => {
    const finding = await scan(
      {
        "src/index.js":
          LIB +
          `const registry = { impl: () => lib.vulnerable() };\n` +
          `function main() { return lib.safe(); }\n` +
          `exports.main = registry.impl;\n` +
          `exports.unused = main;\n`,
      },
      "src/index.js",
      "src/index.js",
    );
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(reasonsOf(finding)).toContain("entrypoint_root_incomplete");
  });

  it("satisfies no requirement with a module-scope name when the export is written inside a function: UNKNOWN", async () => {
    const finding = await scan(
      {
        "src/index.js":
          LIB +
          `function run() { return lib.safe(); }\n` +
          `function setup() {\n` +
          `  function run() { return lib.vulnerable(); }\n` +
          `  exports.main = run;\n` +
          `}\n` +
          `setup();\n`,
      },
      "src/index.js",
      "src/index.js",
    );
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(reasonsOf(finding)).toContain("entrypoint_root_incomplete");
  });

  it("roots the `main` a shorthand export binds, not a nested `main` that calls the target: family C stands (the base's false AFFECTED)", async () => {
    const finding = await scan(
      {
        "src/index.js":
          LIB +
          // The decoy never leaves `helper`: nothing can call it.
          `function helper() { function main() { return lib.vulnerable(); } return 0; }\n` +
          `function main() { return lib.safe(); }\n` +
          `module.exports = { main, helper };\n`,
      },
      "src/index.js",
      "src/index.js",
    );
    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeDefined();
  });
});

describe("V-3: shapes its independent audit found on the first fix", () => {
  it("reports a deferred whole-module write's root as a gap, never drops it: UNKNOWN (finding 1)", async () => {
    const finding = await scan(
      {
        "src/index.js":
          LIB +
          `function run() { return lib.vulnerable(); }\n` +
          `function setup() { module.exports = { main: run }; }\n` +
          `setup();\n`,
      },
      "src/index.js",
      "src/index.js",
    );
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(reasonsOf(finding)).toContain("entrypoint_root_incomplete");
  });

  it("roots an ESM `export default run` (no local recorded) at `run`: AFFECTED, file and symbol `default` (finding 2)", async () => {
    const files = {
      "src/index.mjs":
        `import lib from "vuln-lib";\n` +
        `function run() { return lib.vulnerable(); }\n` +
        `export default run;\n`,
    };
    const asFile = await scan(files, "src/index.mjs", "src/index.mjs");
    expect(asFile?.verdict).toBe("AFFECTED");
    rmSync(tmpDir ?? "", { recursive: true, force: true });
    const asSymbol = await scan(files, "src/index.mjs", {
      file: "src/index.mjs",
      symbol: "default",
    });
    expect(asSymbol?.verdict).toBe("AFFECTED");
  });

  it("roots an anonymous ESM default function at its position: AFFECTED (finding 2)", async () => {
    const finding = await scan(
      {
        "src/index.mjs":
          `import lib from "vuln-lib";\n` +
          `export default function () { return lib.vulnerable(); }\n`,
      },
      "src/index.mjs",
      { file: "src/index.mjs", symbol: "default" },
    );
    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("witnesses no reassigned binding by its stale declaration: UNKNOWN (finding 3)", async () => {
    const finding = await scan(
      {
        "src/index.js":
          LIB +
          `let main = function () { return lib.safe(); };\n` +
          `main = function () { return lib.vulnerable(); };\n` +
          `exports.main = main;\n`,
      },
      "src/index.js",
      SYMBOL,
    );
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(reasonsOf(finding)).toContain("entrypoint_root_incomplete");
  });

  it("roots no `var` whose initializer runs after the export reads it: not AFFECTED (finding 5)", async () => {
    // Node: `exports.main` is `undefined` when written; calling it throws.
    const finding = await scan(
      {
        "src/index.js":
          LIB +
          `exports.main = run;\n` +
          `var run = function () { return lib.vulnerable(); };\n`,
      },
      "src/index.js",
      SYMBOL,
    );
    expect(finding?.verdict).not.toBe("AFFECTED");
  });
});

describe("V-3: shapes its second independent audit found", () => {
  it("roots no reassigned ESM default identifier at its stale declaration: UNKNOWN (finding 1)", async () => {
    const files = {
      "src/index.mjs":
        `import lib from "vuln-lib";\n` +
        `let run = function () { return lib.safe(); };\n` +
        `run = function () { return lib.vulnerable(); };\n` +
        `export default run;\n`,
    };
    const asSymbol = await scan(files, "src/index.mjs", {
      file: "src/index.mjs",
      symbol: "default",
    });
    expect(asSymbol?.verdict).toBe("UNKNOWN");
    expect(reasonsOf(asSymbol)).toContain("entrypoint_root_incomplete");
    rmSync(tmpDir ?? "", { recursive: true, force: true });
    const asFile = await scan(files, "src/index.mjs", "src/index.mjs");
    expect(asFile?.verdict).not.toBe("NOT_AFFECTED");
  });

  it("roots no function declaration the file reassigns in a closure: not NOT_AFFECTED (finding 1)", async () => {
    const finding = await scan(
      {
        "src/index.js":
          LIB +
          `function run() { return lib.safe(); }\n` +
          `function swap() { run = function () { return lib.vulnerable(); }; }\n` +
          `swap();\n` +
          `module.exports = { main: run };\n`,
      },
      "src/index.js",
      SYMBOL,
    );
    expect(finding?.verdict).not.toBe("NOT_AFFECTED");
  });

  it("counts a CommonJS whole-module write for every symbol: UNKNOWN (finding 2)", async () => {
    const finding = await scan(
      {
        "src/index.js":
          LIB +
          `exports.main = function () { return lib.safe(); };\n` +
          `const api = { main: run };\n` +
          `module.exports = api;\n` +
          `function run() { return lib.vulnerable(); }\n`,
      },
      "src/index.js",
      SYMBOL,
    );
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(reasonsOf(finding)).toContain("entrypoint_root_incomplete");
  });

  it("roots no other export's value for a withdrawn symbol: not AFFECTED (finding 3)", async () => {
    const finding = await scan(
      {
        "src/index.js":
          LIB +
          `if (process.env.VT_NEVER_SET === undefined) exports.main = function () { return lib.safe(); };\n` +
          `exports.other = function () { return lib.vulnerable(); };\n`,
      },
      "src/index.js",
      SYMBOL,
    );
    expect(finding?.verdict).toBe("UNKNOWN");
  });
});
