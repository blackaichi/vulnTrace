import { describe, expect, it } from "vitest";
import {
  buildDependencyGraph,
  isTopLevelPath,
  resolveDependency,
} from "./dependency-graph.js";
import { parsePackageJson } from "./package-json.js";
import { parsePackageLock } from "./package-lock.js";

describe("isTopLevelPath", () => {
  it("is true for a package installed directly under the project root", () => {
    expect(isTopLevelPath("node_modules/foo")).toBe(true);
    expect(isTopLevelPath("node_modules/@scope/foo")).toBe(true);
  });

  it("is false for a package nested under another package", () => {
    expect(isTopLevelPath("node_modules/foo/node_modules/bar")).toBe(false);
  });

  it("is false for the root entry and non-node_modules paths", () => {
    expect(isTopLevelPath("")).toBe(false);
    expect(isTopLevelPath("packages/foo")).toBe(false);
  });
});

describe("resolveDependency", () => {
  const packages = {
    "": {
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      optionalDependencies: {},
    },
    "node_modules/foo": {
      version: "2.0.0",
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      optionalDependencies: {},
    },
    "node_modules/legacy-consumer/node_modules/foo": {
      version: "1.0.0",
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      optionalDependencies: {},
    },
  };

  it("resolves to the nearest ancestor node_modules first", () => {
    expect(
      resolveDependency("node_modules/legacy-consumer", "foo", packages),
    ).toBe("node_modules/legacy-consumer/node_modules/foo");
  });

  it("falls back to the root node_modules when no nested copy exists", () => {
    expect(
      resolveDependency(
        "node_modules/legacy-consumer",
        "does-not-nest-anywhere",
        packages,
      ),
    ).toBeUndefined();
    expect(resolveDependency("", "foo", packages)).toBe("node_modules/foo");
  });

  it("returns undefined when nothing satisfies the dependency", () => {
    expect(resolveDependency("", "missing", packages)).toBeUndefined();
  });
});

describe("buildDependencyGraph", () => {
  it("distinguishes a direct top-level version from a nested transitive version of the same package", () => {
    const packageJson = parsePackageJson({
      dependencies: { foo: "^2.0.0", "legacy-consumer": "^1.0.0" },
    });

    const packageLock = parsePackageLock({
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: { foo: "^2.0.0", "legacy-consumer": "^1.0.0" },
        },
        "node_modules/foo": {
          version: "2.0.0",
          dependencies: { bar: "^1.0.0" },
        },
        "node_modules/bar": { version: "1.5.0" },
        "node_modules/legacy-consumer": {
          version: "1.0.0",
          dependencies: { foo: "^1.0.0" },
        },
        "node_modules/legacy-consumer/node_modules/foo": { version: "1.0.0" },
      },
    });

    const graph = buildDependencyGraph(packageJson, packageLock);
    const byPath = new Map(graph.map((node) => [node.locations[0], node]));

    const topLevelFoo = byPath.get("node_modules/foo");
    expect(topLevelFoo?.version).toBe("2.0.0");
    expect(topLevelFoo?.direct).toBe(true);
    expect(topLevelFoo?.dependencyPaths).toEqual([["foo"]]);

    const nestedFoo = byPath.get(
      "node_modules/legacy-consumer/node_modules/foo",
    );
    expect(nestedFoo?.version).toBe("1.0.0");
    expect(nestedFoo?.direct).toBe(false);
    expect(nestedFoo?.dependencyPaths).toEqual([["legacy-consumer", "foo"]]);

    // Same name, two DependencyNodes, two different versions: multiple
    // installed versions are represented distinctly (docs/SDD.md § 11).
    expect(topLevelFoo?.name).toBe(nestedFoo?.name);
    expect(topLevelFoo?.version).not.toBe(nestedFoo?.version);

    const bar = byPath.get("node_modules/bar");
    expect(bar?.direct).toBe(false); // top-level, but not in package.json
    expect(bar?.dependencyPaths).toEqual([["foo", "bar"]]);

    const legacyConsumer = byPath.get("node_modules/legacy-consumer");
    expect(legacyConsumer?.direct).toBe(true);
    expect(legacyConsumer?.dependencyPaths).toEqual([["legacy-consumer"]]);

    expect(graph).toHaveLength(4);
  });

  it("generates PURLs for unscoped and scoped packages", () => {
    const packageJson = parsePackageJson({
      dependencies: { foo: "^1.0.0", "@scope/bar": "^2.0.0" },
    });
    const packageLock = parsePackageLock({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { foo: "^1.0.0", "@scope/bar": "^2.0.0" } },
        "node_modules/foo": { version: "1.0.0" },
        "node_modules/@scope/bar": { version: "2.0.0" },
      },
    });

    const graph = buildDependencyGraph(packageJson, packageLock);
    const byName = new Map(graph.map((node) => [node.name, node]));

    expect(byName.get("foo")?.purl).toBe("pkg:npm/foo@1.0.0");
    expect(byName.get("@scope/bar")?.purl).toBe("pkg:npm/%40scope/bar@2.0.0");
  });

  it("skips entries with no resolvable name/version rather than fabricating a node", () => {
    const packageJson = parsePackageJson({});
    const packageLock = parsePackageLock({
      lockfileVersion: 3,
      packages: {
        "": {},
        "packages/workspace-member": { link: true },
      },
    });

    const graph = buildDependencyGraph(packageJson, packageLock);
    expect(graph).toHaveLength(0);
  });

  it("still includes an entry unreachable from root, with empty dependencyPaths, rather than dropping it", () => {
    const packageJson = parsePackageJson({});
    const packageLock = parsePackageLock({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/orphan": { version: "1.0.0" },
      },
    });

    const graph = buildDependencyGraph(packageJson, packageLock);
    expect(graph).toHaveLength(1);
    expect(graph[0]?.dependencyPaths).toEqual([]);
    expect(graph[0]?.direct).toBe(false);
  });
});
