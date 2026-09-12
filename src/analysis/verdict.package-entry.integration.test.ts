import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import { buildKnownPackageRoots } from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { fixturePath } from "../testing/fixtures.js";
import { buildFindingForTest } from "../testing/finding.js";
import { discoverEntrypoints } from "./entrypoints.js";

/**
 * P1-A3's permanent PACKAGE-ENTRY SEMANTICS matrix
 * (see fixtures/package-entry/README.md).
 *
 * The question this suite pins is *which public surface of which installed
 * instance* an advisory target is anchored at, across the package-entry
 * forms Node itself distinguishes: npm aliases, scoped packages,
 * `package.json` `exports` (string shorthand, `"."`, explicit subpaths,
 * conditional branches, wildcard patterns), subpath-only packages with no
 * `"."` at all, and plain `main`.
 *
 * It builds on, and never replaces, its two predecessors:
 *
 * - **P1-A1/RWF-029** (`verdict.target-side-reexport.integration.test.ts`)
 *   pins the forwarding RELATION — given a starting file and a name, which
 *   literal specifier does that value come from. P1-A3 re-uses it
 *   unchanged; the subpath-forwarding case below is that relation anchored
 *   at a subpath's own entry.
 * - **P1-A2/RWF-030** (`verdict.authoritative-public-entry.integration.test.ts`)
 *   pins that only a package's authoritative public entry may answer for
 *   it, never a same-named sibling. P1-A3 widens *what counts as* that
 *   entry without widening *how much* may answer: every case below that
 *   cannot establish a public surface refuses (UNKNOWN) rather than
 *   falling back to any file that happens to export the name.
 *
 * Every expectation here is derived from real Node semantics, asserted
 * independently by the fixture's own `verify.cjs` runtime oracle (executed
 * by this suite's last test), never from what the analyzer happens to say.
 */

const FIXTURE = "package-entry";

interface ScanOptions {
  readonly entrypoint: string;
  /** The advisory's package name — what selects installed instances. */
  readonly packageName: string;
  /**
   * The advisory target's module specifier. Defaults to `packageName`;
   * set it to a subpath (`"pkg/parse"`) to ask about that public surface.
   */
  readonly targetModule?: string;
  readonly target?: string;
  /** Install path relative to the fixture's `node_modules/`. */
  readonly packageInstance: string;
}

async function scan(options: ScanOptions) {
  const root = fixturePath(FIXTURE);
  const entry = path.join(root, ...options.entrypoint.split("/"));
  const resolver = createModuleResolver(loadTsProject(root));
  const knownPackageRoots = buildKnownPackageRoots([], root);

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
    id: "GHSA-p1-a3-package-entry",
    aliases: [],
    package: options.packageName,
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-p1-a3-package-entry",
    package: { name: options.packageName },
    targets: [{ module: targetModule, export: targetExport, kind: "function" }],
  };

  const finding = await buildFindingForTest({
    vulnerability,
    packageName: options.packageName,
    packageVersion: "1.0.0",
    packageInstance: path.join(
      root,
      "node_modules",
      ...options.packageInstance.split("/"),
    ),
    matchResult: "affected",
    rule,
    graph,
    entrypoints: entrypointsResult.entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
  });

  return { finding, graph, root };
}

type Finding = Awaited<ReturnType<typeof scan>>["finding"];

function evidencePath(finding: Finding): readonly string[] {
  return finding?.evidence?.path ?? [];
}

/** The resolved target: the last node of the reachable path. */
function resolvedTarget(finding: Finding): string {
  return evidencePath(finding).at(-1) ?? "";
}

function inPackage(...segments: string[]): string {
  return path.join("node_modules", ...segments);
}

/** Every file named anywhere in the evidence path. */
function pathMentions(finding: Finding, ...segments: string[]): boolean {
  const needle = inPackage(...segments);
  return evidencePath(finding).some((node) => node.includes(needle));
}

// ---------------------------------------------------------------------------
// C — exports "." and its authority over main.
// ---------------------------------------------------------------------------

describe('P1-A3 § C: exports "." has authority over main', () => {
  it("anchors the advisory at the exports entry, never at the superseded main", async () => {
    // Real Node: `require("expmain-lib")` IS modern.js. legacy.js is the
    // `main` field, superseded by `exports`, and unreachable through the
    // package name from any importer.
    const { finding } = await scan({
      entrypoint: "src/expmain-consumer.cjs",
      packageName: "expmain-lib",
      packageInstance: "expmain-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      inPackage("expmain-lib", "modern.js"),
    );
    expect(pathMentions(finding, "expmain-lib", "legacy.js")).toBe(false);
  });

  it("does NOT bind a reachable, dangerous, same-named superseded main", async () => {
    // THE P1-A3 false-AFFECTED case. The public `vulnerable` is modern.js's
    // safe callable and is never called; the superseded `main` file exports
    // the same literal name, is dangerous, and IS genuinely reached (the
    // public entry re-publishes it under a different public name).
    //
    // Before P1-A3 the authoritative-entry probe set included the
    // instance's absolute install PATH, and a path request never consults
    // `exports` in real Node — so legacy.js entered the entry union and
    // answered for the package. Anything but a negative here is that
    // defect.
    const { finding } = await scan({
      entrypoint: "src/expmainsafe-consumer.cjs",
      packageName: "expmainsafe-lib",
      packageInstance: "expmainsafe-lib",
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(pathMentions(finding, "expmainsafe-lib", "legacy.js")).toBe(false);
  });

  it("resolves the exports STRING shorthand, not the root index.js convention", async () => {
    const { finding } = await scan({
      entrypoint: "src/shorthand-consumer.cjs",
      packageName: "shorthand-lib",
      packageInstance: "shorthand-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join(inPackage("shorthand-lib"), "out", "index.js"),
    );
  });
});

// ---------------------------------------------------------------------------
// D — explicit exports subpaths.
// ---------------------------------------------------------------------------

describe("P1-A3 § D: explicit exports subpaths are distinct public surfaces", () => {
  it('anchors `pkg/parse#vulnerable` at exports["./parse"]', async () => {
    const { finding } = await scan({
      entrypoint: "src/subpath-consumer.cjs",
      packageName: "subpath-lib",
      targetModule: "subpath-lib/parse",
      packageInstance: "subpath-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join(inPackage("subpath-lib"), "lib", "parse.js"),
    );
  });

  it('does NOT answer `pkg#vulnerable` from the "./parse" surface', async () => {
    // Same package, same literal export name, same scan — but the ROOT
    // surface publishes a different callable, and the consumer never calls
    // it. Resolving the root advisory from lib/parse.js would be a false
    // AFFECTED across public surfaces.
    const { finding } = await scan({
      entrypoint: "src/subpath-consumer.cjs",
      packageName: "subpath-lib",
      packageInstance: "subpath-lib",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
    expect(pathMentions(finding, "subpath-lib", "lib", "parse.js")).toBe(false);
  });

  it("resolves a scoped package's subpath surface", async () => {
    const { finding } = await scan({
      entrypoint: "src/scope-api-consumer.cjs",
      packageName: "@scope/pkg",
      targetModule: "@scope/pkg/api",
      packageInstance: "@scope/pkg",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join(inPackage("@scope", "pkg"), "out", "api.js"),
    );
  });
});

// ---------------------------------------------------------------------------
// Subpath authority -> P1-A1 forwarding -> implementation.
// ---------------------------------------------------------------------------

describe("P1-A3: subpath authority reuses P1-A1 forwarding", () => {
  it("follows explicit forwarding from a SUBPATH entry to the implementation", async () => {
    const { finding } = await scan({
      entrypoint: "src/subpathfwd-consumer.cjs",
      packageName: "subpathfwd-lib",
      targetModule: "subpathfwd-lib/api",
      packageInstance: "subpathfwd-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join(inPackage("subpathfwd-lib"), "out", "impl.js"),
    );
  });

  it("does not let the subpath's implementation answer for the ROOT surface", async () => {
    const { finding } = await scan({
      entrypoint: "src/subpathfwd-consumer.cjs",
      packageName: "subpathfwd-lib",
      packageInstance: "subpathfwd-lib",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
  });

  it("follows forwarding that RENAMES the public name to an internal one", async () => {
    const { finding } = await scan({
      entrypoint: "src/renamed-consumer.cjs",
      packageName: "renamed-lib",
      packageInstance: "renamed-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      inPackage("renamed-lib", "impl.js"),
    );
  });
});

// ---------------------------------------------------------------------------
// F — subpath-only packages: no "." must never be invented.
// ---------------------------------------------------------------------------

describe("P1-A3 § F: a subpath-only package has no package-root surface", () => {
  it('refuses a package-ROOT advisory when no "." entry exists', async () => {
    // Real Node: `require("subpathonly-lib")` throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED. There is no "." to anchor at, and an
    // arbitrary subpath must never be promoted into one.
    const { finding } = await scan({
      entrypoint: "src/subpathonly-consumer.cjs",
      packageName: "subpathonly-lib",
      packageInstance: "subpathonly-lib",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("resolves an explicitly targeted subpath of that same package", async () => {
    const { finding } = await scan({
      entrypoint: "src/subpathonly-consumer.cjs",
      packageName: "subpathonly-lib",
      targetModule: "subpathonly-lib/get",
      packageInstance: "subpathonly-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      inPackage("subpathonly-lib", "get.js"),
    );
  });

  it("refuses a subpath the package does not export, even though it exists", async () => {
    const { finding } = await scan({
      entrypoint: "src/subpathonly-consumer.cjs",
      packageName: "subpathonly-lib",
      targetModule: "subpathonly-lib/missing",
      packageInstance: "subpathonly-lib",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// E — conditional exports.
// ---------------------------------------------------------------------------

describe("P1-A3 § E: conditional exports follow the consumer's own context", () => {
  it("resolves the `require` branch for a CommonJS consumer", async () => {
    const { finding } = await scan({
      entrypoint: "src/cond-cjs-consumer.cjs",
      packageName: "cond-lib",
      packageInstance: "cond-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(inPackage("cond-lib", "cjs.cjs"));
  });

  it("resolves the `import` branch for an ESM consumer", async () => {
    const { finding } = await scan({
      entrypoint: "src/cond-esm-consumer.mjs",
      packageName: "cond-lib",
      packageInstance: "cond-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(inPackage("cond-lib", "esm.mjs"));
  });

  it("never manufactures a positive from the INACTIVE condition", async () => {
    // condsafe-lib's `require` branch (what a CommonJS consumer really
    // loads) is safe and uncalled; its `import` branch is dangerous. The
    // entry union may carry the ESM candidate, but it can only contribute a
    // target when the call graph holds a real node for that file — and
    // nothing ever loads it. That invariant is what makes the union safe.
    const { finding } = await scan({
      entrypoint: "src/condsafe-consumer.cjs",
      packageName: "condsafe-lib",
      packageInstance: "condsafe-lib",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
    expect(pathMentions(finding, "condsafe-lib", "esm.mjs")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wildcard subpaths — consumed from the resolver, never re-implemented.
// ---------------------------------------------------------------------------

describe("P1-A3: wildcard subpaths", () => {
  it("resolves a pattern subpath the real resolver itself supports", async () => {
    const { finding } = await scan({
      entrypoint: "src/wildcard-consumer.cjs",
      packageName: "wildcard-lib",
      targetModule: "wildcard-lib/features/alpha",
      packageInstance: "wildcard-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join(inPackage("wildcard-lib"), "src", "features", "alpha.js"),
    );
  });

  it("refuses a pattern subpath with no matching file", async () => {
    const { finding } = await scan({
      entrypoint: "src/wildcard-consumer.cjs",
      packageName: "wildcard-lib",
      targetModule: "wildcard-lib/features/missing",
      packageInstance: "wildcard-lib",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("refuses the package ROOT of a pattern-only exports map", async () => {
    const { finding } = await scan({
      entrypoint: "src/wildcard-consumer.cjs",
      packageName: "wildcard-lib",
      packageInstance: "wildcard-lib",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// B — scoped packages.
// ---------------------------------------------------------------------------

describe("P1-A3 § B: scoped packages", () => {
  it("resolves the scoped package ROOT at node_modules/@scope/pkg", async () => {
    const { finding } = await scan({
      entrypoint: "src/scope-consumer.cjs",
      packageName: "@scope/pkg",
      packageInstance: "@scope/pkg",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join(inPackage("@scope", "pkg"), "out", "index.js"),
    );
  });

  it("keeps a same-basename package under a DIFFERENT scope distinct", async () => {
    // @other/pkg is loaded by the same entrypoint and exports the same
    // literal name, but its callable is never called. Splitting the
    // specifier at "@other" instead of "@other/pkg" would make the scope
    // DIRECTORY look like a package root and collapse the two.
    const { finding } = await scan({
      entrypoint: "src/scope-consumer.cjs",
      packageName: "@other/pkg",
      packageInstance: "@other/pkg",
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(pathMentions(finding, "@scope", "pkg")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A — npm aliases, and the alias/real twin.
// ---------------------------------------------------------------------------

describe("P1-A3 § A: npm alias installs keep an exact PackageInstance", () => {
  it("resolves the ALIAS instance's own public entry", async () => {
    // node_modules/twin-alias and node_modules/twin-lib both declare
    // `"name": "twin-lib"` at the same version. Only the alias instance's
    // public `vulnerable` is called.
    const { finding } = await scan({
      entrypoint: "src/twin-consumer.cjs",
      packageName: "twin-lib",
      packageInstance: "twin-alias",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      inPackage("twin-alias", "index.js"),
    );
    expect(pathMentions(finding, "twin-lib", "index.js")).toBe(false);
  });

  it("does not let the alias instance answer for the REAL install", async () => {
    const { finding } = await scan({
      entrypoint: "src/twin-consumer.cjs",
      packageName: "twin-lib",
      packageInstance: "twin-lib",
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(pathMentions(finding, "twin-alias")).toBe(false);
  });

  it("keeps the twins distinct on a SUBPATH surface too", async () => {
    const affected = await scan({
      entrypoint: "src/twin-api-consumer.cjs",
      packageName: "twin-lib",
      targetModule: "twin-lib/api",
      packageInstance: "twin-alias",
    });
    expect(affected.finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(affected.finding)).toContain(
      inPackage("twin-alias", "api.js"),
    );

    const notAffected = await scan({
      entrypoint: "src/twin-api-consumer.cjs",
      packageName: "twin-lib",
      targetModule: "twin-lib/api",
      packageInstance: "twin-lib",
    });
    expect(notAffected.finding?.verdict).toBe("NOT_AFFECTED");
    expect(pathMentions(notAffected.finding, "twin-alias")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Exports encapsulation.
// ---------------------------------------------------------------------------

describe("P1-A3: exports encapsulation is not bypassed", () => {
  it("refuses an UNEXPORTED internal file even though it is reachable", async () => {
    // encap-lib's internal lib/vulnerable.js exports the advisory's literal
    // name, is loaded, and is genuinely called — through the public entry's
    // own `safeName`. It is not importable as `encap-lib/lib/vulnerable`
    // under real Node, so it is not a public surface of this package.
    const { finding } = await scan({
      entrypoint: "src/encap-consumer.cjs",
      packageName: "encap-lib",
      targetModule: "encap-lib/lib/vulnerable",
      packageInstance: "encap-lib",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("refuses the package ROOT advisory when the entry publishes no such name", async () => {
    const { finding } = await scan({
      entrypoint: "src/encap-consumer.cjs",
      packageName: "encap-lib",
      packageInstance: "encap-lib",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(pathMentions(finding, "encap-lib", "lib", "vulnerable.js")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// main-only fallback, invalid targets, root escape.
// ---------------------------------------------------------------------------

describe("P1-A3: main-only, invalid and escaping entries", () => {
  it("keeps `main` authoritative for a package with no exports", async () => {
    const { finding } = await scan({
      entrypoint: "src/mainonly-consumer.cjs",
      packageName: "mainonly-lib",
      packageInstance: "mainonly-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join(inPackage("mainonly-lib"), "lib", "index.js"),
    );
    // The root index.js sibling that `main` points away from must not
    // answer, even though it exports the same literal name.
    expect(evidencePath(finding).at(-1)).not.toContain(
      path.join(inPackage("mainonly-lib"), "index.js"),
    );
  });

  it("refuses an exports target that points at a file that is not there", async () => {
    // badexports-lib's only real file exports the advisory's literal name
    // and IS reachable (the consumer reaches it by relative path, which
    // real Node allows). The package's own public entry is unresolvable, so
    // UNKNOWN is the sound answer — never the sibling.
    const { finding } = await scan({
      entrypoint: "src/badexports-consumer.cjs",
      packageName: "badexports-lib",
      packageInstance: "badexports-lib",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("refuses an exports target that escapes the package root", async () => {
    const { finding } = await scan({
      entrypoint: "src/mainonly-consumer.cjs",
      packageName: "escape-lib",
      packageInstance: "escape-lib",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// The unreachable control: new entry support must not force positives.
// ---------------------------------------------------------------------------

describe("P1-A3: an exactly-resolved target that is simply not called", () => {
  it("reports NOT_AFFECTED with a valid proof, not AFFECTED", async () => {
    const { finding } = await scan({
      entrypoint: "src/unreach-consumer.cjs",
      packageName: "unreach-lib",
      packageInstance: "unreach-lib",
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    // A valid family-C negative proof, naming the exact target it is about
    // -- not a bare "we found nothing".
    const proof = finding?.evidence?.confirmedUnreachableTarget;
    expect(proof).toBeDefined();
    expect(proof?.target).toEqual({
      module: "unreach-lib",
      export: "vulnerable",
    });
    expect(proof?.reachableSubgraphComplete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ground truth.
// ---------------------------------------------------------------------------

describe("P1-A3: real Node ground truth", () => {
  it("the fixture's runtime oracle agrees with every expectation above", () => {
    const root = fixturePath(FIXTURE);
    const stdout = execFileSync(
      process.execPath,
      [path.join(root, "verify.cjs")],
      { encoding: "utf-8" },
    );

    expect(stdout).toContain("checks OK");
    expect(stdout).toContain("24 checks OK");
    expect(stdout).toContain("has authority over");
    expect(stdout).toContain("an absolute PATH request bypasses exports");
    expect(stdout).toContain("the package ROOT is not importable");
    expect(stdout).toContain("same manifest name, DISTINCT instances");
    expect(stdout).toContain("an UNEXPORTED internal file is not importable");
    expect(stdout).toContain("public `vulnerable` is SAFE and never called");
  });
});
