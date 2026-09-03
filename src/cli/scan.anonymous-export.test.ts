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
  /** Present only when a Family C negative proof was actually issued. */
  readonly hasNegativeProof: boolean;
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
      evidence?: {
        path: string[];
        confirmedUnreachableTarget?: unknown;
      };
    }>;
  };
  const finding = output.findings.find((f) => f.package === "anon-lib");
  return {
    verdict: finding ? finding.verdict : "NO_FINDING",
    evidence: finding?.evidence?.path ?? [],
    hasNegativeProof:
      finding?.evidence?.confirmedUnreachableTarget !== undefined,
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

  it("stays UNKNOWN when a MUTATED hop breaks the alias chain (RWF-012)", async () => {
    const root = callingProject({
      "node_modules/anon-lib/index.js":
        "const a = function (x) { return x; };\nlet b = a;\nb = other;\nconst c = b;\nmodule.exports = c;\n",
    });

    expect((await scan(root)).verdict).toBe("UNKNOWN");
  });

  it("stays UNKNOWN when the alias chain is a CYCLE (RWF-012)", async () => {
    const root = callingProject({
      "node_modules/anon-lib/index.js":
        "const a = b;\nconst b = a;\nmodule.exports = a;\n",
    });

    expect((await scan(root)).verdict).toBe("UNKNOWN");
  });

  it("stays UNKNOWN when a hop is conditionally initialized (RWF-012)", async () => {
    const root = callingProject({
      "node_modules/anon-lib/index.js":
        "let a;\nif (process.env.FLAG) {\n  a = function (x) { return x; };\n}\nconst b = a;\nmodule.exports = b;\n",
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

describe("scan: RWF-012 alias chains, end to end through the real scan", () => {
  it("reaches AFFECTED through a THREE-hop alias chain to an anonymous export", async () => {
    // Every hop is a module-scope, declared-once, never-reassigned
    // binding, so the chain is a proof and the anonymous function at the
    // end of it is the module's real exported callable.
    const root = callingProject({
      "node_modules/anon-lib/index.js":
        "const a = function (x) { return x; };\nconst b = a;\nconst c = b;\nmodule.exports = c;\n",
    });

    const { verdict, evidence } = await scan(root);
    expect(verdict).toBe("AFFECTED");
    expect(evidence.some((step) => step.includes("anon-lib"))).toBe(true);
  });

  it("an alias chain does not invent an anon-lib target for a CROSS-PACKAGE re-export", async () => {
    // The sibling RWF-004b boundary case above, with a three-hop chain in
    // front of it. The rule names `anon-lib#default`, but the real callable
    // lives in `other` -- so anon-lib's own finding must stay UNKNOWN. A
    // chain that resolved to something inside anon-lib here would be a
    // phantom target manufactured by alias chasing.
    const root = callingProject({
      "node_modules/anon-lib/index.js":
        'const dep = require("other");\nconst a = dep;\nconst b = a;\nmodule.exports = b;\n',
      "node_modules/other/package.json": manifest("other"),
      "node_modules/other/index.js":
        "module.exports = function (a) {\n  return a;\n};\n",
    });

    expect((await scan(root)).verdict).toBe("UNKNOWN");
  });
});

describe("scan: RWF-012 chained whole-module exports need an unconditional assignment", () => {
  /**
   * The blocker an independent soundness audit reproduced against the
   * first RWF-012 commit, pinned end to end through the real scan.
   *
   * `module.exports` is assigned in BOTH branches, so
   * `findLastModuleExportsAssignment`'s last-write-wins choice is a branch
   * picked by source order. Before the guard, reading through the chained
   * assignment handed that arbitrary choice a `localName`, the same-file
   * name search bound `second`, and -- because the application never calls
   * the library at all -- Family C proved THAT node unreachable and issued
   * a complete NOT_AFFECTED. The run that took the other branch exports
   * `first`, so the clean bill of health was for a value the module may
   * never have exported.
   *
   * The assertion is deliberately two-part: the verdict must be UNKNOWN,
   * AND no negative proof may be issued at all. A verdict check alone
   * would still pass if some future change produced UNKNOWN while leaving
   * a stale `confirmedUnreachableTarget` in the evidence.
   */
  const CONDITIONAL_CHAIN =
    "function first(a) {\n  return a;\n}\n" +
    "function second(a) {\n  return a;\n}\n" +
    "if (process.env.FLAG) {\n  module.exports = alias = first;\n} else {\n  module.exports = alias = second;\n}\n";

  it("stays UNKNOWN, with NO negative proof, for a conditional chained assignment", async () => {
    const root = callingProject(
      { "node_modules/anon-lib/index.js": CONDITIONAL_CHAIN },
      "return input;",
    );

    const { verdict, hasNegativeProof } = await scan(root);
    expect(verdict).toBe("UNKNOWN");
    expect(hasNegativeProof).toBe(false);
  });

  it("stays UNKNOWN, with NO negative proof, for a chained assignment in a function body", async () => {
    const root = callingProject(
      {
        "node_modules/anon-lib/index.js":
          "function impl(a) {\n  return a;\n}\n" +
          "function configure() {\n  module.exports = alias = impl;\n}\nconfigure();\n",
      },
      "return input;",
    );

    const { verdict, hasNegativeProof } = await scan(root);
    expect(verdict).toBe("UNKNOWN");
    expect(hasNegativeProof).toBe(false);
  });

  it("still reaches AFFECTED through an UNCONDITIONAL chained assignment", async () => {
    // The control: RWF-012's intended improvement must survive the guard.
    const root = callingProject({
      "node_modules/anon-lib/index.js":
        "function impl(a) {\n  return a;\n}\nmodule.exports = alias = impl;\n",
    });

    expect((await scan(root)).verdict).toBe("AFFECTED");
  });

  it("still reaches NOT_AFFECTED through an UNCONDITIONAL chained assignment nothing calls", async () => {
    // The other half of the control: an unconditional chained export is
    // authoritative enough to carry a NEGATIVE proof too, exactly as the
    // direct form does. This is the transition the guard must NOT undo.
    const root = callingProject(
      {
        "node_modules/anon-lib/index.js":
          "function impl(a) {\n  return a;\n}\nmodule.exports = alias = impl;\n",
      },
      "return input;",
    );

    const { verdict, hasNegativeProof } = await scan(root);
    expect(verdict).toBe("NOT_AFFECTED");
    expect(hasNegativeProof).toBe(true);
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
