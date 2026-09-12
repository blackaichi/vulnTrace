import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixturePath } from "../testing/fixtures.js";
import { createModuleResolver } from "./module-resolver.js";
import {
  declaresExports,
  installDirectorySpecifier,
  parseBarePackageSpecifier,
  publicSubpathOf,
  resolveAuthoritativePackageEntries,
} from "./package-entry.js";
import { loadTsProject } from "./ts-project.js";

const FIXTURE = "package-entry";

function root(): string {
  return fixturePath(FIXTURE);
}

function instance(...segments: string[]): string {
  return path.join(root(), "node_modules", ...segments);
}

async function entries(
  requestedModuleSpecifier: string,
  packageInstance: string,
  entrypoint?: string,
) {
  const projectRoot = root();
  const resolver = createModuleResolver(loadTsProject(projectRoot));
  return resolveAuthoritativePackageEntries({
    resolver,
    requestedModuleSpecifier,
    packageInstance,
    referenceContext: path.join(projectRoot, "package.json"),
    entrypointFiles: entrypoint
      ? [path.join(projectRoot, ...entrypoint.split("/"))]
      : [],
  });
}

/** Fixture-root-relative, POSIX-spelled resolved files, for readable assertions. */
async function resolvedFiles(
  requestedModuleSpecifier: string,
  packageInstance: string,
  entrypoint?: string,
): Promise<string[]> {
  const found = await entries(
    requestedModuleSpecifier,
    packageInstance,
    entrypoint,
  );
  return found
    .map((entry) =>
      path.relative(root(), entry.resolvedFile).split(path.sep).join("/"),
    )
    .sort();
}

// ---------------------------------------------------------------------------
// Specifier parsing.
// ---------------------------------------------------------------------------

describe("parseBarePackageSpecifier", () => {
  it("splits an unscoped specifier at the first segment", () => {
    expect(parseBarePackageSpecifier("foo")).toEqual({
      packageName: "foo",
      subpath: undefined,
    });
    expect(parseBarePackageSpecifier("foo/parse")).toEqual({
      packageName: "foo",
      subpath: "parse",
    });
    expect(parseBarePackageSpecifier("foo/lib/deep/thing.js")).toEqual({
      packageName: "foo",
      subpath: "lib/deep/thing.js",
    });
  });

  it("keeps a SCOPE and its package as one two-segment name", () => {
    // The whole point of § B: the package root is node_modules/@scope/pkg,
    // never the scope directory node_modules/@scope.
    expect(parseBarePackageSpecifier("@scope/pkg")).toEqual({
      packageName: "@scope/pkg",
      subpath: undefined,
    });
    expect(parseBarePackageSpecifier("@scope/pkg/api")).toEqual({
      packageName: "@scope/pkg",
      subpath: "api",
    });
    expect(parseBarePackageSpecifier("@scope/pkg/lib/deep")).toEqual({
      packageName: "@scope/pkg",
      subpath: "lib/deep",
    });
  });

  it("refuses a bare scope with no package after it", () => {
    expect(parseBarePackageSpecifier("@scope")).toBeUndefined();
  });

  it("refuses anything that is not a bare package specifier", () => {
    for (const specifier of [
      "",
      ".",
      "..",
      "./local",
      "../up",
      "/absolute/path",
      "#internal",
      "fs",
      "node:fs",
      "foo//parse",
      "foo/",
    ]) {
      expect(parseBarePackageSpecifier(specifier)).toBeUndefined();
    }
  });

  it("maps parsed parts to the package.json exports spelling", () => {
    expect(publicSubpathOf({ packageName: "foo" })).toBe(".");
    expect(publicSubpathOf({ packageName: "foo", subpath: "parse" })).toBe(
      "./parse",
    );
    expect(publicSubpathOf({ packageName: "@scope/pkg", subpath: "api" })).toBe(
      "./api",
    );
  });
});

// ---------------------------------------------------------------------------
// Install-directory derivation (the npm-alias handle).
// ---------------------------------------------------------------------------

describe("installDirectorySpecifier", () => {
  it("derives the install DIRECTORY, not the manifest name", () => {
    // An alias install's manifest says `"name": "twin-lib"` while the
    // directory is `twin-alias` -- and the directory is the only one of the
    // two that resolves.
    expect(installDirectorySpecifier(instance("twin-alias"))).toBe(
      "twin-alias",
    );
  });

  it("keeps a scoped install directory whole", () => {
    expect(installDirectorySpecifier(instance("@scope", "pkg"))).toBe(
      "@scope/pkg",
    );
  });

  it("uses the LAST node_modules segment for a nested install", () => {
    expect(
      installDirectorySpecifier(
        path.join(instance("outer"), "node_modules", "inner"),
      ),
    ).toBe("inner");
  });

  it("returns undefined for an instance outside any node_modules", () => {
    expect(
      installDirectorySpecifier(path.join(root(), "packages", "member")),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The `exports` gate on the absolute-install-PATH probe.
// ---------------------------------------------------------------------------

describe("declaresExports", () => {
  it("is true for a package that declares exports, in either spelling", () => {
    expect(declaresExports(instance("expmain-lib"))).toBe(true);
    expect(declaresExports(instance("shorthand-lib"))).toBe(true);
  });

  it("is false for a package with only main", () => {
    expect(declaresExports(instance("mainonly-lib"))).toBe(false);
  });

  it("is false for an unreadable package.json", () => {
    expect(declaresExports(instance("does-not-exist"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Authoritative entry resolution.
// ---------------------------------------------------------------------------

describe("resolveAuthoritativePackageEntries", () => {
  it('gives exports "." authority over main', async () => {
    // The superseded `main` file must not appear. An absolute-PATH request
    // for the install directory resolves to it in real Node (a path request
    // never consults `exports`), which is why that probe is gated.
    expect(await resolvedFiles("expmain-lib", instance("expmain-lib"))).toEqual(
      ["node_modules/expmain-lib/modern.js"],
    );
  });

  it("resolves the exports string shorthand", async () => {
    expect(
      await resolvedFiles("shorthand-lib", instance("shorthand-lib")),
    ).toEqual(["node_modules/shorthand-lib/dist/index.js"]);
  });

  it("keeps main authoritative for a package with no exports", async () => {
    expect(
      await resolvedFiles("mainonly-lib", instance("mainonly-lib")),
    ).toEqual(["node_modules/mainonly-lib/lib/index.js"]);
  });

  it("anchors an explicit subpath at its own exports entry", async () => {
    expect(
      await resolvedFiles("subpath-lib/parse", instance("subpath-lib")),
    ).toEqual(["node_modules/subpath-lib/lib/parse.js"]);
    expect(await resolvedFiles("subpath-lib", instance("subpath-lib"))).toEqual(
      ["node_modules/subpath-lib/index.js"],
    );
  });

  it("returns nothing for a package-root request against a subpath-only package", async () => {
    expect(
      await resolvedFiles("subpathonly-lib", instance("subpathonly-lib")),
    ).toEqual([]);
    // ...while its declared subpath still resolves.
    expect(
      await resolvedFiles("subpathonly-lib/get", instance("subpathonly-lib")),
    ).toEqual(["node_modules/subpathonly-lib/get.js"]);
  });

  it("returns nothing for an unexported internal file", async () => {
    expect(
      await resolvedFiles("subpath-lib/lib/internal", instance("subpath-lib")),
    ).toEqual([]);
    expect(
      await resolvedFiles("encap-lib/lib/vulnerable", instance("encap-lib")),
    ).toEqual([]);
  });

  it("returns nothing for an invalid or escaping exports target", async () => {
    expect(
      await resolvedFiles("badexports-lib", instance("badexports-lib")),
    ).toEqual([]);
    expect(await resolvedFiles("escape-lib", instance("escape-lib"))).toEqual(
      [],
    );
  });

  it("resolves a wildcard subpath the resolver itself supports, and no other", async () => {
    expect(
      await resolvedFiles(
        "wildcard-lib/features/alpha",
        instance("wildcard-lib"),
      ),
    ).toEqual(["node_modules/wildcard-lib/src/features/alpha.js"]);
    expect(
      await resolvedFiles(
        "wildcard-lib/features/missing",
        instance("wildcard-lib"),
      ),
    ).toEqual([]);
  });

  it("resolves the conditional branch the CONSUMER's own context selects", async () => {
    expect(
      await resolvedFiles(
        "cond-lib",
        instance("cond-lib"),
        "src/cond-cjs-consumer.cjs",
      ),
    ).toContain("node_modules/cond-lib/cjs.cjs");
    expect(
      await resolvedFiles(
        "cond-lib",
        instance("cond-lib"),
        "src/cond-esm-consumer.mjs",
      ),
    ).toContain("node_modules/cond-lib/esm.mjs");
  });

  it("resolves an ALIAS install through its directory, never its manifest name", async () => {
    // The advisory names `twin-lib`; the instance is node_modules/twin-alias.
    // No context resolves `twin-lib` into that directory, so only the
    // install-directory specifier can -- and it must land inside exactly
    // that instance.
    expect(await resolvedFiles("twin-lib", instance("twin-alias"))).toEqual([
      "node_modules/twin-alias/index.js",
    ]);
    expect(await resolvedFiles("twin-lib", instance("twin-lib"))).toEqual([
      "node_modules/twin-lib/index.js",
    ]);
  });

  it("keeps alias and real twins distinct on a subpath surface", async () => {
    expect(await resolvedFiles("twin-lib/api", instance("twin-alias"))).toEqual(
      ["node_modules/twin-alias/api.js"],
    );
    expect(await resolvedFiles("twin-lib/api", instance("twin-lib"))).toEqual([
      "node_modules/twin-lib/api.js",
    ]);
  });

  it("resolves a scoped package at its own root, not the scope directory", async () => {
    expect(
      await resolvedFiles("@scope/pkg", instance("@scope", "pkg")),
    ).toEqual(["node_modules/@scope/pkg/dist/index.js"]);
    expect(
      await resolvedFiles("@scope/pkg/api", instance("@scope", "pkg")),
    ).toEqual(["node_modules/@scope/pkg/dist/api.js"]);
    expect(
      await resolvedFiles("@other/pkg", instance("@other", "pkg")),
    ).toEqual(["node_modules/@other/pkg/index.js"]);
  });

  it("never answers one instance's request with another instance's entry", async () => {
    // Asking about @other/pkg while gating on @scope/pkg's install path
    // must return nothing at all -- identity is the whole install path.
    expect(
      await resolvedFiles("@other/pkg", instance("@scope", "pkg")),
    ).toEqual([]);
    expect(await resolvedFiles("twin-alias", instance("twin-lib"))).toEqual([]);
  });

  it("carries the public subpath and the probe that established the entry", async () => {
    const [entry] = await entries("subpath-lib/parse", instance("subpath-lib"));
    expect(entry?.publicSubpath).toBe("./parse");
    expect(entry?.packageInstance).toBe(instance("subpath-lib"));
    expect(entry?.via).toContain("subpath-lib/parse");
  });

  it("memoizes per (instance, specifier) without collapsing distinct surfaces", async () => {
    const projectRoot = root();
    const resolver = createModuleResolver(loadTsProject(projectRoot));
    const memo = new Map<
      string,
      Awaited<ReturnType<typeof resolveAuthoritativePackageEntries>>
    >();
    const common = {
      resolver,
      packageInstance: instance("subpath-lib"),
      referenceContext: path.join(projectRoot, "package.json"),
      entrypointFiles: [],
      memo,
    };

    const rootEntries = await resolveAuthoritativePackageEntries({
      ...common,
      requestedModuleSpecifier: "subpath-lib",
    });
    const parseEntries = await resolveAuthoritativePackageEntries({
      ...common,
      requestedModuleSpecifier: "subpath-lib/parse",
    });

    expect(memo.size).toBe(2);
    expect(rootEntries[0]?.resolvedFile).not.toBe(
      parseEntries[0]?.resolvedFile,
    );

    // A repeat call returns the memoized array itself.
    expect(
      await resolveAuthoritativePackageEntries({
        ...common,
        requestedModuleSpecifier: "subpath-lib/parse",
      }),
    ).toBe(parseEntries);
  });
});
