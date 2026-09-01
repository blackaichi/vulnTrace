import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runScanCommand } from "./scan.js";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";

/**
 * RWF-003's end-to-end soundness attack, run through the REAL scan command
 * (dependency graph -> module resolution -> call graph -> reachability ->
 * verdict -> JSON), with only the OSV boundary stubbed.
 *
 * Every scenario here deliberately combines the newly-supported anonymous
 * `module.exports` function with a shape the relation must REFUSE to
 * resolve — a conditional assignment, a shadowed CommonJS ambient name, an
 * alias chain longer than one hop, a reassignment, a cross-package hop, a
 * duplicate install of the same name and version. The unit and call-graph
 * suites already pin each relation in isolation; the point of running them
 * together, at this layer, is that a wrong function identity or a wrong
 * PackageInstance only becomes a FALSE VERDICT here.
 *
 * Two of these assert a positive result, and both are load-bearing: an
 * attack suite that can only ever produce UNKNOWN would pass just as well
 * against an analyzer that resolves nothing at all.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ADVISORY: RawVulnerability = {
  id: "GHSA-anon-0001",
  aliases: [],
  affected: [
    {
      package: { ecosystem: "npm", name: "anon-lib" },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "9.0.0" }] },
      ],
    },
  ],
  references: [],
};

const provider: VulnerabilityProvider = {
  queryPackage(query: PackageQuery): Promise<readonly RawVulnerability[]> {
    return Promise.resolve(query.name === "anon-lib" ? [ADVISORY] : []);
  },
};

const CONFIG =
  "analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n";

/**
 * The rule names the module's whole callable export — the existing rule
 * vocabulary's `export: default`, unchanged by RWF-003.
 */
const RULES =
  "rules:\n" +
  "  - id: GHSA-anon-0001\n" +
  "    package:\n" +
  "      name: anon-lib\n" +
  "    targets:\n" +
  "      - module: anon-lib\n" +
  "        export: default\n" +
  "        kind: function\n" +
  "        confidence: 1.0\n";

function manifest(name: string): string {
  return JSON.stringify({ name, version: "1.0.0", main: "index.js" });
}

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-anon-scan-"));
  dirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return root;
}

/** A single-dependency project whose entrypoint calls `anon-lib` directly. */
function callingProject(
  libFiles: Readonly<Record<string, string>>,
  entryBody = "return lib(input);",
): string {
  return project({
    "vulntrace.yml": CONFIG,
    "rules.yml": RULES,
    "package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { "anon-lib": "1.0.0" },
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
          dependencies: { "anon-lib": "1.0.0" },
        },
        "node_modules/anon-lib": { version: "1.0.0" },
      },
    }),
    "src/index.js":
      'const lib = require("anon-lib");\n' +
      `function main(input) {\n  ${entryBody}\n}\n` +
      "module.exports = { main };\n",
    "node_modules/anon-lib/package.json": manifest("anon-lib"),
    ...libFiles,
  });
}

async function scan(root: string): Promise<{
  readonly verdict: string;
  readonly evidence: readonly string[];
}> {
  const stdout: string[] = [];
  await runScanCommand({
    projectPathArg: root,
    configPathOverride: path.join(root, "vulntrace.yml"),
    provider,
    noCache: true,
    io: { stdout: (text) => stdout.push(text), stderr: () => {} },
  });
  const output = JSON.parse(stdout.join("")) as {
    findings: ReadonlyArray<{
      package: string;
      verdict: string;
      evidence?: { path: string[] };
    }>;
  };
  const finding = output.findings.find((f) => f.package === "anon-lib");
  return {
    verdict: finding ? finding.verdict : "NO_FINDING",
    evidence: finding?.evidence?.path ?? [],
  };
}

describe("scan: RWF-003 anonymous module.exports function, end to end", () => {
  it("reports AFFECTED with evidence ending at the anonymous function itself", async () => {
    const root = callingProject({
      "node_modules/anon-lib/index.js": 'module.exports = require("./impl");\n',
      "node_modules/anon-lib/impl.js":
        "module.exports = function (input) {\n  return input;\n};\n",
    });

    const { verdict, evidence } = await scan(root);

    expect(verdict).toBe("AFFECTED");
    expect(evidence.at(-1)).toContain(path.join("anon-lib", "impl.js"));
  });

  it("names the LAST module.exports assignment, never the overwritten one", async () => {
    // Node's reassignment semantics are last-write-wins. Line 1's function
    // is genuinely not this module's exported value.
    const root = callingProject({
      "node_modules/anon-lib/index.js":
        "module.exports = function overwritten(a) { return a; };\n" +
        "module.exports = function (b) { return b; };\n",
    });

    const { verdict, evidence } = await scan(root);

    expect(verdict).toBe("AFFECTED");
    expect(evidence.at(-1)).toMatch(/index\.js:2$/);
  });

  it("keeps evidence inside the REACHED instance when two same-name, same-version installs exist", async () => {
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": RULES,
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { host: "1.0.0" },
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
            dependencies: { host: "1.0.0" },
          },
          "node_modules/host": { version: "1.0.0" },
          "node_modules/host/node_modules/anon-lib": { version: "1.0.0" },
          "node_modules/anon-lib": { version: "1.0.0" },
        },
      }),
      "src/index.js":
        'const host = require("host");\nfunction main(input) {\n  return host.run(input);\n}\nmodule.exports = { main };\n',
      "node_modules/host/package.json": manifest("host"),
      "node_modules/host/index.js":
        'const nested = require("anon-lib");\nfunction run(input) {\n  return nested(input);\n}\nmodule.exports = { run };\n',
      // The install that is actually reached.
      "node_modules/host/node_modules/anon-lib/package.json":
        manifest("anon-lib"),
      "node_modules/host/node_modules/anon-lib/index.js":
        "module.exports = function (a) {\n  return a;\n};\n",
      // A structurally identical install at a different path, never called.
      "node_modules/anon-lib/package.json": manifest("anon-lib"),
      "node_modules/anon-lib/index.js":
        "module.exports = function (b) {\n  return b;\n};\n",
    });

    const { verdict, evidence } = await scan(root);

    expect(verdict).toBe("AFFECTED");
    for (const step of evidence) {
      if (step.includes("anon-lib")) {
        expect(step).toContain(path.join("host", "node_modules", "anon-lib"));
      }
    }
  });
});

describe("scan: RWF-003 shapes that must never produce a confident verdict", () => {
  it("stays UNKNOWN for a conditionally-assigned anonymous export", async () => {
    const root = callingProject({
      "node_modules/anon-lib/index.js": 'module.exports = require("./impl");\n',
      "node_modules/anon-lib/impl.js":
        "if (process.env.FLAG) {\n  module.exports = function (a) { return a; };\n} else {\n  module.exports = function (b) { return b; };\n}\n",
    });

    expect((await scan(root)).verdict).toBe("UNKNOWN");
  });

  it("stays UNKNOWN when the implementation file shadows the CommonJS ambient names", async () => {
    const root = callingProject({
      "node_modules/anon-lib/index.js": 'module.exports = require("./impl");\n',
      "node_modules/anon-lib/impl.js":
        "const module = { exports: null };\nmodule.exports = function (a) { return a; };\n",
    });

    expect((await scan(root)).verdict).toBe("UNKNOWN");
  });

  it("stays UNKNOWN for an alias chain longer than one hop (RWF-012 boundary)", async () => {
    const root = callingProject({
      "node_modules/anon-lib/index.js":
        "const a = function (x) { return x; };\nconst b = a;\nmodule.exports = b;\n",
    });

    expect((await scan(root)).verdict).toBe("UNKNOWN");
  });

  it("stays UNKNOWN for a CROSS-PACKAGE re-export of an anonymous export (RWF-004b boundary)", async () => {
    const root = callingProject({
      "node_modules/anon-lib/index.js": 'module.exports = require("other");\n',
      "node_modules/other/package.json": manifest("other"),
      "node_modules/other/index.js":
        "module.exports = function (a) {\n  return a;\n};\n",
    });

    expect((await scan(root)).verdict).toBe("UNKNOWN");
  });
});

describe("scan: RWF-003 attribution is a precondition for BOTH verdicts", () => {
  it("reaches NOT_AFFECTED for an attributed anonymous export nothing calls", async () => {
    // The application requires anon-lib and never calls it; main() returns
    // its own argument. The target is now a REAL node, the graph is
    // complete, and no path reaches it -- so this is the correct answer,
    // reached by exactly the same positive-proof route RWB-06/RWB-11b
    // already use.
    //
    // Recorded deliberately: before RWF-003 this was UNKNOWN, because the
    // export could not be attributed at all (verdict.ts's Site A). Better
    // attribution legitimately enables a negative proof as well as a
    // positive one -- the two are the same fact -- and this is the one
    // place that transition is pinned. Note what is NOT happening: nothing
    // here infers NOT_AFFECTED from a failure to resolve. When the same
    // export cannot be attributed (every scenario in the block above), the
    // verdict is UNKNOWN, never NOT_AFFECTED.
    const root = callingProject(
      {
        "node_modules/anon-lib/index.js":
          "module.exports = function (a) {\n  return a;\n};\n",
      },
      "return input;",
    );

    expect((await scan(root)).verdict).toBe("NOT_AFFECTED");
  });
});
