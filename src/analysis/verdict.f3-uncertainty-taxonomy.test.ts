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
import type { UncertaintyCategory } from "../domain/uncertainty.js";
import type { Finding } from "../domain/verdict.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { buildFindingForTest } from "../testing/finding.js";

/**
 * FOUNDATION F3 -- the verdict-level half of the taxonomy.
 *
 * Two questions, and the second one matters more than the first:
 *
 * 1. Does an UNKNOWN get classified correctly? (Test-matrix rows A-D, F.)
 * 2. Does classification change anything? (Rows L, M, and the whole
 *    soundness block at the bottom.)
 *
 * F3 § 24 makes the second one the acceptance condition: the taxonomy is
 * OBSERVATIONAL, so for every existing finding the verdict must be
 * byte-identical to what it was before. The `before`/`after` framing is
 * structural here rather than historical -- the classification is compared
 * against the verdict on the SAME finding, so a change that made a reason
 * influence a verdict would show up as the two disagreeing.
 *
 * Real projects on disk, real module resolution, real call graphs. A
 * synthetic graph would let a construct be classified without ever proving
 * the analyzer produces that construct's reason for that source shape,
 * which is most of what could actually go wrong.
 */

const vulnerability: Vulnerability = {
  id: "GHSA-f3-taxonomy",
  aliases: [],
  package: "vuln-lib",
  ecosystem: "npm",
  affectedVersions: [],
  fixedVersions: [],
  references: [],
};

const rule: VulnerableSymbolRule = {
  id: "GHSA-f3-taxonomy",
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

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

interface RunOptions {
  readonly files: Readonly<Record<string, string>>;
  readonly entries: readonly string[];
  readonly graphTruncated?: boolean;
  readonly moduleLoadClosureUnavailable?: boolean;
  readonly matchResult?: "affected" | "indeterminate";
  readonly rule?: VulnerableSymbolRule;
}

/** Real project -> real call graph -> real buildFinding. */
async function run(options: RunOptions): Promise<Finding | undefined> {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-f3-"));
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
      path.join(root, "node_modules/vuln-lib"),
    ),
    matchResult: options.matchResult ?? "affected",
    rule: options.rule ?? rule,
    graph,
    entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
    graphTruncated: options.graphTruncated ?? false,
    moduleLoadClosureUnavailable: options.moduleLoadClosureUnavailable ?? false,
  });
}

/** The categories an UNKNOWN finding reports, deduplicated. */
function categoriesOf(finding: Finding | undefined): UncertaintyCategory[] {
  return [...new Set((finding?.unknownReasons ?? []).map((e) => e.category))];
}

function reasonsOf(finding: Finding | undefined): string[] {
  return (finding?.unknownReasons ?? []).map((e) => e.reason);
}

describe("F3 test matrix: each construct reaches its own category", () => {
  /**
   * ROW A -- an unsupported call shape.
   *
   * A call through an expression the call graph has no rule for. It is
   * NON-widening (whatever it reaches was already in scope, in a module
   * already loaded), which is exactly what makes it a bounded, closeable
   * coverage gap rather than an escape.
   */
  it("A: an unsupported construct is unmodeled_construct", async () => {
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "src/index.js":
          'const lib = require("vuln-lib");\n' +
          "module.exports.main = function main(){\n" +
          // A call on the result of an immediately-invoked expression:
          // no callee the graph can name.
          "  return (function(){ return lib.safe; })()();\n" +
          "};\n",
      },
      entries: ["src/index.js"],
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(categoriesOf(finding)).toContain("unmodeled_construct");
    expect(reasonsOf(finding)).toContain("unsupported_construct");
  });

  /**
   * ROW B -- a computed member with a non-literal key.
   *
   * The analyzer understands `lib[name]()` perfectly; what it cannot do is
   * pick which of the values already in scope `name` names. Deliberately
   * NOT capability_escape -- this call cannot introduce a module the graph
   * never saw -- and not a coverage gap, since no syntax support closes it.
   */
  it("B: a computed dynamic member is value_uncertainty", async () => {
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "src/index.js":
          'const lib = require("vuln-lib");\n' +
          "module.exports.main = function main(name){\n" +
          "  return lib[name]();\n" +
          "};\n",
      },
      entries: ["src/index.js"],
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(reasonsOf(finding)).toContain("dynamic_member_access");
    expect(categoriesOf(finding)).toContain("value_uncertainty");
    // The distinction the whole category exists for.
    expect(categoriesOf(finding)).not.toContain("unmodeled_construct");
  });

  /**
   * ROW C -- runtime capability escapes.
   *
   * Each of these can execute or load code the graph never discovered.
   * Grouped by CONSEQUENCE rather than syntax, which is why `require(x)`
   * belongs here and not with the computed member above: the unknown value
   * is a module specifier, so the uncertainty is not bounded to anything
   * already discovered.
   */
  const ESCAPES: readonly { name: string; body: string; reason: string }[] = [
    {
      name: "eval",
      body: "  return eval(src);\n",
      reason: "eval",
    },
    {
      name: "the Function constructor",
      body: "  return new Function(src)();\n",
      reason: "function_constructor",
    },
    {
      name: "a dynamic require",
      body: "  return require(src);\n",
      reason: "dynamic_require",
    },
  ];

  for (const escape of ESCAPES) {
    it(`C: ${escape.name} is capability_escape`, async () => {
      const finding = await run({
        files: {
          ...INSTALLED_LIB,
          "src/index.js":
            'const lib = require("vuln-lib");\n' +
            "module.exports.main = function main(src){\n" +
            escape.body +
            "};\n" +
            "module.exports.use = function use(){ return lib.safe(); };\n",
        },
        entries: ["src/index.js"],
      });

      expect(finding?.verdict).toBe("UNKNOWN");
      expect(reasonsOf(finding)).toContain(escape.reason);

      // Attack D, asserted precisely: the ESCAPE's own entry must be
      // `capability_escape`. Deliberately not "this finding has no
      // unmodeled_construct anywhere" -- `new Function(src)()` genuinely
      // produces a second, separate `unsupported_construct` edge for the
      // call on the constructed function, and that edge IS a real coverage
      // gap. Both are true at once, both are reported, and asserting the
      // blanket negative would have been asserting that F3 collapses
      // co-occurring blockers -- the opposite of what § 19 requires.
      expect(
        finding?.unknownReasons?.find(
          (entry) => entry.reason === escape.reason,
        ),
      ).toMatchObject({ category: "capability_escape" });
    });
  }

  /**
   * ROW D -- identity that could not be established.
   *
   * The advisory names a module nothing in this project installs, so the
   * {module, export} pair cannot be bound to a callable at all. That is an
   * identity fact, not a construct the analyzer declined to model.
   */
  it("D: an unresolvable vulnerable target is identity_unresolved", async () => {
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "src/index.js":
          'const lib = require("vuln-lib");\n' +
          "module.exports.main = function main(){ return lib.safe(); };\n",
      },
      entries: ["src/index.js"],
      rule: {
        ...rule,
        targets: [
          {
            module: "package-that-is-not-installed",
            export: "vulnerable",
            kind: "function",
            confidence: 1,
          },
        ],
      },
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(reasonsOf(finding)).toContain("vulnerable_target_unresolved");
    expect(categoriesOf(finding)).toContain("identity_unresolved");
  });

  /**
   * ROW D (second form) -- version applicability that could not be decided.
   *
   * This UNKNOWN is reached before reachability is ever attempted, and
   * before F3 it carried no evidence and no reason whatsoever: the HTML
   * report had to GUESS, in prose, which of two causes produced it.
   */
  it("D: an indeterminate version match is identity_unresolved, and no longer reasonless", async () => {
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "src/index.js": "module.exports.main = function main(){ return 1; };\n",
      },
      entries: ["src/index.js"],
      matchResult: "indeterminate",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.unknownReasons).toEqual([
      {
        category: "identity_unresolved",
        reason: "advisory_version_applicability_indeterminate",
        count: 1,
      },
    ]);
  });

  /**
   * ROW F -- a configured bound stopped the work.
   *
   * Distinct from every other row: the analyzer knows exactly how to do
   * this and was told not to. Raising a limit closes it and no code change
   * does, which is why conflating it with a syntax gap (attack E) would
   * send someone to write a parser for a problem that has none.
   */
  it("F: a truncated call graph is budget_exceeded", async () => {
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "src/index.js":
          'const lib = require("vuln-lib");\n' +
          "module.exports.main = function main(){ return lib.safe(); };\n",
      },
      entries: ["src/index.js"],
      graphTruncated: true,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.unknownReasons).toEqual([
      {
        category: "budget_exceeded",
        reason: "call_graph_truncated",
        count: 1,
      },
    ]);
  });

  /**
   * F3 § 12 -- FOUNDATION F2's blocker, classified without being changed.
   */
  it("classifies an absent module-load closure as analysis_precondition_unmet", async () => {
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "src/index.js":
          'const lib = require("vuln-lib");\n' +
          "module.exports.main = function main(){ return lib.safe(); };\n",
      },
      entries: ["src/index.js"],
      moduleLoadClosureUnavailable: true,
    });

    // F2's behavior, unchanged: the absent closure still BLOCKS the
    // negative proof and still produces UNKNOWN. F3 only names it.
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.unknownReasons).toEqual([
      {
        category: "analysis_precondition_unmet",
        reason: "module_load_closure_unavailable",
        count: 1,
      },
    ]);
  });
});

describe("F3 § 24/§ 26: classification never moves a verdict", () => {
  /**
   * ROW L -- an AFFECTED is unchanged, and carries no uncertainty at all.
   *
   * Attack A. A finding with a reproduced path is not uncertain, so
   * attaching a reason to it would be a category error that invites
   * "how sure are we about this AFFECTED?" -- a question this analyzer
   * does not answer.
   */
  it("L: AFFECTED is unchanged and carries no unknownReasons", async () => {
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "src/index.js":
          'const lib = require("vuln-lib");\n' +
          "module.exports.main = function main(){ return lib.vulnerable(1); };\n",
      },
      entries: ["src/index.js"],
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(finding?.unknownReasons).toBeUndefined();
    expect(finding?.evidence?.path.length).toBeGreaterThan(0);
  });

  /**
   * ROW M -- a NOT_AFFECTED keeps its proof and gains nothing.
   *
   * The proof object is the verdict's whole justification; if a
   * classification could appear beside it, a reader could reasonably ask
   * which one the verdict rests on.
   */
  it("M: NOT_AFFECTED keeps its proof and carries no unknownReasons", async () => {
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "src/index.js":
          'const lib = require("vuln-lib");\n' +
          "module.exports.main = function main(){ return lib.safe(1); };\n",
      },
      entries: ["src/index.js"],
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.unknownReasons).toBeUndefined();
    // Exactly one proof family, exactly as before F3.
    const evidence = finding?.evidence;
    const proofs = [
      evidence?.confirmedAbsentFromModuleLoadClosure,
      evidence?.confirmedAbsentInstance,
      evidence?.confirmedUnreachableTarget,
    ].filter((proof) => proof !== undefined);
    expect(proofs).toHaveLength(1);
  });

  /**
   * F3 § 26 -- MONOTONICITY.
   *
   * Adding blockers must never produce a MORE confident verdict. Stated as
   * a property over an escalating series rather than as one case, because
   * the failure this guards against is a classifier that happens to be
   * correct for one reason and lets a second one cancel it.
   */
  it("stays UNKNOWN as blockers accumulate, and never becomes more confident", async () => {
    const escalation = [
      "  return lib[name]();\n",
      "  return lib[name]() + eval(name);\n",
      "  return lib[name]() + eval(name) + require(name);\n",
    ];

    let previousReasonCount = 0;
    for (const body of escalation) {
      const finding = await run({
        files: {
          ...INSTALLED_LIB,
          "src/index.js":
            'const lib = require("vuln-lib");\n' +
            "module.exports.main = function main(name){\n" +
            body +
            "};\n",
        },
        entries: ["src/index.js"],
      });

      expect(finding?.verdict).toBe("UNKNOWN");
      // More blockers, never fewer, and never a verdict that got braver.
      const count = finding?.unknownReasons?.length ?? 0;
      expect(count).toBeGreaterThanOrEqual(previousReasonCount);
      previousReasonCount = count;
    }
    // The last one genuinely had several distinct blockers, so the series
    // was not vacuous.
    expect(previousReasonCount).toBeGreaterThan(1);
  });

  /**
   * F3 § 19/§ 20 -- every blocker survives to the output.
   *
   * Attack F. A finding blocked by an escape AND a value uncertainty
   * reports both; nothing is elected primary and nothing is dropped.
   */
  it("reports several independent blockers on one finding", async () => {
    const finding = await run({
      files: {
        ...INSTALLED_LIB,
        "src/index.js":
          'const lib = require("vuln-lib");\n' +
          "module.exports.main = function main(name){\n" +
          "  return lib[name]() + eval(name);\n" +
          "};\n",
      },
      entries: ["src/index.js"],
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(categoriesOf(finding)).toEqual(
      expect.arrayContaining(["value_uncertainty", "capability_escape"]),
    );
    // The prose is retained in full alongside the structure -- F3 § 6
    // forbids removing useful specific details to make room for tokens.
    expect(finding?.evidence?.reasons?.length ?? 0).toBeGreaterThan(0);
  });

  /**
   * F3 § 27 -- determinism, end to end through a real graph.
   *
   * The unit-level determinism proof lives in `domain/uncertainty.test.ts`.
   * This is the integration half: the same project, built twice, must
   * produce byte-identical structured reasons even though graph edge order
   * is not a guaranteed property of a build.
   */
  it("produces byte-identical reasons for the same project built twice", async () => {
    const files = {
      ...INSTALLED_LIB,
      "src/index.js":
        'const lib = require("vuln-lib");\n' +
        "module.exports.main = function main(name){\n" +
        "  return lib[name]() + eval(name) + require(name);\n" +
        "};\n",
    };

    const first = await run({ files, entries: ["src/index.js"] });
    const second = await run({ files, entries: ["src/index.js"] });

    expect(JSON.stringify(second?.unknownReasons)).toBe(
      JSON.stringify(first?.unknownReasons),
    );
  });
});

describe("F3: every UNKNOWN carries at least one reason", () => {
  /**
   * The completeness claim the schema documentation makes, asserted over
   * every UNKNOWN route this suite can reach. Before F3 two of the eight
   * routes carried nothing at all; a route that regressed to silence would
   * be invisible without this.
   */
  const ROUTES: readonly { name: string; options: RunOptions }[] = [
    {
      name: "indeterminate version",
      options: {
        files: {
          ...INSTALLED_LIB,
          "src/index.js": "module.exports.main = function(){ return 1; };\n",
        },
        entries: ["src/index.js"],
        matchResult: "indeterminate",
      },
    },
    {
      name: "no vulnerable-symbol rule targets",
      options: {
        files: {
          ...INSTALLED_LIB,
          "src/index.js": "module.exports.main = function(){ return 1; };\n",
        },
        entries: ["src/index.js"],
        rule: { ...rule, targets: [] },
      },
    },
    {
      name: "graph truncated",
      options: {
        files: {
          ...INSTALLED_LIB,
          "src/index.js":
            'const lib = require("vuln-lib");\n' +
            "module.exports.main = function(){ return lib.safe(); };\n",
        },
        entries: ["src/index.js"],
        graphTruncated: true,
      },
    },
    {
      name: "closure unavailable",
      options: {
        files: {
          ...INSTALLED_LIB,
          "src/index.js":
            'const lib = require("vuln-lib");\n' +
            "module.exports.main = function(){ return lib.safe(); };\n",
        },
        entries: ["src/index.js"],
        moduleLoadClosureUnavailable: true,
      },
    },
    {
      name: "unresolved call edge",
      options: {
        files: {
          ...INSTALLED_LIB,
          "src/index.js":
            'const lib = require("vuln-lib");\n' +
            "module.exports.main = function(n){ return lib[n](); };\n",
        },
        entries: ["src/index.js"],
      },
    },
  ];

  for (const route of ROUTES) {
    it(`${route.name}: UNKNOWN with a non-empty, fully classified reason set`, async () => {
      const finding = await run(route.options);
      expect(finding?.verdict).toBe("UNKNOWN");
      expect(finding?.unknownReasons?.length ?? 0).toBeGreaterThan(0);
      for (const entry of finding?.unknownReasons ?? []) {
        expect(entry.count).toBeGreaterThan(0);
        expect(entry.reason).not.toBe("unclassified_uncertainty_reason");
      }
    });
  }
});
