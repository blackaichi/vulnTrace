import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
} from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { fixturePath } from "../testing/fixtures.js";
import { buildFindingForTest } from "../testing/finding.js";
import { discoverEntrypoints } from "./entrypoints.js";

/**
 * P1-A1's permanent TARGET-SIDE re-export matrix
 * (see fixtures/target-side-reexport/README.md).
 *
 * The question this suite pins is *target identity*, not reachability:
 * "which concrete callable does an advisory naming `pkg#vulnerable`
 * actually describe, when the package publishes that name through one or
 * more forwarding layers?" Reachability is asserted only where it is the
 * observable consequence of getting identity right or wrong.
 *
 * Deliberately separate from RWF-004a/b's own suites
 * (verdict.commonjs-reexport.integration.test.ts,
 * verdict.cross-package-reexport.integration.test.ts), which pin the
 * CONSUMER-side chase: a call site following a value through a package's
 * re-exports. That relation already worked before P1-A1 — and it is
 * exactly why the two must not be confounded. `fixture-lib`'s chain
 * resolves there because some file in the package exports the advisory's
 * literal name (`exports.vulnerable = vulnerable` in lib.js), so
 * attribution finds it directly. RWB-05's `qs` does not: `lib/index.js`
 * forwards `parse` to `lib/parse.js`, which publishes it as an ANONYMOUS
 * whole-module default under the canonical name `"default"`. No file in
 * `qs` exports anything called `parse`, so no per-file attribution could
 * ever answer the advisory.
 *
 * Every expectation here is derived from real Node semantics, asserted
 * independently by the fixture's own `verify.cjs` runtime oracle (executed
 * by this suite's last test), never from what the analyzer happens to say.
 */

const FIXTURE = "target-side-reexport";

interface ScanOptions {
  readonly entrypoint: string;
  readonly packageName: string;
  readonly target: string;
  readonly packageInstance?: string;
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

  const vulnerability: Vulnerability = {
    id: "GHSA-p1-a1-target-side",
    aliases: [],
    package: options.packageName,
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-p1-a1-target-side",
    package: { name: options.packageName },
    targets: [
      {
        module: options.packageName,
        export: options.target,
        kind: "function",
      },
    ],
  };

  const finding = await buildFindingForTest({
    vulnerability,
    packageName: options.packageName,
    packageVersion: "1.0.0",
    packageInstance: options.packageInstance,
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

/** The evidence path, or `[]` — the concrete reachable path an AFFECTED must carry. */
function evidencePath(
  finding: Awaited<ReturnType<typeof scan>>["finding"],
): readonly string[] {
  return finding?.evidence?.path ?? [];
}

function inPackage(...segments: string[]): string {
  return path.join("node_modules", ...segments);
}

describe("P1-A1 target-side re-export: direct export control", () => {
  it("resolves and reaches a directly-declared, directly-exported target -> AFFECTED", async () => {
    const { finding } = await scan({
      entrypoint: "src/direct-reachable.cjs",
      packageName: "direct-lib",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(evidencePath(finding).at(-1) ?? "").toContain(
      inPackage("direct-lib", "index.js"),
    );
  });
});

describe("P1-A1 target-side re-export: one-hop forwarding (the RWB-05/qs shape)", () => {
  it("resolves the advisory name through one hop onto the ANONYMOUS sibling implementation -> AFFECTED", async () => {
    const { finding } = await scan({
      entrypoint: "src/onehop-reachable.cjs",
      packageName: "onehop-lib",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("AFFECTED");

    const last = evidencePath(finding).at(-1) ?? "";
    // The implementation, not the facade that merely advertises the name.
    expect(last).toContain(inPackage("onehop-lib", "impl.js"));
    expect(last).not.toContain(inPackage("onehop-lib", "index.js"));
    expect(last).not.toContain(inPackage("onehop-lib", "safe.js"));
  });

  it("carries a concrete, non-empty reachable path (never AFFECTED on identity alone)", async () => {
    const { finding } = await scan({
      entrypoint: "src/onehop-reachable.cjs",
      packageName: "onehop-lib",
      target: "vulnerable",
    });

    expect(evidencePath(finding).length).toBeGreaterThan(0);
  });

  it("resolves the SAME target exactly when it is never called, and does not force AFFECTED", async () => {
    // The RWB-05 shape proper: only the unrelated sibling export is called.
    // Exact target resolution must not, by itself, produce a positive
    // finding -- and must not be mistaken for one either.
    const { finding } = await scan({
      entrypoint: "src/onehop-unreachable.cjs",
      packageName: "onehop-lib",
      target: "vulnerable",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
    expect(evidencePath(finding)).toEqual([]);
  });

  it("reaches a NEGATIVE PROOF for the resolved-but-uncalled target -> NOT_AFFECTED", async () => {
    // Target resolution is a prerequisite for a negative proof, never a
    // substitute for one: this verdict rests on the existing family-C
    // exhaustive search, which only runs once the target's identity is
    // known. Before P1-A1 this case could not even be asked.
    const { finding } = await scan({
      entrypoint: "src/onehop-unreachable.cjs",
      packageName: "onehop-lib",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
  });
});

describe("P1-A1 target-side re-export: two-hop forwarding", () => {
  it("chases index -> api -> impl and binds the real implementation -> AFFECTED", async () => {
    const { finding } = await scan({
      entrypoint: "src/twohop-reachable.cjs",
      packageName: "twohop-lib",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("AFFECTED");

    const last = evidencePath(finding).at(-1) ?? "";
    expect(last).toContain(inPackage("twohop-lib", "impl.js"));
    expect(last).not.toContain(inPackage("twohop-lib", "api.js"));
    expect(last).not.toContain(inPackage("twohop-lib", "index.js"));
  });
});

describe("P1-A1 target-side re-export: renamed export and same-name decoy", () => {
  it("maps the advisory-facing name onto the implementation-facing one -> AFFECTED", async () => {
    const { finding } = await scan({
      entrypoint: "src/renamed-reachable.cjs",
      packageName: "renamed-lib",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(evidencePath(finding).at(-1) ?? "").toContain(
      inPackage("renamed-lib", "impl.js"),
    );
  });

  it("binds `internalName`, NOT the same-named decoy sitting in the very same file", async () => {
    // impl.js declares a function literally called `vulnerable` (exported
    // under a different name). A resolution that searched a file for a
    // same-named declaration would land there; an authoritative one
    // follows the rename the export binding actually proves.
    const { finding, graph } = await scan({
      entrypoint: "src/renamed-reachable.cjs",
      packageName: "renamed-lib",
      target: "vulnerable",
    });

    const decoy = graph.nodes.find(
      (n) => n.name === "vulnerable" && n.module.includes("renamed-lib"),
    );
    const internal = graph.nodes.find(
      (n) => n.name === "internalName" && n.module.includes("renamed-lib"),
    );
    expect(decoy).toBeDefined();
    expect(internal).toBeDefined();

    const last = evidencePath(finding).at(-1) ?? "";
    expect(last).toContain(`:${internal?.location?.line}`);
    expect(last).not.toContain(`:${decoy?.location?.line}`);
  });
});

describe("P1-A1 target-side re-export: local alias forwarding", () => {
  it("looks through a single-assignment local alias -> AFFECTED", async () => {
    const { finding } = await scan({
      entrypoint: "src/alias-reachable.cjs",
      packageName: "alias-lib",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(evidencePath(finding).at(-1) ?? "").toContain(
      inPackage("alias-lib", "impl.js"),
    );
  });
});

describe("P1-A1 target-side re-export: stale/ambiguous bindings fail closed", () => {
  it("refuses a REASSIGNED alias rather than binding its stale initializer -> UNKNOWN", async () => {
    const { finding } = await scan({
      entrypoint: "src/reassigned-reachable.cjs",
      packageName: "reassigned-lib",
      target: "vulnerable",
    });

    // Node publishes `harmless` here; `dangerous` is the stale binding.
    // Binding the advisory to `dangerous` would be a manufactured target,
    // and a NOT_AFFECTED would be a manufactured negative.
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(evidencePath(finding)).toEqual([]);
  });

  it("never binds the stale FIRST write of a duplicated export", async () => {
    const { finding, graph } = await scan({
      entrypoint: "src/duplicate-reachable.cjs",
      packageName: "duplicate-lib",
      target: "vulnerable",
    });

    const dangerous = graph.nodes.find(
      (n) => n.name === "dangerous" && n.module.includes("duplicate-lib"),
    );
    expect(dangerous).toBeDefined();

    for (const step of evidencePath(finding)) {
      expect(step).not.toContain(`:${dangerous?.location?.line}`);
    }
  });

  it("resolves a duplicated export to the LAST write, which is what Node publishes", async () => {
    const { finding, graph } = await scan({
      entrypoint: "src/duplicate-reachable.cjs",
      packageName: "duplicate-lib",
      target: "vulnerable",
    });

    const harmless = graph.nodes.find(
      (n) => n.name === "harmless" && n.module.includes("duplicate-lib"),
    );
    expect(harmless).toBeDefined();
    expect(finding?.verdict).toBe("AFFECTED");
    expect(evidencePath(finding).at(-1) ?? "").toContain(
      `:${harmless?.location?.line}`,
    );
  });
});

describe("P1-A1 target-side re-export: cycles terminate", () => {
  it("terminates on a forwarding cycle and refuses to pick a member -> UNKNOWN", async () => {
    // index -> a -> b -> a. Node publishes nothing at all here, so there is
    // no exact answer to find; the chase must stop on the repeated hop
    // rather than recurse or choose arbitrarily.
    const { finding } = await scan({
      entrypoint: "src/cycle-consumer.cjs",
      packageName: "cycle-lib",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(evidencePath(finding)).toEqual([]);
  });
});

describe("P1-A1 target-side re-export: unsupported forwarding degrades to UNKNOWN", () => {
  it("refuses a DYNAMIC (computed) forwarding specifier", async () => {
    const { finding } = await scan({
      entrypoint: "src/dynamic-consumer.cjs",
      packageName: "dynamic-lib",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("refuses a CONDITIONAL export write", async () => {
    const { finding } = await scan({
      entrypoint: "src/conditional-consumer.cjs",
      packageName: "conditional-lib",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });
});

describe("P1-A1 target-side re-export: package boundaries are not crossed", () => {
  it("refuses a RELATIVE hop that escapes the package root -> UNKNOWN", async () => {
    const { finding } = await scan({
      entrypoint: "src/boundary-consumer.cjs",
      packageName: "boundary-lib",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("never binds a boundary-lib advisory to outside-lib's implementation", async () => {
    const { finding } = await scan({
      entrypoint: "src/boundary-consumer.cjs",
      packageName: "boundary-lib",
      target: "vulnerable",
    });

    for (const step of evidencePath(finding)) {
      expect(step).not.toContain(inPackage("outside-lib"));
    }
  });

  it("refuses a CROSS-PACKAGE bare-specifier hop -> UNKNOWN (advisory ownership unchanged)", async () => {
    // The call graph deliberately follows this hop when chasing a VALUE
    // (RWF-004b). Re-pointing an ADVISORY at another package is a
    // different claim, and P1-A1 does not make it.
    const { finding } = await scan({
      entrypoint: "src/crosspkg-consumer.cjs",
      packageName: "crosspkg-lib",
      target: "vulnerable",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    for (const step of evidencePath(finding)) {
      expect(step).not.toContain(inPackage("outside-lib"));
    }
  });
});

describe("P1-A1 target-side re-export: PackageInstance exactness survives forwarding", () => {
  const nestedTwin = (root: string) =>
    canonicalizePackageInstancePath(
      path.join(
        root,
        "node_modules",
        "wrapper-lib",
        "node_modules",
        "twin-lib",
      ),
    );
  const topLevelTwin = (root: string) =>
    canonicalizePackageInstancePath(
      path.join(root, "node_modules", "twin-lib"),
    );

  it("resolves the forwarded target inside the NESTED instance that is actually reached -> AFFECTED", async () => {
    const root = fixturePath(FIXTURE);
    const { finding } = await scan({
      entrypoint: "src/twin-nested-consumer.cjs",
      packageName: "twin-lib",
      target: "vulnerable",
      packageInstance: nestedTwin(root),
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(evidencePath(finding).at(-1) ?? "").toContain(
      path.join("wrapper-lib", "node_modules", "twin-lib", "impl.js"),
    );
  });

  it("does not answer the TOP-LEVEL twin's finding with the nested instance's reachability", async () => {
    // Same name, same version, different install path. A forwarding chase
    // that resolved a package by name/version rather than by install path
    // would hand this instance the other one's answer.
    const root = fixturePath(FIXTURE);
    const { finding } = await scan({
      entrypoint: "src/twin-nested-consumer.cjs",
      packageName: "twin-lib",
      target: "vulnerable",
      packageInstance: topLevelTwin(root),
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
    for (const step of evidencePath(finding)) {
      expect(step).not.toContain(
        path.join("wrapper-lib", "node_modules", "twin-lib"),
      );
    }
  });
});

describe("P1-A1 target-side re-export: runtime oracle", () => {
  it("the fixture's real-Node ground truth holds", () => {
    // VulnTrace itself never executes target code. This runs the fixture's
    // oracle out-of-process, so every expectation above stays anchored to
    // what Node really does rather than to the analyzer's own opinion.
    const root = fixturePath(FIXTURE);
    const output = execFileSync(process.execPath, ["verify.cjs"], {
      cwd: root,
      encoding: "utf-8",
    });

    expect(output).toContain("runtime ground truth OK");
  });
});
