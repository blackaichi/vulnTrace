import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizePackageInstancePath } from "../domain/resolved-target.js";
import { fixturePath } from "../testing/fixtures.js";
import { buildDependencyGraph } from "./dependency-graph.js";
import { loadPackageJsonFile } from "./package-json.js";
import { loadPackageLockFile } from "./package-lock.js";
import {
  buildPackageInstanceRegistry,
  describePackageInstance,
  findApplicablePackageInstances,
} from "./package-instances.js";
import { discoverWorkspacePackages } from "./workspaces.js";

/**
 * P1-A5 MULTI-INSTANCE DIFFERENTIAL ORACLE (real node vs VulnTrace).
 *
 * The question this exists to answer is not "does enumeration return a
 * plausible-looking list" but "does it name the instances that REALLY
 * exist, as real Node sees them". Ground truth is obtained out of process,
 * from Node itself: `require.resolve` from a real consumer directory,
 * `fs.realpathSync` on the result, then the nearest ancestor with a
 * `package.json`. That is, by construction, the physical copy Node would
 * load and cache -- Node keys its module cache by realpath, so this is the
 * runtime identity, not a VulnTrace convention.
 *
 * The fixture (`fixtures/multi-instance/`) is hermetic and contains the
 * shapes that break a name-keyed or version-keyed analyzer:
 *
 * - `twinlib` installed TWICE, same name AND same version, at
 *   `node_modules/twinlib` and `packages/app/node_modules/twinlib`, which
 *   two different consumers really do resolve differently;
 * - an npm ALIAS, `node_modules/aliaslib`, whose own manifest declares
 *   `reallib`, beside the real `node_modules/reallib`;
 * - SCOPED duplicates, `node_modules/@scope/dup` and the workspace
 *   `packages/scopeddup`, both declaring `@scope/dup`;
 * - a SYMLINK, `node_modules/privlib -> ../packages/privlib`, which must
 *   converge to ONE instance and whose manifest declares no version.
 *
 * Required mismatch count on supported shapes: **0**.
 *
 * The child process only RESOLVES specifiers. It never loads, requires or
 * executes the fixture packages' code (AGENTS.md: never execute target
 * application code).
 */

const FIXTURE = "multi-instance";

interface NodeGroundTruth {
  /** Canonical physical root of the package Node would load. */
  readonly root: string;
  readonly name: string;
  readonly version?: string;
}

/**
 * Asks real Node, out of process, which physical package a specifier
 * resolves to from a given consumer directory.
 */
function askNode(
  consumerDir: string,
  specifier: string,
): NodeGroundTruth | undefined {
  const script = `
    const path = require("node:path");
    const fs = require("node:fs");
    const Module = require("node:module");
    const [, , from, spec] = process.argv;
    const req = Module.createRequire(path.join(from, "noop.js"));
    let file;
    try {
      file = fs.realpathSync(req.resolve(spec));
    } catch {
      process.stdout.write("null");
      process.exit(0);
    }
    let dir = path.dirname(file);
    while (!fs.existsSync(path.join(dir, "package.json"))) {
      const up = path.dirname(dir);
      if (up === dir) { process.stdout.write("null"); process.exit(0); }
      dir = up;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    process.stdout.write(JSON.stringify({
      root: fs.realpathSync(dir),
      name: manifest.name,
      version: manifest.version,
    }));
  `;
  const stdout = execFileSync(
    process.execPath,
    ["-e", script, "vulntrace-oracle", consumerDir, specifier],
    { encoding: "utf-8" },
  );
  return (JSON.parse(stdout) as NodeGroundTruth | null) ?? undefined;
}

function buildRegistry(root: string) {
  const dependencyNodes = buildDependencyGraph(
    loadPackageJsonFile(path.join(root, "package.json")),
    loadPackageLockFile(path.join(root, "package-lock.json")),
  );
  return buildPackageInstanceRegistry({
    dependencyNodes,
    projectRoot: root,
    workspacePackages: discoverWorkspacePackages(root).packages,
  });
}

interface Case {
  /** Consumer directory, relative to the fixture root. */
  readonly from: string;
  readonly specifier: string;
  /** The advisory package name this instance must be selectable by. */
  readonly advisoryName: string;
  /** Physical root Node loads, relative to the fixture root. */
  readonly instance: string;
  readonly shape: string;
}

const CASES: readonly Case[] = [
  {
    from: ".",
    specifier: "twinlib",
    advisoryName: "twinlib",
    instance: "node_modules/twinlib",
    shape: "hoisted twin, resolved from the repository root",
  },
  {
    from: "packages/app",
    specifier: "twinlib",
    advisoryName: "twinlib",
    instance: "packages/app/node_modules/twinlib",
    shape: "nested twin, same name AND version, resolved from its consumer",
  },
  {
    from: ".",
    specifier: "reallib",
    advisoryName: "reallib",
    instance: "node_modules/reallib",
    shape: "the real package beside its alias",
  },
  {
    from: ".",
    specifier: "aliaslib",
    advisoryName: "reallib",
    instance: "node_modules/aliaslib",
    shape: "npm alias: install handle aliaslib, declared identity reallib",
  },
  {
    from: ".",
    specifier: "@scope/dup",
    advisoryName: "@scope/dup",
    instance: "node_modules/@scope/dup",
    shape: "scoped package, installed copy",
  },
  {
    from: ".",
    specifier: "scopeddup",
    advisoryName: "@scope/dup",
    instance: "packages/scopeddup",
    shape: "scoped duplicate, workspace copy of the same scoped name",
  },
  {
    from: ".",
    specifier: "privlib",
    advisoryName: "privlib",
    instance: "packages/privlib",
    shape: "symlinked workspace package, no declared version",
  },
];

describe("P1-A5 multi-instance differential oracle (real node vs VulnTrace)", () => {
  it("enumerates exactly the physical instance real Node loads, for every case", () => {
    const root = fixturePath(FIXTURE);
    const registry = buildRegistry(root);
    const mismatches: string[] = [];

    for (const testCase of CASES) {
      const consumerDir = path.join(root, ...testCase.from.split("/"));
      const truth = askNode(consumerDir, testCase.specifier);

      if (!truth) {
        mismatches.push(`${testCase.shape}: real Node resolved nothing`);
        continue;
      }

      const expectedRoot = canonicalizePackageInstancePath(
        path.join(root, ...testCase.instance.split("/")),
      );
      if (truth.root !== expectedRoot) {
        // The fixture itself drifted -- assert it rather than silently
        // measuring VulnTrace against a layout that no longer holds.
        mismatches.push(
          `${testCase.shape}: real Node loads ${truth.root}, fixture claims ${expectedRoot}`,
        );
        continue;
      }

      const candidates = findApplicablePackageInstances(
        registry,
        testCase.advisoryName,
      );
      const matched = candidates.filter(
        (candidate) => candidate.packageInstance === truth.root,
      );

      if (matched.length !== 1) {
        mismatches.push(
          `${testCase.shape}: advisory "${testCase.advisoryName}" selected ` +
            `${matched.length} candidates for the instance Node loads ` +
            `(${describePackageInstance(truth.root, root)}); candidates were ` +
            candidates
              .map((c) => describePackageInstance(c.packageInstance, root))
              .join(", "),
        );
        continue;
      }

      // The version must be this instance's OWN declared version -- Node
      // read it from the same manifest, so any disagreement here is a
      // borrowed or invented version.
      const candidate = matched[0];
      if (candidate?.version !== truth.version) {
        mismatches.push(
          `${testCase.shape}: VulnTrace says version ${String(candidate?.version)}, ` +
            `the installed manifest says ${String(truth.version)}`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("keeps the two same-version twinlib installs DISTINCT, as Node does", () => {
    const root = fixturePath(FIXTURE);

    const fromRoot = askNode(root, "twinlib");
    const fromApp = askNode(path.join(root, "packages", "app"), "twinlib");

    // Real Node genuinely loads two different physical copies here. This is
    // the fact every instance-collapsing analyzer gets wrong.
    expect(fromRoot?.name).toBe("twinlib");
    expect(fromApp?.name).toBe("twinlib");
    expect(fromRoot?.version).toBe(fromApp?.version);
    expect(fromRoot?.root).not.toBe(fromApp?.root);

    const candidates = findApplicablePackageInstances(
      buildRegistry(root),
      "twinlib",
    ).map((c) => describePackageInstance(c.packageInstance, root));

    expect(candidates.sort()).toEqual([
      "node_modules/twinlib",
      "packages/app/node_modules/twinlib",
    ]);
  });

  it("converges the privlib SYMLINK and its target into ONE instance", () => {
    const root = fixturePath(FIXTURE);

    // Two logical paths -- node_modules/privlib and packages/privlib --
    // one physical directory. Node proves it by realpath.
    const viaLink = askNode(root, "privlib");
    expect(viaLink?.root).toBe(
      canonicalizePackageInstancePath(path.join(root, "packages", "privlib")),
    );

    const candidates = findApplicablePackageInstances(
      buildRegistry(root),
      "privlib",
    );

    // One instance, one verdict -- never a phantom duplicate a reader
    // cannot tell apart from a genuine twin.
    expect(
      candidates.map((c) => describePackageInstance(c.packageInstance, root)),
    ).toEqual(["packages/privlib"]);
    // And no version was invented for it.
    expect(candidates[0]?.version).toBeUndefined();
  });

  it("selects the alias install by its DECLARED name, not its directory", () => {
    const root = fixturePath(FIXTURE);

    const alias = askNode(root, "aliaslib");
    expect(alias?.name).toBe("reallib");

    const candidates = findApplicablePackageInstances(
      buildRegistry(root),
      "reallib",
    ).map((c) => describePackageInstance(c.packageInstance, root));

    // An advisory about `reallib` applies to BOTH physical copies: the one
    // installed under its own name and the one installed under an alias.
    expect(candidates.sort()).toEqual([
      "node_modules/aliaslib",
      "node_modules/reallib",
    ]);
  });

  it("enumerates every physical instance exactly once, and nothing twice", () => {
    const root = fixturePath(FIXTURE);
    const registry = buildRegistry(root);

    const roots = registry.instances.map((i) => i.packageInstance);
    expect(new Set(roots).size).toBe(roots.length);

    // Every enumerated root is a real directory with its own manifest,
    // canonical under realpath -- checked out of process so the assertion
    // does not share VulnTrace's own filesystem assumptions.
    const script = `
      const fs = require("node:fs");
      const path = require("node:path");
      process.stdout.write(JSON.stringify(
        JSON.parse(process.argv[2]).map((dir) => ({
          dir,
          hasManifest: fs.existsSync(path.join(dir, "package.json")),
          canonical: fs.realpathSync(dir),
        })),
      ));
    `;
    const checked = JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", script, "vulntrace-oracle", JSON.stringify(roots)],
        { encoding: "utf-8" },
      ),
    ) as { dir: string; hasManifest: boolean; canonical: string }[];

    for (const entry of checked) {
      expect(entry.hasManifest).toBe(true);
      expect(entry.canonical).toBe(entry.dir);
    }
  });
});
