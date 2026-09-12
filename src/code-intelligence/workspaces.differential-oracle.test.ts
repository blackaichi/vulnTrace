import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverWorkspacePackages } from "../dependencies/workspaces.js";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
  identifyModule,
} from "../domain/resolved-target.js";
import { fixturePath } from "../testing/fixtures.js";
import { createModuleResolver } from "./module-resolver.js";
import { resolveAuthoritativePackageEntries } from "./package-entry.js";
import { loadTsProject } from "./ts-project.js";

/**
 * WORKSPACE DIFFERENTIAL ORACLE (P1-A4).
 *
 * For every workspace shape in the hermetic `workspaces` fixture, compares
 * real Node against VulnTrace on the two questions P1-A4 is responsible
 * for, kept deliberately separate because they fail differently:
 *
 * 1. **IDENTITY** — which canonical package ROOT does the resolved file
 *    belong to? Node's answer is the nearest ancestor directory with a
 *    `package.json`, taken from the realpath of what it would actually
 *    load. VulnTrace's answer is `identifyModule(...).packageInstance`.
 * 2. **ENTRY** — which FILE answers for the requested public surface?
 *    Node's answer is `require.resolve`; VulnTrace's is
 *    {@link resolveAuthoritativePackageEntries}.
 *
 * Both are asked **from the true consumer context** (`packages/app`), not
 * from the repository root. That distinction is the point of the exercise:
 * a workspace member with its own nested `node_modules` resolves a
 * different copy than the root does, and an analyzer that asked from the
 * root would silently answer a different question.
 *
 * Where Node refuses a surface the package does not PUBLISH
 * (`ERR_PACKAGE_PATH_NOT_EXPORTED`, an undeclared subpath) VulnTrace must
 * return nothing: inventing a root entry for a subpath-only workspace
 * package would show up here as a disagreement rather than as a silent
 * verdict change. Refusals about mere IMPORTABILITY are held separately
 * and are not disagreements — see `Case.refusalIsImportability`, and the
 * `unimportable entries bind nothing` test that recovers the guarantee
 * directly.
 *
 * Required disagreement count on supported shapes: **0**.
 *
 * The child process only RESOLVES specifiers; it never loads target code,
 * and the analyzer side is pure resolution (AGENTS.md).
 */

const FIXTURE = "workspaces";
/** Every request is made from the workspace member that really makes it. */
const CONSUMER_DIR = "packages/app";

interface Case {
  readonly specifier: string;
  /** The package root this specifier must land in, relative to the fixture. */
  readonly instance: string;
  readonly shape: string;
  /**
   * Set for the rows where Node's refusal is about IMPORTABILITY -- "no
   * package by that name is installed anywhere I can see" -- rather than
   * about what the instance publishes.
   *
   * The entry relation deliberately does not model importability. It
   * answers "which file is THIS instance's public surface for this
   * requested surface", and for a package whose own manifest declares the
   * advisory's name and which declares no `exports`, that file is its
   * `main` -- a true statement regardless of whether any consumer can
   * currently reach the package under that name.
   *
   * Holding those apart is what keeps the comparison honest, and the
   * soundness it gives up is recovered directly: an instance no consumer
   * can import contributes no nodes to the call graph, so its entry can
   * bind no target and can never produce AFFECTED. The
   * `unimportable entries bind nothing` test below asserts exactly that,
   * rather than leaving it as an argument.
   */
  readonly refusalIsImportability?: true;
}

const CASES: readonly Case[] = [
  {
    specifier: "lib",
    instance: "packages/lib",
    shape: "workspace package, plain main",
  },
  {
    specifier: "safelib",
    instance: "packages/safelib",
    shape: "workspace package whose entry is not its sibling",
  },
  {
    specifier: "fwdlib",
    instance: "packages/fwdlib",
    shape: "workspace package with a forwarding entry",
  },
  {
    specifier: "exportslib",
    instance: "packages/exportslib",
    shape: 'workspace exports "." over main',
  },
  {
    specifier: "exportslib/api",
    instance: "packages/exportslib",
    shape: "workspace explicit exports subpath",
  },
  {
    specifier: "exportslib/legacy.js",
    instance: "packages/exportslib",
    shape: "workspace superseded main, unreachable by name",
  },
  {
    specifier: "expmainlib",
    instance: "packages/expmainlib",
    shape: 'workspace exports "." over a reachable, same-named main',
  },
  {
    specifier: "subpathonlylib",
    instance: "packages/subpathonlylib",
    shape: "subpath-only workspace package, ROOT surface refused",
  },
  {
    specifier: "subpathonlylib/api",
    instance: "packages/subpathonlylib",
    shape: "subpath-only workspace package, declared subpath",
  },
  {
    specifier: "@scope/lib",
    instance: "packages/scopedlib",
    shape: "scoped workspace package root (directory != name)",
  },
  {
    specifier: "@scope/lib/api",
    instance: "packages/scopedlib",
    shape: "scoped workspace package subpath",
  },
  {
    specifier: "twinlib",
    instance: "node_modules/twinlib",
    shape: "installed twin wins over an unlinked workspace twin",
  },
  {
    specifier: "nestedlib",
    instance: "packages/app/node_modules/nestedlib",
    shape: "nested install shadows the root-level copy",
  },
  {
    specifier: "dup",
    instance: "packages/dupa",
    shape: "duplicate workspace names — resolves to NEITHER",
    refusalIsImportability: true,
  },
  {
    specifier: "dupa",
    instance: "packages/dupa",
    shape: "a duplicate addressed by its own directory",
  },
  {
    specifier: "dupb",
    instance: "packages/dupb",
    shape: "the other duplicate, independently addressable",
  },
  {
    specifier: "condlib",
    instance: "packages/condlib",
    shape: "workspace conditional exports, active require branch",
  },
  {
    specifier: "condsafelib",
    instance: "packages/condsafelib",
    shape: "workspace conditional exports, safe active branch",
  },
  {
    specifier: "mixedlib",
    instance: "packages/mixedlib",
    shape: "linked workspace copy beside a safe installed copy",
  },
  {
    specifier: "workspaces-fixture",
    instance: ".",
    shape: "the monorepo ROOT is not installed anywhere",
    refusalIsImportability: true,
  },
];

/**
 * What real `node` would load for each specifier FROM THE CONSUMER, and
 * the canonical package root it belongs to — or `null` where Node refuses.
 * Runs out-of-process so the answer is the real loader's.
 */
function nodeResolutions(
  root: string,
  consumerDir: string,
): Record<string, { file: string; packageRoot: string | undefined } | null> {
  const script = `
    const fs = require("node:fs");
    const path = require("node:path");
    const specifiers = ${JSON.stringify(CASES.map((c) => c.specifier))};
    const consumer = process.argv[2];
    function packageRootOf(file) {
      let dir = path.dirname(file);
      for (;;) {
        if (fs.existsSync(path.join(dir, "package.json"))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
      }
    }
    const out = {};
    for (const specifier of specifiers) {
      try {
        // realpath: Node loads and caches by physical path, so this is the
        // identity a symlinked workspace reference really has.
        const file = fs.realpathSync(
          require.resolve(specifier, { paths: [consumer] }),
        );
        out[specifier] = { file, packageRoot: packageRootOf(file) };
      } catch {
        out[specifier] = null;
      }
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const stdout = execFileSync(
    process.execPath,
    ["-e", script, root, path.join(root, ...consumerDir.split("/"))],
    { encoding: "utf-8" },
  );
  return JSON.parse(stdout) as Record<
    string,
    { file: string; packageRoot: string | undefined } | null
  >;
}

describe("P1-A4 workspace differential oracle (real node vs VulnTrace)", () => {
  it("agrees with real Node on every supported workspace root and entry", async () => {
    const root = fixturePath(FIXTURE);
    const resolver = createModuleResolver(loadTsProject(root));
    const consumerFile = path.join(
      root,
      ...CONSUMER_DIR.split("/"),
      "src",
      "lib-consumer.cjs",
    );

    const discovery = discoverWorkspacePackages(root);
    const knownPackageRoots = buildKnownPackageRoots(
      [],
      root,
      discovery.packages.map((workspacePackage) => ({
        canonicalRoot: workspacePackage.canonicalRoot,
        packageName:
          workspacePackage.packageName ??
          path.basename(workspacePackage.canonicalRoot),
      })),
    );

    const fromNode = nodeResolutions(root, CONSUMER_DIR);

    const identityDisagreements: string[] = [];
    const entryDisagreements: string[] = [];

    for (const testCase of CASES) {
      const expected = fromNode[testCase.specifier];
      const instance = canonicalizePackageInstancePath(
        path.join(root, ...testCase.instance.split("/")),
      );

      // --- 1. IDENTITY ---------------------------------------------------
      if (expected) {
        const identity = identifyModule(expected.file, knownPackageRoots);
        const nodeRoot = expected.packageRoot
          ? canonicalizePackageInstancePath(expected.packageRoot)
          : undefined;
        if (identity.packageInstance !== nodeRoot) {
          identityDisagreements.push(
            `${testCase.specifier} (${testCase.shape}): node root ${nodeRoot}, VulnTrace instance ${identity.packageInstance}`,
          );
        }
      }

      // --- 2. ENTRY ------------------------------------------------------
      const entries = await resolveAuthoritativePackageEntries({
        resolver,
        requestedModuleSpecifier: testCase.specifier,
        packageInstance: instance,
        referenceContext: consumerFile,
        entrypointFiles: [consumerFile],
        knownPackageRoots,
      });
      const selected = entries.map((entry) => entry.resolvedFile).sort();

      // The child reports every specifier, as a resolution or an explicit
      // `null` refusal. A MISSING key would mean the oracle never ran this
      // case, which must fail loudly rather than read as a refusal.
      expect(Object.hasOwn(fromNode, testCase.specifier)).toBe(true);

      if (!expected) {
        // A refusal the entry relation DOES model (`exports` does not
        // publish this surface) must produce nothing. A refusal about mere
        // importability is a different question -- see `Case`.
        if (!testCase.refusalIsImportability && selected.length !== 0) {
          entryDisagreements.push(
            `${testCase.specifier} (${testCase.shape}): node REFUSES, VulnTrace selected ${selected.join(", ")}`,
          );
        }
        continue;
      }
      if (!selected.includes(expected.file)) {
        entryDisagreements.push(
          `${testCase.specifier} (${testCase.shape}): node loads ${expected.file}, VulnTrace selected [${selected.join(", ")}]`,
        );
      }
    }

    expect(identityDisagreements).toEqual([]);
    expect(entryDisagreements).toEqual([]);
  });

  it("unimportable entries bind nothing: no graph nodes, so no target, so never AFFECTED", async () => {
    // The guarantee that replaces a refusal check for the importability
    // rows. `packages/dupa` declares `"name": "dup"` and no `exports`, so
    // the entry relation truthfully reports its `main` as the public
    // surface of instance `packages/dupa`. Real Node nevertheless refuses
    // `require("dup")` -- nothing links either duplicate under that name.
    //
    // That gap cannot move a verdict, and this is the reason: an instance
    // no consumer can import is never traversed, so the call graph built
    // from the real consumer contains NO node inside it. An entry with no
    // node behind it binds no target (verdict.ts requires a real graph
    // node for the resolved file), so AFFECTED is unreachable by
    // construction rather than by good fortune.
    const root = fixturePath(FIXTURE);
    const resolver = createModuleResolver(loadTsProject(root));
    const consumerFile = path.join(
      root,
      ...CONSUMER_DIR.split("/"),
      "src",
      "dup-consumer.cjs",
    );
    const { buildCallGraph } = await import("./call-graph.js");
    const discovery = discoverWorkspacePackages(root);
    const knownPackageRoots = buildKnownPackageRoots(
      [],
      root,
      discovery.packages.map((workspacePackage) => ({
        canonicalRoot: workspacePackage.canonicalRoot,
        packageName:
          workspacePackage.packageName ??
          path.basename(workspacePackage.canonicalRoot),
      })),
    );
    const graph = await buildCallGraph({
      entryFiles: [consumerFile],
      resolver,
      knownPackageRoots,
    });

    for (const duplicate of ["dupa", "dupb"]) {
      const instance = canonicalizePackageInstancePath(
        path.join(root, "packages", duplicate),
      );
      // The entry relation does report a surface for this instance...
      const entries = await resolveAuthoritativePackageEntries({
        resolver,
        requestedModuleSpecifier: "dup",
        packageInstance: instance,
        referenceContext: consumerFile,
        entrypointFiles: [consumerFile],
        knownPackageRoots,
      });
      expect(entries.length).toBeGreaterThan(0);

      // ...and no file of it is in the graph at all, from the real
      // consumer that actually asks for `dup`.
      const nodesInside = graph.nodes.filter(
        (node) =>
          identifyModule(node.module, knownPackageRoots).packageInstance ===
          instance,
      );
      expect(nodesInside).toEqual([]);
    }
  });

  it("every workspace package discovery finds is a real, canonical root Node agrees with", () => {
    // The converse direction: not "did we miss one", but "did we invent
    // one". Every root discovery admits must be a directory that really
    // holds a package.json, canonicalized, inside the repository.
    const root = fixturePath(FIXTURE);
    const { packages, unsupported } = discoverWorkspacePackages(root);

    expect(unsupported).toEqual([]);
    expect(packages.length).toBeGreaterThan(0);

    const script = `
      const fs = require("node:fs");
      const path = require("node:path");
      const roots = ${"JSON.parse(process.argv[2])"};
      process.stdout.write(JSON.stringify(roots.map((dir) => ({
        dir,
        hasManifest: fs.existsSync(path.join(dir, "package.json")),
        canonical: fs.realpathSync(dir),
      }))));
    `;
    const checked = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          script,
          "",
          JSON.stringify(packages.map((p) => p.canonicalRoot)),
        ],
        { encoding: "utf-8" },
      ),
    ) as { dir: string; hasManifest: boolean; canonical: string }[];

    for (const entry of checked) {
      expect(entry.hasManifest).toBe(true);
      expect(entry.canonical).toBe(entry.dir);
      expect(entry.dir.startsWith(canonicalizePackageInstancePath(root))).toBe(
        true,
      );
      expect(entry.dir).not.toBe(canonicalizePackageInstancePath(root));
      expect(entry.dir.includes(`${path.sep}node_modules${path.sep}`)).toBe(
        false,
      );
    }
  });
});
