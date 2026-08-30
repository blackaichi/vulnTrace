import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import type { DependencyNode } from "../domain/dependency.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
} from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Finding } from "../domain/verdict.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { buildGateEligibleModuleLoadClosure } from "./module-load-closure.js";
import { buildFinding } from "./verdict.js";

/**
 * VT-CONTRACT-02 -- proof family C's evidence is now STRUCTURALLY required,
 * not conditionally attached.
 *
 * Family C previously built its evidence through a conditional spread:
 *
 *     ...(unreachableTarget ? { confirmedUnreachableTarget: ... } : {})
 *
 * That shape encoded a control-flow argument as an assumption. The
 * argument held -- `checkedAny` is set in exactly three places and every
 * one of them either returns earlier (family A, family B, AFFECTED),
 * forces `sawUnknown` (UNKNOWN), or sets `unreachableTarget` -- but if a
 * future refactor ever broke it, the failure mode was the worst available
 * one: a NOT_AFFECTED with NO proof object at all, i.e. an unproven
 * negative verdict. `buildFinding` now refuses to return family C without
 * an authoritative unreachable target and degrades to UNKNOWN instead.
 *
 * The guard's own branch is not reachable through any composition this
 * suite can build (that is the point of the argument above), so it is not
 * asserted directly here -- doing so would require faking analyzer
 * internals and would test the fake, not the analyzer. What IS asserted,
 * across every scenario below, is the invariant the guard exists to
 * protect: a NOT_AFFECTED carries exactly one proof object, and a family-C
 * NOT_AFFECTED always carries `confirmedUnreachableTarget`.
 *
 * The second half of this file is a soundness regression battery. VT-
 * CONTRACT-02 is evidence hardening, NOT precision expansion: every
 * construct that blocked family C before must still block it.
 */

const LIB_SRC =
  "function vulnerable(x){ return x; }\n" +
  "function safe(x){ return x; }\n" +
  "module.exports = { vulnerable, safe };\n";

const rule: VulnerableSymbolRule = {
  id: "GHSA-fixture-0001",
  package: { name: "vuln-lib" },
  targets: [
    {
      module: "vuln-lib",
      export: "vulnerable",
      kind: "function",
      confidence: 1,
    },
  ],
};

const vulnerability: Vulnerability = {
  id: "GHSA-fixture-0001",
  aliases: [],
  package: "vuln-lib",
  ecosystem: "npm",
  affectedVersions: [],
  fixedVersions: [],
  references: [],
};

type Family = "A" | "B" | "C" | "NONE";

function familyOf(finding: Finding | undefined): Family {
  const evidence = finding?.evidence;
  if (evidence?.confirmedAbsentFromModuleLoadClosure) return "A";
  if (evidence?.confirmedAbsentInstance) return "B";
  if (evidence?.confirmedUnreachableTarget) return "C";
  return "NONE";
}

function proofObjectCount(finding: Finding | undefined): number {
  const evidence = finding?.evidence;
  if (!evidence) return 0;
  return [
    evidence.confirmedAbsentFromModuleLoadClosure,
    evidence.confirmedAbsentInstance,
    evidence.confirmedUnreachableTarget,
  ].filter((proof) => proof !== undefined).length;
}

/**
 * THE invariant VT-CONTRACT-02 protects, asserted on every finding this
 * file produces regardless of what the scenario was aiming at.
 */
function expectNegativeProofInvariant(finding: Finding | undefined): void {
  if (finding?.verdict === "NOT_AFFECTED") {
    expect(proofObjectCount(finding)).toBe(1);
  } else {
    expect(proofObjectCount(finding)).toBe(0);
  }
}

describe("VT-CONTRACT-02: family C evidence is structurally required", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  /** Real project -> real closure + real call graph -> real buildFinding. */
  async function run(options: {
    readonly files: Readonly<Record<string, string>>;
    readonly entries: readonly string[];
    readonly installRelPaths?: readonly string[];
    readonly instanceRelPath?: string;
    readonly graphTruncated?: boolean;
    readonly ruleOverride?: VulnerableSymbolRule;
  }): Promise<Finding | undefined> {
    const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-famc-"));
    tempDirs.push(root);
    const write = (rel: string, content: string): string => {
      const p = path.join(root, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
      return p;
    };

    write("package.json", JSON.stringify({ name: "app" }));
    for (const [rel, content] of Object.entries(options.files)) {
      write(rel, content);
    }

    const installRelPaths = options.installRelPaths ?? [
      "node_modules/vuln-lib",
    ];
    const project = loadTsProject(root);
    const resolver = createModuleResolver(project);
    const dependencyNodes: DependencyNode[] = installRelPaths.map(
      (rel, index) => ({
        id: `vuln-lib@${index}`,
        name: "vuln-lib",
        version: "1.0.0",
        ecosystem: "npm",
        direct: index === 0,
        locations: [path.join(root, rel)],
        dependencyPaths: [],
      }),
    );
    const knownPackageRoots = buildKnownPackageRoots(dependencyNodes, root);
    const entrypoints: Entrypoint[] = options.entries.map((rel) => ({
      filePath: path.join(root, rel),
      source: "configured",
      reason: "test",
    }));

    const moduleLoadClosure = await buildGateEligibleModuleLoadClosure({
      entrypoints,
      resolver,
      maxFiles: 5000,
      knownPackageRoots,
    });
    const graph = await buildCallGraph({
      entryFiles: entrypoints.map((entry) => entry.filePath),
      resolver,
      project,
    });

    return buildFinding({
      vulnerability,
      packageName: "vuln-lib",
      packageVersion: "1.0.0",
      packageInstance: canonicalizePackageInstancePath(
        path.join(root, options.instanceRelPath ?? "node_modules/vuln-lib"),
      ),
      matchResult: "affected",
      rule: options.ruleOverride ?? rule,
      graph,
      entrypoints,
      resolver,
      projectRoot: root,
      knownPackageRoots,
      moduleLoadClosure,
      graphTruncated: options.graphTruncated ?? false,
    });
  }

  const INSTALLED_LIB: Readonly<Record<string, string>> = {
    "node_modules/vuln-lib/package.json": JSON.stringify({
      name: "vuln-lib",
      version: "1.0.0",
    }),
    "node_modules/vuln-lib/index.js": LIB_SRC,
  };

  it("a direct loaded-but-uncalled target yields family C WITH its evidence object", async () => {
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "src/index.js":
          'const { safe } = require("vuln-lib");\n' +
          "function main(){ return safe(1); }\nmodule.exports = { main };\n",
      },
      entries: ["src/index.js"],
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(familyOf(finding)).toBe("C");

    const proof = finding?.evidence?.confirmedUnreachableTarget;
    expect(proof).toBeDefined();
    expect(proof?.target).toEqual({ module: "vuln-lib", export: "vulnerable" });
    expect(proof?.entrypointRoots.length).toBeGreaterThan(0);
    expect(proof?.reachableSubgraphComplete).toBe(true);
    expectNegativeProofInvariant(finding);
  });

  it("a wrapper chain to a safe export still yields family C WITH its evidence object", async () => {
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "src/wrapper.js":
          'const { safe } = require("vuln-lib");\n' +
          "function wrap(x){ return safe(x); }\nmodule.exports = { wrap };\n",
        "src/index.js":
          'const { wrap } = require("./wrapper.js");\n' +
          "function main(){ return wrap(1); }\nmodule.exports = { main };\n",
      },
      entries: ["src/index.js"],
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(familyOf(finding)).toBe("C");
    expect(
      finding?.evidence?.confirmedUnreachableTarget?.reachableSubgraphComplete,
    ).toBe(true);
    expectNegativeProofInvariant(finding);
  });

  it("multiple entrypoints, none reaching the target, record every root on the proof", async () => {
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "src/index.js":
          'const { safe } = require("vuln-lib");\n' +
          "function main(){ return safe(1); }\nmodule.exports = { main };\n",
        "src/worker.js":
          'const { safe } = require("vuln-lib");\n' +
          "function work(){ return safe(2); }\nmodule.exports = { work };\n",
      },
      entries: ["src/index.js", "src/worker.js"],
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(familyOf(finding)).toBe("C");
    expect(
      finding?.evidence?.confirmedUnreachableTarget?.entrypointRoots,
    ).toHaveLength(2);
    expectNegativeProofInvariant(finding);
  });

  it("names the reachable subgraph, never the whole call graph", async () => {
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "src/index.js":
          'const { safe } = require("vuln-lib");\n' +
          "function main(){ return safe(1); }\nmodule.exports = { main };\n",
      },
      entries: ["src/index.js"],
    });

    const proof = finding?.evidence?.confirmedUnreachableTarget;
    expect(proof?.reachableSubgraphComplete).toBe(true);
    // The retired name must not reappear on the serialized proof.
    expect(
      (proof as unknown as Record<string, unknown>)["callGraphComplete"],
    ).toBeUndefined();
  });

  /**
   * SOUNDNESS REGRESSION. Each construct below blocked family C before
   * VT-CONTRACT-02 and must still block it: this task hardens how the
   * evidence is built, and must not widen what counts as proof. A
   * NOT_AFFECTED appearing here would be a new false negative.
   */
  describe("soundness regression: no new NOT_AFFECTED", () => {
    const attacks: readonly {
      readonly name: string;
      readonly options: Parameters<typeof run>[0];
    }[] = [
      {
        name: "unresolved reachable edge (dynamic require in a reachable function)",
        options: {
          files: {
            ...INSTALLED_LIB,
            "src/index.js":
              "function main(name){ const m = require(name); return m; }\n" +
              "module.exports = { main };\n",
          },
          entries: ["src/index.js"],
        },
      },
      {
        name: "graph truncated by a resource limit",
        options: {
          files: {
            ...INSTALLED_LIB,
            "src/index.js":
              'const { safe } = require("vuln-lib");\n' +
              "function main(){ return safe(1); }\nmodule.exports = { main };\n",
          },
          entries: ["src/index.js"],
          graphTruncated: true,
        },
      },
      {
        name: "parse_failure in a transitively loaded file",
        options: {
          files: {
            ...INSTALLED_LIB,
            "src/broken.js": "function oops({ { return 1; }\n",
            "src/index.js":
              'require("./broken.js");\n' +
              'const { safe } = require("vuln-lib");\n' +
              "function main(){ return safe(1); }\nmodule.exports = { main };\n",
          },
          entries: ["src/index.js"],
        },
      },
      {
        name: "loader_hook_mutation (non-call loader assignment)",
        options: {
          files: {
            ...INSTALLED_LIB,
            "src/index.js":
              'const Module = require("module");\n' +
              "Module._extensions['.js'] = function(){};\n" +
              'const { safe } = require("vuln-lib");\n' +
              "function main(){ return safe(1); }\nmodule.exports = { main };\n",
          },
          entries: ["src/index.js"],
        },
      },
      {
        name: "target module unresolved",
        options: {
          files: {
            "src/index.js":
              "function main(){ return 1; }\nmodule.exports = { main };\n",
          },
          entries: ["src/index.js"],
          ruleOverride: {
            id: "GHSA-fixture-0001",
            package: { name: "vuln-lib" },
            targets: [
              { module: "not-installed-anywhere", export: "vulnerable" },
            ],
          },
        },
      },
      {
        name: "target export unattributed inside a discovered instance",
        options: {
          files: {
            ...INSTALLED_LIB,
            "src/index.js":
              'const { safe } = require("vuln-lib");\n' +
              "function main(){ return safe(1); }\nmodule.exports = { main };\n",
          },
          entries: ["src/index.js"],
          ruleOverride: {
            id: "GHSA-fixture-0001",
            package: { name: "vuln-lib" },
            targets: [{ module: "vuln-lib", export: "noSuchExport" }],
          },
        },
      },
      {
        name: "re-export binding gap with a duplicate instance genuinely called",
        options: {
          files: {
            ...INSTALLED_LIB,
            "node_modules/consumer/package.json": JSON.stringify({
              name: "consumer",
              version: "1.0.0",
            }),
            "node_modules/consumer/index.js":
              'module.exports = require("vuln-lib");\n',
            "node_modules/consumer/node_modules/vuln-lib/package.json":
              JSON.stringify({ name: "vuln-lib", version: "1.0.0" }),
            "node_modules/consumer/node_modules/vuln-lib/index.js": LIB_SRC,
            "src/index.js":
              'const c = require("consumer");\n' +
              "function main(){ return c.vulnerable(1); }\nmodule.exports = { main };\n",
          },
          entries: ["src/index.js"],
          installRelPaths: [
            "node_modules/vuln-lib",
            "node_modules/consumer/node_modules/vuln-lib",
          ],
          instanceRelPath: "node_modules/consumer/node_modules/vuln-lib",
        },
      },
    ];

    for (const attack of attacks) {
      it(`${attack.name} -> never a family C NOT_AFFECTED`, async () => {
        const finding = await run(attack.options);

        // The invariant holds no matter which verdict came out.
        expectNegativeProofInvariant(finding);
        // And family C specifically must not have fired.
        expect(familyOf(finding)).not.toBe("C");
        expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
      });
    }
  });

  it("duplicate instances keep their own verdicts, and neither is an unproven NOT_AFFECTED", async () => {
    // The entrypoint imports and calls the TOP-LEVEL install directly; the
    // nested one is never loaded. Both instances are evaluated, and both
    // must satisfy the invariant.
    const files: Readonly<Record<string, string>> = {
      ...INSTALLED_LIB,
      "node_modules/consumer/package.json": JSON.stringify({
        name: "consumer",
        version: "1.0.0",
      }),
      "node_modules/consumer/node_modules/vuln-lib/package.json":
        JSON.stringify({ name: "vuln-lib", version: "1.0.0" }),
      "node_modules/consumer/node_modules/vuln-lib/index.js": LIB_SRC,
      "src/index.js":
        'const { safe } = require("vuln-lib");\n' +
        "function main(){ return safe(1); }\nmodule.exports = { main };\n",
    };
    const installRelPaths = [
      "node_modules/vuln-lib",
      "node_modules/consumer/node_modules/vuln-lib",
    ];

    const topLevel = await run({
      files,
      entries: ["src/index.js"],
      installRelPaths,
      instanceRelPath: "node_modules/vuln-lib",
    });
    const nested = await run({
      files,
      entries: ["src/index.js"],
      installRelPaths,
      instanceRelPath: "node_modules/consumer/node_modules/vuln-lib",
    });

    expectNegativeProofInvariant(topLevel);
    expectNegativeProofInvariant(nested);
    // The loaded instance's target is genuinely never called -> family C.
    expect(topLevel?.verdict).toBe("NOT_AFFECTED");
    expect(familyOf(topLevel)).toBe("C");
    // The never-loaded duplicate is a different claim entirely, and it is
    // never family C -- it must not borrow the reachable instance's proof.
    expect(familyOf(nested)).not.toBe("C");
  });
});
