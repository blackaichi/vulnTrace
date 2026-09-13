import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DependencyNode } from "../domain/dependency.js";
import { canonicalizePackageInstancePath } from "../domain/resolved-target.js";
import {
  advisoryQueryVersions,
  buildPackageInstanceRegistry,
  describePackageInstance,
  findApplicablePackageInstances,
} from "./package-instances.js";
import type { WorkspacePackage } from "./workspaces.js";

/**
 * P1-A5 -- CANDIDATE PACKAGE INSTANCE ENUMERATION.
 *
 * The invariant every case here defends is one sentence: a logical package
 * instance is enumerated EXACTLY ONCE, and two distinct physical ones are
 * never merged. Both halves fail silently and in opposite directions --
 * over-merging loses a vulnerable copy from the report entirely, and
 * over-splitting invents a phantom instance a reader cannot distinguish
 * from a real twin -- so both are asserted directly rather than inferred
 * from a verdict downstream.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-instances-"));
  dirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return root;
}

function manifest(name: string, version?: string): string {
  return JSON.stringify(version === undefined ? { name } : { name, version });
}

function node(
  name: string,
  version: string,
  ...locations: string[]
): DependencyNode {
  return {
    id: `npm:${locations[0] ?? name}`,
    name,
    version,
    ecosystem: "npm",
    direct: false,
    locations,
    dependencyPaths: [],
  };
}

/** Canonical roots of every instance an advisory about `name` selects. */
function rootsFor(
  registry: ReturnType<typeof buildPackageInstanceRegistry>,
  name: string,
  projectRoot: string,
): string[] {
  return findApplicablePackageInstances(registry, name)
    .map((instance) =>
      describePackageInstance(instance.packageInstance, projectRoot),
    )
    .sort();
}

describe("P1-A5 candidate instance enumeration", () => {
  it("keeps same-name, same-version installs at different roots DISTINCT", () => {
    const root = tree({
      "node_modules/foo/package.json": manifest("foo", "1.2.0"),
      "node_modules/host/node_modules/foo/package.json": manifest(
        "foo",
        "1.2.0",
      ),
    });

    const registry = buildPackageInstanceRegistry({
      dependencyNodes: [
        node("foo", "1.2.0", "node_modules/foo"),
        node("foo", "1.2.0", "node_modules/host/node_modules/foo"),
      ],
      projectRoot: root,
    });

    // Identical name AND version. Merging them would be the exact collapse
    // P1-A5 forbids: they can have entirely different reachability.
    expect(rootsFor(registry, "foo", root)).toEqual([
      "node_modules/foo",
      "node_modules/host/node_modules/foo",
    ]);
  });

  it("converges a SYMLINK and its physical target into ONE instance", () => {
    const root = tree({
      "packages/lib/package.json": manifest("lib", "1.0.0"),
    });
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(root, "packages/lib"),
      path.join(root, "node_modules/lib"),
      "dir",
    );

    // Both authorities name the same physical package: the lockfile's own
    // workspace entry and the node_modules link npm writes beside it.
    const registry = buildPackageInstanceRegistry({
      dependencyNodes: [
        node("lib", "1.0.0", "packages/lib"),
        node("lib", "1.0.0", "node_modules/lib"),
      ],
      projectRoot: root,
    });

    // One physical directory is one loaded copy at runtime -- Node resolves
    // and caches by realpath -- so it must be one instance with one verdict.
    expect(rootsFor(registry, "lib", root)).toEqual(["packages/lib"]);
  });

  it("converges a lockfile entry and workspace discovery naming the same root", () => {
    const root = tree({
      "packages/lib/package.json": manifest("lib", "1.0.0"),
    });

    const workspacePackages: WorkspacePackage[] = [
      {
        canonicalRoot: canonicalizePackageInstancePath(
          path.join(root, "packages/lib"),
        ),
        packageName: "lib",
        version: "1.0.0",
        pattern: "packages/*",
      },
    ];

    const registry = buildPackageInstanceRegistry({
      dependencyNodes: [node("lib", "1.0.0", "packages/lib")],
      projectRoot: root,
      workspacePackages,
    });

    expect(rootsFor(registry, "lib", root)).toEqual(["packages/lib"]);
    expect(registry.instances).toHaveLength(1);
    // The dependency graph is the older, more specific authority, so it
    // keeps the provenance label when both name the same root.
    expect(registry.instances[0]?.provenance).toBe("dependency-graph");
  });

  it("admits a workspace package the lockfile dropped for having no version", () => {
    // buildDependencyGraph skips any lockfile entry with no version, so a
    // private workspace package formed no DependencyNode and was not a
    // candidate for ANY advisory -- absent from the report entirely.
    const root = tree({
      "packages/privlib/package.json": manifest("privlib"),
      "node_modules/privlib/package.json": manifest("privlib", "1.0.0"),
    });

    const registry = buildPackageInstanceRegistry({
      dependencyNodes: [node("privlib", "1.0.0", "node_modules/privlib")],
      projectRoot: root,
      workspacePackages: [
        {
          canonicalRoot: canonicalizePackageInstancePath(
            path.join(root, "packages/privlib"),
          ),
          packageName: "privlib",
          pattern: "packages/*",
        },
      ],
    });

    expect(rootsFor(registry, "privlib", root)).toEqual([
      "node_modules/privlib",
      "packages/privlib",
    ]);

    const workspaceInstance = findApplicablePackageInstances(
      registry,
      "privlib",
    ).find((instance) => instance.provenance === "workspace");

    // Never borrowed from the installed sibling of the same name.
    expect(workspaceInstance?.version).toBeUndefined();
  });

  it("does not admit a workspace root whose manifest declares no name", () => {
    // With no declared name there is nothing an advisory could select it
    // by, and inferring one from the directory name is the path-shape
    // guess P1-A4 forbids.
    const root = tree({ "packages/anon/package.json": "{}" });

    const registry = buildPackageInstanceRegistry({
      dependencyNodes: [],
      projectRoot: root,
      workspacePackages: [
        {
          canonicalRoot: canonicalizePackageInstancePath(
            path.join(root, "packages/anon"),
          ),
          pattern: "packages/*",
        },
      ],
    });

    expect(registry.instances).toEqual([]);
  });

  it("selects an npm ALIAS install by the name its own manifest declares", () => {
    // "foo-alias": "npm:foo@1.2.0" -- the install DIRECTORY is foo-alias,
    // the package IS foo. P1-A3 made the manifest name the ownership
    // authority; this reuses it rather than inventing a second rule.
    const root = tree({
      "node_modules/foo-alias/package.json": manifest("foo", "1.2.0"),
      "node_modules/foo/package.json": manifest("foo", "1.2.0"),
    });

    const registry = buildPackageInstanceRegistry({
      // A hand-written lockfile that omits the alias entry's own `name`
      // leaves the graph with the path-derived handle. The manifest is
      // what recovers ownership.
      dependencyNodes: [
        node("foo-alias", "1.2.0", "node_modules/foo-alias"),
        node("foo", "1.2.0", "node_modules/foo"),
      ],
      projectRoot: root,
    });

    expect(rootsFor(registry, "foo", root)).toEqual([
      "node_modules/foo",
      "node_modules/foo-alias",
    ]);
    // And the install handle still selects it, so a lockfile that names the
    // alias handle does not lose the instance either.
    expect(rootsFor(registry, "foo-alias", root)).toEqual([
      "node_modules/foo-alias",
    ]);
  });

  it("keeps SCOPED twins distinct and never truncates the scope", () => {
    const root = tree({
      "packages/scopedlib/package.json": manifest("@scope/lib", "1.0.0"),
      "packages/scopedtwin/package.json": manifest("@scope/lib", "1.0.0"),
    });

    const registry = buildPackageInstanceRegistry({
      dependencyNodes: [
        node("@scope/lib", "1.0.0", "packages/scopedlib"),
        node("@scope/lib", "1.0.0", "packages/scopedtwin"),
      ],
      projectRoot: root,
    });

    expect(rootsFor(registry, "@scope/lib", root)).toEqual([
      "packages/scopedlib",
      "packages/scopedtwin",
    ]);
    // The unscoped name selects nothing: `lib` and `@scope/lib` are
    // different packages and an advisory about one is not about the other.
    expect(findApplicablePackageInstances(registry, "lib")).toEqual([]);
  });

  it("is independent of dependency-graph and workspace enumeration order", () => {
    const root = tree({
      "node_modules/foo/package.json": manifest("foo", "1.0.0"),
      "node_modules/host/node_modules/foo/package.json": manifest(
        "foo",
        "2.0.0",
      ),
      "packages/foo/package.json": manifest("foo", "3.0.0"),
    });

    const nodes = [
      node("foo", "1.0.0", "node_modules/foo"),
      node("foo", "2.0.0", "node_modules/host/node_modules/foo"),
    ];
    const workspacePackages: WorkspacePackage[] = [
      {
        canonicalRoot: canonicalizePackageInstancePath(
          path.join(root, "packages/foo"),
        ),
        packageName: "foo",
        version: "3.0.0",
        pattern: "packages/*",
      },
    ];

    const forward = buildPackageInstanceRegistry({
      dependencyNodes: nodes,
      projectRoot: root,
      workspacePackages,
    });
    const reversed = buildPackageInstanceRegistry({
      dependencyNodes: [...nodes].reverse(),
      projectRoot: root,
      workspacePackages: [...workspacePackages].reverse(),
    });

    const shape = (
      registry: ReturnType<typeof buildPackageInstanceRegistry>,
    ): unknown =>
      registry.instances.map((instance) => ({
        root: describePackageInstance(instance.packageInstance, root),
        version: instance.version,
        provenance: instance.provenance,
      }));

    expect(shape(reversed)).toEqual(shape(forward));
    expect(rootsFor(forward, "foo", root)).toEqual([
      "node_modules/foo",
      "node_modules/host/node_modules/foo",
      "packages/foo",
    ]);
  });
});

describe("P1-A5 metadata reconciliation on one canonical root", () => {
  /**
   * Identity convergence and METADATA reconciliation are different
   * questions, and conflating them is how enumeration order leaks into a
   * verdict. Two discovery records that resolve to one physical root are
   * one instance -- that part was always right. But when those records
   * DISAGREE about the version, keeping whichever arrived first makes the
   * instance's version, and therefore the advisory applicability computed
   * from it, a function of input order.
   */
  function conflictingRegistry(order: "forward" | "reverse") {
    const root = tree({
      "packages/foo/package.json": manifest("foo", "1.0.0"),
    });
    // Both records name the SAME physical directory -- the second through
    // a `node_modules` path that canonicalizes onto it -- but disagree
    // about the version. A stale or hand-edited lockfile is the realistic
    // source; npm itself would not normally write this.
    const records = [
      node("foo", "1.0.0", "packages/foo"),
      node("foo", "2.0.0", "packages/../packages/foo"),
    ];
    return {
      root,
      registry: buildPackageInstanceRegistry({
        dependencyNodes: order === "forward" ? records : [...records].reverse(),
        projectRoot: root,
      }),
    };
  }

  it("converges conflicting records to ONE instance, as it always did", () => {
    const { root, registry } = conflictingRegistry("forward");
    expect(rootsFor(registry, "foo", root)).toEqual(["packages/foo"]);
  });

  it("does not let enumeration order decide the version", () => {
    const forward = conflictingRegistry("forward");
    const reverse = conflictingRegistry("reverse");

    const versionOf = (r: ReturnType<typeof conflictingRegistry>) =>
      findApplicablePackageInstances(r.registry, "foo")[0]?.version;

    expect(versionOf(reverse)).toEqual(versionOf(forward));
  });

  it("FAILS CLOSED: two conflicting declared versions leave no version at all", () => {
    // Not first, not last, not highest, not lowest. The project's own
    // metadata contradicts itself about this exact directory, so the
    // honest answer is that its version is not established -- which flows
    // to `indeterminate` applicability and an UNKNOWN, never to a
    // confident verdict computed from an arbitrarily chosen version.
    const { registry } = conflictingRegistry("forward");
    expect(
      findApplicablePackageInstances(registry, "foo")[0]?.version,
    ).toBeUndefined();
  });

  it("stays conflicted once conflicted, even if a third record agrees again", () => {
    // A fold that merely compares "incoming vs current" can be walked back
    // to a concrete value by a later record. 1.0.0 -> 2.0.0 -> 1.0.0 must
    // remain unresolved, because the contradiction is a property of the
    // whole record SET, not of the last comparison.
    const root = tree({
      "packages/foo/package.json": manifest("foo", "1.0.0"),
    });
    const registry = buildPackageInstanceRegistry({
      dependencyNodes: [
        node("foo", "1.0.0", "packages/foo"),
        node("foo", "2.0.0", "packages/../packages/foo"),
        node("foo", "1.0.0", "./packages/foo"),
      ],
      projectRoot: root,
    });

    expect(
      findApplicablePackageInstances(registry, "foo")[0]?.version,
    ).toBeUndefined();
  });

  it("a source that is SILENT about the version is not a conflict", () => {
    // Absence is not a competing claim. Every fallback in this codebase
    // reads "this source does not know" as a reason to consult the other
    // source, never as a contradiction -- `identifyModule` prefers a
    // manifest name and falls back to the path, `buildDependencyGraph`
    // calls a versionless link entry "inherent to unversioned/local
    // links". Treating silence as conflict would turn every ordinary npm
    // workspace member -- present in the lockfile WITH a version and
    // discovered again from a manifest WITHOUT one -- into an UNKNOWN, a
    // large coverage loss for no soundness gain.
    const root = tree({ "packages/foo/package.json": manifest("foo") });
    const records = {
      dependencyNodes: [node("foo", "1.0.0", "packages/foo")],
      projectRoot: root,
      workspacePackages: [
        {
          canonicalRoot: canonicalizePackageInstancePath(
            path.join(root, "packages/foo"),
          ),
          packageName: "foo",
          pattern: "packages/*",
        } satisfies WorkspacePackage,
      ],
    };

    const registry = buildPackageInstanceRegistry(records);
    expect(findApplicablePackageInstances(registry, "foo")[0]?.version).toBe(
      "1.0.0",
    );
    expect(registry.instances).toHaveLength(1);
  });

  it("is identical across every permutation of the same metadata multiset", () => {
    const permutationsOf = <T>(items: readonly T[]): T[][] =>
      items.length <= 1
        ? [[...items]]
        : items.flatMap((item, index) =>
            permutationsOf([
              ...items.slice(0, index),
              ...items.slice(index + 1),
            ]).map((rest) => [item, ...rest]),
          );

    const cases: readonly (readonly (string | undefined)[])[] = [
      ["1.0.0", "2.0.0"],
      ["1.0.0", undefined],
      ["1.0.0", "2.0.0", "1.0.0"],
      ["1.0.0", "1.0.0"],
      [undefined, undefined],
    ];

    for (const versions of cases) {
      const root = tree({
        "packages/foo/package.json": manifest("foo", "1.0.0"),
      });
      const spellings = [
        "packages/foo",
        "packages/../packages/foo",
        "./packages/foo",
      ];
      const results = new Set<string>();

      for (const permuted of permutationsOf([...versions.keys()])) {
        const dependencyNodes = permuted
          .filter((index) => versions[index] !== undefined)
          .map((index) =>
            node(
              "foo",
              versions[index] as string,
              spellings[index] ?? `packages/foo/../foo${index}`,
            ),
          );
        const workspacePackages = permuted
          .filter((index) => versions[index] === undefined)
          .map(
            () =>
              ({
                canonicalRoot: canonicalizePackageInstancePath(
                  path.join(root, "packages/foo"),
                ),
                packageName: "foo",
                pattern: "packages/*",
              }) satisfies WorkspacePackage,
          );

        const registry = buildPackageInstanceRegistry({
          dependencyNodes,
          projectRoot: root,
          workspacePackages,
        });
        results.add(
          JSON.stringify(
            registry.instances.map((instance) => ({
              root: describePackageInstance(instance.packageInstance, root),
              version: instance.version ?? null,
              packageName: instance.packageName,
              provenance: instance.provenance,
              declaredLocation: instance.declaredLocation,
              ownershipNames: [...instance.ownershipNames].sort(),
            })),
          ),
        );
      }

      expect(
        results.size,
        `permutations of ${JSON.stringify(versions)} produced ${results.size} different registries: ${[...results].join(" | ")}`,
      ).toBe(1);
    }
  });
});

describe("P1-A5 version-conflict reporting", () => {
  /**
   * The conflict is REPORTED, never resolved. Reconciliation already fails
   * closed; these cases pin that the report agrees with it exactly -- one
   * entry per contradictory root, none for a root that is merely silent or
   * that agrees, and none for two roots that are simply different packages.
   */
  function registryFor(
    versions: readonly (string | undefined)[],
    order: "forward" | "reverse",
    // Both orderings must be compared against the SAME tree: the conflict
    // record carries an absolute canonical root, so two temp directories
    // would differ for a reason that has nothing to do with ordering.
    existingRoot?: string,
  ) {
    const root =
      existingRoot ??
      tree({
        "packages/foo/package.json": manifest("foo", "1.0.0"),
      });
    const spellings = [
      "packages/foo",
      "packages/../packages/foo",
      "./packages/foo",
    ];
    const dependencyNodes = versions.flatMap((version, index) =>
      version === undefined
        ? []
        : [node("foo", version, spellings[index] ?? `packages/foo/../foo`)],
    );
    const workspacePackages = versions.flatMap((version) =>
      version === undefined
        ? [
            {
              canonicalRoot: canonicalizePackageInstancePath(
                path.join(root, "packages/foo"),
              ),
              packageName: "foo",
              pattern: "packages/*",
            } satisfies WorkspacePackage,
          ]
        : [],
    );
    return {
      root,
      registry: buildPackageInstanceRegistry({
        dependencyNodes:
          order === "forward"
            ? dependencyNodes
            : [...dependencyNodes].reverse(),
        projectRoot: root,
        workspacePackages,
      }),
    };
  }

  it("A. reports ONE conflict for a root with two contradictory versions", () => {
    const { root, registry } = registryFor(["1.0.0", "2.0.0"], "forward");

    expect(registry.versionConflicts).toHaveLength(1);
    const conflict = registry.versionConflicts[0];
    expect(describePackageInstance(conflict?.packageInstance ?? "", root)).toBe(
      "packages/foo",
    );
    expect(conflict?.packageName).toBe("foo");
    expect(conflict?.declaredVersions).toEqual(["1.0.0", "2.0.0"]);
    // And it agrees with what reconciliation actually did.
    expect(registry.instances[0]?.version).toBeUndefined();
  });

  it("B. reports the identical conflict with the records reversed", () => {
    const forward = registryFor(["1.0.0", "2.0.0"], "forward");
    const reverse = registryFor(["1.0.0", "2.0.0"], "reverse", forward.root);

    expect(JSON.stringify(reverse.registry.versionConflicts)).toBe(
      JSON.stringify(forward.registry.versionConflicts),
    );
  });

  it("C. collapses a repeated conflicting value into one entry", () => {
    const { registry } = registryFor(["1.0.0", "2.0.0", "1.0.0"], "forward");

    expect(registry.versionConflicts).toHaveLength(1);
    // Sorted and de-duplicated: the set of claims, not the list of records.
    expect(registry.versionConflicts[0]?.declaredVersions).toEqual([
      "1.0.0",
      "2.0.0",
    ]);
  });

  it("D. reports NO conflict for a known version beside a silent source", () => {
    // Silence is not a competing claim (see reconcileInstanceMetadata).
    for (const order of ["forward", "reverse"] as const) {
      const { registry } = registryFor(["1.0.0", undefined], order);
      expect(registry.versionConflicts).toEqual([]);
      expect(registry.instances[0]?.version).toBe("1.0.0");
    }
  });

  it("E. reports NO conflict when the records agree", () => {
    const { registry } = registryFor(["1.0.0", "1.0.0"], "forward");

    expect(registry.versionConflicts).toEqual([]);
    expect(registry.instances[0]?.version).toBe("1.0.0");
  });

  it("F. reports NO conflict for two DIFFERENT physical roots", () => {
    // Two installs of one name at two versions is ordinary, and is exactly
    // what per-instance analysis exists for -- not contradictory metadata.
    const root = tree({
      "node_modules/foo/package.json": manifest("foo", "1.0.0"),
      "node_modules/host/node_modules/foo/package.json": manifest(
        "foo",
        "2.0.0",
      ),
    });
    const registry = buildPackageInstanceRegistry({
      dependencyNodes: [
        node("foo", "1.0.0", "node_modules/foo"),
        node("foo", "2.0.0", "node_modules/host/node_modules/foo"),
      ],
      projectRoot: root,
    });

    expect(registry.versionConflicts).toEqual([]);
    expect(registry.instances.map((i) => i.version).sort()).toEqual([
      "1.0.0",
      "2.0.0",
    ]);
  });

  it("reports no conflict for an ordinary single-record root", () => {
    const { registry } = registryFor(["1.0.0"], "forward");
    expect(registry.versionConflicts).toEqual([]);
  });
});

describe("P1-A5 advisory query versions", () => {
  it("asks once per distinct version, never once per instance", () => {
    const root = tree({
      "node_modules/foo/package.json": manifest("foo", "1.2.0"),
      "node_modules/host/node_modules/foo/package.json": manifest(
        "foo",
        "1.2.0",
      ),
      "node_modules/other/node_modules/foo/package.json": manifest(
        "foo",
        "2.0.0",
      ),
    });

    const registry = buildPackageInstanceRegistry({
      dependencyNodes: [
        node("foo", "1.2.0", "node_modules/foo"),
        node("foo", "1.2.0", "node_modules/host/node_modules/foo"),
        node("foo", "2.0.0", "node_modules/other/node_modules/foo"),
      ],
      projectRoot: root,
    });

    // Three instances, two versions, two queries -- and sorted, so the
    // query order does not depend on enumeration order.
    expect(
      advisoryQueryVersions(findApplicablePackageInstances(registry, "foo")),
    ).toEqual(["1.2.0", "2.0.0"]);
  });

  it("contributes no query for an instance with no established version", () => {
    const root = tree({ "packages/privlib/package.json": manifest("privlib") });

    const registry = buildPackageInstanceRegistry({
      dependencyNodes: [],
      projectRoot: root,
      workspacePackages: [
        {
          canonicalRoot: canonicalizePackageInstancePath(
            path.join(root, "packages/privlib"),
          ),
          packageName: "privlib",
          pattern: "packages/*",
        },
      ],
    });

    // Nothing to ask the provider -- but the instance still exists and is
    // still evaluated against whatever a sibling's query returns.
    expect(
      advisoryQueryVersions(
        findApplicablePackageInstances(registry, "privlib"),
      ),
    ).toEqual([]);
    expect(findApplicablePackageInstances(registry, "privlib")).toHaveLength(1);
  });
});

describe("P1-A5 instance rendering", () => {
  it("renders an in-project instance relative, with POSIX separators", () => {
    const root = tree({
      "node_modules/foo/package.json": manifest("foo", "1.0.0"),
    });
    const instance = canonicalizePackageInstancePath(
      path.join(root, "node_modules", "host", "node_modules", "foo"),
    );

    expect(describePackageInstance(instance, root)).toBe(
      "node_modules/host/node_modules/foo",
    );
  });

  it("keeps an out-of-project instance absolute rather than escaping upward", () => {
    const outside = tree({
      "store/foo/package.json": manifest("foo", "1.0.0"),
    });
    const root = tree({ "package.json": manifest("app", "1.0.0") });
    const instance = canonicalizePackageInstancePath(
      path.join(outside, "store", "foo"),
    );

    // A `../../..` string would be both unreadable and ambiguous.
    expect(describePackageInstance(instance, root)).toBe(instance);
  });
});
