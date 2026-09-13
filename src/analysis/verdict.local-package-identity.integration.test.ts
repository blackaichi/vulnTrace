import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { buildFindingForTest } from "../testing/finding.js";
import { discoverEntrypoints } from "./entrypoints.js";

/**
 * P1-A4 REMEDIATION — LOSS OF PACKAGE IDENTITY MUST NEVER CREATE
 * NOT_AFFECTED.
 *
 * The independent audit of P1-A4 found a runtime-reachable false
 * NOT_AFFECTED, and the path to it had two independent halves:
 *
 * 1. **Discovery truncated silently.** A `packages/**` pattern nested
 *    deeper than the traversal cap returned its partial result as though
 *    it were complete, reporting nothing, so a real workspace package
 *    vanished from the known roots.
 * 2. **Site B then answered anyway.** With no `PackageInstance` for the
 *    package, `resolveTargetNodes` fell through to resolving the
 *    advisory's module from the PROJECT ROOT with no instance gate and no
 *    RWF-030 public-entry authority. Its phantom target was then searched,
 *    found unreachable, and certified NOT_AFFECTED — about a sink real
 *    Node executes.
 *
 * Half 1 is a bug and is fixed. Half 2 is the STRUCTURAL guarantee, and
 * it is what this suite exists for: identity may be lost for reasons this
 * analyzer will never enumerate in advance (an unsupported declaration
 * shape, a package manager whose layout is not read, a manifest that
 * cannot be parsed, a future traversal limit). Whenever it is lost, the
 * only sound answer is UNKNOWN.
 *
 * So these tests deliberately do NOT go through the truncation bug. They
 * remove identity by the most ordinary means available — a monorepo whose
 * workspace layout this analyzer does not read at all — and assert the
 * guarantee directly.
 */

function repoWith(options: {
  /** Root manifest's `workspaces` value; omit for a layout we do not read. */
  readonly workspaces?: unknown;
  /** Extra files, relative to the repo root. */
  readonly extraFiles?: Record<string, string>;
  /** `true` to make the local package's public entry FORWARD its export. */
  readonly forwarding?: boolean;
  /** `true` for a consumer that loads the package but never calls the sink. */
  readonly unreachable?: boolean;
}): { root: string; consumer: string; libRoot: string } {
  const root = mkdtempSync(path.join(tmpdir(), "vulntrace-p1a4-identity-"));
  const write = (relative: string, contents: string): void => {
    const full = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  };

  const rootManifest: Record<string, unknown> = {
    name: "monorepo-root",
    version: "1.0.0",
    private: true,
  };
  if (options.workspaces !== undefined) {
    rootManifest.workspaces = options.workspaces;
  }
  write("package.json", JSON.stringify(rootManifest));

  write(
    "packages/lib/package.json",
    JSON.stringify({ name: "lib", version: "1.0.0", main: "./index.js" }),
  );
  if (options.forwarding) {
    write(
      "packages/lib/index.js",
      `"use strict";\nexports.vulnerable = require("./impl").internal;\n`,
    );
    write(
      "packages/lib/impl.js",
      `"use strict";\nexports.internal = function libDanger(input) {\n  return "lib/impl.js:internal:" + String(input);\n};\n`,
    );
  } else {
    write(
      "packages/lib/index.js",
      `"use strict";\nfunction vulnerable(input) {\n  return "lib/index.js:vulnerable:" + String(input);\n}\nmodule.exports = { vulnerable };\n`,
    );
  }

  write(
    "packages/app/package.json",
    JSON.stringify({ name: "app", version: "1.0.0" }),
  );
  write(
    "packages/app/src/consumer.cjs",
    options.unreachable
      ? `"use strict";\nconst lib = require("lib");\nmodule.exports.handle = function handle() {\n  return typeof lib;\n};\n`
      : `"use strict";\nconst lib = require("lib");\nmodule.exports.handle = function handle(input) {\n  return lib.vulnerable(input);\n};\n`,
  );

  for (const [relative, contents] of Object.entries(options.extraFiles ?? {})) {
    write(relative, contents);
  }

  // The node_modules link a real install materializes. Without it nothing
  // resolves at all and the scenario would prove nothing.
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  symlinkSync(
    path.join(root, "packages", "lib"),
    path.join(root, "node_modules", "lib"),
    "dir",
  );

  return {
    root,
    consumer: "packages/app/src/consumer.cjs",
    libRoot: path.join(root, "packages", "lib"),
  };
}

/** What real `node` does, out of process: resolution and whether the sink runs. */
function runtime(
  root: string,
  consumer: string,
): { resolved: string; result: string } {
  const consumerFile = path.join(root, ...consumer.split("/"));
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "-e",
        `const path = require("node:path");
         const out = {
           resolved: require.resolve("lib", { paths: [${JSON.stringify(path.dirname(consumerFile))}] }),
           result: String(require(${JSON.stringify(consumerFile)}).handle("X")),
         };
         process.stdout.write(JSON.stringify(out));`,
      ],
      { encoding: "utf-8" },
    ),
  ) as { resolved: string; result: string };
}

async function scan(options: {
  readonly root: string;
  readonly consumer: string;
  readonly packageInstance: string;
}) {
  const { root } = options;
  const entry = path.join(root, ...options.consumer.split("/"));
  const resolver = createModuleResolver(loadTsProject(root));
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

  const [graph, entrypointsResult] = await Promise.all([
    buildCallGraph({ entryFiles: [entry], resolver, knownPackageRoots }),
    discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: [options.consumer],
    }),
  ]);

  const vulnerability: Vulnerability = {
    id: "GHSA-p1-a4-identity",
    aliases: [],
    package: "lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-p1-a4-identity",
    package: { name: "lib" },
    targets: [{ module: "lib", export: "vulnerable", kind: "function" }],
  };

  const finding = await buildFindingForTest({
    vulnerability,
    packageName: "lib",
    packageVersion: "1.0.0",
    packageInstance: canonicalizePackageInstancePath(options.packageInstance),
    matchResult: "affected",
    rule,
    graph,
    entrypoints: entrypointsResult.entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
  });

  return { finding, discovery, knownPackageRoots, graph };
}

// ---------------------------------------------------------------------------
// A — identity absent, target RUNTIME-REACHABLE. The blocker.
// ---------------------------------------------------------------------------

describe("P1-A4 remediation § A: missing identity + reachable target", () => {
  it("never answers NOT_AFFECTED for a forwarded sink real Node executes", async () => {
    // A pnpm-style monorepo: the packages are declared somewhere this
    // analyzer does not read, so no workspace root is discovered and the
    // local package has no identity at all. The sink is nevertheless
    // genuinely executed.
    const repo = repoWith({
      forwarding: true,
      extraFiles: { "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n" },
    });

    const real = runtime(repo.root, repo.consumer);
    expect(real.result).toMatch(/^lib\/impl\.js:internal:/);
    expect(real.resolved).toBe(path.join(repo.libRoot, "index.js"));

    const { finding, knownPackageRoots } = await scan({
      root: repo.root,
      consumer: repo.consumer,
      packageInstance: repo.libRoot,
    });

    // Identity really is absent -- this is the precondition, not an
    // incidental detail.
    expect(
      identifyModule(path.join(repo.libRoot, "index.js"), knownPackageRoots)
        .packageInstance,
    ).toBeUndefined();

    expect(finding?.verdict).not.toBe("NOT_AFFECTED");
    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("never answers NOT_AFFECTED for a directly exported sink either", async () => {
    const repo = repoWith({
      extraFiles: { "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n" },
    });
    expect(runtime(repo.root, repo.consumer).result).toMatch(
      /^lib\/index\.js:vulnerable:/,
    );

    const { finding } = await scan({
      root: repo.root,
      consumer: repo.consumer,
      packageInstance: repo.libRoot,
    });
    expect(finding?.verdict).not.toBe("NOT_AFFECTED");
  });

  it("refuses the same way when the declaration shape is unsupported", async () => {
    const repo = repoWith({ workspaces: "packages/*", forwarding: true });
    expect(runtime(repo.root, repo.consumer).result).toMatch(
      /^lib\/impl\.js:internal:/,
    );

    const { finding, discovery } = await scan({
      root: repo.root,
      consumer: repo.consumer,
      packageInstance: repo.libRoot,
    });
    expect(discovery.packages).toEqual([]);
    expect(finding?.verdict).not.toBe("NOT_AFFECTED");
  });
});

// ---------------------------------------------------------------------------
// B — identity absent, target genuinely UNREACHABLE.
// ---------------------------------------------------------------------------

describe("P1-A4 remediation § B: missing identity + unreachable target", () => {
  it("still refuses rather than certifying a negative it cannot prove", async () => {
    // The consumer loads the package but never calls the sink, so the
    // honest answer would be a negative -- IF the package could be
    // identified. It cannot, so no negative may be certified: the analyzer
    // has no way to tell this case apart from § A at the point the proof
    // would be written.
    const repo = repoWith({
      unreachable: true,
      extraFiles: { "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n" },
    });

    const { finding } = await scan({
      root: repo.root,
      consumer: repo.consumer,
      packageInstance: repo.libRoot,
    });
    expect(finding?.verdict).not.toBe("NOT_AFFECTED");
    expect(finding?.verdict).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// C — identity PRESENT: the legitimate negative must survive.
// ---------------------------------------------------------------------------

describe("P1-A4 remediation § C: identity present", () => {
  it("keeps the legitimate negative when the package IS identified", async () => {
    // Same repository, declared in a form this analyzer does read. The
    // package now has an exact instance, so a negative is provable and
    // must not be lost to the new gate.
    const repo = repoWith({ workspaces: ["packages/*"], unreachable: true });

    const { finding, knownPackageRoots } = await scan({
      root: repo.root,
      consumer: repo.consumer,
      packageInstance: repo.libRoot,
    });

    expect(
      identifyModule(path.join(repo.libRoot, "index.js"), knownPackageRoots)
        .packageInstance,
    ).toBe(canonicalizePackageInstancePath(repo.libRoot));
    expect(finding?.verdict).toBe("NOT_AFFECTED");
  });

  it("binds the reachable target exactly when the package IS identified", async () => {
    const repo = repoWith({ workspaces: ["packages/*"], forwarding: true });

    const { finding } = await scan({
      root: repo.root,
      consumer: repo.consumer,
      packageInstance: repo.libRoot,
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(finding?.evidence?.path?.at(-1)).toContain(
      path.join("packages", "lib", "impl.js"),
    );
  });

  it("keeps the legitimate negative for a package nothing imports at all", async () => {
    // The most common source of correct negatives, and the one the new
    // gate must not touch: the package is discovered, identified, and
    // simply never imported by anything.
    const repo = repoWith({ workspaces: ["packages/*"] });
    const write = (relative: string, contents: string): void => {
      const full = path.join(repo.root, ...relative.split("/"));
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents);
    };
    write(
      "packages/unused/package.json",
      JSON.stringify({ name: "unused", version: "1.0.0", main: "./index.js" }),
    );
    write(
      "packages/unused/index.js",
      `"use strict";\nmodule.exports = { vulnerable(x) { return x; } };\n`,
    );
    symlinkSync(
      path.join(repo.root, "packages", "unused"),
      path.join(repo.root, "node_modules", "unused"),
      "dir",
    );

    const entry = path.join(repo.root, ...repo.consumer.split("/"));
    const resolver = createModuleResolver(loadTsProject(repo.root));
    const discovery = discoverWorkspacePackages(repo.root);
    const knownPackageRoots = buildKnownPackageRoots(
      [],
      repo.root,
      discovery.packages.map((p) => ({
        canonicalRoot: p.canonicalRoot,
        packageName: p.packageName ?? path.basename(p.canonicalRoot),
      })),
    );
    const [graph, eps] = await Promise.all([
      buildCallGraph({ entryFiles: [entry], resolver, knownPackageRoots }),
      discoverEntrypoints({
        projectRoot: repo.root,
        resolver,
        configuredEntrypoints: [repo.consumer],
      }),
    ]);
    const finding = await buildFindingForTest({
      vulnerability: {
        id: "GHSA-unused",
        aliases: [],
        package: "unused",
        ecosystem: "npm",
        affectedVersions: [{ introduced: "0" }],
        fixedVersions: [],
        references: [],
      },
      packageName: "unused",
      packageVersion: "1.0.0",
      packageInstance: canonicalizePackageInstancePath(
        path.join(repo.root, "packages", "unused"),
      ),
      matchResult: "affected",
      rule: {
        id: "GHSA-unused",
        package: { name: "unused" },
        targets: [{ module: "unused", export: "vulnerable", kind: "function" }],
      },
      graph,
      entrypoints: eps.entrypoints,
      resolver,
      projectRoot: repo.root,
      knownPackageRoots,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
  });
});
