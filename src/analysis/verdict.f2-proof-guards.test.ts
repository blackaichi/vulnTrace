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
import { buildFindingForTest } from "../testing/finding.js";
import {
  buildGateEligibleModuleLoadClosure,
  callGraphNegativeProofBlockers,
  type ModuleLoadClosure,
} from "./module-load-closure.js";

/**
 * FOUNDATION-F2 / F2-A -- an ABSENT `ModuleLoadClosure` must block every
 * call-graph-derived negative proof.
 *
 * THE DEFECT. `callGraphNegativeProofBlockers(undefined)` returned `[]`,
 * documented as "an absent closure is not itself evidence of a blocker"
 * and carried in `buildFinding` as an accepted residual risk. That
 * confused two different questions. The guard does not ask whether the
 * closure OBSERVED a problem; it asks whether the loader, syntax-validity
 * and execution-capability precondition has been ESTABLISHED. An absent
 * closure establishes nothing, and `[]` reported that as an all-clear.
 *
 * WHY IT IS NOT COSMETIC. Two of the conditions a present closure blocks
 * on are conditions the CALL GRAPH structurally cannot detect on its own:
 *
 *  - a SYNTAX ERROR in a loaded member. `indexSourceFileFromDisk` is
 *    error-tolerant, so the graph is built from a partial, silently
 *    reshaped AST; it never checks `hasSyntaxErrors`. A `require` and the
 *    call that follows it can be swallowed by the same error.
 *  - a loader mutation in a NON-CALL position
 *    (`require.extensions['.js'] = hook`). VT-300's own guard inspects
 *    unresolved CALL EDGES, and an assignment produces no edge at all.
 *
 * Only the closure's whole-file scan sees either one. Both were reproduced
 * reaching NOT_AFFECTED with the closure absent and every other
 * precondition unchanged. The `withClosure`/`withoutClosure` pairs below
 * are those reproductions, kept as the permanent regression.
 *
 * COST, STATED PLAINLY. A scan with no closure can no longer reach a
 * call-graph-derived NOT_AFFECTED at all -- see the "clean project" case,
 * which has no widening construct anywhere and still degrades. That is
 * intended. In production a closure is absent only when there were no
 * entrypoints (nothing was analyzable), when construction threw
 * (cli/scan.ts diagnoses and continues), or when the context binding
 * REJECTED it for not belonging to this scan. Declining to certify a
 * negative in all three is the right answer.
 */

const vulnerability: Vulnerability = {
  id: "GHSA-fixture-0001",
  aliases: [],
  package: "vuln-lib",
  ecosystem: "npm",
  affectedVersions: [],
  fixedVersions: [],
  references: [],
};

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

const INSTALLED_LIB: Readonly<Record<string, string>> = {
  "node_modules/vuln-lib/package.json": JSON.stringify({
    name: "vuln-lib",
    version: "1.0.0",
  }),
  "node_modules/vuln-lib/index.js":
    "function vulnerable(x){ return x; }\n" +
    "function safe(x){ return x; }\n" +
    "module.exports = { vulnerable, safe };\n",
};

type Family = "A" | "B" | "C" | "NONE";

function familyOf(finding: Finding | undefined): Family {
  const evidence = finding?.evidence;
  if (evidence?.confirmedAbsentFromModuleLoadClosure) return "A";
  if (evidence?.confirmedAbsentInstance) return "B";
  if (evidence?.confirmedUnreachableTarget) return "C";
  return "NONE";
}

/** A NOT_AFFECTED carries exactly one proof object; anything else carries none. */
function expectExclusivity(finding: Finding | undefined): void {
  const evidence = finding?.evidence;
  const count = [
    evidence?.confirmedAbsentFromModuleLoadClosure,
    evidence?.confirmedAbsentInstance,
    evidence?.confirmedUnreachableTarget,
  ].filter((proof) => proof !== undefined).length;
  expect(count).toBe(finding?.verdict === "NOT_AFFECTED" ? 1 : 0);
}

describe("F2-A: an absent ModuleLoadClosure blocks call-graph-derived negatives", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  /** Real project -> real call graph -> real buildFinding, with the closure supplied or withheld. */
  async function run(options: {
    readonly files: Readonly<Record<string, string>>;
    readonly entries: readonly string[];
    readonly withClosure: boolean;
    readonly instanceRelPath?: string;
  }): Promise<Finding | undefined> {
    const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-f2a-"));
    tempDirs.push(root);
    const write = (rel: string, content: string): void => {
      const full = path.join(root, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    write("package.json", JSON.stringify({ name: "app" }));
    for (const [rel, content] of Object.entries(options.files)) {
      write(rel, content);
    }

    const project = loadTsProject(root);
    const resolver = createModuleResolver(project);
    const dependencyNodes: DependencyNode[] = [
      {
        id: "vuln-lib@0",
        name: "vuln-lib",
        version: "1.0.0",
        ecosystem: "npm",
        direct: true,
        locations: [path.join(root, "node_modules/vuln-lib")],
        dependencyPaths: [],
      },
    ];
    const knownPackageRoots = buildKnownPackageRoots(dependencyNodes, root);
    const entrypoints: Entrypoint[] = options.entries.map((rel) => ({
      filePath: path.join(root, rel),
      source: "configured",
      reason: "test",
    }));

    const graph = await buildCallGraph({
      entryFiles: entrypoints.map((entry) => entry.filePath),
      resolver,
      project,
    });

    return buildFindingForTest({
      vulnerability,
      packageName: "vuln-lib",
      packageVersion: "1.0.0",
      packageInstance: canonicalizePackageInstancePath(
        path.join(root, options.instanceRelPath ?? "node_modules/vuln-lib"),
      ),
      matchResult: "affected",
      rule,
      graph,
      entrypoints,
      resolver,
      projectRoot: root,
      knownPackageRoots,
      graphTruncated: false,
      moduleLoadClosureUnavailable: !options.withClosure,
    });
  }

  /**
   * The reproductions. Each construct is one the CALL GRAPH cannot see for
   * itself, so with the closure withheld the analyzer previously had
   * nothing left to object with and certified a negative.
   */
  const CLOSURE_ONLY_BLOCKERS: readonly {
    readonly name: string;
    readonly blocker: string;
    readonly files: Readonly<Record<string, string>>;
  }[] = [
    {
      name: "a syntax error in a loaded member",
      blocker: "parse_failure",
      files: {
        ...INSTALLED_LIB,
        "src/broken.js": "function oops( { /* unterminated\n",
        "src/index.js":
          'const { safe } = require("vuln-lib");\n' +
          'require("./broken.js");\n' +
          "function main(){ return safe(1); }\nmodule.exports = { main };\n",
      },
    },
    {
      name: "a loader mutation in a non-call position",
      blocker: "loader_hook_mutation",
      files: {
        ...INSTALLED_LIB,
        "src/index.js":
          'const { safe } = require("vuln-lib");\n' +
          'require.extensions[".js"] = function(){};\n' +
          "function main(){ return safe(1); }\nmodule.exports = { main };\n",
      },
    },
  ];

  for (const scenario of CLOSURE_ONLY_BLOCKERS) {
    it(`WITH a closure, ${scenario.name} blocks the negative (control)`, async () => {
      const finding = await run({
        files: scenario.files,
        entries: ["src/index.js"],
        withClosure: true,
      });

      expect(finding?.verdict).toBe("UNKNOWN");
      expect(finding?.evidence?.reasons?.[0]).toContain(scenario.blocker);
      expectExclusivity(finding);
    });

    it(`WITHOUT a closure, ${scenario.name} must STILL block the negative`, async () => {
      const finding = await run({
        files: scenario.files,
        entries: ["src/index.js"],
        withClosure: false,
      });

      // Pre-F2-A this was NOT_AFFECTED -- a false negative over code that
      // can rewire module loading or hide a call behind a syntax error.
      expect(finding?.verdict).toBe("UNKNOWN");
      expect(familyOf(finding)).toBe("NONE");
      expect(finding?.evidence?.reasons?.[0]).toContain(
        "module_load_closure_unavailable",
      );
      expectExclusivity(finding);
    });
  }

  it("degrades even a project with no widening construct anywhere", async () => {
    // The cost of failing closed, stated as a test rather than left to be
    // discovered: this project is clean, and the answer is still UNKNOWN,
    // because the guard's evidence is missing rather than satisfied.
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "src/index.js":
          'const { safe } = require("vuln-lib");\n' +
          "function main(){ return safe(1); }\nmodule.exports = { main };\n",
      },
      entries: ["src/index.js"],
      withClosure: false,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(familyOf(finding)).toBe("NONE");
    expectExclusivity(finding);
  });

  it("still reaches family C on the SAME clean project once the closure exists", async () => {
    // The isolator is honest: identical inputs, only the closure differs.
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "src/index.js":
          'const { safe } = require("vuln-lib");\n' +
          "function main(){ return safe(1); }\nmodule.exports = { main };\n",
      },
      entries: ["src/index.js"],
      withClosure: true,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(familyOf(finding)).toBe("C");
    expect(
      finding?.evidence?.confirmedUnreachableTarget?.reachableSubgraphComplete,
    ).toBe(true);
    expectExclusivity(finding);
  });

  it("blocks the family-B shape (instance never traversed) when the closure is absent", async () => {
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "node_modules/other-lib/package.json": JSON.stringify({
          name: "other-lib",
          version: "1.0.0",
        }),
        "node_modules/other-lib/index.js": "module.exports = {};\n",
        "src/index.js": 'require("other-lib");\nmodule.exports = {};\n',
      },
      entries: ["src/index.js"],
      withClosure: false,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(familyOf(finding)).toBe("NONE");
    expectExclusivity(finding);
  });
});

describe("F2-A: the blocker helper itself", () => {
  it("reports module_load_closure_unavailable for an absent closure, never []", async () => {
    expect(callGraphNegativeProofBlockers(undefined)).toEqual([
      "module_load_closure_unavailable",
    ]);
  });

  it("is unchanged for a present, complete closure", async () => {
    const complete: ModuleLoadClosure = {
      rootFiles: ["/project/src/index.js"],
      loadedFiles: ["/project/src/index.js"],
      loadedPackageInstances: [],
      complete: true,
      incompleteness: [],
    };
    expect(callGraphNegativeProofBlockers(complete)).toEqual([]);
  });

  it("is unchanged for a present, incomplete closure", async () => {
    const incomplete: ModuleLoadClosure = {
      rootFiles: ["/project/src/index.js"],
      loadedFiles: ["/project/src/index.js"],
      loadedPackageInstances: [],
      complete: false,
      incompleteness: [
        { reason: "dynamic_require", importer: "/project/src/index.js" },
        { reason: "parse_failure", importer: "/project/src/broken.js" },
        // Excluded by `invalidatesCallGraphNegativeProof` -- the closure's
        // own bound says nothing about how far the call graph got, which
        // `graphTruncated` guards independently.
        { reason: "traversal_truncated", importer: "/project/src/deep.js" },
      ],
    };
    expect(callGraphNegativeProofBlockers(incomplete)).toEqual([
      "dynamic_require",
      "parse_failure",
    ]);
  });
});

describe("F2-A: closure CONSTRUCTION failure modes all reach absence", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("no entrypoints -> no gate-eligible closure -> absence", async () => {
    // The real production shape behind cli/scan.ts's own "no entrypoints
    // were discovered" diagnostic. A vacuously-complete zero-root closure
    // would put EVERY installed instance out of the closure, so the
    // builder refuses to produce one at all -- and F2-A makes that refusal
    // block the proof rather than silently permit it.
    const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-f2a-noep-"));
    tempDirs.push(root);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "app" }),
    );

    const resolver = createModuleResolver(loadTsProject(root));
    const closure = await buildGateEligibleModuleLoadClosure({
      entrypoints: [],
      resolver,
      knownPackageRoots: new Map(),
    });

    expect(closure).toBeUndefined();
    expect(callGraphNegativeProofBlockers(closure)).toEqual([
      "module_load_closure_unavailable",
    ]);
  });
});
