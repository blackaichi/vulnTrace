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
 * RWF-028's permanent end-to-end regression (see
 * fixtures/commonjs-circular-import-invocation-provenance-ground-truth/README.md
 * for the real-Node, ASSERTED runtime proof that an aliased call enters
 * its source function's own body, that a cyclic `require()` really does
 * retain the earlier dangerous export, and that all five shapes here abort
 * module evaluation while every negative control genuinely completes).
 *
 * Each of the five modules is RWF-016's fixture with exactly one thing
 * changed: the invocation SHAPE of the statement that ends module
 * evaluation.
 *
 * ```js
 * const alias = bail; alias();                  // index.js    (C07)
 * function viaHelper() { bail(); } viaHelper(); // wrapper.js  (C08)
 * const handlers = { bail }; handlers.bail();   // member.js   (C09)
 * { const bail = () => { throw }; bail(); }     // shadow.js   (C10)
 * new bail();                                   // construct.js (E01)
 * ```
 *
 * Before RWF-028 the callee-side proof already existed in every one of
 * them and was thrown away because the call site was not a bare
 * identifier. The whole exported value bound to `safeOp`, the entrypoint's
 * `fixture(input)` call got a fully RESOLVED edge to it, `dangerousOp` was
 * left with no incoming edge at all, and the reachability search over
 * `danger.explode` came back unreachable with a COMPLETE subgraph -- a
 * Family C proof, and a false NOT_AFFECTED, for a package that reaches the
 * sink on every load taking the early branch.
 *
 * Post-fix the whole-module export is ambiguous, nothing attributes it,
 * and the call becomes an honest `unknown(unresolved_target)` edge --
 * UNKNOWN.
 *
 * `valid.js` is the control that makes this sound rather than merely
 * aggressive, and `stable.js` is the Family C positive control that keeps
 * this task from having bought its soundness by disabling negative proofs.
 */

const FIXTURE = "commonjs-invocation-provenance-soundness";
const ENTRYPOINT = "src/index.cjs";
/** Reaches only the definitely-reached whole-module export — see the fixture. */
const STABLE_ENTRYPOINT = "src/stable-only.cjs";
/** Reaches only the negative-control module, for the same subgraph-completeness reason. */
const VALID_ENTRYPOINT = "src/valid-only.cjs";
/** Reaches only the parameter-shadow control, and CALLS its exported value. */
const PARAM_SHADOW_ENTRYPOINT = "src/param-shadow-only.cjs";

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
    id: "GHSA-rwf-028",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-028",
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

describe("RWF-028 fixture: an invocation whose PROVENANCE, not whose callee, was the open question (fixtures/commonjs-invocation-provenance-soundness)", () => {
  it("does not prove the bypassed vulnerable branch unreachable -> UNKNOWN", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("issues no Family C negative proof for the branch that survived to the end of the file", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: ENTRYPOINT,
    });

    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("attributes no definitive whole-module target to either branch (C07, the one-hop alias)", async () => {
    const { finding, graph } = await scan({
      module: "fixture-lib",
      export: "default",
      entrypoint: ENTRYPOINT,
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

  for (const [label, module] of [
    ["C08, the one-hop local wrapper", "fixture-lib/wrapper"],
    ["C09, the exact object-literal member", "fixture-lib/member"],
    ["C10, the throwing block-scoped shadow", "fixture-lib/shadow"],
    [
      "E01, the construction of an exact throwing callable",
      "fixture-lib/construct",
    ],
  ] as const) {
    it(`attributes no definitive whole-module target (${label})`, async () => {
      const { finding } = await scan({
        module,
        export: "default",
        entrypoint: ENTRYPOINT,
      });

      expect(finding?.verdict).toBe("UNKNOWN");
      expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
    });
  }

  it("never substitutes a different PackageInstance for the ambiguous export", async () => {
    // The fixture really does install a SECOND fixture-lib@1.0.0 at
    // node_modules/elsewhere/node_modules/fixture-lib -- same name, same
    // version, different install path -- so a resolution keyed on
    // name-and-version rather than on install path would attribute it.
    const { finding, root } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: ENTRYPOINT,
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

  it("keeps the later export attributable when EVERY invocation is one RWF-028 may not prove (the control that makes this sound rather than merely aggressive)", async () => {
    // `fixture-lib/valid` holds a safe alias, a two-hop alias, a
    // conditional alias, four wrappers that each keep a normal path (a
    // conditional one, a returning one, a catching one and a deferring
    // one), an overwritten property, a safe-last duplicate key, an object
    // that escapes to a mutator, a SAFE inner shadow spelled `bail` over
    // a THROWING outer `bail`, an `async` and a generator callee, and a
    // caught alias invocation.
    //
    // None of them ends module evaluation -- measured row by row under
    // real `node` in the ground-truth fixture's forms.js -- so
    // `module.exports = safeOp` really is reached on every load.
    // Withdrawing its authority for any of them would be an overreach.
    //
    // **What this case does and does not detect.** It is scanned from
    // `valid-only.cjs`, which `require`s the module and never CALLS its
    // export, so the target is unreachable either way and this assertion
    // is a statement about VERDICT and NEGATIVE-PROOF behavior -- that a
    // module full of unprovable invocations still supports a complete
    // Family C proof. It is NOT sensitive to whether one individual
    // invocation was wrongly proven: withdrawing authority would leave
    // this verdict NOT_AFFECTED all the same.
    //
    // The per-shape overreach controls live one layer down, in
    // module-model.invocation-provenance-soundness.test.ts, where each is
    // asserted to refuse a cutoff on its own with no earlier cutoff in
    // the file to mask it. End-to-end fixtures prove verdict and proof
    // behavior; the focused module-model matrix proves the overreach
    // controls.
    const { finding } = await scan({
      module: "fixture-lib/valid",
      export: "default",
      entrypoint: VALID_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
      reachableSubgraphComplete: true,
      target: { module: "fixture-lib/valid", export: "default" },
    });
  });

  it("keeps a module's export attributable when a wrapper PARAMETER shadows the throwing callable (the audit blocker)", async () => {
    // `fixture-lib/param-shadow` holds ten wrappers whose parameter is
    // spelled `bail`, shadowing that module's own throwing `bail`. Under
    // real `node` every one of them invokes `safeFn` and returns, and
    // `module.exports = safeOp` is written on every load.
    //
    // RWF-028's first implementation resolved those bodies' `bail()` to
    // the OUTER declaration — the lexical walk stepped over the function
    // boundary — and withdrew this module's authority, making its whole
    // exported value ambiguous. That is a false AFFECTED for a module
    // that runs to completion, and it is what `scopeDeclares`' new
    // function-like case fixes.
    //
    // The entrypoint CALLS the exported value, so this asserts EXPORT
    // ATTRIBUTION rather than Family C: with authority intact the export
    // resolves to `safeOp` and the call reaches it (AFFECTED). With the
    // shadow crossed the export is ambiguous and nothing resolves
    // (UNKNOWN) — which is exactly what this assertion catches.
    //
    // There is deliberately no `confirmedUnreachableTarget` claim here:
    // calling a PARAMETER is genuinely unresolvable, so the reachable
    // subgraph is legitimately incomplete. That is why these controls
    // live in their own module rather than in `valid.js`, whose job is
    // the complete-subgraph negative proof.
    const { finding } = await scan({
      module: "fixture-lib/param-shadow",
      export: "default",
      entrypoint: PARAM_SHADOW_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("still proves a genuinely unreachable, DEFINITELY REACHED whole-module export -> NOT_AFFECTED (Family C control)", async () => {
    // The control must keep working, or this task would have bought its
    // soundness by disabling negative proofs rather than by narrowing
    // which invocations may withdraw authority.
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
