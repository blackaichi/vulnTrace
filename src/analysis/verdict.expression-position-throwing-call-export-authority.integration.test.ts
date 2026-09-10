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
 * RWF-026's permanent end-to-end regression (see
 * fixtures/commonjs-circular-import-expression-position-throw-ground-truth/README.md
 * for the real-Node runtime proof that a cyclic `require()` really can
 * retain the earlier, dangerous export these fixtures' `bail()` calls
 * bypass -- and, in the same process, that the CONDITIONAL and DEFERRED
 * controls genuinely do NOT bypass it).
 *
 * `fixture-lib/index.js` is RWF-016 through RWF-024's fixture family with
 * the call moved into a position none of them models, and -- decisively --
 * into no privileged syntactic slot at all. It is an ordinary call
 * ARGUMENT:
 *
 * ```js
 * sink(before(), bail(), after());
 * ```
 *
 * Arguments are evaluated, left to right, into an argument list BEFORE the
 * callee is entered, so reaching that statement necessarily invokes
 * `bail()` and the statement never completes. `object-value.js` carries
 * the same defect as an object literal's property VALUE (a safe computed
 * KEY, so RWF-024's rule provably never fires), and `header.js` as an `if`
 * statement's CONDITION.
 *
 * Before RWF-026 all three files' whole exported value bound to `safeOp`,
 * the entrypoint's `fixture(input)` call got a fully RESOLVED edge to it,
 * `dangerousOp` was left with no incoming edge at all, and the
 * reachability search over `danger.explode` came back unreachable with a
 * complete subgraph -- a Family C proof, and a false NOT_AFFECTED, for a
 * package that reaches the sink on every load that takes the early branch.
 *
 * Post-fix the whole-module export is ambiguous, nothing attributes it,
 * and the call becomes an honest `unknown(unresolved_target)` edge -- so
 * the answer is UNKNOWN, with no Family C evidence attached.
 */

const FIXTURE = "commonjs-expression-position-throwing-call-export-authority";
const REQUIRED_ENTRYPOINT = "src/index.cjs";
/** Reaches only the definitely-reached whole-module export — see the fixture's README. */
const STABLE_ENTRYPOINT = "src/stable-only.cjs";
/** Reaches only the CONDITIONAL/DEFERRED control, for the same subgraph-completeness reason. */
const CONDITIONAL_ENTRYPOINT = "src/conditional-only.cjs";

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
    id: "GHSA-rwf-026",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-026",
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

describe("RWF-026 fixture: a resolvable local throwing call in a REQUIRED expression position bypassing the final whole-module export", () => {
  it("does not prove the bypassed vulnerable branch unreachable -> UNKNOWN", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: REQUIRED_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("issues no Family C negative proof for the branch that survived to the end of the file", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: REQUIRED_ENTRYPOINT,
    });

    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("attributes no definitive whole-module target to either branch (call ARGUMENT)", async () => {
    const { finding, graph } = await scan({
      module: "fixture-lib",
      export: "default",
      entrypoint: REQUIRED_ENTRYPOINT,
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

  it("attributes no definitive whole-module target for an object literal's property VALUE", async () => {
    // The computed KEY here is `safeKey()`, so RWF-024's rule provably
    // never fires: this withdrawal is RWF-026's alone.
    const { finding } = await scan({
      module: "fixture-lib/object-value",
      export: "default",
      entrypoint: REQUIRED_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("attributes no definitive whole-module target for an `if` statement's CONDITION", async () => {
    const { finding } = await scan({
      module: "fixture-lib/header",
      export: "default",
      entrypoint: REQUIRED_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("never substitutes a different PackageInstance for the ambiguous export", async () => {
    const { finding, root } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: REQUIRED_ENTRYPOINT,
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

  it("keeps the same-name, same-version TWIN install a distinct instance", async () => {
    // Both installs declare `fixture-lib@1.0.0`; only their locations
    // differ, and only one of them carries the defect. A model that
    // collapsed identity by name+version would let the twin's harmless,
    // unconditional export answer for the vulnerable instance.
    const { graph } = await scan({
      module: "fixture-lib",
      export: "default",
      entrypoint: REQUIRED_ENTRYPOINT,
    });

    const vulnerableInstance = graph.nodes.filter(
      (n) =>
        n.module.endsWith(
          path.join("node_modules", "fixture-lib", "index.js"),
        ) && !n.module.includes(path.join("elsewhere", "node_modules")),
    );
    const twinInstance = graph.nodes.filter((n) =>
      n.module.includes(path.join("elsewhere", "node_modules", "fixture-lib")),
    );

    expect(vulnerableInstance.length).toBeGreaterThan(0);
    expect(twinInstance.length).toBeGreaterThan(0);
    for (const node of twinInstance) {
      expect(vulnerableInstance.map((n) => n.id)).not.toContain(node.id);
    }
  });

  it("keeps the later export attributable when the call sits in CONDITIONAL / DEFERRED positions (the control that makes this sound rather than merely conservative)", async () => {
    // `fixture-lib/conditional` holds the identical call in a logical
    // RIGHT operand, an arrow body, a default parameter and a class
    // INSTANCE field. None runs during module evaluation, so
    // `module.exports = safeOp` really is reached on every load -- proven
    // in-process in the ground-truth fixture's `c.js`. Treating any of
    // them like a required position would withdraw authority from an
    // export that is genuinely reached, which is a false refusal rather
    // than conservatism.
    const { finding } = await scan({
      module: "fixture-lib/conditional",
      export: "default",
      entrypoint: CONDITIONAL_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
      reachableSubgraphComplete: true,
      target: { module: "fixture-lib/conditional", export: "default" },
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
