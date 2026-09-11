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
import { discoverEntrypoints } from "./entrypoints.js";
import { buildFindingForTest } from "../testing/finding.js";

/**
 * RWF-027's permanent end-to-end regression (see
 * fixtures/commonjs-circular-import-multipath-class-heritage-ground-truth/README.md
 * for the real-Node, ASSERTED runtime proof that BOTH endings of the same
 * factory abort the class definition, that a cyclic `require()` really does
 * retain the earlier dangerous export, and that the multi-path NEGATIVE
 * controls genuinely do bind their classes).
 *
 * The fixture's `fixture-lib/index.js` is RWF-022's fixture with exactly one
 * thing changed: the heritage callee now has TWO endings instead of one.
 *
 * ```js
 * function maybe(flag) {
 *   if (flag) { throw new Error("boom"); }
 *   return 1;
 * }
 * class Mode extends maybe(FLAG) {}
 * ```
 *
 * Neither existing rule can say anything about it. RWF-020 asks whether the
 * heritage CALL completes -- on the falsy path it does, so
 * `cannotCompleteNormally` refuses. RWF-022 asks what the returned VALUE is
 * -- the body is not a single unconditional return, so
 * `classifyExactCallReturnValue` is `"unknown"`. Before RWF-027 nothing
 * fired: the whole exported value bound to `safeOp`, the entrypoint's
 * `fixture(input)` call got a fully RESOLVED edge to it, `dangerousOp` was
 * left with no incoming edge at all, and the reachability search over
 * `danger.explode` came back unreachable with a COMPLETE subgraph -- a
 * Family C proof, and a false NOT_AFFECTED, for a package that reaches the
 * sink on every load taking the early branch.
 *
 * Post-fix the whole-module export is ambiguous, nothing attributes it, and
 * the call becomes an honest `unknown(unresolved_target)` edge -- UNKNOWN.
 *
 * Three modules carry the defect, through three different path shapes:
 *
 * - `index.js` -- THROW + invalid return (the two fatality reasons COMPOSED,
 *   which is the whole point: neither reason alone covers the path set);
 * - `two-bad.js` -- invalid + invalid, with no throwing path at all;
 * - `fallthrough.js` -- one written `return 1` and one IMPLICIT `undefined`,
 *   pinning that the unwritten ending is treated as a real path.
 *
 * `valid-multipath.js` is the control that makes this sound rather than
 * merely aggressive: seven factories that ALSO have several endings, each
 * keeping one that leaves the class definition able to complete.
 */

const FIXTURE = "commonjs-multipath-class-definition-completion";
const HERITAGE_ENTRYPOINT = "src/index.cjs";
/** Reaches only the definitely-reached whole-module export — see the fixture. */
const STABLE_ENTRYPOINT = "src/stable-only.cjs";
/** Reaches only the multi-path control, for the same subgraph-completeness reason. */
const VALID_ENTRYPOINT = "src/valid-only.cjs";

async function scan(options: {
  readonly module: string;
  readonly export: string;
  readonly packageInstance?: string;
  readonly entrypoint: string;
}) {
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
    id: "GHSA-rwf-027",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-027",
    package: { name: "fixture-lib" },
    targets: [
      { module: options.module, export: options.export, kind: "function" },
    ],
  };

  const finding = await buildFindingForTest({
    vulnerability,
    packageName: "fixture-lib",
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

describe("RWF-027 fixture: a heritage call whose EVERY ending prevents the class definition from completing (fixtures/commonjs-multipath-class-definition-completion)", () => {
  it("does not prove the bypassed vulnerable branch unreachable -> UNKNOWN", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: HERITAGE_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("issues no Family C negative proof for the branch that survived to the end of the file", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: HERITAGE_ENTRYPOINT,
    });

    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("attributes no definitive whole-module target to either branch (THROW + invalid return)", async () => {
    const { finding, graph } = await scan({
      module: "fixture-lib",
      export: "default",
      entrypoint: HERITAGE_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");

    const branchNodes = graph.nodes.filter(
      (n) =>
        (n.name === "dangerousOp" || n.name === "safeOp") &&
        n.module.endsWith(path.join("fixture-lib", "index.js")),
    );
    expect(branchNodes).toHaveLength(2);
    for (const node of branchNodes) {
      expect(finding?.evidence?.path ?? []).not.toContain(node.id);
    }
  });

  it("attributes no definitive whole-module target when BOTH endings return an invalid base and nothing throws", async () => {
    const { finding } = await scan({
      module: "fixture-lib/two-bad",
      export: "default",
      entrypoint: HERITAGE_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("attributes no definitive whole-module target when one ending is the IMPLICIT `undefined`", async () => {
    // The fatal ending here is never written. node raises
    // `TypeError: Class extends value undefined is not a constructor or null`
    // on the falsy path.
    const { finding } = await scan({
      module: "fixture-lib/fallthrough",
      export: "default",
      entrypoint: HERITAGE_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("never substitutes a different PackageInstance for the ambiguous export", async () => {
    const { finding, root } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: HERITAGE_ENTRYPOINT,
      packageInstance: canonicalizePackageInstancePath(
        path.join(
          fixturePath(FIXTURE),
          "node_modules",
          "elsewhere",
          "node_modules",
          "fixture-lib",
        ),
      ),
    });

    expect(root).toBeTruthy();
    expect(finding?.verdict).not.toBe("AFFECTED");
    expect(finding?.evidence?.path ?? []).toHaveLength(0);
  });

  it("keeps the later export attributable when EVERY multi-path factory keeps a good ending (the control that makes this sound rather than merely aggressive)", async () => {
    // `fixture-lib/valid-multipath` holds `throwOrBase` (throw + a class),
    // `invalidOrBase` (1 + a class), `invalidOrNull` (1 + `null`, which
    // `extends` ACCEPTS), `throwOrNull`, `invalidOrUnknown` (one
    // unclassifiable ending), `nestedWithValidLeaf` (a constructable leaf two
    // levels down), `loopBodied` (unmodeled control flow) and an all-fatal
    // factory whose class is DEFERRED inside a never-called function.
    //
    // None of them ends module evaluation, so `module.exports = safeOp`
    // really is reached on every load -- measured in-process, and asserted in
    // the ground-truth fixture's `c.js`. Treating any of them as
    // definitely non-completing would withdraw authority from an export that
    // is genuinely reached: an overreach, not conservatism.
    //
    // **What this case does and does not detect.** It is scanned from
    // `valid-only.cjs`, which `require`s the module and never CALLS its
    // export, so the target is unreachable either way and this assertion is a
    // statement about VERDICT and NEGATIVE-PROOF behavior -- that a module
    // full of multi-path heritage factories still supports a complete Family
    // C proof. It is NOT sensitive to whether one individual factory's
    // authority was withdrawn: withdrawing it would leave this verdict
    // `NOT_AFFECTED` all the same.
    //
    // The per-factory overreach controls live one layer down, in
    // module-model.multipath-class-definition-completion.test.ts, where each
    // shape is asserted to refuse a cutoff on its own with no earlier cutoff
    // in the file to mask it. End-to-end fixtures prove verdict and proof
    // behavior; the focused module-model matrix proves the path-summary
    // overreach controls.
    const { finding } = await scan({
      module: "fixture-lib/valid-multipath",
      export: "default",
      entrypoint: VALID_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
      reachableSubgraphComplete: true,
      target: { module: "fixture-lib/valid-multipath", export: "default" },
    });
  });

  it("still proves a genuinely unreachable, DEFINITELY REACHED whole-module export -> NOT_AFFECTED (Family C control)", async () => {
    // The control must keep working, or this task would have bought its
    // soundness by disabling negative proofs rather than by narrowing them.
    const { finding } = await scan({
      module: "fixture-lib/stable",
      export: "default",
      entrypoint: STABLE_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
      reachableSubgraphComplete: true,
      target: { module: "fixture-lib/stable", export: "default" },
    });
  });
});
