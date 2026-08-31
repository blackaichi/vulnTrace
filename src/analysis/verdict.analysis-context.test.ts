import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import type { ModuleResolver } from "../code-intelligence/module-resolver.js";
import type { DependencyNode } from "../domain/dependency.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import type { CallGraph } from "../domain/graph.js";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
  type KnownPackageRoots,
} from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Finding } from "../domain/verdict.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import {
  createAnalysisProofContext,
  isAnalysisProofContext,
  type AnalysisProofContext,
} from "./analysis-context.js";
import {
  buildGateEligibleModuleLoadClosure,
  type ModuleLoadClosure,
} from "./module-load-closure.js";
import { buildFinding } from "./verdict.js";

/**
 * VT-CONTRACT-03 -- a negative proof may only be built from ONE scan's own
 * artifacts.
 *
 * THE HAZARD, reproduced end-to-end against the pre-fix tree before this
 * suite existed. `buildFinding` used to accept the project root, the
 * entrypoints, the `KnownPackageRoots`, the call graph, its truncation flag
 * and the `ModuleLoadClosure` as six independent options, so a caller could
 * supply five from one scan and the sixth from another. A foreign closure
 * is not malformed -- it is a perfectly well-formed, `complete` closure --
 * and it trivially does not contain the other project's install paths,
 * which is exactly what proof family A reads as "this instance cannot be
 * loaded". Concretely: a `vuln-lib` instance that IS loaded and IS called
 * (reached through an ESM `export * from` re-export, which call-graph
 * discovery does not follow, so the closure gate is genuinely consulted)
 * correctly produced UNKNOWN against its own closure, and a false
 * NOT_AFFECTED the moment an unrelated project's closure was passed
 * instead -- with the forged evidence carrying one project's
 * `packageInstance` beside the other project's `entrypointRoots`.
 *
 * Three layers close it, and this file exercises all three:
 *
 *  1. STRUCTURAL -- the six options became one {@link AnalysisProofContext},
 *     so there is no longer an argument to pass from the wrong scan.
 *  2. NOMINAL -- the context is branded, so an object literal cannot
 *     impersonate one (see the `@ts-expect-error` cases below).
 *  3. SEMANTIC -- a closure is only kept if its `rootFiles` are exactly
 *     this context's entrypoints, which is what defeats a caller who
 *     deliberately assembles a mixed context; plus a runtime mark that
 *     catches a context fabricated with a cast.
 *
 * Every case uses REAL on-disk projects and the real production
 * composition, because the hazard is about two genuinely different
 * analyses being confused for one another -- something a synthetic closure
 * cannot honestly reproduce.
 */

const LIB_ESM = "export function vulnerable(x){ return x; }\n";
const LIB_CJS =
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

interface Analyzed {
  readonly root: string;
  readonly entries: readonly string[];
  readonly resolver: ModuleResolver;
  readonly knownPackageRoots: KnownPackageRoots;
  readonly entrypoints: readonly Entrypoint[];
  readonly graph: CallGraph;
  readonly moduleLoadClosure: ModuleLoadClosure | undefined;
  readonly instance: string;
  readonly nestedInstance: string;
}

describe("VT-CONTRACT-03: buildFinding proof-context identity", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  /** Writes a project on disk and runs the real production composition over it. */
  async function analyze(options: {
    readonly files: Readonly<Record<string, string>>;
    readonly entries: readonly string[];
    readonly installs?: readonly string[];
  }): Promise<Analyzed> {
    const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-ctx-"));
    tempDirs.push(root);
    const write = (rel: string, content: string): void => {
      const p = path.join(root, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
    };

    write("package.json", JSON.stringify({ name: "app" }));
    for (const [rel, content] of Object.entries(options.files)) {
      write(rel, content);
    }

    const installs = options.installs ?? ["node_modules/vuln-lib"];
    const project = loadTsProject(root);
    const resolver = createModuleResolver(project);
    const dependencyNodes: DependencyNode[] = installs.map((rel, index) => ({
      id: `vuln-lib@${index}`,
      name: index === 0 ? "vuln-lib" : "vuln-lib",
      version: "1.0.0",
      ecosystem: "npm",
      direct: index === 0,
      locations: [path.join(root, rel)],
      dependencyPaths: [],
    }));
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

    return {
      root,
      entries: options.entries,
      resolver,
      knownPackageRoots,
      entrypoints,
      graph,
      moduleLoadClosure,
      instance: canonicalizePackageInstancePath(
        path.join(root, "node_modules/vuln-lib"),
      ),
      nestedInstance: canonicalizePackageInstancePath(
        path.join(root, "node_modules/consumer/node_modules/vuln-lib"),
      ),
    };
  }

  function contextFor(
    analyzed: Analyzed,
    overrides: {
      readonly moduleLoadClosure?: ModuleLoadClosure | undefined;
      readonly entrypoints?: readonly Entrypoint[];
    } = {},
  ): AnalysisProofContext {
    return createAnalysisProofContext({
      projectRoot: analyzed.root,
      resolver: analyzed.resolver,
      entrypoints: overrides.entrypoints ?? analyzed.entrypoints,
      knownPackageRoots: analyzed.knownPackageRoots,
      graph: analyzed.graph,
      graphTruncated: false,
      moduleLoadClosure:
        "moduleLoadClosure" in overrides
          ? overrides.moduleLoadClosure
          : analyzed.moduleLoadClosure,
    });
  }

  function find(
    context: AnalysisProofContext,
    packageInstance: string,
  ): Promise<Finding | undefined> {
    return buildFinding({
      vulnerability,
      packageName: "vuln-lib",
      packageVersion: "1.0.0",
      packageInstance,
      matchResult: "affected",
      rule,
      context,
    });
  }

  /**
   * vuln-lib installed, and an entrypoint that does NOT load it -- the
   * family-A shape. Cases needing a different entrypoint body override
   * `src/index.js` after spreading this.
   */
  const INSTALLED_CJS: Readonly<Record<string, string>> = {
    "node_modules/vuln-lib/package.json": JSON.stringify({
      name: "vuln-lib",
      version: "1.0.0",
    }),
    "node_modules/vuln-lib/index.js": LIB_CJS,
    "src/index.js":
      "function main(){ return 1; }\nmodule.exports = { main };\n",
  };

  /** The re-export shape: loaded and called, yet invisible to call-graph discovery. */
  const REEXPORT_PROJECT: Readonly<Record<string, string>> = {
    "package.json": JSON.stringify({ name: "app", type: "module" }),
    "node_modules/vuln-lib/package.json": JSON.stringify({
      name: "vuln-lib",
      version: "1.0.0",
      type: "module",
      main: "index.js",
    }),
    "node_modules/vuln-lib/index.js": LIB_ESM,
    "node_modules/consumer/package.json": JSON.stringify({
      name: "consumer",
      version: "1.0.0",
      type: "module",
      main: "index.js",
    }),
    "node_modules/consumer/index.js": 'export * from "vuln-lib";\n',
    "src/index.js":
      'import { vulnerable } from "consumer";\nexport function main(){ return vulnerable(1); }\n',
  };

  /** Same layout, but nothing loads vuln-lib -- a donor of "clean" closures. */
  const UNLOADED_PROJECT: Readonly<Record<string, string>> = {
    ...REEXPORT_PROJECT,
    "src/index.js": "export function main(){ return 1; }\n",
  };

  // ---------------------------------------------------------------- 1-3
  it("case 1: same-context family A is unchanged", async () => {
    const p = await analyze({
      files: INSTALLED_CJS,
      entries: ["src/index.js"],
    });
    const finding = await find(contextFor(p), p.instance);

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(familyOf(finding)).toBe("A");
  });

  it("case 2: same-context family B is unchanged", async () => {
    const p = await analyze({
      files: {
        ...INSTALLED_CJS,
        "node_modules/consumer/package.json": JSON.stringify({
          name: "consumer",
          version: "1.0.0",
        }),
        "node_modules/consumer/node_modules/vuln-lib/package.json":
          JSON.stringify({ name: "vuln-lib", version: "1.0.0" }),
        "node_modules/consumer/node_modules/vuln-lib/index.js": LIB_CJS,
        "src/index.js":
          'const { vulnerable } = require("vuln-lib");\n' +
          "function main(){ return vulnerable(1); }\nmodule.exports = { main };\n",
      },
      entries: ["src/index.js"],
      installs: [
        "node_modules/vuln-lib",
        "node_modules/consumer/node_modules/vuln-lib",
      ],
    });
    const finding = await find(contextFor(p), p.nestedInstance);

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(familyOf(finding)).toBe("B");
  });

  it("case 3: same-context family C is unchanged", async () => {
    const p = await analyze({
      files: {
        ...INSTALLED_CJS,
        "src/index.js":
          'const { safe } = require("vuln-lib");\n' +
          "function main(){ return safe(1); }\nmodule.exports = { main };\n",
      },
      entries: ["src/index.js"],
    });
    const finding = await find(contextFor(p), p.instance);

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(familyOf(finding)).toBe("C");
  });

  // ---------------------------------------------------------------- 4-5
  it("case 4: a foreign closure cannot manufacture family A (THE reproduced hazard)", async () => {
    // B genuinely loads AND calls the vulnerable export through a
    // re-export, so its own closure contains the instance -> UNKNOWN.
    const loaded = await analyze({
      files: REEXPORT_PROJECT,
      entries: ["src/index.js"],
    });
    // A never loads it, so A's complete closure omits it -- and omits
    // every path of B's project too, which is the whole problem.
    const donor = await analyze({
      files: UNLOADED_PROJECT,
      entries: ["src/index.js"],
    });

    // Precondition: this is the shape that used to forge a proof.
    expect(loaded.moduleLoadClosure?.complete).toBe(true);
    expect(loaded.moduleLoadClosure?.loadedPackageInstances).toContain(
      loaded.instance,
    );
    expect(donor.moduleLoadClosure?.complete).toBe(true);
    expect(donor.moduleLoadClosure?.loadedPackageInstances).not.toContain(
      loaded.instance,
    );

    const honest = await find(contextFor(loaded), loaded.instance);
    expect(honest?.verdict).toBe("UNKNOWN");

    const crossWired = await find(
      contextFor(loaded, { moduleLoadClosure: donor.moduleLoadClosure }),
      loaded.instance,
    );

    // The foreign closure is refused, so the verdict is the same
    // conservative UNKNOWN the honest context produces -- never a proof.
    expect(crossWired?.verdict).toBe("UNKNOWN");
    expect(familyOf(crossWired)).toBe("NONE");
    expect(
      crossWired?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
  });

  it("case 5: a foreign closure cannot corroborate family B", async () => {
    const p = await analyze({
      files: {
        ...INSTALLED_CJS,
        "node_modules/consumer/package.json": JSON.stringify({
          name: "consumer",
          version: "1.0.0",
        }),
        "node_modules/consumer/node_modules/vuln-lib/package.json":
          JSON.stringify({ name: "vuln-lib", version: "1.0.0" }),
        "node_modules/consumer/node_modules/vuln-lib/index.js": LIB_CJS,
        "src/index.js":
          'const { vulnerable } = require("vuln-lib");\n' +
          "function main(){ return vulnerable(1); }\nmodule.exports = { main };\n",
      },
      entries: ["src/index.js"],
      installs: [
        "node_modules/vuln-lib",
        "node_modules/consumer/node_modules/vuln-lib",
      ],
    });
    const donor = await analyze({
      files: INSTALLED_CJS,
      entries: ["src/index.js"],
    });

    // Same context -> family B, as case 2 established.
    expect(familyOf(await find(contextFor(p), p.nestedInstance))).toBe("B");

    const crossWired = await find(
      contextFor(p, { moduleLoadClosure: donor.moduleLoadClosure }),
      p.nestedInstance,
    );

    expect(crossWired?.verdict).toBe("UNKNOWN");
    expect(familyOf(crossWired)).toBe("NONE");
    expect(crossWired?.evidence?.confirmedAbsentInstance).toBeUndefined();
  });

  // ------------------------------------------------------------------ 6
  it("case 5b: swapping the entrypoints AND the closure together still forges nothing", async () => {
    // Found by adversarially probing the first version of this hardening,
    // which bound the closure to the entrypoints only. Swapping BOTH keeps
    // that pair mutually consistent, so the root check passes -- while the
    // graph, the roots and the packageInstance still come from the project
    // under analysis. That reassembled the original hazard one layer up and
    // did forge a family-A NOT_AFFECTED, until the graph was bound to the
    // entrypoints too.
    const loaded = await analyze({
      files: REEXPORT_PROJECT,
      entries: ["src/index.js"],
    });
    const donor = await analyze({
      files: UNLOADED_PROJECT,
      entries: ["src/index.js"],
    });

    const swapped = createAnalysisProofContext({
      projectRoot: loaded.root,
      resolver: loaded.resolver,
      knownPackageRoots: loaded.knownPackageRoots,
      graph: loaded.graph,
      graphTruncated: false,
      // Both taken from the donor, so they agree with each other.
      entrypoints: donor.entrypoints,
      moduleLoadClosure: donor.moduleLoadClosure,
    });

    // The donor's entrypoints are not in the victim's graph, so the pair is
    // refused despite being internally consistent.
    expect(swapped.moduleLoadClosure).toBeUndefined();

    const finding = await find(swapped, loaded.instance);
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(familyOf(finding)).toBe("NONE");
  });

  it("case 6: the same project analyzed over a DIFFERENT entrypoint set is a different proof context", async () => {
    const p = await analyze({
      files: {
        ...INSTALLED_CJS,
        "src/index.js":
          "function main(){ return 1; }\nmodule.exports = { main };\n",
        "src/other.js":
          "function other(){ return 2; }\nmodule.exports = { other };\n",
      },
      entries: ["src/index.js"],
    });

    // Same project and same files, but the context claims a different root
    // set than the closure was traversed over. "Unreachable from THESE
    // roots" is not transferable to other roots, so the closure is refused.
    const otherEntrypoints: Entrypoint[] = [
      {
        filePath: path.join(p.root, "src/other.js"),
        source: "configured",
        reason: "test",
      },
    ];
    const mismatched = contextFor(p, { entrypoints: otherEntrypoints });

    expect(mismatched.moduleLoadClosure).toBeUndefined();
    expect(familyOf(await find(mismatched, p.instance))).not.toBe("A");
    // The honest context over the original roots still proves family A.
    expect(familyOf(await find(contextFor(p), p.instance))).toBe("A");
  });

  // ------------------------------------------------------------------ 7
  it("case 7: two independently created contexts over the same project are distinct objects, each internally valid", async () => {
    const p = await analyze({
      files: INSTALLED_CJS,
      entries: ["src/index.js"],
    });

    const first = contextFor(p);
    const second = contextFor(p);

    expect(first).not.toBe(second);
    expect(isAnalysisProofContext(first)).toBe(true);
    expect(isAnalysisProofContext(second)).toBe(true);
    // Distinct identity is not distrust: each is self-consistent, so both
    // legitimately prove the same thing. The mechanism rejects MIXTURE,
    // not multiplicity.
    expect(familyOf(await find(first, p.instance))).toBe("A");
    expect(familyOf(await find(second, p.instance))).toBe("A");
  });

  // ---------------------------------------------------------------- 8-9
  it("case 8: one context serves many findings, exactly as production uses it", async () => {
    const p = await analyze({
      files: INSTALLED_CJS,
      entries: ["src/index.js"],
    });
    const context = contextFor(p);

    const findings = await Promise.all([
      find(context, p.instance),
      find(context, p.instance),
      find(context, p.instance),
    ]);

    for (const finding of findings) {
      expect(finding?.verdict).toBe("NOT_AFFECTED");
      expect(familyOf(finding)).toBe("A");
    }
  });

  it("case 9: exact-instance semantics survive inside one context", async () => {
    const p = await analyze({
      files: {
        ...INSTALLED_CJS,
        "node_modules/consumer/package.json": JSON.stringify({
          name: "consumer",
          version: "1.0.0",
        }),
        "node_modules/consumer/node_modules/vuln-lib/package.json":
          JSON.stringify({ name: "vuln-lib", version: "1.0.0" }),
        "node_modules/consumer/node_modules/vuln-lib/index.js": LIB_CJS,
        "src/index.js":
          'const { safe } = require("vuln-lib");\n' +
          "function main(){ return safe(1); }\nmodule.exports = { main };\n",
      },
      entries: ["src/index.js"],
      installs: [
        "node_modules/vuln-lib",
        "node_modules/consumer/node_modules/vuln-lib",
      ],
    });
    const context = contextFor(p);

    const topLevel = await find(context, p.instance);
    const nested = await find(context, p.nestedInstance);

    // Same name, same version, same context -- different install
    // locations, and their answers stay independent.
    expect(p.instance).not.toBe(p.nestedInstance);
    expect(familyOf(topLevel)).toBe("C");
    expect(familyOf(nested)).not.toBe("C");
    expect(topLevel?.evidence?.confirmedUnreachableTarget).toBeDefined();
  });

  // -------------------------------------------------------------- 10-11
  it("case 10: a context with no closure keeps the existing conservative behavior", async () => {
    const p = await analyze({
      files: INSTALLED_CJS,
      entries: ["src/index.js"],
    });
    const context = contextFor(p, { moduleLoadClosure: undefined });

    expect(context.moduleLoadClosure).toBeUndefined();

    const finding = await find(context, p.instance);
    // No closure means neither closure-derived proof is available: family A
    // is impossible and family B has nothing to corroborate with. `undefined`
    // is never read as "an empty closure" in which every instance would be
    // unloadable. Family C is unaffected -- it does not consult the closure
    // at all -- so this project still concludes through the ordinary
    // reachability route, exactly as it did before VT-CONTRACT-03.
    expect(familyOf(finding)).not.toBe("A");
    expect(familyOf(finding)).not.toBe("B");
    // With its own closure the same project proves the STRONGER family A.
    expect(familyOf(await find(contextFor(p), p.instance))).toBe("A");
  });

  it("case 11: an incomplete closure keeps the existing conservative behavior", async () => {
    const p = await analyze({
      files: INSTALLED_CJS,
      entries: ["src/index.js"],
    });
    const incomplete: ModuleLoadClosure = {
      ...p.moduleLoadClosure!,
      complete: false,
      incompleteness: [
        {
          reason: "dynamic_require",
          importer: p.entrypoints[0]!.filePath,
        },
      ],
    };

    // Roots still match, so the closure is this context's -- it is simply
    // not a complete one, and the existing gate refuses it on its merits.
    const context = contextFor(p, { moduleLoadClosure: incomplete });
    expect(context.moduleLoadClosure).toBeDefined();

    const finding = await find(context, p.instance);
    expect(finding?.verdict).not.toBe("NOT_AFFECTED");
  });

  // ------------------------------------------------------------- 13 (12
  // and 14 live in the CLI suite, where a real scan is available)
  it("case 13: a fabricated context is rejected at compile time and at runtime", async () => {
    const p = await analyze({
      files: INSTALLED_CJS,
      entries: ["src/index.js"],
    });

    const forged = {
      projectRoot: p.root,
      resolver: p.resolver,
      entrypoints: p.entrypoints,
      knownPackageRoots: p.knownPackageRoots,
      graph: p.graph,
      graphTruncated: false,
      moduleLoadClosure: p.moduleLoadClosure,
    };

    // COMPILE TIME: the brand makes an object literal unassignable, even
    // though every visible field is correct and correctly typed.
    await buildFinding({
      vulnerability,
      packageName: "vuln-lib",
      packageVersion: "1.0.0",
      packageInstance: p.instance,
      matchResult: "affected",
      rule,
      // @ts-expect-error -- not created by createAnalysisProofContext
      context: forged,
    });

    // RUNTIME: a cast gets past the compiler, so the mark catches it and
    // every negative proof is withdrawn.
    expect(isAnalysisProofContext(forged)).toBe(false);
    const finding = await find(
      forged as unknown as AnalysisProofContext,
      p.instance,
    );
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(familyOf(finding)).toBe("NONE");
  });

  it("keeps the context immutable, so a proof cannot be redefined after the fact", async () => {
    const p = await analyze({
      files: INSTALLED_CJS,
      entries: ["src/index.js"],
    });
    const context = contextFor(p);

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.entrypoints)).toBe(true);
    expect(() => {
      (context as { graphTruncated: boolean }).graphTruncated = true;
    }).toThrow();
  });

  it("does not expose the context mark as an enumerable property", async () => {
    const p = await analyze({
      files: INSTALLED_CJS,
      entries: ["src/index.js"],
    });
    const context = contextFor(p);

    // The mark is internal machinery, not data: it must not appear in
    // Object.keys, a spread, or anything derived from them.
    expect(Object.keys(context)).not.toContain("mark");
    expect(JSON.stringify(context)).not.toContain("analysisProofContext");
    const spread = { ...context };
    expect(isAnalysisProofContext(spread)).toBe(false);
  });
});
