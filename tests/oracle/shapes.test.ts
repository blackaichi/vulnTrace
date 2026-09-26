import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempProject, type ProjectSpec } from "../../src/testing/oracle/project.js";
import { assertLoudFixture } from "../../src/testing/oracle/loud-fixture.js";
import {
  nodeEntryCommand,
  nodeSymbolEntryCommand,
  runGroundTruth,
} from "../../src/testing/oracle/ground-truth.js";
import { runOracleScan } from "../../src/testing/oracle/scan.js";
import {
  injectedOsvProvider,
  syntheticProvider,
} from "../../src/testing/oracle/provider.js";
import {
  simpleConfigFile,
  simpleRuleFile,
} from "../../src/testing/oracle/config-files.js";
import { compileTypeScript } from "../../src/testing/oracle/typescript-compile.js";
import { HIT_HELPER_SOURCE, hitFunction } from "../../src/testing/oracle/hit.js";

/**
 * Demonstrates the harness genuinely supports every project shape task
 * H-0 step 1 lists, each against a fixture known to pass on `main` today
 * (no open defect is asserted on here -- see the pagination and
 * malformed-lockfile cases below, which deliberately assert only on the
 * MECHANISM, never on a verdict that would pin an undecided or open
 * question).
 */

const LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `module.exports = { parse, safe };\n`;

describe("shape: nested installs and a same-name-same-version twin", () => {
  it("keeps two installs of the same package at different paths as distinct instances", async () => {
    const project: ProjectSpec = {
      files: {
        "package.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          dependencies: { "vuln-lib": "1.0.0", other: "1.0.0" },
        }),
        "package-lock.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": { name: "app", version: "1.0.0" },
            "node_modules/vuln-lib": { version: "1.0.0" },
            "node_modules/other": { version: "1.0.0" },
            "node_modules/other/node_modules/vuln-lib": { version: "1.0.0" },
          },
        }),
        "node_modules/vuln-lib/package.json": JSON.stringify({
          name: "vuln-lib",
          version: "1.0.0",
          main: "index.js",
        }),
        "node_modules/vuln-lib/index.js": LIB_SOURCE,
        "node_modules/other/package.json": JSON.stringify({
          name: "other",
          version: "1.0.0",
          main: "index.js",
        }),
        // "other" requires the BARE specifier "vuln-lib" from its own
        // directory, so Node's own node_modules algorithm resolves it to
        // its OWN nested install -- never the top-level one -- exactly
        // how a real nested/twin install is reached (matching
        // src/cli/scan.module-load-closure.test.ts's RWB-09a fixture).
        "node_modules/other/index.js":
          'const lib = require("vuln-lib");\n' +
          "function run(x) { return lib.parse(x); }\n" +
          "module.exports = { run };\n",
        "node_modules/other/node_modules/vuln-lib/package.json": JSON.stringify(
          { name: "vuln-lib", version: "1.0.0", main: "index.js" },
        ),
        "node_modules/other/node_modules/vuln-lib/index.js": LIB_SOURCE,
        "src/index.js":
          'const other = require("other");\n' + 'other.run("x");\n',
        "rules.yml": simpleRuleFile({
          id: "GHSA-nested-twin",
          packageName: "vuln-lib",
          exportName: "parse",
        }),
        "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.js"] }),
      },
    };

    await withTempProject(project, async (dir) => {
      const scan = await runOracleScan(
        dir,
        syntheticProvider([
          { id: "GHSA-nested-twin", packageName: "vuln-lib", fixed: "99.0.0" },
        ]),
      );
      expect(scan.findings.length).toBe(2);
      const instances = scan.findings.map((f) => f.packageInstance);
      expect(new Set(instances).size).toBe(2);
      const nestedSuffix = path.join("other", "node_modules", "vuln-lib");
      const nestedFinding = scan.findings.find((f) =>
        f.packageInstance?.includes(nestedSuffix),
      );
      expect(nestedFinding?.verdict).toBe("AFFECTED");
    });
  });
});

describe("shape: an ESM package installed via a symlink (file: dependency)", () => {
  it("loud-checks and scans a symlinked ESM install", async () => {
    const esmLibSource =
      HIT_HELPER_SOURCE + "export " + hitFunction("parse", '"p"');
    const project: ProjectSpec = {
      files: {
        "package.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          type: "module",
          dependencies: { "vuln-lib": "file:packages/vuln-lib" },
        }),
        "package-lock.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "app",
              version: "1.0.0",
              dependencies: { "vuln-lib": "file:packages/vuln-lib" },
            },
            "node_modules/vuln-lib": { resolved: "packages/vuln-lib", link: true },
            "packages/vuln-lib": { name: "vuln-lib", version: "1.0.0" },
          },
        }),
        "packages/vuln-lib/package.json": JSON.stringify({
          name: "vuln-lib",
          version: "1.0.0",
          type: "module",
          main: "index.js",
        }),
        "packages/vuln-lib/index.js": esmLibSource,
        "src/index.mjs": 'import { parse } from "vuln-lib";\nparse("x");\n',
        "rules.yml": simpleRuleFile({
          id: "GHSA-symlink-esm",
          packageName: "vuln-lib",
          exportName: "parse",
        }),
        "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.mjs"] }),
      },
      symlinks: { "node_modules/vuln-lib": "../packages/vuln-lib" },
    };

    await withTempProject(project, async (dir) => {
      const loud = assertLoudFixture(dir, {
        specifier: "vuln-lib",
        boundNames: ["parse"],
        esm: true,
      });
      expect(loud.exportedNames).toContain("parse");

      const scan = await runOracleScan(
        dir,
        syntheticProvider([
          { id: "GHSA-symlink-esm", packageName: "vuln-lib", fixed: "99.0.0" },
        ]),
      );
      expect(scan.findings[0]?.verdict).toBe("AFFECTED");
    });
  });
});

describe("shape: TypeScript source compiled with the repository's own TypeScript for ground truth", () => {
  it("compiles a .ts entrypoint to dist/ and real Node runs the compiled output", async () => {
    const tsSource =
      'import lib = require("vuln-lib");\n' + 'lib.parse("x");\nexport {};\n';
    const compiled = compileTypeScript(tsSource, "index.ts");

    const project: ProjectSpec = {
      files: {
        "package.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          dependencies: { "vuln-lib": "1.0.0" },
        }),
        "package-lock.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "app",
              version: "1.0.0",
              dependencies: { "vuln-lib": "1.0.0" },
            },
            "node_modules/vuln-lib": { version: "1.0.0" },
          },
        }),
        "tsconfig.json": JSON.stringify({
          compilerOptions: { module: "commonjs", allowJs: true },
        }),
        "node_modules/vuln-lib/package.json": JSON.stringify({
          name: "vuln-lib",
          version: "1.0.0",
          main: "index.js",
        }),
        "node_modules/vuln-lib/index.js": LIB_SOURCE,
        "src/index.ts": tsSource,
        "dist/index.js": compiled,
        "rules.yml": simpleRuleFile({
          id: "GHSA-ts-compile",
          packageName: "vuln-lib",
          exportName: "parse",
        }),
        "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.ts"] }),
      },
    };

    await withTempProject(project, async (dir) => {
      const groundTruth = runGroundTruth(dir, nodeEntryCommand("dist/index.js"));
      expect(groundTruth.calledMarkers.has("parse")).toBe(true);

      const scan = await runOracleScan(
        dir,
        syntheticProvider([
          { id: "GHSA-ts-compile", packageName: "vuln-lib", fixed: "99.0.0" },
        ]),
      );
      expect(scan.findings[0]?.verdict).toBe("AFFECTED");
    });
  });
});

describe("shape: a symbol entrypoint ({file, symbol}) and analysis.limits.maxFiles", () => {
  it("scans from a named exported symbol, with a generous maxFiles", async () => {
    const project: ProjectSpec = {
      files: {
        "package.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          dependencies: { "vuln-lib": "1.0.0" },
        }),
        "package-lock.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "app",
              version: "1.0.0",
              dependencies: { "vuln-lib": "1.0.0" },
            },
            "node_modules/vuln-lib": { version: "1.0.0" },
          },
        }),
        "node_modules/vuln-lib/package.json": JSON.stringify({
          name: "vuln-lib",
          version: "1.0.0",
          main: "index.js",
        }),
        "node_modules/vuln-lib/index.js": LIB_SOURCE,
        "src/index.js":
          'const lib = require("vuln-lib");\n' +
          "function main() { return lib.parse(\"x\"); }\n" +
          "module.exports = { main };\n",
        "rules.yml": simpleRuleFile({
          id: "GHSA-symbol-entry",
          packageName: "vuln-lib",
          exportName: "parse",
        }),
        "vulntrace.yml": simpleConfigFile({
          entrypoints: [{ file: "src/index.js", symbol: "main" }],
          maxFiles: 500,
        }),
      },
    };

    await withTempProject(project, async (dir) => {
      const groundTruth = runGroundTruth(
        dir,
        nodeSymbolEntryCommand("src/index.js", "main"),
      );
      expect(groundTruth.calledMarkers.has("parse")).toBe(true);

      const scan = await runOracleScan(
        dir,
        syntheticProvider([
          { id: "GHSA-symbol-entry", packageName: "vuln-lib", fixed: "99.0.0" },
        ]),
      );
      expect(scan.findings[0]?.verdict).toBe("AFFECTED");
    });
  });
});

describe("shape: the real OsvProvider driven by an injected fetch", () => {
  it("routes a query through the injected fetchImpl instead of the network", async () => {
    const requests: unknown[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      requests.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ vulns: [{ id: "GHSA-page-1", affected: [] }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = injectedOsvProvider(fetchImpl);
    const results = await provider.queryPackage({
      ecosystem: "npm",
      name: "vuln-lib",
      version: "1.0.0",
    });

    expect(requests.length).toBe(1);
    expect(results.length).toBe(1);
  });
});

describe("shape: a verbatim, non-generated package-lock.json", () => {
  it("accepts a hand-written lockfile with a nameless file: link entry", async () => {
    const project: ProjectSpec = {
      files: {
        "package.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          dependencies: { "vuln-lib": "file:vendor/vuln-lib" },
        }),
        // Written verbatim, not through simplePackageFiles -- a real npm
        // lockfile for a file: dependency omits "name" on the linked
        // entry itself (task H-0 step 1: "malformed and nameless
        // entries"). No verdict is asserted here: whether this shape is
        // handled soundly is exactly the kind of question a LATER task's
        // reproduction settles, not this harness self-test.
        "package-lock.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "app",
              version: "1.0.0",
              dependencies: { "vuln-lib": "file:vendor/vuln-lib" },
            },
            "vendor/vuln-lib": { version: "1.0.0" },
            "node_modules/vuln-lib": {
              resolved: "vendor/vuln-lib",
              link: true,
            },
          },
        }),
        "vendor/vuln-lib/package.json": JSON.stringify({
          name: "vuln-lib",
          version: "1.0.0",
          main: "index.js",
        }),
        "vendor/vuln-lib/index.js": LIB_SOURCE,
        "src/index.js": 'const lib = require("vuln-lib");\nlib.parse("x");\n',
        "rules.yml": simpleRuleFile({
          id: "GHSA-verbatim-lock",
          packageName: "vuln-lib",
          exportName: "parse",
        }),
        "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.js"] }),
      },
      symlinks: { "node_modules/vuln-lib": "../vendor/vuln-lib" },
    };

    await withTempProject(project, async (dir) => {
      const loud = assertLoudFixture(dir, {
        specifier: "vuln-lib",
        boundNames: ["parse"],
      });
      expect(loud.exportedNames).toContain("parse");

      const groundTruth = runGroundTruth(dir, nodeEntryCommand("src/index.js"));
      expect(groundTruth.calledMarkers.has("parse")).toBe(true);

      const scan = await runOracleScan(
        dir,
        syntheticProvider([
          { id: "GHSA-verbatim-lock", packageName: "vuln-lib", fixed: "99.0.0" },
        ]),
      );
      expect(typeof scan.exitCode).toBe("number");
    });
  });
});
