import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
import type { Vulnerability } from "../domain/vulnerability.js";
import { buildGateEligibleModuleLoadClosure } from "./module-load-closure.js";
import { buildFindingForTest } from "../testing/finding.js";

/**
 * VT-307e FAMILY B SOUNDNESS FIX -- the mandatory real end-to-end
 * regression for the exact counterexample VT-307e's own final audit
 * reproduced (BLOCKER, see the audit report):
 *
 *   two installs of one package, X and Y, same name/version;
 *   `consumer` re-exports Y wholesale: `export * from "vuln"`;
 *   the entrypoint imports X directly (so the CALL GRAPH discovers X) and
 *   calls the vulnerable export reached through `consumer` (so Y's own
 *   code GENUINELY RUNS);
 *   ModuleLoadClosure: complete=true, Y IN loadedPackageInstances;
 *   CallGraph: Y absent, graphTruncated=false.
 *
 * PRE-FIX, `buildFinding` for Y returned a false `NOT_AFFECTED` via family
 * B (`confirmedAbsentInstance`), asserting `callGraphComplete: true` on the
 * strength of `graphTruncated === false` alone. That is not the same claim
 * as "the call graph is complete": the call graph's own discovery never
 * follows a re-export DECLARATION as an edge at all (VT-307c-fix-8 added
 * that traversal to ModuleLoadClosure ONLY), so Y -- genuinely loaded and
 * genuinely called -- was invisible to it.
 *
 * POST-FIX, family B additionally requires the SAME exact canonical
 * instance to be independently corroborated absent from a complete,
 * gate-eligible ModuleLoadClosure. Since Y IS in the closure here, family B
 * is disqualified; nothing else takes its place (no reachability search
 * ever actually ran for Y -- `checkReachability`'s `confirmedAbsentInstance`
 * branch `continue`s before reaching the BFS), so the correct, honest
 * result is UNKNOWN.
 *
 * ROUND-TRIP VERIFIED against the pre-fix commit (VT-307e's own
 * `d7877ff`): this exact scenario, run against a `dist/` build of that
 * commit, returns `verdict: "NOT_AFFECTED"` with
 * `confirmedAbsentInstance.packageInstance` naming Y and
 * `callGraphComplete: true` -- the reproduction this file pins.
 */

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-vt307e-famb-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

function entrypoint(filePath: string): Entrypoint {
  return { filePath, source: "configured", reason: "test" };
}

function dependencyNode(name: string, location: string): DependencyNode {
  return {
    id: `${name}@0`,
    name,
    version: "1.0.0",
    ecosystem: "npm",
    direct: true,
    locations: [location],
    dependencyPaths: [],
  };
}

const rule: VulnerableSymbolRule = {
  id: "GHSA-fixture-0001",
  package: { name: "vuln" },
  targets: [
    {
      module: "vuln",
      export: "vulnerable",
      kind: "function",
      confidence: 1.0,
    },
  ],
};

function vulnerability(): Vulnerability {
  return {
    id: "GHSA-fixture-0001",
    aliases: [],
    package: "vuln",
    ecosystem: "npm",
    affectedVersions: [],
    fixedVersions: [],
    references: [],
  };
}

interface Outcome {
  readonly verdict: string | undefined;
  readonly family: string;
  readonly closureComplete: boolean;
  readonly yInClosure: boolean;
}

/** Real builder + real call graph + real buildFinding, exactly as cli/scan.ts composes them. */
async function run(
  root: string,
  entrypoints: readonly Entrypoint[],
  targetInstance: string,
  installLocations: readonly string[],
): Promise<Outcome> {
  const project = loadTsProject(root);
  const resolver = createModuleResolver(project);
  const knownPackageRoots = buildKnownPackageRoots(
    installLocations.map((loc) => dependencyNode("vuln", loc)),
    root,
  );

  const closure = await buildGateEligibleModuleLoadClosure({
    entrypoints,
    resolver,
    maxFiles: 5000,
    knownPackageRoots,
  });
  const graph = await buildCallGraph({
    entryFiles: entrypoints.map((e) => e.filePath),
    resolver,
    project,
  });

  const finding = await buildFindingForTest({
    vulnerability: vulnerability(),
    packageName: "vuln",
    packageVersion: "1.0.0",
    packageInstance: targetInstance,
    matchResult: "affected",
    rule,
    graph,
    entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
    moduleLoadClosure: closure,
    // Deliberately NOT forced -- the audit's own counterexample requires
    // graphTruncated to be genuinely false (a truncated graph would
    // already, correctly, force UNKNOWN via the pre-existing VT-202
    // guard, which would mask whether THIS fix is doing anything at all).
    graphTruncated: false,
  });

  const e = finding?.evidence;
  return {
    verdict: finding?.verdict,
    family: e?.confirmedAbsentFromModuleLoadClosure
      ? "A"
      : e?.confirmedAbsentInstance
        ? "B"
        : e?.confirmedUnreachableTarget
          ? "C"
          : "-",
    closureComplete: closure?.complete ?? false,
    yInClosure:
      closure?.loadedPackageInstances.includes(targetInstance) ?? false,
  };
}

describe("VT-307e Family B fix: the exact reproduced counterexample", () => {
  it("a re-export-only duplicate instance, genuinely loaded and called, must NEVER receive a family-B NOT_AFFECTED", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );

    // X: top-level install, imported directly by the entrypoint -- the
    // call graph WILL discover this one.
    write(
      root,
      "node_modules/vuln/package.json",
      JSON.stringify({ name: "vuln", version: "1.0.0", type: "module" }),
    );
    write(
      root,
      "node_modules/vuln/index.js",
      "export function vulnerable(x){ return x; }\n",
    );

    // Y: a SEPARATE, nested install of the SAME name/version, reached ONLY
    // through consumer's re-export declaration.
    write(
      root,
      "node_modules/consumer/node_modules/vuln/package.json",
      JSON.stringify({ name: "vuln", version: "1.0.0", type: "module" }),
    );
    write(
      root,
      "node_modules/consumer/node_modules/vuln/index.js",
      "export function vulnerable(x){ return x; }\n",
    );
    write(
      root,
      "node_modules/consumer/package.json",
      JSON.stringify({ name: "consumer", version: "1.0.0", type: "module" }),
    );
    // The exact mechanism the call graph cannot follow as a discovery
    // edge: a pure re-export declaration, no require/import expression.
    write(root, "node_modules/consumer/index.js", "export * from 'vuln';\n");

    // Entry imports X directly (never calls it) AND genuinely calls
    // vulnerable() through consumer -- which is Y's own code running.
    const entry = write(
      root,
      "src/index.mjs",
      "import * as x from 'vuln';\n" +
        "import { vulnerable } from 'consumer';\n" +
        "export function go(){ return vulnerable(1); }\n" +
        "go();\n" +
        "export { x };\n",
    );

    const Y = canonicalizePackageInstancePath(
      path.join(root, "node_modules/consumer/node_modules/vuln"),
    );
    const X = canonicalizePackageInstancePath(
      path.join(root, "node_modules/vuln"),
    );
    expect(Y).not.toBe(X);

    const outcome = await run(root, [entrypoint(entry)], Y, [
      path.join(root, "node_modules/vuln"),
      path.join(root, "node_modules/consumer/node_modules/vuln"),
    ]);

    // The load-bearing facts that make this THE counterexample shape:
    expect(
      outcome.closureComplete,
      "the closure must see this as complete",
    ).toBe(true);
    expect(
      outcome.yInClosure,
      "Y must be genuinely loaded per the closure -- this is what makes the old family-B verdict false",
    ).toBe(true);

    // The decisive assertion.
    expect(
      outcome.verdict,
      "a genuinely loaded, genuinely called instance must never be declared call-graph-absent",
    ).not.toBe("NOT_AFFECTED");
    expect(outcome.family).not.toBe("B");
    expect(outcome.verdict).toBe("UNKNOWN");

    rmSync(root, { recursive: true, force: true });
  });
});

describe("VT-307e Family B fix: additional real-source canonicalization variants", () => {
  /**
   * Why only these two, and not one per VT-307d loading shape (TS
   * import=require, npm alias, multiple entrypoints): every one of those
   * mechanisms compiles to a real `require`/`import` EXPRESSION, which is
   * exactly what the call graph's own discovery (`prepareFile`) already
   * follows -- the same reason `buildCallGraph` correctly produces AFFECTED
   * for each of them (see VT-307d's own real-source coverage,
   * `verdict.module-load-absence.integration.test.ts` cases 19-25, and
   * `module-load-closure.test.ts`, which already exhaustively prove closure
   * MEMBERSHIP is correct for every one of those shapes). This fix does not
   * change closure-membership computation at all -- it only adds a READ of
   * an already-tested fact (`closureContainsPackageInstance`) into family
   * B's decision, which is loading-shape-agnostic by construction (matrix
   * item 2 in verdict.negative-proof.test.ts proves the guard itself does
   * not care how an instance got into the closure). A re-export
   * DECLARATION is the one mechanism among all of VT-307d's covered shapes
   * that produces no such expression at all, which is why it is the only
   * one that can reproduce "closure IN, but call graph structurally could
   * never have discovered it" -- re-testing per-shape closure membership
   * here would duplicate that existing coverage rather than test anything
   * new.
   *
   * What IS genuinely new risk from this fix is CANONICALIZATION: does
   * `closureContainsPackageInstance`'s comparison of the closure's
   * `PackageInstanceId` against `absentInstance` (itself derived from the
   * finding's own `packageInstance`, both ultimately produced by
   * `identifyModule`/`canonicalizePackageInstancePath`) agree for the
   * trickiest identity shapes -- a workspace/file-linked install with NO
   * `node_modules` segment at all (relies on `KnownPackageRoots`), and a
   * pnpm-style symlinked install (relies on `realpathSync`). Both are
   * exercised below, composed with the same re-export blind spot so the
   * corroboration check is actually reached (not merely closure membership
   * in isolation, which VT-307d already covers).
   */

  it("workspace-linked duplicate reached via re-export: no node_modules segment, corroboration still blocks family B", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );

    // X: ordinary top-level install, discovered directly by the graph.
    write(
      root,
      "node_modules/vuln/package.json",
      JSON.stringify({ name: "vuln", version: "1.0.0", type: "module" }),
    );
    write(
      root,
      "node_modules/vuln/index.js",
      "export function vulnerable(x){ return x; }\n",
    );

    // Y: a workspace member with NO node_modules segment anywhere in its
    // path -- identity comes entirely from KnownPackageRoots.
    write(
      root,
      "packages/vuln-workspace/package.json",
      JSON.stringify({ name: "vuln", version: "1.0.0", type: "module" }),
    );
    write(
      root,
      "packages/vuln-workspace/index.js",
      "export function vulnerable(x){ return x; }\n",
    );
    write(
      root,
      "node_modules/consumer/package.json",
      JSON.stringify({ name: "consumer", version: "1.0.0", type: "module" }),
    );
    write(
      root,
      "node_modules/consumer/index.js",
      "export * from '../../packages/vuln-workspace/index.js';\n",
    );

    const entry = write(
      root,
      "src/index.mjs",
      "import * as x from 'vuln';\n" +
        "import { vulnerable } from 'consumer';\n" +
        "export function go(){ return vulnerable(1); }\n" +
        "go();\n" +
        "export { x };\n",
    );

    const Y = canonicalizePackageInstancePath(
      path.join(root, "packages/vuln-workspace"),
    );

    const outcome = await run(root, [entrypoint(entry)], Y, [
      path.join(root, "node_modules/vuln"),
      path.join(root, "packages/vuln-workspace"),
    ]);

    expect(outcome.closureComplete).toBe(true);
    expect(
      outcome.yInClosure,
      "the workspace member must be recognized as loaded despite having no node_modules segment",
    ).toBe(true);
    expect(outcome.verdict).not.toBe("NOT_AFFECTED");
    expect(outcome.family).not.toBe("B");
    expect(outcome.verdict).toBe("UNKNOWN");

    rmSync(root, { recursive: true, force: true });
  });

  it("pnpm-symlinked duplicate reached via re-export: canonical realpath still blocks family B", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );

    // X: ordinary top-level install, discovered directly by the graph.
    write(
      root,
      "node_modules/vuln/package.json",
      JSON.stringify({ name: "vuln", version: "1.0.0", type: "module" }),
    );
    write(
      root,
      "node_modules/vuln/index.js",
      "export function vulnerable(x){ return x; }\n",
    );

    // Y: the pnpm content-addressed store copy, surfaced through a
    // symlink -- identity must be keyed by the REALPATH, not the symlink.
    write(
      root,
      "node_modules/.pnpm/vuln@1.0.0/node_modules/vuln/package.json",
      JSON.stringify({ name: "vuln", version: "1.0.0", type: "module" }),
    );
    write(
      root,
      "node_modules/.pnpm/vuln@1.0.0/node_modules/vuln/index.js",
      "export function vulnerable(x){ return x; }\n",
    );
    write(
      root,
      "node_modules/consumer/package.json",
      JSON.stringify({ name: "consumer", version: "1.0.0", type: "module" }),
    );
    // Real pnpm structure: the symlink is named "vuln" and lives directly
    // under CONSUMER'S OWN node_modules, so a bare specifier resolves to it
    // via Node's ordinary nearest-node_modules lookup -- exactly how pnpm
    // gives each package its own, independently-resolved dependency set.
    mkdirSync(path.join(root, "node_modules/consumer/node_modules"), {
      recursive: true,
    });
    symlinkSync(
      path.join(root, "node_modules/.pnpm/vuln@1.0.0/node_modules/vuln"),
      path.join(root, "node_modules/consumer/node_modules/vuln"),
      "dir",
    );
    write(root, "node_modules/consumer/index.js", "export * from 'vuln';\n");

    const entry = write(
      root,
      "src/index.mjs",
      "import * as x from 'vuln';\n" +
        "import { vulnerable } from 'consumer';\n" +
        "export function go(){ return vulnerable(1); }\n" +
        "go();\n" +
        "export { x };\n",
    );

    // The finding's own identity is the STORE (realpath) instance -- this
    // is what production would carry, since the dependency graph resolves
    // the real, physical install location.
    const Y = canonicalizePackageInstancePath(
      path.join(root, "node_modules/.pnpm/vuln@1.0.0/node_modules/vuln"),
    );

    const outcome = await run(root, [entrypoint(entry)], Y, [
      path.join(root, "node_modules/vuln"),
      path.join(root, "node_modules/consumer/node_modules/vuln"),
    ]);

    expect(outcome.closureComplete).toBe(true);
    expect(
      outcome.yInClosure,
      "the symlinked install's REALPATH instance must be recognized as loaded",
    ).toBe(true);
    expect(outcome.verdict).not.toBe("NOT_AFFECTED");
    expect(outcome.family).not.toBe("B");
    expect(outcome.verdict).toBe("UNKNOWN");

    rmSync(root, { recursive: true, force: true });
  });
});
