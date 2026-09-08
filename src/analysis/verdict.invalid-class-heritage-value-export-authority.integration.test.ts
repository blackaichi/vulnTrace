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
 * RWF-022's permanent end-to-end regression (see
 * fixtures/commonjs-circular-import-invalid-class-heritage-ground-truth/README.md
 * for the real-Node, ASSERTED runtime proof that a cyclic `require()` really
 * does retain the earlier, dangerous export this fixture's
 * `notAConstructor()` heritage bypasses -- and, in the same process, that
 * the VALID-heritage and DEFERRED controls genuinely do NOT bypass it).
 *
 * The fixture's `fixture-lib/index.js` is RWF-020's fixture with exactly one
 * thing changed: the heritage callee RETURNS instead of throwing.
 *
 * ```js
 * function notAConstructor() { return 1; }
 * class Mode extends notAConstructor() {}
 * ```
 *
 * RWF-020 asks whether the heritage CALL completes. Here it does -- so
 * before RWF-022 nothing fired, the whole exported value bound to `safeOp`,
 * the entrypoint's `fixture(input)` call got a fully RESOLVED edge to it,
 * `dangerousOp` was left with no incoming edge at all, and the reachability
 * search over `danger.explode` came back unreachable with a COMPLETE
 * subgraph -- a Family C proof, and a false NOT_AFFECTED, for a package that
 * reaches the sink on every load that takes the early branch.
 *
 * Post-fix the whole-module export is ambiguous, nothing attributes it, and
 * the call becomes an honest `unknown(unresolved_target)` edge -- UNKNOWN.
 *
 * Three modules carry the defect, deliberately through the classifier's
 * three different routes, so a regression in any one of them is visible:
 *
 * - `index.js` -- a `function` declaration returning a NUMERIC LITERAL;
 * - `class-expression.js` -- a `const` ARROW with a CONCISE body returning an
 *   OBJECT LITERAL, on an anonymous class expression with no binding, no
 *   name, no elements and no `static` token in the file;
 * - `async-callee.js` -- CALLEE IDENTITY alone: an `async` callee whose body
 *   returns a perfectly good class, wrapped in a Promise that is not a
 *   constructor.
 */

const FIXTURE = "commonjs-invalid-class-heritage-value-export-authority";
const HERITAGE_ENTRYPOINT = "src/index.cjs";
/** Reaches only the definitely-reached whole-module export — see the fixture. */
const STABLE_ENTRYPOINT = "src/stable-only.cjs";
/** Reaches only the valid-heritage control, for the same subgraph-completeness reason. */
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
    id: "GHSA-rwf-022",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-022",
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

describe("RWF-022 fixture: a heritage call that RETURNS an invalid superclass bypassing the final whole-module export (fixtures/commonjs-invalid-class-heritage-value-export-authority)", () => {
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

  it("attributes no definitive whole-module target to either branch", async () => {
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

  it("attributes no definitive whole-module target for an anonymous class EXPRESSION whose CONCISE-ARROW factory returns an object literal", async () => {
    const { finding } = await scan({
      module: "fixture-lib/class-expression",
      export: "default",
      entrypoint: HERITAGE_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("attributes no definitive whole-module target for an ASYNC callee -- decided by callee identity, not by its body", async () => {
    // The body returns `class Base {}`. Only the `async` wrapper makes the
    // call's VALUE a Promise, and only that makes the heritage invalid.
    const { finding } = await scan({
      module: "fixture-lib/async-callee",
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

  it("keeps the later export attributable when every heritage VALUE is valid (the control that makes this sound rather than merely conservative)", async () => {
    // `fixture-lib/valid-heritage` holds `extends makeBase()` (returns a
    // class), `extends makeCtor()` (returns an ordinary function),
    // `extends makeNull()` (returns `null`, which `extends` ACCEPTS),
    // `extends maybeBase(true)` (two returns, not definitely anything) and a
    // `class ... extends notAConstructor() {}` inside a never-called
    // function. None of them ends module evaluation, so
    // `module.exports = safeOp` really is reached on every load -- proven
    // in-process in the ground-truth fixture's `c.js`. Treating any of them
    // as a definitely-invalid heritage value would withdraw authority from
    // an export that is genuinely reached: a false refusal, not conservatism.
    const { finding } = await scan({
      module: "fixture-lib/valid-heritage",
      export: "default",
      entrypoint: VALID_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
      reachableSubgraphComplete: true,
      target: { module: "fixture-lib/valid-heritage", export: "default" },
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
