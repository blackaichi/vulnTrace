import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import { discoverWorkspacePackages } from "../dependencies/workspaces.js";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
  identifyModule,
} from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { fixturePath } from "../testing/fixtures.js";
import { buildFindingForTest } from "../testing/finding.js";
import { discoverEntrypoints } from "./entrypoints.js";

/**
 * P1-A4's permanent WORKSPACE / MONOREPO matrix
 * (see fixtures/workspaces/README.md).
 *
 * The question this suite pins is WHICH LOCAL PACKAGE an advisory is
 * anchored in, when the packages in question live in the repository rather
 * than in `node_modules` -- and, critically, that answering it at all
 * introduces no new way to answer it WRONGLY.
 *
 * P1-A4 adds exactly one thing: a workspace package can now HAVE an
 * identity. Everything that happens once it does is unchanged machinery:
 *
 * - **P1-A1/RWF-029** supplies the forwarding relation (§ H below);
 * - **P1-A2/RWF-030** supplies public-entry authority, so a workspace
 *   sibling that merely exports the advisory's name still answers for
 *   nothing (§ I);
 * - **P1-A3/RWF-031** supplies `exports`/subpath semantics, which a
 *   workspace package obeys exactly as an installed one does (§ E, § F).
 *
 * There is deliberately NO workspace-specific target resolver. If a case
 * below passes for a workspace package, it passes because the existing
 * relation was given an exact `PackageInstance` to work with.
 *
 * Every expectation is derived from real Node semantics, asserted
 * independently by `fixtures/workspaces/verify.cjs` out of process (run by
 * this suite's last test), never from what the analyzer happens to say.
 */

const FIXTURE = "workspaces";

interface ScanOptions {
  /** Consumer entrypoint, relative to the monorepo root. */
  readonly entrypoint: string;
  /** The advisory's package name -- what selects instances. */
  readonly packageName: string;
  /** The advisory target's module specifier; defaults to `packageName`. */
  readonly targetModule?: string;
  readonly target?: string;
  /** The exact package root, relative to the monorepo root. */
  readonly packageInstance: string;
  /**
   * Omit workspace discovery entirely, reproducing merged main's behavior
   * for a local package. Used only to pin the BASELINE (§ Z).
   */
  readonly withoutWorkspaceDiscovery?: boolean;
}

async function scan(options: ScanOptions) {
  const root = fixturePath(FIXTURE);
  const entry = path.join(root, ...options.entrypoint.split("/"));
  const resolver = createModuleResolver(loadTsProject(root));

  // The REAL production authority: the repository's own `workspaces`
  // declaration, read exactly as `cli/scan.ts` reads it. No test-only
  // root list -- if discovery cannot establish a root, this suite sees
  // precisely what a real scan would see.
  const discovery = options.withoutWorkspaceDiscovery
    ? { packages: [], unsupported: [] }
    : discoverWorkspacePackages(root);
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

  const [graph, entrypointsResult] = await Promise.all([
    buildCallGraph({ entryFiles: [entry], resolver, knownPackageRoots }),
    discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: [options.entrypoint],
    }),
  ]);

  const targetExport = options.target ?? "vulnerable";
  const targetModule = options.targetModule ?? options.packageName;
  const vulnerability: Vulnerability = {
    id: "GHSA-p1-a4-workspaces",
    aliases: [],
    package: options.packageName,
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-p1-a4-workspaces",
    package: { name: options.packageName },
    targets: [{ module: targetModule, export: targetExport, kind: "function" }],
  };

  const finding = await buildFindingForTest({
    vulnerability,
    packageName: options.packageName,
    packageVersion: "1.0.0",
    packageInstance: canonicalizePackageInstancePath(
      path.join(root, ...options.packageInstance.split("/")),
    ),
    matchResult: "affected",
    rule,
    graph,
    entrypoints: entrypointsResult.entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
  });

  return { finding, graph, root, knownPackageRoots };
}

type Finding = Awaited<ReturnType<typeof scan>>["finding"];

function evidencePath(finding: Finding): readonly string[] {
  return finding?.evidence?.path ?? [];
}

/** The resolved target: the last node of the reachable path. */
function resolvedTarget(finding: Finding): string {
  return evidencePath(finding).at(-1) ?? "";
}

/** Whether any file in the evidence path sits under `segments`. */
function pathMentions(finding: Finding, ...segments: string[]): boolean {
  const needle = path.join(...segments);
  return evidencePath(finding).some((node) => node.includes(needle));
}

const APP = "packages/app/src";

// ---------------------------------------------------------------------------
// Z -- BASELINE: what a local workspace package was before P1-A4.
// ---------------------------------------------------------------------------

describe("P1-A4 § Z: the baseline P1-A4 changes", () => {
  it("without workspace discovery a workspace package has NO identity at all", async () => {
    // This is the whole defect, stated at the identity layer. A local
    // package's files have no `node_modules` segment, and merged main has
    // no other authority that can name them -- so `identifyModule` returns
    // a bare file with no package and no instance.
    const { root } = await scan({
      entrypoint: `${APP}/lib-consumer.cjs`,
      packageName: "lib",
      packageInstance: "packages/lib",
      withoutWorkspaceDiscovery: true,
    });
    const file = path.join(root, "packages", "lib", "index.js");

    const withoutDiscovery = buildKnownPackageRoots([], root);
    expect(
      identifyModule(file, withoutDiscovery).packageInstance,
    ).toBeUndefined();
    expect(identifyModule(file, withoutDiscovery).packageName).toBeUndefined();

    const discovery = discoverWorkspacePackages(root);
    const withDiscovery = buildKnownPackageRoots(
      [],
      root,
      discovery.packages.map((workspacePackage) => ({
        canonicalRoot: workspacePackage.canonicalRoot,
        packageName:
          workspacePackage.packageName ??
          path.basename(workspacePackage.canonicalRoot),
      })),
    );
    expect(identifyModule(file, withDiscovery).packageInstance).toBe(
      canonicalizePackageInstancePath(path.join(root, "packages", "lib")),
    );
    expect(identifyModule(file, withDiscovery).packageName).toBe("lib");
  });

  it("without identity, a target is bound by project-root resolution instead of the consumer's", async () => {
    // With no instance to anchor to, resolution falls back to resolving the
    // advisory's module from the PROJECT ROOT. For the simple case that
    // happens to reach the same file, so the verdict is unchanged -- P1-A4
    // changes WHY, not WHAT, here.
    const { finding } = await scan({
      entrypoint: `${APP}/lib-consumer.cjs`,
      packageName: "lib",
      packageInstance: "packages/lib",
      withoutWorkspaceDiscovery: true,
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("nested INSTALLED copies were already exact -- P1-A4 changes nothing there", async () => {
    // Worth pinning explicitly, because it bounds the defect. A package
    // under `node_modules` -- even nested inside a workspace member -- has
    // always had an identity from its path shape, so instance-exactness
    // already worked here without any workspace machinery. The gap P1-A4
    // closes is specifically packages OUTSIDE `node_modules`.
    const withoutDiscovery = await scan({
      entrypoint: `${APP}/nestedlib-consumer.cjs`,
      packageName: "nestedlib",
      packageInstance: "packages/app/node_modules/nestedlib",
      withoutWorkspaceDiscovery: true,
    });
    expect(withoutDiscovery.finding?.verdict).toBe("AFFECTED");
  });

  it("the baseline never MIXES the installed twin into the workspace twin's answer", async () => {
    // Worth pinning as a NEGATIVE result, because it is the obvious place
    // a workspace/installed mix-up would have shown up and it does not.
    // Even with no identity for packages/twinlib, the separately installed
    // node_modules/twinlib DOES have one (path shape), so the graph knows
    // about an instance of this name that is not this finding's -- and
    // instance-exactness (VT-212/ADV2-045) refuses rather than substituting
    // it. Merged main is UNINFORMATIVE about workspace packages, not wrong
    // about them, and P1-A4 must keep it that way.
    const withoutDiscovery = await scan({
      entrypoint: `${APP}/twinlib-consumer.cjs`,
      packageName: "twinlib",
      packageInstance: "packages/twinlib",
      withoutWorkspaceDiscovery: true,
    });
    expect(withoutDiscovery.finding?.verdict).toBe("UNKNOWN");
    expect(
      pathMentions(withoutDiscovery.finding, "node_modules", "twinlib"),
    ).toBe(false);

    // With workspace identity the answer stays non-AFFECTED and still
    // never borrows the installed copy's evidence -- now backed by an
    // exact canonical root rather than by the absence of one.
    const withDiscovery = await scan({
      entrypoint: `${APP}/twinlib-consumer.cjs`,
      packageName: "twinlib",
      packageInstance: "packages/twinlib",
    });
    expect(withDiscovery.finding?.verdict).not.toBe("AFFECTED");
    expect(pathMentions(withDiscovery.finding, "node_modules", "twinlib")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// A -- The basic npm workspace case.
// ---------------------------------------------------------------------------

describe("P1-A4 § A: npm workspace basic case", () => {
  it("anchors the advisory in the exact workspace package and resolves the target", async () => {
    const { finding, knownPackageRoots } = await scan({
      entrypoint: `${APP}/lib-consumer.cjs`,
      packageName: "lib",
      packageInstance: "packages/lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join("packages", "lib", "index.js"),
    );
    // Concrete instance, concrete path -- not a package name. The
    // resolved target file really belongs to the workspace package root,
    // as decided by the single identity authority.
    expect(
      identifyModule(
        resolvedTarget(finding).replace(/:\d+$/, ""),
        knownPackageRoots,
      ).packageInstance,
    ).toBe(
      canonicalizePackageInstancePath(
        path.join(fixturePath(FIXTURE), "packages", "lib"),
      ),
    );
  });

  it("keeps a loaded-but-uncalled workspace target out of AFFECTED", async () => {
    const { finding } = await scan({
      entrypoint: `${APP}/unreach-consumer.cjs`,
      packageName: "lib",
      packageInstance: "packages/lib",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
  });
});

// ---------------------------------------------------------------------------
// I -- The SAFE control. RWF-030 still governs a workspace package.
// ---------------------------------------------------------------------------

describe("P1-A4 § I: a workspace sibling never establishes authority", () => {
  it("does NOT bind a same-named export from an unpublished workspace sibling", async () => {
    // safelib's public entry publishes `safe`. sibling.js exports
    // `vulnerable`, is a real file in the same workspace package, and is
    // not what `require("safelib")` returns. Anything but a refusal here
    // is RWF-030 reopened through the workspace door.
    const { finding } = await scan({
      entrypoint: `${APP}/safelib-consumer.cjs`,
      packageName: "safelib",
      packageInstance: "packages/safelib",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
    expect(pathMentions(finding, "packages", "safelib", "sibling.js")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// H -- Forwarding out of a workspace package's entry (RWF-029 reused).
// ---------------------------------------------------------------------------

describe("P1-A4 § H: workspace forwarding", () => {
  it("follows the workspace entry's forward to the real implementation", async () => {
    const { finding } = await scan({
      entrypoint: `${APP}/fwdlib-consumer.cjs`,
      packageName: "fwdlib",
      packageInstance: "packages/fwdlib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join("packages", "fwdlib", "impl.js"),
    );
  });
});

// ---------------------------------------------------------------------------
// E -- exports "." / subpaths / main, for a workspace package (P1-A3 reused).
// ---------------------------------------------------------------------------

describe("P1-A4 § E: workspace exports and subpaths", () => {
  it('anchors a root request at exports "."', async () => {
    const { finding } = await scan({
      entrypoint: `${APP}/exportslib-consumer.cjs`,
      packageName: "exportslib",
      packageInstance: "packages/exportslib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join("packages", "exportslib", "dist", "index.js"),
    );
  });

  it("anchors a subpath request at its own distinct surface", async () => {
    const { finding } = await scan({
      entrypoint: `${APP}/exportslib-api-consumer.cjs`,
      packageName: "exportslib",
      targetModule: "exportslib/api",
      packageInstance: "packages/exportslib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join("packages", "exportslib", "dist", "api.js"),
    );
    // The root surface is a different question and must not answer this one.
    expect(
      pathMentions(finding, "packages", "exportslib", "dist", "index.js"),
    ).toBe(false);
  });

  it('lets exports "." supersede a dangerous workspace main', async () => {
    // THE P1-A4 false-AFFECTED case for a workspace package. legacy.js
    // exports the advisory's literal name and IS genuinely loaded (modern.js
    // re-publishes it under another name) -- but no importer can reach it
    // through the package name.
    const { finding } = await scan({
      entrypoint: `${APP}/expmainlib-consumer.cjs`,
      packageName: "expmainlib",
      packageInstance: "packages/expmainlib",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
    expect(pathMentions(finding, "packages", "expmainlib", "legacy.js")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// F -- SUBPATH-ONLY workspace package.
// ---------------------------------------------------------------------------

describe("P1-A4 § F: subpath-only workspace package", () => {
  it("refuses a root-surface request rather than inventing an entry", async () => {
    // index.js exists and exports `vulnerable`. Real Node refuses the root
    // surface outright (ERR_PACKAGE_PATH_NOT_EXPORTED), so there is no
    // public entry to anchor at.
    const { finding } = await scan({
      entrypoint: `${APP}/subpathonly-consumer.cjs`,
      packageName: "subpathonlylib",
      packageInstance: "packages/subpathonlylib",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(
      pathMentions(finding, "packages", "subpathonlylib", "index.js"),
    ).toBe(false);
  });

  it("resolves its DECLARED subpath authoritatively", async () => {
    const { finding } = await scan({
      entrypoint: `${APP}/subpathonly-consumer.cjs`,
      packageName: "subpathonlylib",
      targetModule: "subpathonlylib/api",
      packageInstance: "packages/subpathonlylib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join("packages", "subpathonlylib", "api.js"),
    );
  });
});

// ---------------------------------------------------------------------------
// G -- SCOPED workspace package.
// ---------------------------------------------------------------------------

describe("P1-A4 § G: scoped workspace package", () => {
  it("resolves a scoped workspace subpath in the right directory", async () => {
    // The manifest name is `@scope/lib`; the DIRECTORY is
    // `packages/scopedlib`. The root is identity, the name is metadata --
    // and neither may be derived from the other.
    const { finding } = await scan({
      entrypoint: `${APP}/scope-api-consumer.cjs`,
      packageName: "@scope/lib",
      targetModule: "@scope/lib/api",
      packageInstance: "packages/scopedlib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join("packages", "scopedlib", "dist", "api.js"),
    );
  });

  it("does not let the scoped root surface answer the subpath advisory", async () => {
    const { finding } = await scan({
      entrypoint: `${APP}/scope-api-consumer.cjs`,
      packageName: "@scope/lib",
      packageInstance: "packages/scopedlib",
    });

    // The advisory names the ROOT surface, which publishes only `safe`.
    expect(finding?.verdict).not.toBe("AFFECTED");
  });
});

// ---------------------------------------------------------------------------
// C -- WORKSPACE vs INSTALLED copy: the instance-exactness case.
// ---------------------------------------------------------------------------

describe("P1-A4 § C: workspace copy vs installed copy", () => {
  it("binds the INSTALLED twin the consumer actually resolves", async () => {
    const { finding } = await scan({
      entrypoint: `${APP}/twinlib-consumer.cjs`,
      packageName: "twinlib",
      packageInstance: "node_modules/twinlib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join("node_modules", "twinlib", "index.js"),
    );
    expect(pathMentions(finding, "packages", "twinlib")).toBe(false);
  });

  it("never lets the installed twin's reachability answer for the WORKSPACE twin", async () => {
    // Same advisory, same name, same version -- the other physical copy.
    // The workspace copy is never reached from this entrypoint, and its
    // finding must not inherit the installed copy's AFFECTED.
    const { finding } = await scan({
      entrypoint: `${APP}/twinlib-consumer.cjs`,
      packageName: "twinlib",
      packageInstance: "packages/twinlib",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
    expect(pathMentions(finding, "node_modules", "twinlib")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D -- NESTED node_modules: the consumer's own context decides.
// ---------------------------------------------------------------------------

describe("P1-A4 § D: nested node_modules under a workspace member", () => {
  it("binds the NESTED copy the workspace consumer really resolves", async () => {
    const { finding } = await scan({
      entrypoint: `${APP}/nestedlib-consumer.cjs`,
      packageName: "nestedlib",
      packageInstance: "packages/app/node_modules/nestedlib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join("packages", "app", "node_modules", "nestedlib", "index.js"),
    );
  });

  it("does not attribute that call to the shadowed ROOT-level copy", async () => {
    const { finding } = await scan({
      entrypoint: `${APP}/nestedlib-consumer.cjs`,
      packageName: "nestedlib",
      packageInstance: "node_modules/nestedlib",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
  });
});

// ---------------------------------------------------------------------------
// J -- DUPLICATE workspace names.
// ---------------------------------------------------------------------------

describe("P1-A4 § J: duplicate workspace package names", () => {
  it.each([["packages/dupa"], ["packages/dupb"]])(
    "refuses to answer for %s by traversal order",
    async (instance) => {
      // Two workspace packages both declare `"name": "dup"`, and real Node
      // resolves `require("dup")` to NEITHER. Picking one would be choosing
      // by enumeration order; both must refuse, symmetrically.
      const { finding } = await scan({
        entrypoint: `${APP}/dup-consumer.cjs`,
        packageName: "dup",
        packageInstance: instance,
      });

      expect(finding?.verdict).not.toBe("AFFECTED");
    },
  );

  it("gives BOTH duplicates the same answer -- no asymmetry to exploit", async () => {
    const [a, b] = await Promise.all([
      scan({
        entrypoint: `${APP}/dup-consumer.cjs`,
        packageName: "dup",
        packageInstance: "packages/dupa",
      }),
      scan({
        entrypoint: `${APP}/dup-consumer.cjs`,
        packageName: "dup",
        packageInstance: "packages/dupb",
      }),
    ]);

    expect(a.finding?.verdict).toBe(b.finding?.verdict);
  });
});

// ---------------------------------------------------------------------------
// K -- file:/link: targets reached through materialized links.
// ---------------------------------------------------------------------------

describe("P1-A4 § K: file: and link: protocol targets", () => {
  it.each([
    ["filelib", "filelib"],
    ["linklib", "linklib"],
  ])(
    "gets %s no workspace identity -- the protocol word grants nothing",
    async (name, dir) => {
      // These roots are NOT workspace members: `workspaces: ["packages/*"]`
      // does not cover them, so workspace discovery correctly refuses to
      // claim them, and the `"file:"`/`"link:"` specifier in the consumer's
      // manifest is never read as authority for anything. P1-A4 adds
      // nothing here BY DESIGN.
      const { root } = await scan({
        entrypoint: `${APP}/${name}-consumer.cjs`,
        packageName: name,
        packageInstance: dir,
      });
      const discovery = discoverWorkspacePackages(root);
      expect(discovery.packages.some((p) => p.packageName === name)).toBe(
        false,
      );
    },
  );

  it("leaves such a root to the PRE-EXISTING dependency-graph provenance authority", async () => {
    // Given real dependency-graph provenance (what a lockfile supplies in a
    // production scan, and what `buildKnownPackageRoots`' first argument is
    // for), the very same root becomes an exact instance through the
    // unchanged VT-307c-fix-4b path -- no workspace machinery involved.
    const root = fixturePath(FIXTURE);
    const fromDependencyGraph = buildKnownPackageRoots(
      [
        {
          id: "npm:filelib",
          name: "filelib",
          version: "1.0.0",
          ecosystem: "npm",
          direct: true,
          locations: ["filelib"],
          dependencyPaths: [],
          purl: "pkg:npm/filelib@1.0.0",
        },
      ],
      root,
    );
    expect(
      identifyModule(
        path.join(root, "filelib", "index.js"),
        fromDependencyGraph,
      ).packageInstance,
    ).toBe(canonicalizePackageInstancePath(path.join(root, "filelib")));
  });
});

// ---------------------------------------------------------------------------
// M -- CONDITIONAL exports in a workspace package.
// ---------------------------------------------------------------------------

describe("P1-A4 § M: workspace conditional exports", () => {
  it("binds the branch the consumer really selects", async () => {
    const { finding } = await scan({
      entrypoint: `${APP}/condlib-consumer.cjs`,
      packageName: "condlib",
      packageInstance: "packages/condlib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join("packages", "condlib", "cjs.cjs"),
    );
  });

  it("does NOT let an inactive workspace branch manufacture an AFFECTED", async () => {
    // `vulnerable` exists only in the `import` branch, which this CommonJS
    // consumer never selects. The candidate may enter the entry union; it
    // materializes no graph node, so it can bind no target.
    const { finding } = await scan({
      entrypoint: `${APP}/condsafelib-consumer.cjs`,
      packageName: "condsafelib",
      packageInstance: "packages/condsafelib",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
    expect(pathMentions(finding, "packages", "condsafelib", "esm.mjs")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// N -- Vulnerable WORKSPACE copy beside a safe installed copy.
// ---------------------------------------------------------------------------

describe("P1-A4 § N: vulnerable workspace copy, safe installed copy", () => {
  it("binds the reachable WORKSPACE copy, not the safe installed twin", async () => {
    // The false-NOT_AFFECTED direction of the twin problem. A safe
    // installed mixedlib@1.0.0 exists at packages/lib/node_modules/mixedlib;
    // what the app actually resolves and calls is the vulnerable workspace
    // copy. Answering with the safe one would be a confident negative about
    // a genuinely executed sink.
    const { finding } = await scan({
      entrypoint: `${APP}/mixedlib-consumer.cjs`,
      packageName: "mixedlib",
      packageInstance: "packages/mixedlib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join("packages", "mixedlib", "index.js"),
    );
    expect(
      pathMentions(finding, "packages", "lib", "node_modules", "mixedlib"),
    ).toBe(false);
  });

  it("gives the safe installed copy its own, separate answer", async () => {
    const { finding } = await scan({
      entrypoint: `${APP}/mixedlib-consumer.cjs`,
      packageName: "mixedlib",
      packageInstance: "packages/lib/node_modules/mixedlib",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
    expect(pathMentions(finding, "packages", "mixedlib", "index.js")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// O -- A scoped workspace twin never answers for the scoped name.
// ---------------------------------------------------------------------------

describe("P1-A4 § O: scoped workspace twin", () => {
  it("does not let a same-scoped-name twin answer for the resolved package", async () => {
    // packages/scopedtwin declares `@scope/lib` too. Nothing links it, so
    // it is never what `require("@scope/lib")` resolves -- and a matching
    // scoped name must not be enough to make it answer.
    const { finding } = await scan({
      entrypoint: `${APP}/scope-api-consumer.cjs`,
      packageName: "@scope/lib",
      targetModule: "@scope/lib/api",
      packageInstance: "packages/scopedtwin",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
    expect(pathMentions(finding, "packages", "scopedtwin")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Runtime oracle.
// ---------------------------------------------------------------------------

describe("P1-A4 runtime oracle", () => {
  it("every expectation above matches real Node, asserted out of process", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(fixturePath(FIXTURE), "verify.cjs")],
      { encoding: "utf-8" },
    );
    const result = JSON.parse(output) as { ok: boolean; checks: string[] };
    expect(result.ok).toBe(true);
    expect(result.checks.length).toBeGreaterThanOrEqual(30);
  });
});
