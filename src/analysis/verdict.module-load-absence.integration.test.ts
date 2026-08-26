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
import { buildFinding } from "./verdict.js";

/**
 * VT-307d regression matrix, cases 19-25 -- REAL on-disk projects, real
 * module resolution, the real strict closure builder, and the real
 * `buildFinding` gate end to end.
 *
 * Every case here is a LOADED package under a module-loading shape that a
 * naive traversal could plausibly miss: a re-export with no import
 * declaration, TypeScript's `import = require`, an `exports`-map subpath,
 * a workspace link with no `node_modules` segment of its own, a pnpm-style
 * symlink, an entrypoint set where only one root reaches the package, and
 * a `{file, symbol}` entrypoint whose FILE loads it at top level.
 *
 * Missing any one of them would leave a genuinely-loaded package OUT of a
 * closure still reporting `complete: true` -- which is exactly the input
 * that makes the Site-B gate emit a FALSE NOT_AFFECTED. So each case
 * asserts BOTH halves: the instance is IN the closure, AND the gate
 * consequently does not fire for it. Asserting membership alone would miss
 * a gate that ignored membership; asserting the verdict alone would miss a
 * closure that was right for the wrong reason.
 *
 * Distinct from module-load-closure.test.ts, which proves the same
 * membership facts about the BUILDER in isolation: what is under test here
 * is the composition -- builder plus gate plus finding.
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-vt307d-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

function entrypoint(filePath: string, symbol?: string): Entrypoint {
  return {
    filePath,
    source: "configured",
    reason: "test",
    ...(symbol === undefined ? {} : { symbol }),
  };
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

function vulnerability(): Vulnerability {
  return {
    id: "GHSA-fixture-0001",
    aliases: [],
    package: "vuln-lib",
    ecosystem: "npm",
    affectedVersions: [],
    fixedVersions: [],
    references: [],
  };
}

const rule: VulnerableSymbolRule = {
  id: "GHSA-fixture-0001",
  package: { name: "vuln-lib" },
  targets: [
    {
      module: "vuln-lib",
      export: "vulnerable",
      kind: "function",
      confidence: 1.0,
    },
  ],
};

/** Writes a minimal, real installed package with a `vulnerable` export. */
function installVulnLib(
  root: string,
  installPath: string,
  extra: Record<string, unknown> = {},
): string {
  write(
    root,
    `${installPath}/package.json`,
    JSON.stringify({ name: "vuln-lib", version: "1.0.0", ...extra }),
  );
  write(
    root,
    `${installPath}/index.js`,
    "function vulnerable(x){ return x; }\nmodule.exports = { vulnerable };\n",
  );
  return canonicalizePackageInstancePath(path.join(root, installPath));
}

interface Outcome {
  readonly isMember: boolean;
  readonly verdict: string | undefined;
  readonly gateFired: boolean;
  readonly complete: boolean;
  readonly loadedInstances: readonly string[];
}

/**
 * Runs the REAL pipeline -- strict closure builder plus call graph plus
 * `buildFinding` -- exactly as `cli/scan.ts` composes them.
 */
async function run(
  root: string,
  entrypoints: readonly Entrypoint[],
  packageInstance: string,
  installLocations: readonly string[],
): Promise<Outcome> {
  const project = loadTsProject(root);
  const resolver = createModuleResolver(project);
  const knownPackageRoots = buildKnownPackageRoots(
    installLocations.map((loc) => dependencyNode("vuln-lib", loc)),
    root,
  );

  const closure = await buildGateEligibleModuleLoadClosure({
    entrypoints,
    resolver,
    knownPackageRoots,
  });
  expect(
    closure,
    "the strict builder must produce a closure here",
  ).toBeDefined();
  if (!closure) {
    throw new Error("unreachable");
  }

  const graph = await buildCallGraph({
    entryFiles: entrypoints.map((e) => e.filePath),
    resolver,
    project,
  });

  const finding = await buildFinding({
    vulnerability: vulnerability(),
    packageName: "vuln-lib",
    packageVersion: "1.0.0",
    packageInstance,
    matchResult: "affected",
    rule,
    graph,
    entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
    moduleLoadClosure: closure,
    // Forces the ordinary reachability route to UNKNOWN, so a
    // NOT_AFFECTED here could only have come from the new gate. Without
    // this isolator these assertions could not distinguish the two.
    graphTruncated: true,
  });

  return {
    isMember: closure.loadedPackageInstances.includes(packageInstance),
    verdict: finding?.verdict,
    gateFired:
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure !== undefined,
    complete: closure.complete,
    loadedInstances: closure.loadedPackageInstances,
  };
}

function expectLoadedAndNoGate(outcome: Outcome, why: string): void {
  expect(
    outcome.isMember,
    `${why}\nclosure held: ${outcome.loadedInstances.join(", ")}`,
  ).toBe(true);
  expect(
    outcome.gateFired,
    "a LOADED package instance must never receive a module-load absence proof",
  ).toBe(false);
  expect(outcome.verdict).toBe("UNKNOWN");
}

describe("VT-307d case 19: re-export-only package load", () => {
  it("is IN the closure and gets no gate, though no import declaration names it", async () => {
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ name: "app" }));
    const instance = installVulnLib(root, "node_modules/vuln-lib");
    // `export * from` is a LOAD, not merely a binding: it executes the
    // module exactly as unconditionally as `import` does, whether or not
    // any re-exported name is ever used downstream (VT-307c-fix-8).
    const entry = write(root, "src/index.js", 'export * from "vuln-lib";\n');

    const outcome = await run(root, [entrypoint(entry)], instance, [
      path.join(root, "node_modules/vuln-lib"),
    ]);
    expectLoadedAndNoGate(
      outcome,
      "a re-exported package is genuinely loaded and must be IN",
    );
  });
});

describe("VT-307d case 20: TypeScript import = require", () => {
  it("is IN the closure and gets no gate", async () => {
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ name: "app" }));
    const instance = installVulnLib(root, "node_modules/vuln-lib");
    const entry = write(
      root,
      "src/index.ts",
      'import lib = require("vuln-lib");\nexport const x = lib;\n',
    );

    const outcome = await run(root, [entrypoint(entry)], instance, [
      path.join(root, "node_modules/vuln-lib"),
    ]);
    expectLoadedAndNoGate(
      outcome,
      "TypeScript's import-equals form is a real runtime require",
    );
  });
});

describe("VT-307d case 21: exports-map subpath", () => {
  it("attributes the subpath to the correct canonical PackageInstance, IN, no gate", async () => {
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ name: "app" }));
    const instance = installVulnLib(root, "node_modules/vuln-lib", {
      exports: { "./deep": "./lib/deep.js" },
    });
    write(
      root,
      "node_modules/vuln-lib/lib/deep.js",
      "module.exports = { deep: 1 };\n",
    );
    // The loaded FILE is lib/deep.js, but the PACKAGE INSTANCE is the
    // install root -- identity must come from the install location, never
    // from whichever file inside it happened to resolve.
    const entry = write(
      root,
      "src/index.js",
      'const deep = require("vuln-lib/deep");\nmodule.exports = { deep };\n',
    );

    const outcome = await run(root, [entrypoint(entry)], instance, [
      path.join(root, "node_modules/vuln-lib"),
    ]);
    expectLoadedAndNoGate(
      outcome,
      "a subpath import still loads the package instance it belongs to",
    );
  });
});

describe("VT-307d case 22: workspace / file-linked dependency", () => {
  it("is IN via KnownPackageRoots, though it has no node_modules segment", async () => {
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ name: "app" }));
    // A workspace member: real installed dependency, physical path with NO
    // node_modules segment. Without KnownPackageRoots its identity would
    // be lost entirely -- it would load and still report no package
    // instance, the exact false-absence shape the strict builder's
    // type-level requirement exists to prevent.
    const instance = installVulnLib(root, "packages/vuln-lib");
    const entry = write(
      root,
      "src/index.js",
      'const lib = require("../packages/vuln-lib/index.js");\nmodule.exports = { lib };\n',
    );

    const outcome = await run(root, [entrypoint(entry)], instance, [
      path.join(root, "packages/vuln-lib"),
    ]);
    expectLoadedAndNoGate(
      outcome,
      "a workspace-linked dependency is a real installed instance and must keep its identity",
    );
  });
});

describe("VT-307d case 23: pnpm-style symlinked instance", () => {
  it("resolves to the canonical realpath instance, IN, no gate", async () => {
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ name: "app" }));
    // The physical store copy...
    const storeInstance = installVulnLib(
      root,
      "node_modules/.pnpm/vuln-lib@1.0.0/node_modules/vuln-lib",
    );
    // ...surfaced through a symlink, as pnpm really does it.
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(
        root,
        "node_modules/.pnpm/vuln-lib@1.0.0/node_modules/vuln-lib",
      ),
      path.join(root, "node_modules/vuln-lib"),
      "dir",
    );
    const entry = write(
      root,
      "src/index.js",
      'const lib = require("vuln-lib");\nmodule.exports = { lib };\n',
    );

    // The finding's identity is the CANONICAL (realpath) instance -- the
    // logical symlink path and the physical store path must not be two
    // different answers.
    const outcome = await run(root, [entrypoint(entry)], storeInstance, [
      path.join(root, "node_modules/vuln-lib"),
    ]);
    expectLoadedAndNoGate(
      outcome,
      "a symlinked install and its store target are ONE instance, keyed by realpath",
    );
  });
});

describe("VT-307d case 24: multiple entrypoints, only one loading the package", () => {
  it("is IN because ONE root loads it, and gets no gate", async () => {
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ name: "app" }));
    const instance = installVulnLib(root, "node_modules/vuln-lib");
    const cleanEntry = write(
      root,
      "src/clean.js",
      "function clean(){ return 1; }\nmodule.exports = { clean };\n",
    );
    const loadingEntry = write(
      root,
      "src/loads.js",
      'const lib = require("vuln-lib");\nmodule.exports = { lib };\n',
    );

    // The closure is the union over ALL roots. A per-root answer, or a
    // first-root-wins answer, would call this absent and fire the gate.
    const outcome = await run(
      root,
      [entrypoint(cleanEntry), entrypoint(loadingEntry)],
      instance,
      [path.join(root, "node_modules/vuln-lib")],
    );
    expectLoadedAndNoGate(
      outcome,
      "loading from ANY configured entrypoint makes the package loaded",
    );
  });
});

describe("VT-307d case 25: {file, symbol} entrypoint whose file top-level loads the package", () => {
  it("is IN even though the configured SYMBOL never touches it", async () => {
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ name: "app" }));
    const instance = installVulnLib(root, "node_modules/vuln-lib");
    // The symbol narrowing is a CALL-side concept (SDD-v0.2.md § 6).
    // Loading the file runs its top-level code regardless of which export
    // is the configured reachability source, so module-load membership
    // must NOT inherit that narrowing -- if it did, the gate could declare
    // a package unloadable while its top-level code demonstrably runs.
    const entry = write(
      root,
      "src/index.js",
      'const lib = require("vuln-lib");\n' +
        "function chosen(){ return 1; }\n" +
        "function other(){ return lib.vulnerable(1); }\n" +
        "module.exports = { chosen, other };\n",
    );

    const outcome = await run(root, [entrypoint(entry, "chosen")], instance, [
      path.join(root, "node_modules/vuln-lib"),
    ]);
    expectLoadedAndNoGate(
      outcome,
      "a {file, symbol} entrypoint still roots the closure at the whole FILE",
    );
  });
});

describe("VT-307d: the paired positive control", () => {
  it("fires the gate for a genuinely unloaded instance in an otherwise identical project", async () => {
    // Same shape as case 24's clean entrypoint, with the package installed
    // and never required. Proves cases 19-25's UNKNOWNs come from
    // MEMBERSHIP and not from the gate being inert in this harness.
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ name: "app" }));
    const instance = installVulnLib(root, "node_modules/vuln-lib");
    const entry = write(
      root,
      "src/index.js",
      "function clean(){ return 1; }\nmodule.exports = { clean };\n",
    );

    const outcome = await run(root, [entrypoint(entry)], instance, [
      path.join(root, "node_modules/vuln-lib"),
    ]);

    expect(outcome.isMember).toBe(false);
    expect(outcome.complete).toBe(true);
    expect(outcome.gateFired).toBe(true);
    expect(outcome.verdict).toBe("NOT_AFFECTED");
  });
});
