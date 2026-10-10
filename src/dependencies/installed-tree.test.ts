import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalizePackageInstancePath } from "../domain/resolved-target.js";
import { enumerateInstalledPackages } from "./installed-tree.js";

/**
 * Task B-4 (AUD-08, decision 9): the walk of the installed tree the
 * lockfile is cross-checked against. Each test names the exact canonical
 * roots it expects, so a walk that merges two directories (by name, or by
 * name and version) or invents one fails loudly.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tree(
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, string>> = {},
): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-b4-tree-"));
  dirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  for (const [link, target] of Object.entries(links)) {
    const absolute = path.join(root, link);
    mkdirSync(path.dirname(absolute), { recursive: true });
    symlinkSync(
      path.isAbsolute(target)
        ? target
        : path.relative(path.dirname(absolute), path.join(root, target)),
      absolute,
      "dir",
    );
  }
  return root;
}

const manifest = (name: string, version?: string): string =>
  JSON.stringify(version === undefined ? { name } : { name, version });

function roots(root: string, startRoots: readonly string[] = [root]) {
  const result = enumerateInstalledPackages({ projectRoot: root, startRoots });
  return {
    truncated: result.truncated,
    packages: result.packages.map((entry) => ({
      at: path.relative(
        canonicalizePackageInstancePath(root),
        entry.canonicalRoot,
      ),
      name: entry.name,
      version: entry.version,
    })),
  };
}

describe("B-4 installed tree: what counts as an installed package", () => {
  it("finds hoisted, nested and scoped packages, each as its own root", () => {
    const root = tree({
      "node_modules/a/package.json": manifest("a", "1.0.0"),
      "node_modules/a/node_modules/b/package.json": manifest("b", "2.0.0"),
      "node_modules/@scope/c/package.json": manifest("@scope/c", "3.0.0"),
    });

    expect(roots(root)).toEqual({
      truncated: false,
      packages: [
        {
          at: path.join("node_modules", "@scope", "c"),
          name: "@scope/c",
          version: "3.0.0",
        },
        { at: path.join("node_modules", "a"), name: "a", version: "1.0.0" },
        {
          at: path.join("node_modules", "a", "node_modules", "b"),
          name: "b",
          version: "2.0.0",
        },
      ],
    });
  });

  it("keeps two copies with the same name and version as two roots", () => {
    const root = tree({
      "node_modules/twin/package.json": manifest("twin", "1.0.0"),
      "node_modules/host/package.json": manifest("host", "1.0.0"),
      "node_modules/host/node_modules/twin/package.json": manifest(
        "twin",
        "1.0.0",
      ),
    });

    expect(
      roots(root).packages.filter((entry) => entry.name === "twin"),
    ).toHaveLength(2);
  });

  it("counts a directory with no manifest (Node can load its index.js), and skips npm's dot-entries", () => {
    const root = tree({
      "node_modules/bare/index.js": "module.exports = {};\n",
      "node_modules/.bin/tool": "#!/bin/sh\n",
      "node_modules/.package-lock.json": "{}",
      "node_modules/.cache/x/package.json": manifest("x", "1.0.0"),
    });

    expect(roots(root).packages).toEqual([
      {
        at: path.join("node_modules", "bare"),
        name: undefined,
        version: undefined,
      },
    ]);
  });

  it("follows a link by realpath: a linked workspace member is its target, found once", () => {
    const root = tree(
      {
        "packages/foo/package.json": manifest("foo"),
        "packages/foo/node_modules/dep/package.json": manifest("dep", "1.0.0"),
      },
      {
        "node_modules/foo": "packages/foo",
        "node_modules/foo-again": "packages/foo",
      },
    );

    expect(roots(root).packages.map((entry) => entry.at)).toEqual([
      path.join("packages", "foo"),
      path.join("packages", "foo", "node_modules", "dep"),
    ]);
  });

  it("ignores a dangling link: it installs nothing", () => {
    const root = tree({}, { "node_modules/gone": "nowhere" });

    expect(roots(root).packages).toEqual([]);
  });

  it("reports a link out of the project, without walking that checkout's own node_modules", () => {
    const outside = tree({
      "pkg/package.json": manifest("ext", "1.0.0"),
      "pkg/node_modules/deep/package.json": manifest("deep", "1.0.0"),
    });
    const root = tree({}, { "node_modules/ext": path.join(outside, "pkg") });

    const found = enumerateInstalledPackages({
      projectRoot: root,
      startRoots: [root],
    }).packages.map((entry) => entry.name);

    expect(found).toEqual(["ext"]);
  });

  it("walks every start root's node_modules (a workspace member's own)", () => {
    const root = tree({
      "packages/app/package.json": manifest("app", "1.0.0"),
      "packages/app/node_modules/only-here/package.json": manifest(
        "only-here",
        "1.0.0",
      ),
    });

    expect(
      roots(root, [root, path.join(root, "packages", "app")]).packages.map(
        (entry) => entry.name,
      ),
    ).toEqual(["only-here"]);
  });

  it("never returns the project root itself, even through a link to it", () => {
    const root = tree(
      { "package.json": manifest("app", "1.0.0") },
      {
        "node_modules/self": ".",
      },
    );

    expect(roots(root).packages).toEqual([]);
  });
});

describe("B-4 installed tree: the bound is reported, never silent", () => {
  it("marks the enumeration truncated when the directory bound stops it", () => {
    const root = tree({
      "node_modules/a/package.json": manifest("a", "1.0.0"),
      "node_modules/a/node_modules/b/package.json": manifest("b", "1.0.0"),
    });

    // One operation: listing the root's node_modules. Examining `a` is
    // work the bound declines.
    const result = enumerateInstalledPackages({
      projectRoot: root,
      startRoots: [root],
      maxDirectories: 1,
    });

    expect(result.truncated).toBe(true);
  });

  it("is not truncated when the bound is exactly enough", () => {
    const root = tree({
      "node_modules/a/package.json": manifest("a", "1.0.0"),
    });

    // The root's node_modules, the candidate `a`, then `a`'s own
    // node_modules (absent): three operations.
    const result = enumerateInstalledPackages({
      projectRoot: root,
      startRoots: [root],
      maxDirectories: 3,
    });

    expect(result).toMatchObject({ truncated: false });
    expect(result.packages).toHaveLength(1);
  });
});

describe("B-4 installed tree: the bound counts operations, not only listings", () => {
  // The independent audit of B-4: a single wide node_modules was bounded
  // only by its entry count, because only listings were counted. Every
  // entry examined (a stat, a realpath, a manifest read) costs one too.
  // Five flat packages: 1 listing + 5 entries + 5 nested listings = 11.
  const flat = () =>
    tree(
      Object.fromEntries(
        ["a", "b", "c", "d", "e"].map((name) => [
          `node_modules/${name}/package.json`,
          manifest(name, "1.0.0"),
        ]),
      ),
    );

  it("completes with exactly enough operations", () => {
    const root = flat();
    const result = enumerateInstalledPackages({
      projectRoot: root,
      startRoots: [root],
      maxDirectories: 11,
    });

    expect(result.truncated).toBe(false);
    expect(result.packages).toHaveLength(5);
  });

  it("is truncated one operation short", () => {
    const root = flat();

    expect(
      enumerateInstalledPackages({
        projectRoot: root,
        startRoots: [root],
        maxDirectories: 10,
      }).truncated,
    ).toBe(true);
  });
});

describe("B-4 installed tree: an unreadable path is reported, never read as empty", () => {
  // The independent audit of B-4, finding 1: a permission error was
  // swallowed and read as "no packages here". Skipped as root, which
  // reads through permissions.
  const asRoot = process.getuid?.() === 0;

  it.skipIf(asRoot)("lists a node_modules it cannot read as unreadable", () => {
    const root = tree({
      "node_modules/unlisted/package.json": manifest("unlisted", "1.0.0"),
    });
    const nodeModules = path.join(root, "node_modules");
    chmodSync(nodeModules, 0o311);
    try {
      const result = enumerateInstalledPackages({
        projectRoot: root,
        startRoots: [root],
      });

      expect(result.packages).toEqual([]);
      expect(result.unreadable).toEqual([
        path.join(canonicalizePackageInstancePath(root), "node_modules"),
      ]);
    } finally {
      chmodSync(nodeModules, 0o755);
    }
  });

  it("an absent node_modules is not unreadable (control)", () => {
    const root = tree({ "package.json": manifest("app", "1.0.0") });

    expect(
      enumerateInstalledPackages({ projectRoot: root, startRoots: [root] }),
    ).toEqual({ packages: [], truncated: false, unreadable: [] });
  });
});
