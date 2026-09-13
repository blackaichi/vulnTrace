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
