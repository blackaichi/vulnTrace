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
 * SITE B TARGET AUTHORITY — a concrete path to the WRONG package instance
 * is not evidence about this finding's package.
 *
 * Site A (`resolveTargetNodes`'s instance-anchored branch) has always
 * required `instance === packageInstance` before any node may answer for a
 * finding: VT-212/ADV2-045 reproduced a false verdict when one installed
 * instance inherited another's reachability. Site B — the fallback taken
 * when the call graph contains no node of the advisory's package NAME at
 * all — never had the equivalent check. It resolved the advisory's module
 * from the PROJECT ROOT and bound whatever real node it landed on.
 *
 * That is enough to fabricate an AFFECTED about a package that does not
 * contain the vulnerable export at all:
 *
 *   advisory            : foo
 *   finding instance    : packages/foo   <- publishes only `safe`
 *   node_modules/foo    -> packages/bar  <- publishes `vulnerable`, and runs
 *   verdict (before)    : AFFECTED, evidence in packages/bar
 *
 * The first P1-A4 remediation gated this on identity being ABSENT, on the
 * theory that a positive "can mis-attribute but never fabricate". Both
 * halves of that were wrong: the verdict above is fabricated (the finding's
 * own package has no such export), and it reproduces just as readily with
 * identity fully available, where `packages/bar` is correctly identified as
 * a different instance. Identity presence was never the question —
 * OWNERSHIP is.
 *
 * These cases are deliberately not workspace-specific. The invariant is a
 * general one about target authority and is pinned here permanently.
 */

interface RepoOptions {
  /** Declare `workspaces`, so every local package has an identity. */
  readonly declareWorkspaces?: boolean;
  /** Which physical package `node_modules/foo` points at. */
  readonly linkFooTo: "foo" | "bar";
  /** Give `bar` the same manifest name/version as `foo`. */
  readonly barImpersonatesFoo?: boolean;
  /** `foo` publishes the vulnerable export too. */
  readonly fooVulnerable?: boolean;
  /** `foo` publishes it by FORWARDING rather than declaring it. */
  readonly fooForwards?: boolean;
  /** The consumer loads the package but never calls the sink. */
  readonly unreachable?: boolean;
  /** Use a scoped advisory/package name. */
  readonly scoped?: boolean;
}

function buildRepo(options: RepoOptions): {
  root: string;
  app: string;
  consumer: string;
  fooRoot: string;
  barRoot: string;
  advisory: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "vulntrace-siteb-"));
  const write = (relative: string, contents: string): void => {
    const full = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  };
  const advisory = options.scoped ? "@scope/foo" : "foo";

  const rootManifest: Record<string, unknown> = {
    name: "monorepo-root",
    version: "1.0.0",
    private: true,
  };
  if (options.declareWorkspaces) {
    rootManifest.workspaces = ["packages/*"];
  } else {
    write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
  }
  write("package.json", JSON.stringify(rootManifest));

  // packages/foo -- the package the finding is ABOUT.
  write(
    "packages/foo/package.json",
    JSON.stringify({ name: advisory, version: "1.0.0", main: "./index.js" }),
  );
  if (options.fooForwards) {
    write(
      "packages/foo/index.js",
      `"use strict";\nexports.vulnerable = require("./impl").internal;\n`,
    );
    write(
      "packages/foo/impl.js",
      `"use strict";\nexports.internal = function fooDanger(x) { return "foo-impl:" + x; };\n`,
    );
  } else if (options.fooVulnerable) {
    write(
      "packages/foo/index.js",
      `"use strict";\nfunction vulnerable(x) { return "foo:" + x; }\nmodule.exports = { vulnerable };\n`,
    );
  } else {
    write(
      "packages/foo/index.js",
      `"use strict";\nmodule.exports = { safe(x) { return "foo-safe:" + x; } };\n`,
    );
  }

  // packages/bar -- a DIFFERENT package that publishes the advisory's name.
  write(
    "packages/bar/package.json",
    JSON.stringify({
      name: options.barImpersonatesFoo ? advisory : "bar",
      version: "1.0.0",
      main: "./index.js",
    }),
  );
  write(
    "packages/bar/index.js",
    `"use strict";\nfunction vulnerable(x) { return "bar-danger:" + x; }\nmodule.exports = { vulnerable };\n`,
  );

  write(
    "packages/app/package.json",
    JSON.stringify({ name: "app", version: "1.0.0" }),
  );
  write(
    "packages/app/src/consumer.cjs",
    options.unreachable
      ? `"use strict";\nconst dep = require(${JSON.stringify(advisory)});\nmodule.exports.handle = function handle() { return typeof dep; };\n`
      : `"use strict";\nconst dep = require(${JSON.stringify(advisory)});\nmodule.exports.handle = function handle(x) { return dep.vulnerable(x); };\n`,
  );

  const linkPath = options.scoped
    ? path.join(root, "node_modules", "@scope", "foo")
    : path.join(root, "node_modules", "foo");
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(path.join(root, "packages", options.linkFooTo), linkPath, "dir");

  return {
    root,
    app: path.join(root, "packages", "app"),
    consumer: "packages/app/src/consumer.cjs",
    fooRoot: path.join(root, "packages", "foo"),
    barRoot: path.join(root, "packages", "bar"),
    advisory,
  };
}

/** What real `node` actually executes. */
function runtimeResult(repo: { root: string; app: string }): string {
  return execFileSync(
    process.execPath,
    [
      "-e",
      `process.stdout.write(String(require(${JSON.stringify(path.join(repo.app, "src", "consumer.cjs"))}).handle("X")))`,
    ],
    { encoding: "utf-8" },
  );
}

async function scan(
  repo: ReturnType<typeof buildRepo>,
  findingInstance: string,
) {
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
  const entry = path.join(repo.root, ...repo.consumer.split("/"));
  const [graph, entrypointsResult] = await Promise.all([
    buildCallGraph({ entryFiles: [entry], resolver, knownPackageRoots }),
    discoverEntrypoints({
      projectRoot: repo.root,
      resolver,
      configuredEntrypoints: [repo.consumer],
    }),
  ]);

  const vulnerability: Vulnerability = {
    id: "GHSA-site-b-authority",
    aliases: [],
    package: repo.advisory,
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-site-b-authority",
    package: { name: repo.advisory },
    targets: [
      { module: repo.advisory, export: "vulnerable", kind: "function" },
    ],
  };

  const finding = await buildFindingForTest({
    vulnerability,
    packageName: repo.advisory,
    packageVersion: "1.0.0",
    packageInstance: canonicalizePackageInstancePath(findingInstance),
    matchResult: "affected",
    rule,
    graph,
    entrypoints: entrypointsResult.entrypoints,
    resolver,
    projectRoot: repo.root,
    knownPackageRoots,
  });

  const evidence = (finding?.evidence?.path ?? []).map((node) =>
    path
      .relative(repo.root, node.replace(/:\d+$/, ""))
      .split(path.sep)
      .join("/"),
  );
  return { finding, evidence, knownPackageRoots };
}

// ---------------------------------------------------------------------------
// The blocker.
// ---------------------------------------------------------------------------

describe("Site B target authority: a path to the WRONG instance is not evidence", () => {
  it.each([
    ["identity unavailable (pnpm-style layout)", false],
    ["identity fully available (workspaces declared)", true],
  ])(
    "never reports AFFECTED for a package that lacks the export — %s",
    async (_label, declareWorkspaces) => {
      const repo = buildRepo({ declareWorkspaces, linkFooTo: "bar" });

      // Ground truth: bar's callable is what actually runs...
      expect(runtimeResult(repo)).toBe("bar-danger:X");
      // ...and the finding's own package publishes no such export at all.
      const { finding, evidence } = await scan(repo, repo.fooRoot);

      expect(finding?.verdict).not.toBe("AFFECTED");
      expect(evidence.some((file) => file.startsWith("packages/bar"))).toBe(
        false,
      );
      expect(finding?.verdict).toBe("UNKNOWN");
    },
  );

  it("holds when the wrong package IMPERSONATES the advisory's name and version", async () => {
    const repo = buildRepo({
      declareWorkspaces: true,
      linkFooTo: "bar",
      barImpersonatesFoo: true,
    });
    expect(runtimeResult(repo)).toBe("bar-danger:X");

    const { finding, evidence } = await scan(repo, repo.fooRoot);
    expect(finding?.verdict).not.toBe("AFFECTED");
    expect(evidence.some((file) => file.startsWith("packages/bar"))).toBe(
      false,
    );
  });

  it("holds for a SCOPED advisory", async () => {
    const repo = buildRepo({
      declareWorkspaces: true,
      linkFooTo: "bar",
      scoped: true,
    });
    expect(runtimeResult(repo)).toBe("bar-danger:X");

    const { finding } = await scan(repo, repo.fooRoot);
    expect(finding?.verdict).not.toBe("AFFECTED");
  });

  it("does not answer for the wrong instance in the NEGATIVE direction either", async () => {
    // The finding is about packages/bar; resolution from the project root
    // lands on packages/foo. The invariant is that NO verdict about
    // packages/bar may be built out of packages/foo's code.
    //
    // The verdict here is NOT_AFFECTED, and that is correct. It is not an
    // answer borrowed from packages/foo -- it is a family-B proof about
    // packages/bar's OWN absence: with `linkFooTo: "foo"`, node_modules/foo
    // points at packages/foo, nothing resolves to packages/bar, and
    // packages/bar is therefore absent from both the call graph and a
    // complete module-load closure. Confirmed against the real runtime:
    // executing the consumer never loads packages/bar at all (it crashes
    // reaching for `vulnerable` on packages/foo, which publishes only
    // `safe`). The evidence assertion below is what actually pins the
    // invariant, and it still holds -- the proof's path is empty, so no
    // packages/foo file appears in it.
    //
    // This assertion previously read `.not.toBe("NOT_AFFECTED")`, and held
    // only because this suite passed NO ModuleLoadClosure while production
    // (cli/scan.ts) always builds one. `buildFindingForTest` now builds a
    // real closure by default (FOUNDATION-F2/F2-A), so the case finally
    // simulates the pipeline it is meant to describe. Verified to be
    // independent of F2-A's own change: with the production files reverted
    // to main and only the closure supplied, this case yields NOT_AFFECTED
    // identically -- the verdict moved because the TEST gained a closure,
    // not because the guard changed.
    const repo = buildRepo({ declareWorkspaces: true, linkFooTo: "foo" });
    const { finding, evidence } = await scan(repo, repo.barRoot);

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedAbsentInstance?.packageInstance).toBe(
      repo.barRoot,
    );
    expect(evidence.some((file) => file.startsWith("packages/foo"))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Controls: the fix must not suppress sound answers.
// ---------------------------------------------------------------------------

describe("Site B target authority: sound answers are preserved", () => {
  it("still reports AFFECTED when the finding's OWN package really publishes and runs it", async () => {
    const repo = buildRepo({
      declareWorkspaces: true,
      linkFooTo: "foo",
      fooVulnerable: true,
    });
    expect(runtimeResult(repo)).toBe("foo:X");

    const { finding, evidence } = await scan(repo, repo.fooRoot);
    expect(finding?.verdict).toBe("AFFECTED");
    expect(evidence.some((file) => file.startsWith("packages/foo"))).toBe(true);
  });

  it("still reports AFFECTED through FORWARDING from the finding's own package", async () => {
    const repo = buildRepo({
      declareWorkspaces: true,
      linkFooTo: "foo",
      fooForwards: true,
    });
    expect(runtimeResult(repo)).toBe("foo-impl:X");

    const { finding, evidence } = await scan(repo, repo.fooRoot);
    expect(finding?.verdict).toBe("AFFECTED");
    expect(evidence.at(-1)).toContain(path.join("packages", "foo", "impl.js"));
  });

  it("still reports NOT_AFFECTED when the finding's own package is loaded but unused", async () => {
    const repo = buildRepo({
      declareWorkspaces: true,
      linkFooTo: "foo",
      fooVulnerable: true,
      unreachable: true,
    });

    const { finding } = await scan(repo, repo.fooRoot);
    expect(finding?.verdict).toBe("NOT_AFFECTED");
  });

  it("still reports NOT_AFFECTED for a package nothing imports at all", async () => {
    // The most common source of correct negatives, and the one Site B's
    // phantom exists for. The advisory's package resolves, belongs to the
    // finding's own instance, and no file of it is in the graph.
    const repo = buildRepo({
      declareWorkspaces: true,
      linkFooTo: "foo",
      fooVulnerable: true,
    });
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
    const entry = path.join(repo.root, ...repo.consumer.split("/"));
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

// ---------------------------------------------------------------------------
// The invariant, stated directly.
// ---------------------------------------------------------------------------

describe("AFFECTED contract: evidence must belong to the finding's instance", () => {
  it.each([
    ["wrong package, identity unavailable", { declareWorkspaces: false }],
    ["wrong package, identity available", { declareWorkspaces: true }],
    [
      "wrong package impersonating the advisory",
      { declareWorkspaces: true, barImpersonatesFoo: true },
    ],
  ])(
    "every AFFECTED evidence file belongs to the finding's PackageInstance — %s",
    async (_label, options) => {
      const repo = buildRepo({ ...options, linkFooTo: "bar" } as RepoOptions);
      const { finding, evidence, knownPackageRoots } = await scan(
        repo,
        repo.fooRoot,
      );

      if (finding?.verdict !== "AFFECTED") {
        return; // Refusing is always permitted; binding wrongly is not.
      }
      const findingInstance = canonicalizePackageInstancePath(repo.fooRoot);
      for (const file of evidence) {
        const absolute = path.join(repo.root, ...file.split("/"));
        const identity = identifyModule(absolute, knownPackageRoots);
        // Entrypoint/application files carry no package instance; any file
        // that DOES belong to a package must belong to this finding's.
        if (identity.packageInstance !== undefined) {
          expect(identity.packageInstance).toBe(findingInstance);
        }
      }
    },
  );
});
