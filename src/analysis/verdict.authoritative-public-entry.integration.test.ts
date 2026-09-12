import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import { buildKnownPackageRoots } from "../domain/resolved-target.js";
import type { CallGraph } from "../domain/graph.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { fixturePath } from "../testing/fixtures.js";
import { buildFindingForTest } from "../testing/finding.js";
import { discoverEntrypoints } from "./entrypoints.js";

/**
 * P1-A2's permanent AUTHORITATIVE PUBLIC ENTRY matrix
 * (see fixtures/authoritative-public-entry/README.md).
 *
 * The question this suite pins is *which file is allowed to answer for a
 * package*. Before P1-A2, target attribution asked every file of the
 * installed instance independently whether it exported the advisory's
 * literal name, so an unrelated sibling could answer for the package —
 * producing false AFFECTED when the sibling was dangerous and reachable,
 * and false NOT_AFFECTED when a sibling shadowed the genuinely-reached
 * public implementation.
 *
 * Deliberately separate from P1-A1's own suite
 * (verdict.target-side-reexport.integration.test.ts), which pins the
 * forwarding RELATION: given a starting file and a name, which literal
 * specifier does that value come from. P1-A2 reuses that relation
 * unchanged and changes only WHERE it starts. The two are complementary,
 * and confounding them is exactly how a sibling scan survives a
 * forwarding fix.
 *
 * Every expectation here is derived from real Node semantics, asserted
 * independently by the fixture's own `verify.cjs` runtime oracle (executed
 * by this suite's last test), never from what the analyzer happens to say.
 */

const FIXTURE = "authoritative-public-entry";

interface ScanOptions {
  readonly entrypoint: string;
  readonly packageName: string;
  readonly target?: string;
  /** Install path relative to the fixture's `node_modules/`. */
  readonly packageInstance: string;
  /**
   * Rewrites the built call graph before the finding is built — used only
   * by the file-order independence controls, which must prove the answer
   * cannot depend on node enumeration order.
   */
  readonly rewriteGraph?: (graph: CallGraph) => CallGraph;
}

async function scan(options: ScanOptions) {
  const root = fixturePath(FIXTURE);
  const entry = path.join(root, ...options.entrypoint.split("/"));
  const resolver = createModuleResolver(loadTsProject(root));
  const knownPackageRoots = buildKnownPackageRoots([], root);

  const [builtGraph, entrypointsResult] = await Promise.all([
    buildCallGraph({ entryFiles: [entry], resolver, knownPackageRoots }),
    discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: [options.entrypoint],
    }),
  ]);

  const graph = options.rewriteGraph
    ? options.rewriteGraph(builtGraph)
    : builtGraph;

  const targetExport = options.target ?? "vulnerable";
  const vulnerability: Vulnerability = {
    id: "GHSA-p1-a2-authoritative-entry",
    aliases: [],
    package: options.packageName,
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-p1-a2-authoritative-entry",
    package: { name: options.packageName },
    targets: [
      { module: options.packageName, export: targetExport, kind: "function" },
    ],
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

/** The evidence path, or `[]` — the concrete reachable path an AFFECTED must carry. */
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
// THE canonical RWF-030 case.
// ---------------------------------------------------------------------------

describe("P1-A2: the canonical false AFFECTED (public safe, sibling vulnerable)", () => {
  it("binds the advisory to the PUBLIC `vulnerable`, never the same-named sibling", async () => {
    const { finding } = await scan({
      entrypoint: "src/publicsafe-consumer.cjs",
      packageName: "publicsafe-lib",
      packageInstance: "publicsafe-lib",
    });

    // Under real Node `pkg.vulnerable` IS impl.js's safeImpl, and the
    // consumer never calls it. Anything but a negative here is the false
    // AFFECTED this task removes.
    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(pathMentions(finding, "publicsafe-lib", "other.js")).toBe(false);
  });

  it("never reports AFFECTED through the dangerous sibling even though it IS executed", async () => {
    // The sibling callable genuinely runs at runtime — but as
    // `pkg.runOther`, which is not the advisory's symbol. Package
    // membership plus a matching export name is not target identity.
    const { finding } = await scan({
      entrypoint: "src/publicsafe-consumer.cjs",
      packageName: "publicsafe-lib",
      packageInstance: "publicsafe-lib",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
  });
});

describe("P1-A2: the sibling IS bindable, under its REAL public name", () => {
  it("resolves `runOther` to the very file that must never answer for `vulnerable`", async () => {
    // The complement that proves this is target IDENTITY, not a blunt
    // filter on sibling files. other.js's callable genuinely is what the
    // package publishes as `runOther`, so an advisory naming THAT symbol
    // must bind there and report AFFECTED -- the same file the
    // `vulnerable` advisory is refused.
    const { finding } = await scan({
      entrypoint: "src/publicsafe-consumer.cjs",
      packageName: "publicsafe-lib",
      target: "runOther",
      packageInstance: "publicsafe-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      inPackage("publicsafe-lib", "other.js"),
    );
  });
});

// ---------------------------------------------------------------------------
// Positive controls: the public entry really does publish the target.
// ---------------------------------------------------------------------------

describe("P1-A2: direct public export (no precision regression)", () => {
  it("resolves a target declared and exported by the public entry itself", async () => {
    const { finding } = await scan({
      entrypoint: "src/directpub-consumer.cjs",
      packageName: "directpub-lib",
      packageInstance: "directpub-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      inPackage("directpub-lib", "index.js"),
    );
    expect(pathMentions(finding, "directpub-lib", "other.js")).toBe(false);
  });
});

describe("P1-A2: public entry vulnerable, same-named SAFE sibling", () => {
  it("does not let the safe sibling shadow the authoritative public export", async () => {
    const { finding } = await scan({
      entrypoint: "src/publicvuln-consumer.cjs",
      packageName: "publicvuln-lib",
      packageInstance: "publicvuln-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      inPackage("publicvuln-lib", "impl.js"),
    );
    expect(pathMentions(finding, "publicvuln-lib", "safe.js")).toBe(false);
  });
});

describe("P1-A2: renamed public export", () => {
  it("maps the public name onto the implementation's own internal name", async () => {
    // `exports.vulnerable = require("./impl").dangerousImpl` — the
    // advisory-facing and implementation-facing names differ, and the
    // mapping is carried by the hop, never guessed by name.
    const { finding } = await scan({
      entrypoint: "src/publicvuln-consumer.cjs",
      packageName: "publicvuln-lib",
      packageInstance: "publicvuln-lib",
    });

    expect(resolvedTarget(finding)).toContain(
      inPackage("publicvuln-lib", "impl.js"),
    );
  });

  it("resolves a public rename onto a target the consumer never calls -> negative, not the sibling", async () => {
    const { finding } = await scan({
      entrypoint: "src/renamesafe-consumer.cjs",
      packageName: "renamesafe-lib",
      packageInstance: "renamesafe-lib",
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(pathMentions(finding, "renamesafe-lib", "other.js")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The negative control: no public symbol at all.
// ---------------------------------------------------------------------------

describe("P1-A2: missing public symbol with a same-named sibling", () => {
  it("refuses to bind the sibling and degrades to UNKNOWN", async () => {
    const { finding } = await scan({
      entrypoint: "src/missing-consumer.cjs",
      packageName: "missing-lib",
      packageInstance: "missing-lib",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(evidencePath(finding)).toEqual([]);
  });

  it("says WHICH public entry was consulted, so the refusal is explainable", async () => {
    const { finding } = await scan({
      entrypoint: "src/missing-consumer.cjs",
      packageName: "missing-lib",
      packageInstance: "missing-lib",
    });

    const reasons = (finding?.evidence?.reasons ?? []).join("\n");
    expect(reasons).toContain("authoritative public entry");
    expect(reasons).toContain(inPackage("missing-lib", "index.js"));
  });
});

// ---------------------------------------------------------------------------
// Order independence.
// ---------------------------------------------------------------------------

describe("P1-A2: multiple same-named siblings and traversal order", () => {
  it("selects the public entry's forwarding target, never a sibling", async () => {
    const { finding } = await scan({
      entrypoint: "src/multisibling-consumer.cjs",
      packageName: "multisibling-lib",
      packageInstance: "multisibling-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      inPackage("multisibling-lib", "impl.js"),
    );
    for (const sibling of ["sibling-a.js", "sibling-b.js", "sibling-c.js"]) {
      expect(pathMentions(finding, "multisibling-lib", sibling)).toBe(false);
    }
  });

  it("returns the identical target with the graph's node order reversed", async () => {
    const forward = await scan({
      entrypoint: "src/multisibling-consumer.cjs",
      packageName: "multisibling-lib",
      packageInstance: "multisibling-lib",
    });
    const reversed = await scan({
      entrypoint: "src/multisibling-consumer.cjs",
      packageName: "multisibling-lib",
      packageInstance: "multisibling-lib",
      rewriteGraph: (graph) => ({
        nodes: [...graph.nodes].reverse(),
        edges: [...graph.edges].reverse(),
      }),
    });

    expect(reversed.finding?.verdict).toBe(forward.finding?.verdict);
    expect(resolvedTarget(reversed.finding)).toBe(
      resolvedTarget(forward.finding),
    );
  });

  it("returns the identical target with the graph's node order sorted by module", async () => {
    const forward = await scan({
      entrypoint: "src/multisibling-consumer.cjs",
      packageName: "multisibling-lib",
      packageInstance: "multisibling-lib",
    });
    const sorted = await scan({
      entrypoint: "src/multisibling-consumer.cjs",
      packageName: "multisibling-lib",
      packageInstance: "multisibling-lib",
      rewriteGraph: (graph) => ({
        nodes: [...graph.nodes].sort((a, b) =>
          a.module.localeCompare(b.module),
        ),
        edges: graph.edges,
      }),
    });

    expect(sorted.finding?.verdict).toBe(forward.finding?.verdict);
    expect(resolvedTarget(sorted.finding)).toBe(
      resolvedTarget(forward.finding),
    );
  });

  it("is order-independent for the canonical false-AFFECTED case too", async () => {
    const reversed = await scan({
      entrypoint: "src/publicsafe-consumer.cjs",
      packageName: "publicsafe-lib",
      packageInstance: "publicsafe-lib",
      rewriteGraph: (graph) => ({
        nodes: [...graph.nodes].reverse(),
        edges: [...graph.edges].reverse(),
      }),
    });

    expect(reversed.finding?.verdict).toBe("NOT_AFFECTED");
    expect(pathMentions(reversed.finding, "publicsafe-lib", "other.js")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Duplicate public writes: source order, both directions.
// ---------------------------------------------------------------------------

describe("P1-A2: duplicate writes to the same public name", () => {
  it("binds the LAST write, not the stale first one, and not the sibling", async () => {
    const { finding } = await scan({
      entrypoint: "src/dupwrite-consumer.cjs",
      packageName: "dupwrite-lib",
      packageInstance: "dupwrite-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      inPackage("dupwrite-lib", "safe.js"),
    );
    expect(pathMentions(finding, "dupwrite-lib", "dangerous.js")).toBe(false);
    expect(pathMentions(finding, "dupwrite-lib", "other.js")).toBe(false);
  });

  it("binds the LAST write in the reverse direction too", async () => {
    const { finding } = await scan({
      entrypoint: "src/dupreverse-consumer.cjs",
      packageName: "dupreverse-lib",
      packageInstance: "dupreverse-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      inPackage("dupreverse-lib", "dangerous.js"),
    );
    expect(pathMentions(finding, "dupreverse-lib", "safe.js")).toBe(false);
    expect(pathMentions(finding, "dupreverse-lib", "other.js")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed public surfaces.
// ---------------------------------------------------------------------------

describe("P1-A2: ambiguous public exports fail closed", () => {
  it("refuses a CONDITIONAL public export rather than recovering it from a sibling", async () => {
    const { finding } = await scan({
      entrypoint: "src/condpublic-consumer.cjs",
      packageName: "condpublic-lib",
      packageInstance: "condpublic-lib",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(evidencePath(finding)).toEqual([]);
  });

  it("refuses a DYNAMIC/computed public export name", async () => {
    const { finding } = await scan({
      entrypoint: "src/dynpublic-consumer.cjs",
      packageName: "dynpublic-lib",
      packageInstance: "dynpublic-lib",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(evidencePath(finding)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Package entry identity.
// ---------------------------------------------------------------------------

describe("P1-A2: the public entry comes from package metadata, not a filename", () => {
  it('honours "main": "lib/entry.js" and ignores the root index.js decoy', async () => {
    const { finding } = await scan({
      entrypoint: "src/mainfield-consumer.cjs",
      packageName: "mainfield-lib",
      packageInstance: "mainfield-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join("mainfield-lib", "lib", "impl.js"),
    );
    // The decoy is loaded, reachable, and exports the advisory's literal
    // name. Only its not being the package's entry keeps it out.
    expect(resolvedTarget(finding)).not.toContain(
      path.join("mainfield-lib", "index.js"),
    );
  });
});

// ---------------------------------------------------------------------------
// Boundaries this task deliberately does not cross.
// ---------------------------------------------------------------------------

describe("P1-A2: deep-import boundary", () => {
  it("does not reinterpret a public advisory as a deep-imported sibling", async () => {
    // The consumer deep-imports `deep-lib/deep` and calls its `vulnerable`.
    // The advisory names the PUBLIC `deep-lib#vulnerable`, which the
    // package's entry does not publish at all. Tying the two together is a
    // subpath-semantics question this task is scoped not to answer.
    const { finding } = await scan({
      entrypoint: "src/deep-consumer.cjs",
      packageName: "deep-lib",
      packageInstance: "deep-lib",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(evidencePath(finding)).toEqual([]);
  });
});

describe("P1-A2: cross-package boundary (P1-A1's rule, preserved)", () => {
  it("refuses a public entry that forwards the advisory's name into another package", async () => {
    const { finding } = await scan({
      entrypoint: "src/crosspub-consumer.cjs",
      packageName: "crosspub-lib",
      packageInstance: "crosspub-lib",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(evidencePath(finding)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PackageInstance exactness.
// ---------------------------------------------------------------------------

describe("P1-A2: PackageInstance twins are answered independently", () => {
  it("answers the TOP-LEVEL install from its own public entry", async () => {
    const { finding } = await scan({
      entrypoint: "src/twin-consumer.cjs",
      packageName: "twinpub-lib",
      packageInstance: "twinpub-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      inPackage("twinpub-lib", "impl.js"),
    );
    expect(resolvedTarget(finding)).not.toContain(
      path.join("wrap-lib", "node_modules"),
    );
  });

  it("answers the NESTED install from its own public entry", async () => {
    const { finding } = await scan({
      entrypoint: "src/twin-consumer.cjs",
      packageName: "twinpub-lib",
      packageInstance: "wrap-lib/node_modules/twinpub-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      path.join("wrap-lib", "node_modules", "twinpub-lib", "impl.js"),
    );
  });

  it("gives the two name- and version-identical twins different targets", async () => {
    const top = await scan({
      entrypoint: "src/twin-consumer.cjs",
      packageName: "twinpub-lib",
      packageInstance: "twinpub-lib",
    });
    const nested = await scan({
      entrypoint: "src/twin-consumer.cjs",
      packageName: "twinpub-lib",
      packageInstance: "wrap-lib/node_modules/twinpub-lib",
    });

    expect(resolvedTarget(top.finding)).not.toBe(
      resolvedTarget(nested.finding),
    );
  });
});

// ---------------------------------------------------------------------------
// Exact resolution must not force a positive.
// ---------------------------------------------------------------------------

describe("P1-A2: an exactly-resolved authoritative target can still be negative", () => {
  it("keeps a genuine negative proof when the public target is never called", async () => {
    const { finding } = await scan({
      entrypoint: "src/unreachvuln-consumer.cjs",
      packageName: "unreachvuln-lib",
      packageInstance: "unreachvuln-lib",
    });

    // Resolution succeeded exactly (otherwise this would be UNKNOWN, not
    // NOT_AFFECTED): the target is impl.js's dangerousImpl, and nothing
    // calls it.
    expect(finding?.verdict).toBe("NOT_AFFECTED");
  });
});

// ---------------------------------------------------------------------------
// ESM.
// ---------------------------------------------------------------------------

describe("P1-A2: ESM public entry", () => {
  it("resolves `export { internal as vulnerable } from` and ignores the same-named sibling", async () => {
    const { finding } = await scan({
      entrypoint: "src/esmpub-consumer.mjs",
      packageName: "esmpub-lib",
      packageInstance: "esmpub-lib",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(resolvedTarget(finding)).toContain(
      inPackage("esmpub-lib", "impl.js"),
    );
    expect(pathMentions(finding, "esmpub-lib", "other.js")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ground truth.
// ---------------------------------------------------------------------------

describe("P1-A2: real Node ground truth", () => {
  it("the fixture's runtime oracle agrees with every expectation above", () => {
    const root = fixturePath(FIXTURE);
    const stdout = execFileSync(
      process.execPath,
      [path.join(root, "verify.cjs")],
      { encoding: "utf-8" },
    );

    expect(stdout).toContain("checks OK");
    expect(stdout).toContain("public `vulnerable` IS impl.safeImpl");
    expect(stdout).toContain("the consumer never executes the public target");
    expect(stdout).toContain("the two installs publish different callables");
  });
});
