import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Entrypoint } from "../domain/entrypoint.js";
import { canonicalizePackageInstancePath } from "../domain/resolved-target.js";
import {
  isAnalysisProofContext,
  type AnalysisProofContext,
} from "./analysis-context.js";
import {
  classifyMutation,
  contextFor,
  runProofWithContext,
  closureForgets,
  closureIncomplete,
  closureLoads,
  closureWithBlocker,
  closureWithFileRenamed,
  closureWithRoots,
  closureWithoutRoots,
  createMutationLedger,
  createProofWorkspace,
  describeOutcome,
  graphWithUnresolvedEdge,
  graphWithWideningEdge,
  graphWithNode,
  graphWithoutInstance,
  graphWithoutNode,
  mutate,
  runProof,
  type MaterializedProof,
  type MutationOutcome,
  type ProofFamily,
  type ProofInputs,
  type ProofMutationRow,
  type ProofProject,
} from "../testing/proof-mutation.js";

/**
 * FOUNDATION F4 -- SYSTEMATIC NEGATIVE-PROOF PRECONDITION MUTATION.
 *
 * THE QUESTION THIS FILE ANSWERS. `domain/evidence.ts` enumerates, per
 * family, the prerequisites a NOT_AFFECTED rests on. Each is guarded, and
 * each guard has a regression test shaped like the defect that produced
 * it. What has never been stated as one invariant is the property those
 * guards collectively have to hold:
 *
 *   valid proof + one invalidated prerequisite = that proof is GONE.
 *
 * Every row below takes a REAL, valid family A/B/C NOT_AFFECTED produced
 * by the production composition over a real on-disk project, removes or
 * corrupts EXACTLY ONE thing it depends on, and asserts the original proof
 * did not survive. No row asserts `UNKNOWN` mechanically -- see below.
 *
 * WHY `UNKNOWN` IS NOT THE INVARIANT (F4 § 8). VulnTrace has three
 * independent negative proofs with genuinely different claims. Family A
 * says the instance cannot LOAD; family C says a resolved symbol is never
 * CALLED. A mutation that destroys A's premise need not touch C's, and
 * when C then carries the verdict that is a sound answer, not a missed
 * downgrade. Three such takeovers occur below and each is audited
 * individually rather than waved through: the original family must be
 * GONE, the replacement must name its own evidence object, and its own
 * guards must be independently satisfied.
 *
 * CONTROL ROWS. Rows marked `invalidates: false` mutate something the
 * family provably does NOT depend on -- family A ignores `graphTruncated`
 * (it is a module-load proof, decided before the call graph is consulted
 * at all); family C ignores closure MEMBERSHIP (it never claims the
 * package is unloaded). They are here because a harness in which every
 * mutation downgrades proves nothing about precision: it is equally
 * consistent with a guard that rejects everything. Each control asserts
 * the proof SURVIVES, unchanged.
 *
 * MUTATION-CHECKED. The representative rows named in F4 § 26 were
 * verified by temporarily disabling the guard in production source and
 * confirming the corresponding row FAILS -- see the RWF-037 record for
 * which rows, which guards and what each produced.
 */

const LIB_CJS =
  "function vulnerable(x){ return x; }\n" +
  "function safe(x){ return x; }\n" +
  "module.exports = { vulnerable, safe };\n";

const INSTALLED_LIB: Readonly<Record<string, string>> = {
  "node_modules/vuln-lib/package.json": JSON.stringify({
    name: "vuln-lib",
    version: "1.0.0",
  }),
  "node_modules/vuln-lib/index.js": LIB_CJS,
};

// --------------------------------------------------------------------
// THE THREE BASELINES (F4 § 2).
//
// Each is minimal, real, and reaches exactly one family through the
// production proof-selection code. None uses a mock that could bypass a
// guard: the graph comes from `buildCallGraph`, the closure from
// `buildGateEligibleModuleLoadClosure`, the context from
// `createAnalysisProofContext`, and the verdict from `buildFinding`.
// --------------------------------------------------------------------

/**
 * FAMILY A baseline -- the instance is installed and NOTHING loads it.
 *
 * The call graph discovers no instance of `vuln-lib` at all (Site B), the
 * advisory's module still resolves inside the finding's own instance, and
 * a complete closure over the real entrypoint does not contain it.
 */
const FAMILY_A_PROJECT: ProofProject = {
  files: {
    ...INSTALLED_LIB,
    "src/index.js":
      "function main(){ return 1; }\nmodule.exports = { main };\n",
  },
  entries: ["src/index.js"],
  installs: ["node_modules/vuln-lib"],
  findingInstall: "node_modules/vuln-lib",
};

/**
 * FAMILY B baseline -- two installs of one name/version, one reached.
 *
 * The entrypoint requires (and calls) the TOP-LEVEL install, so the call
 * graph discovers that one; the finding is about the NESTED twin, which
 * the graph never traversed (Site A with no instance match) and which a
 * complete closure independently corroborates as never loaded.
 */
const FAMILY_B_PROJECT: ProofProject = {
  files: {
    ...INSTALLED_LIB,
    "node_modules/consumer/package.json": JSON.stringify({
      name: "consumer",
      version: "1.0.0",
    }),
    "node_modules/consumer/node_modules/vuln-lib/package.json": JSON.stringify({
      name: "vuln-lib",
      version: "1.0.0",
    }),
    "node_modules/consumer/node_modules/vuln-lib/index.js": LIB_CJS,
    "src/index.js":
      'const { vulnerable } = require("vuln-lib");\n' +
      "function main(){ return vulnerable(1); }\nmodule.exports = { main };\n",
  },
  entries: ["src/index.js"],
  installs: [
    "node_modules/vuln-lib",
    "node_modules/consumer/node_modules/vuln-lib",
  ],
  findingInstall: "node_modules/consumer/node_modules/vuln-lib",
};

/**
 * FAMILY C baseline -- the instance IS loaded and IS called, on its SAFE
 * export only.
 *
 * Nothing about presence or loading is claimed: the package is in the
 * closure and in the call graph. The claim is that the one resolved,
 * attributed target has no call path from the configured entrypoint.
 */
const FAMILY_C_PROJECT: ProofProject = {
  files: {
    ...INSTALLED_LIB,
    "src/index.js":
      'const { safe } = require("vuln-lib");\n' +
      "function main(){ return safe(1); }\nmodule.exports = { main };\n",
  },
  entries: ["src/index.js"],
  installs: ["node_modules/vuln-lib"],
  findingInstall: "node_modules/vuln-lib",
};

const workspace = createProofWorkspace();
const ledger = createMutationLedger();

let familyA: MaterializedProof;
let familyB: MaterializedProof;
let familyC: MaterializedProof;

beforeAll(async () => {
  familyA = await workspace.materialize(FAMILY_A_PROJECT);
  familyB = await workspace.materialize(FAMILY_B_PROJECT);
  familyC = await workspace.materialize(FAMILY_C_PROJECT);
});

afterAll(() => workspace.cleanup());

/** The closure of a materialized baseline, which is always present by construction. */
function closureOf(proof: MaterializedProof) {
  const closure = proof.inputs.moduleLoadClosure;
  if (!closure) {
    throw new Error("baseline has no module-load closure");
  }
  return closure;
}

/**
 * VT-CONTRACT-01, asserted on EVERY outcome the harness produces.
 *
 * A NOT_AFFECTED carries exactly one negative-proof evidence object;
 * anything else carries none. Checked per mutation rather than once,
 * because a mutation is exactly the kind of state that could produce the
 * proof-less NOT_AFFECTED or the double-proof the schema forbids.
 */
function expectExactlyOneProof(outcome: MutationOutcome): void {
  expect(
    outcome.proofCount,
    `exactly-one-proof contract violated: ${describeOutcome(outcome)}`,
  ).toBe(outcome.verdict === "NOT_AFFECTED" ? 1 : 0);
}

/**
 * Runs one matrix row and records it.
 *
 * The assertion is deliberately narrow: the ORIGINAL family must not
 * survive an invalidating mutation. What replaces it, if anything, is
 * classified and counted, and the per-family takeover audits below assert
 * the replacement's own guards separately.
 */
async function runRow(
  baselineFamily: ProofFamily,
  baseline: ProofInputs,
  row: ProofMutationRow,
): Promise<MutationOutcome> {
  const outcome = await runProof(await row.apply(baseline));
  const classification = classifyMutation(baselineFamily, row, outcome);

  ledger.record({
    family: baselineFamily,
    mutation: row.mutation,
    classification,
    verdict: outcome.verdict,
    resultingFamily: outcome.family,
  });

  expectExactlyOneProof(outcome);

  if (row.invalidates) {
    expect(
      outcome.family,
      `family ${baselineFamily} survived the mutation "${row.mutation}", which removes one of its own prerequisites:\n${describeOutcome(outcome)}`,
    ).not.toBe(baselineFamily);
    expect(classification).not.toBe("unsafe_survival");
  } else {
    expect(
      outcome.family,
      `control row "${row.mutation}" changed the verdict, so it is NOT a control:\n${describeOutcome(outcome)}`,
    ).toBe(baselineFamily);
    expect(outcome.verdict).toBe("NOT_AFFECTED");
  }

  if (row.expectUncertaintyReason !== undefined) {
    // OBSERVATIONAL ONLY (F4 § 18). The taxonomy explains the downgrade;
    // it never authorizes or withdraws a proof, and the invariant above
    // holds whether or not this matches.
    expect(
      outcome.unknownReasons.map((reason) => reason.reason),
      `taxonomy observation for "${row.mutation}":\n${describeOutcome(outcome)}`,
    ).toContain(row.expectUncertaintyReason);
  }

  return outcome;
}

/** Runs a whole matrix as one `it` per row, so a failure names the row. */
function runMatrix(
  family: ProofFamily,
  baseline: () => ProofInputs,
  rows: readonly ProofMutationRow[],
): void {
  for (const row of rows) {
    const label = row.invalidates
      ? `${row.mutation} -> family ${family} must not survive`
      : `${row.mutation} -> control: family ${family} legitimately stands`;
    it(label, async () => {
      await runRow(family, baseline(), row);
    });
  }
}

// ====================================================================
// BASELINE VALIDITY (F4 § 2)
// ====================================================================

describe("F4 baselines: each produces exactly one valid negative proof", () => {
  it("family A: the instance cannot be loaded at all", async () => {
    const outcome = await runProof(familyA.inputs);

    expect(outcome.verdict).toBe("NOT_AFFECTED");
    expect(outcome.family).toBe("A");
    // The proof names the EXACT canonical install location, never a name
    // or a version.
    expect(outcome.proofPackageInstance).toBe(familyA.inputs.packageInstance);
    expect(
      outcome.finding?.evidence?.confirmedAbsentFromModuleLoadClosure
        ?.closureComplete,
    ).toBe(true);
    expect(outcome.proofEntrypointRoots).toEqual(familyA.entryFiles);
    expectExactlyOneProof(outcome);
  });

  it("family B: the call graph never traversed this exact twin", async () => {
    const outcome = await runProof(familyB.inputs);

    expect(outcome.verdict).toBe("NOT_AFFECTED");
    expect(outcome.family).toBe("B");
    expect(outcome.proofPackageInstance).toBe(familyB.inputs.packageInstance);
    // The nested twin, never the reached top-level one.
    expect(outcome.proofPackageInstance).toBe(
      familyB.instances.get("node_modules/consumer/node_modules/vuln-lib"),
    );
    const proof = outcome.finding?.evidence?.confirmedAbsentInstance;
    expect(proof?.graphTruncated).toBe(false);
    expect(proof?.moduleLoadClosureComplete).toBe(true);
    expectExactlyOneProof(outcome);
  });

  it("family C: the resolved target is never called", async () => {
    const outcome = await runProof(familyC.inputs);

    expect(outcome.verdict).toBe("NOT_AFFECTED");
    expect(outcome.family).toBe("C");
    expect(outcome.proofTarget).toEqual({
      module: "vuln-lib",
      export: "vulnerable",
    });
    expect(
      outcome.finding?.evidence?.confirmedUnreachableTarget
        ?.reachableSubgraphComplete,
    ).toBe(true);
    expectExactlyOneProof(outcome);
  });

  it("the baselines are genuinely DIFFERENT proofs, not one shape three times", async () => {
    const families = await Promise.all(
      [familyA, familyB, familyC].map(
        async (proof) => (await runProof(proof.inputs)).family,
      ),
    );
    expect(new Set(families).size).toBe(3);
  });

  it("family C's instance IS loaded and IS in the graph -- the opposite of A's premise", () => {
    // Stated as a test so the three baselines cannot silently converge on
    // the same project shape during a later edit.
    const closure = closureOf(familyC);
    expect(closure.loadedPackageInstances).toContain(
      familyC.inputs.packageInstance,
    );
    expect(
      familyC.inputs.graph.nodes.some((node) =>
        node.module.includes("vuln-lib"),
      ),
    ).toBe(true);

    expect(closureOf(familyA).loadedPackageInstances).not.toContain(
      familyA.inputs.packageInstance,
    );
    expect(
      familyA.inputs.graph.nodes.some((node) =>
        node.module.includes("vuln-lib"),
      ),
    ).toBe(false);
  });
});

// ====================================================================
// FAMILY A MUTATION MATRIX (F4 § 4)
// ====================================================================

describe("F4 family A mutations: the module-load absence proof", () => {
  runMatrix("A", () => familyA.inputs, [
    {
      mutation: "closure_absent",
      invalidates: true,
      apply: (inputs) => mutate(inputs, { moduleLoadClosure: undefined }),
      expectUncertaintyReason: "module_load_closure_unavailable",
    },
    {
      mutation: "closure_incomplete_parse_failure",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureIncomplete(
            closureOf(familyA),
            "parse_failure",
          ),
        }),
      expectUncertaintyReason: "parse_failure",
    },
    {
      mutation: "closure_incomplete_unresolved_module",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureIncomplete(
            closureOf(familyA),
            "unresolved_module",
          ),
        }),
      expectUncertaintyReason: "unresolved_module",
    },
    {
      mutation: "closure_roots_empty_so_gate_ineligible",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureWithoutRoots(closureOf(familyA)),
        }),
      // The CONTEXT drops a closure whose roots are not these entrypoints
      // before the gate is ever reached, so the blocker reported is
      // absence -- the gate-eligibility requirement enforced one layer up.
      expectUncertaintyReason: "module_load_closure_unavailable",
    },
    {
      mutation: "closure_roots_are_a_foreign_file",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureWithRoots(closureOf(familyA), [
            "/elsewhere/other-project/src/index.js",
          ]),
        }),
      expectUncertaintyReason: "module_load_closure_unavailable",
    },
    {
      mutation: "closure_reports_this_exact_instance_as_loaded",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureLoads(
            closureOf(familyA),
            inputs.packageInstance!,
          ),
        }),
    },
    {
      mutation: "package_instance_changed_to_a_different_location",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          packageInstance: `${familyA.root}/node_modules/some-other-install`,
        }),
      expectUncertaintyReason: "vulnerable_target_unresolved",
    },
    {
      mutation: "package_instance_withdrawn_entirely",
      invalidates: true,
      apply: (inputs) => mutate(inputs, { packageInstance: undefined }),
    },
    {
      mutation: "entrypoint_roots_mismatched",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          entrypoints: [
            {
              filePath: `${familyA.root}/node_modules/vuln-lib/index.js`,
              source: "configured",
              reason: "f4-mismatch",
            },
          ],
        }),
    },
    {
      mutation: "graph_no_longer_covers_the_entrypoints",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          graph: graphWithoutNode(
            inputs.graph,
            `${familyA.root}/src/index.js#<module>`,
          ),
        }),
      expectUncertaintyReason: "module_load_closure_unavailable",
    },
    // ------------------------------------------------------- CONTROLS
    {
      // Family A is decided BEFORE the call graph is consulted (VT-307d
      // places it ahead of `graphTruncated` deliberately): a resource
      // limit on the graph's walk cannot make an unloadable package load.
      mutation: "graph_truncated",
      invalidates: false,
      apply: (inputs) => mutate(inputs, { graphTruncated: true }),
    },
    {
      // Same reason: VT-300's widening guard governs family B's
      // call-graph absence, not family A's closure absence. A construct
      // that could genuinely load a new module makes the CLOSURE
      // incomplete, which is the row two above -- and that one does
      // withdraw the proof.
      mutation: "widening_call_edge_in_the_graph_only",
      invalidates: false,
      apply: (inputs) =>
        mutate(inputs, {
          graph: graphWithWideningEdge(inputs.graph, familyA.entryFiles),
        }),
    },
    {
      // Isolates WHICH closure field family A reads. `complete` is the
      // gate; a recorded incompleteness beside `complete: true` is a
      // state no real builder produces, and family A does not read it.
      // The call-graph-derived families DO -- see their own matrices.
      mutation: "incompleteness_recorded_without_clearing_complete",
      invalidates: false,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureWithBlocker(
            closureOf(familyA),
            "loader_hook_mutation",
          ),
        }),
    },
  ]);

  it("AUDIT: closure-says-loaded hands over to family C, which claims something else", async () => {
    // F4 § 8. Family A's claim ("cannot be loaded") is destroyed by this
    // mutation. Family C's claim ("this resolved symbol is never called")
    // is untouched by it, and C's own guards still hold. The takeover is
    // therefore sound -- but it must be AUDITED rather than assumed, so
    // the replacement's independent preconditions are asserted here.
    const outcome = await runProof(
      mutate(familyA.inputs, {
        moduleLoadClosure: closureLoads(
          closureOf(familyA),
          familyA.inputs.packageInstance!,
        ),
      }),
    );

    expect(outcome.family).toBe("C");
    expect(outcome.family).not.toBe("A");
    // Family C's OWN guards, each checked independently of A's:
    expect(
      outcome.finding?.evidence?.confirmedUnreachableTarget
        ?.reachableSubgraphComplete,
    ).toBe(true);
    expect(familyA.inputs.graphTruncated).toBe(false);
    expect(outcome.proofTarget).toEqual({
      module: "vuln-lib",
      export: "vulnerable",
    });
    // And no family-A residue survives anywhere on the finding.
    expect(
      outcome.finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
    expectExactlyOneProof(outcome);
  });

  it("AUDIT: the REAL shape of that state reaches UNKNOWN, not a takeover", async () => {
    // The mutation above manufactures an inconsistency -- a closure that
    // reports an instance loaded beside a call graph with no node of it.
    // The real construct that produces that pair is a re-export
    // declaration, which call-graph DISCOVERY does not follow; and in the
    // real shape the call it hides leaves an unresolved edge in the
    // reachable subgraph, so family C is withdrawn too. Pinned here so
    // the takeover above is never read as a claim about production.
    const reexport = await workspace.materialize({
      files: {
        "package.json": JSON.stringify({ name: "app", type: "module" }),
        "node_modules/vuln-lib/package.json": JSON.stringify({
          name: "vuln-lib",
          version: "1.0.0",
          type: "module",
          main: "index.js",
        }),
        "node_modules/vuln-lib/index.js":
          "export function vulnerable(x){ return x; }\n" +
          "export function safe(x){ return x; }\n",
        "node_modules/consumer/package.json": JSON.stringify({
          name: "consumer",
          version: "1.0.0",
          type: "module",
          main: "index.js",
        }),
        "node_modules/consumer/index.js": 'export * from "vuln-lib";\n',
        "src/index.js":
          'import { vulnerable } from "consumer";\n' +
          "export function main(){ return vulnerable(1); }\n",
      },
      entries: ["src/index.js"],
      installs: ["node_modules/vuln-lib"],
      findingInstall: "node_modules/vuln-lib",
    });

    // The state the synthetic mutation imitated, reached honestly:
    const closure = closureOf(reexport);
    expect(closure.complete).toBe(true);
    expect(closure.loadedPackageInstances).toContain(
      reexport.inputs.packageInstance,
    );
    expect(
      reexport.inputs.graph.nodes.filter((node) =>
        node.module.includes("vuln-lib"),
      ),
    ).toHaveLength(0);

    const outcome = await runProof(reexport.inputs);
    expect(outcome.verdict).toBe("UNKNOWN");
    expect(outcome.family).toBe("NONE");
    expectExactlyOneProof(outcome);
  });

  it("AUDIT: a closure truncated on its OWN walk hands over to family C", async () => {
    // `traversal_truncated` is the single documented exclusion in
    // `invalidatesCallGraphNegativeProof`: it bounds the CLOSURE's walk
    // and says nothing about how far the CALL GRAPH got, which has its
    // own independent guard. Family A needs `complete` and loses it;
    // family C needs `graphTruncated === false` and still has it.
    const outcome = await runProof(
      mutate(familyA.inputs, {
        moduleLoadClosure: closureIncomplete(
          closureOf(familyA),
          "traversal_truncated",
        ),
      }),
    );

    expect(outcome.family).toBe("C");
    expect(
      outcome.finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
    expect(
      outcome.finding?.evidence?.confirmedUnreachableTarget
        ?.reachableSubgraphComplete,
    ).toBe(true);
    expectExactlyOneProof(outcome);

    // And the exclusion is not a blanket one: the SAME closure, truncated
    // AND carrying any other reason, blocks family C as well.
    const alsoBlocked = await runProof(
      mutate(familyA.inputs, {
        moduleLoadClosure: closureIncomplete(
          closureIncomplete(closureOf(familyA), "traversal_truncated"),
          "parse_failure",
        ),
      }),
    );
    expect(alsoBlocked.verdict).toBe("UNKNOWN");
    expect(alsoBlocked.family).toBe("NONE");
  });
});

// ====================================================================
// FAMILY B MUTATION MATRIX (F4 § 5)
// ====================================================================

describe("F4 family B mutations: the call-graph absence proof", () => {
  runMatrix("B", () => familyB.inputs, [
    {
      mutation: "closure_absent",
      invalidates: true,
      apply: (inputs) => mutate(inputs, { moduleLoadClosure: undefined }),
      expectUncertaintyReason: "package_instance_absence_uncorroborated",
    },
    {
      mutation: "closure_incomplete_parse_failure",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureIncomplete(
            closureOf(familyB),
            "parse_failure",
          ),
        }),
      expectUncertaintyReason: "package_instance_absence_uncorroborated",
    },
    {
      mutation: "closure_incomplete_traversal_truncated",
      invalidates: true,
      // Family B's corroboration requires `complete === true` outright --
      // unlike the call-graph BLOCKER partition, which excludes this
      // reason. Two different reads of the closure, and this row pins
      // that they genuinely differ.
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureIncomplete(
            closureOf(familyB),
            "traversal_truncated",
          ),
        }),
      expectUncertaintyReason: "package_instance_absence_uncorroborated",
    },
    {
      mutation: "graph_truncated",
      invalidates: true,
      apply: (inputs) => mutate(inputs, { graphTruncated: true }),
      expectUncertaintyReason: "call_graph_truncated",
    },
    {
      mutation: "closure_reports_this_exact_instance_as_loaded",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureLoads(
            closureOf(familyB),
            inputs.packageInstance!,
          ),
        }),
      expectUncertaintyReason: "package_instance_absence_uncorroborated",
    },
    {
      mutation: "widening_construct_reachable_from_an_entrypoint",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          graph: graphWithWideningEdge(inputs.graph, familyB.entryFiles),
        }),
      expectUncertaintyReason: "closure_widening_construct_reachable",
    },
    {
      mutation: "loader_blocker_recorded_on_the_closure",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureWithBlocker(
            closureOf(familyB),
            "loader_hook_mutation",
          ),
        }),
      expectUncertaintyReason: "loader_hook_mutation",
    },
    {
      mutation: "package_instance_swapped_to_the_REACHED_twin",
      invalidates: true,
      // The other same-name/same-version install IS called. Family B must
      // not survive, and the honest answer is the positive one.
      apply: (inputs) =>
        mutate(inputs, {
          packageInstance: familyB.instances.get("node_modules/vuln-lib"),
        }),
    },
    {
      mutation: "graph_absence_claim_is_no_longer_true",
      invalidates: true,
      // The nested twin's own nodes are INSERTED into the graph, so the
      // "never traversed" premise is false. Family B must go.
      apply: (inputs) => {
        const nested = familyB.instances.get(
          "node_modules/consumer/node_modules/vuln-lib",
        )!;
        return mutate(inputs, {
          graph: graphWithNode(inputs.graph, {
            id: `${nested}/index.js#vulnerable@1:1`,
            kind: "function",
            module: `${nested}/index.js`,
            name: "vulnerable",
            location: { file: `${nested}/index.js`, line: 1, column: 1 },
          }),
        });
      },
    },
    {
      mutation: "entrypoint_roots_mismatched",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          entrypoints: [
            {
              filePath: `${familyB.root}/node_modules/vuln-lib/index.js`,
              source: "configured",
              reason: "f4-mismatch",
            },
          ],
        }),
    },
    {
      mutation: "the_OTHER_instance_is_removed_from_the_graph",
      invalidates: true,
      // With no instance of the name left in the graph, this is no longer
      // Site A at all: the question becomes family A's, and family B --
      // whose premise is "some OTHER instance was discovered" -- is gone.
      apply: (inputs) =>
        mutate(inputs, {
          graph: graphWithoutInstance(
            inputs.graph,
            familyB.instances.get("node_modules/vuln-lib")!,
          ),
        }),
    },
    // ------------------------------------------------------- CONTROLS
    {
      // Corroboration is about THIS instance. The reached twin's presence
      // or absence in the loaded set is a fact about a different
      // question, and family B must not be sensitive to it.
      mutation: "closure_forgets_the_OTHER_instance",
      invalidates: false,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureForgets(
            closureOf(familyB),
            familyB.instances.get("node_modules/vuln-lib")!,
          ),
        }),
    },
    {
      // A NON-widening unresolved edge cannot load an undiscovered
      // instance (its uncertainty is bounded to modules already
      // discovered), so VT-300 correctly ignores it for family B. It is
      // family C that must degrade on it -- see C's own matrix.
      mutation: "non_widening_unresolved_edge",
      invalidates: false,
      apply: (inputs) =>
        mutate(inputs, {
          graph: graphWithUnresolvedEdge(
            inputs.graph,
            familyB.entryFiles,
            "unsupported_construct",
          ),
        }),
    },
  ]);

  it("AUDIT: swapping to the reached twin yields AFFECTED, never a borrowed negative", async () => {
    // The positive takeover (F4 § 28's `AFFECTED` bucket). The decisive
    // property is not the verdict but that the two twins -- same name,
    // same version, different locations -- got INDEPENDENT answers, and
    // that no negative proof about one was reported for the other.
    const outcome = await runProof(
      mutate(familyB.inputs, {
        packageInstance: familyB.instances.get("node_modules/vuln-lib"),
      }),
    );

    expect(outcome.verdict).toBe("AFFECTED");
    expect(outcome.family).toBe("NONE");
    expectExactlyOneProof(outcome);
  });
});

// ====================================================================
// FAMILY C MUTATION MATRIX (F4 § 6)
// ====================================================================

describe("F4 family C mutations: the target-unreachability proof", () => {
  runMatrix("C", () => familyC.inputs, [
    {
      mutation: "closure_absent",
      invalidates: true,
      apply: (inputs) => mutate(inputs, { moduleLoadClosure: undefined }),
      expectUncertaintyReason: "module_load_closure_unavailable",
    },
    {
      mutation: "closure_incomplete_parse_failure",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureIncomplete(
            closureOf(familyC),
            "parse_failure",
          ),
        }),
      expectUncertaintyReason: "parse_failure",
    },
    {
      mutation: "loader_hook_blocker_recorded_on_the_closure",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureWithBlocker(
            closureOf(familyC),
            "loader_hook_mutation",
          ),
        }),
      expectUncertaintyReason: "loader_hook_mutation",
    },
    {
      mutation: "declaration_only_blocker_recorded_on_the_closure",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureWithBlocker(
            closureOf(familyC),
            "declaration_only_resolution",
          ),
        }),
      expectUncertaintyReason: "declaration_only_resolution",
    },
    {
      mutation: "graph_truncated",
      invalidates: true,
      apply: (inputs) => mutate(inputs, { graphTruncated: true }),
      expectUncertaintyReason: "call_graph_truncated",
    },
    {
      mutation: "reachable_subgraph_no_longer_complete",
      invalidates: true,
      // A NON-widening unresolved edge inside the searched region. It
      // isolates `reachableSubgraphComplete` from VT-300's widening guard
      // and from `graphTruncated`: this construct could not load a new
      // module and no limit was hit -- the search simply met something it
      // could not resolve, which is exactly what that field denies.
      apply: (inputs) =>
        mutate(inputs, {
          graph: graphWithUnresolvedEdge(
            inputs.graph,
            familyC.entryFiles,
            "unsupported_construct",
          ),
        }),
      expectUncertaintyReason: "unsupported_construct",
    },
    {
      mutation: "widening_construct_reachable_from_an_entrypoint",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          graph: graphWithWideningEdge(inputs.graph, familyC.entryFiles),
        }),
      expectUncertaintyReason: "dynamic_require",
    },
    {
      mutation: "authoritative_target_node_removed",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          graph: graphWithoutNode(
            inputs.graph,
            `${familyC.root}/node_modules/vuln-lib/index.js#vulnerable@1:1`,
          ),
        }),
      expectUncertaintyReason: "vulnerable_target_unresolved",
    },
    {
      mutation: "target_ownership_withdrawn_via_instance_mismatch",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          packageInstance: `${familyC.root}/node_modules/a-different-install`,
        }),
    },
    {
      mutation: "entrypoint_roots_mismatched",
      invalidates: true,
      apply: (inputs) =>
        mutate(inputs, {
          entrypoints: [
            {
              filePath: `${familyC.root}/node_modules/vuln-lib/index.js`,
              source: "configured",
              reason: "f4-mismatch",
            },
          ],
        }),
    },
    {
      mutation: "root_coverage_lost_entirely",
      invalidates: true,
      apply: (inputs) => mutate(inputs, { entrypoints: [] }),
      // With no roots at all nothing was searched, so `checkedAny` is
      // false and that branch answers first -- ahead of the closure
      // blocker the empty root set also produces. Both are correct; this
      // records which one production actually reports.
      expectUncertaintyReason: "no_entrypoints_available",
    },
    {
      mutation: "package_instance_withdrawn_entirely",
      invalidates: false,
      // A finding with no instance has no ownership to check (callers
      // predating VT-212), and family C never claimed anything about the
      // instance in the first place -- its claim is about the target.
      // Kept as a CONTROL so that asymmetry is explicit rather than
      // discovered later.
      apply: (inputs) => mutate(inputs, { packageInstance: undefined }),
    },
    // ------------------------------------------------------- CONTROLS
    {
      // The one documented exclusion, from family C's side.
      mutation: "closure_incomplete_traversal_truncated_only",
      invalidates: false,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureIncomplete(
            closureOf(familyC),
            "traversal_truncated",
          ),
        }),
    },
    {
      // Family C never claims the package is unloaded, so closure
      // MEMBERSHIP is not one of its prerequisites. If this ever starts
      // downgrading, family C has silently acquired family A's premise.
      mutation: "closure_forgets_this_instance_is_loaded",
      invalidates: false,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureForgets(
            closureOf(familyC),
            inputs.packageInstance!,
          ),
        }),
    },
    {
      // A non-target node of the same package. Removing it changes
      // nothing about the target's own reachability.
      mutation: "a_non_target_node_of_the_same_package_removed",
      invalidates: false,
      apply: (inputs) =>
        mutate(inputs, {
          graph: graphWithoutNode(
            inputs.graph,
            `${familyC.root}/node_modules/vuln-lib/index.js#safe@2:1`,
          ),
        }),
    },
    {
      // The closure's own record of a loaded FILE's identity is not read
      // by family C, whose completeness claim is about the reachable
      // subgraph of the call graph.
      mutation: "a_loaded_file_identity_rewritten_in_the_closure",
      invalidates: false,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: closureWithFileRenamed(
            closureOf(familyC),
            `${familyC.root}/node_modules/vuln-lib/index.js`,
            `${familyC.root}/node_modules/vuln-lib/other.js`,
          ),
        }),
    },
  ]);

  it("AUDIT: an instance mismatch hands over to a family B proof about THAT instance", async () => {
    // F4 § 8 + § 13. Changing the finding's instance does not make family
    // C's target claim false -- it makes it a claim about a package the
    // target does not belong to, so family C is withdrawn. What replaces
    // it is a family-B absence proof, and the decisive property is that
    // the replacement names the MUTATED instance and never borrows the
    // baseline's identity.
    const foreign = `${familyC.root}/node_modules/a-different-install`;
    const outcome = await runProof(
      mutate(familyC.inputs, { packageInstance: foreign }),
    );

    expect(outcome.family).toBe("B");
    expect(outcome.proofPackageInstance).toBe(foreign);
    expect(outcome.proofPackageInstance).not.toBe(
      familyC.inputs.packageInstance,
    );
    expect(
      outcome.finding?.evidence?.confirmedUnreachableTarget,
    ).toBeUndefined();
    expectExactlyOneProof(outcome);
  });
});

// ====================================================================
// PACKAGE-INSTANCE IDENTITY MUTATIONS (F4 § 13)
// ====================================================================

/**
 * Same name, same version, two physically distinct roots. `node_modules`
 * is REACHED; `packages/` is not. The two must get independent answers,
 * and neither may ever be certified by the other's proof.
 */
const TWIN_PROJECT: ProofProject = {
  files: {
    ...INSTALLED_LIB,
    "packages/vuln-lib/package.json": JSON.stringify({
      name: "vuln-lib",
      version: "1.0.0",
    }),
    "packages/vuln-lib/index.js": LIB_CJS,
    "src/index.js":
      'const { safe } = require("vuln-lib");\n' +
      "function main(){ return safe(1); }\nmodule.exports = { main };\n",
  },
  entries: ["src/index.js"],
  installs: ["node_modules/vuln-lib", "packages/vuln-lib"],
  findingInstall: "packages/vuln-lib",
};

/**
 * ONE physical directory reachable under TWO paths: `node_modules/aliased`
 * is a symlink to `packages/aliased`. Canonicalization must collapse them,
 * so the alias path and the canonical path are the SAME instance and get
 * the SAME answer -- the mirror image of the twin case.
 */
const SYMLINK_ALIAS_PROJECT: ProofProject = {
  files: {
    "packages/vuln-lib/package.json": JSON.stringify({
      name: "vuln-lib",
      version: "1.0.0",
    }),
    "packages/vuln-lib/index.js": LIB_CJS,
    "src/index.js":
      'const { safe } = require("vuln-lib");\n' +
      "function main(){ return safe(1); }\nmodule.exports = { main };\n",
  },
  entries: ["src/index.js"],
  installs: ["packages/vuln-lib"],
  findingInstall: "packages/vuln-lib",
  symlinks: [{ target: "packages/vuln-lib", link: "node_modules/vuln-lib" }],
};

describe("F4 package-instance mutations: a proof for A never certifies B", () => {
  it("same-version twins get independent proofs, each naming its own root", async () => {
    const twins = await workspace.materialize(TWIN_PROJECT);
    const unreached = twins.instances.get("packages/vuln-lib")!;
    const reached = twins.instances.get("node_modules/vuln-lib")!;
    expect(unreached).not.toBe(reached);

    const unreachedOutcome = await runProof(twins.inputs);
    const reachedOutcome = await runProof(
      mutate(twins.inputs, { packageInstance: reached }),
    );

    // Both are NOT_AFFECTED here (the vulnerable export is never called
    // either way), and that is precisely why this is the sharp test: the
    // verdicts agree, so only the EVIDENCE can reveal identity confusion.
    expect(unreachedOutcome.verdict).toBe("NOT_AFFECTED");
    expect(reachedOutcome.verdict).toBe("NOT_AFFECTED");

    // Different families, because the two instances are in genuinely
    // different situations -- one was never traversed, one was loaded and
    // searched.
    expect(unreachedOutcome.family).toBe("B");
    expect(reachedOutcome.family).toBe("C");

    // The decisive assertion: no proof names the other instance.
    expect(unreachedOutcome.proofPackageInstance).toBe(unreached);
    expect(unreachedOutcome.proofPackageInstance).not.toBe(reached);
    expectExactlyOneProof(unreachedOutcome);
    expectExactlyOneProof(reachedOutcome);
  });

  it("a symlink alias root and its canonical root are ONE instance, not two", async () => {
    const aliased = await workspace.materialize(SYMLINK_ALIAS_PROJECT);
    const canonical = aliased.instances.get("packages/vuln-lib")!;

    const viaCanonical = await runProof(aliased.inputs);
    // The same physical package addressed through the symlink path.
    const viaAlias = await runProof(
      mutate(aliased.inputs, {
        packageInstance: canonicalizePackageInstancePath(
          `${aliased.root}/node_modules/vuln-lib`,
        ),
      }),
    );

    expect(
      canonicalizePackageInstancePath(`${aliased.root}/node_modules/vuln-lib`),
    ).toBe(canonical);
    expect(viaAlias.verdict).toBe(viaCanonical.verdict);
    expect(viaAlias.family).toBe(viaCanonical.family);
    expectExactlyOneProof(viaAlias);
  });

  it("a scoped lookalike of the same bare name is a different package entirely", async () => {
    // `@scope/vuln-lib` and `vuln-lib` share a bare-ish name and nothing
    // else. A finding about the unscoped install must not be answered
    // with anything established about the scoped one, and vice versa.
    const scoped = await workspace.materialize({
      files: {
        ...INSTALLED_LIB,
        "node_modules/@scope/vuln-lib/package.json": JSON.stringify({
          name: "@scope/vuln-lib",
          version: "1.0.0",
        }),
        "node_modules/@scope/vuln-lib/index.js": LIB_CJS,
        "src/index.js":
          'const { vulnerable } = require("@scope/vuln-lib");\n' +
          "function main(){ return vulnerable(1); }\nmodule.exports = { main };\n",
      },
      entries: ["src/index.js"],
      installs: ["node_modules/vuln-lib"],
      findingInstall: "node_modules/vuln-lib",
    });

    const outcome = await runProof(scoped.inputs);

    // The SCOPED package's vulnerable export is genuinely called. The
    // finding is about the UNSCOPED install, which nothing loads.
    expect(outcome.verdict).toBe("NOT_AFFECTED");
    expect(outcome.family).toBe("A");
    expect(outcome.proofPackageInstance).toBe(
      scoped.instances.get("node_modules/vuln-lib"),
    );
    expect(outcome.proofPackageInstance).not.toContain("@scope");
    expectExactlyOneProof(outcome);
  });

  it("a proof's instance always equals the finding's instance, across every family", async () => {
    // One invariant over all three baselines rather than three separate
    // spot checks: whatever family answers, the instance it names is the
    // one that was asked about.
    for (const proof of [familyA, familyB]) {
      const outcome = await runProof(proof.inputs);
      expect(outcome.proofPackageInstance).toBe(proof.inputs.packageInstance);
    }
    // Family C's evidence is about the TARGET, not an instance -- it
    // carries no `packageInstance` at all, deliberately (see
    // ConfirmedUnreachableTarget), so there is nothing to mis-name.
    const c = await runProof(familyC.inputs);
    expect(c.proofPackageInstance).toBeUndefined();
    expect(c.proofTarget).toBeDefined();
  });
});

// ====================================================================
// TARGET IDENTITY MUTATIONS (F4 § 14)
// ====================================================================

describe("F4 target identity mutations: no proof borrowing", () => {
  it("a same-named export in a SIBLING package cannot answer for this one", async () => {
    // `other-lib` publishes an export called `vulnerable` and it is
    // genuinely called. The advisory is about `vuln-lib`. Nothing about
    // the sibling may become evidence -- in either direction: no false
    // AFFECTED from the sibling's reachable call, and no proof about the
    // sibling standing in for this package.
    const sibling = await workspace.materialize({
      files: {
        ...INSTALLED_LIB,
        "node_modules/other-lib/package.json": JSON.stringify({
          name: "other-lib",
          version: "1.0.0",
        }),
        "node_modules/other-lib/index.js": LIB_CJS,
        "src/index.js":
          'const { vulnerable } = require("other-lib");\n' +
          "function main(){ return vulnerable(1); }\nmodule.exports = { main };\n",
      },
      entries: ["src/index.js"],
      installs: ["node_modules/vuln-lib"],
      findingInstall: "node_modules/vuln-lib",
    });

    const outcome = await runProof(sibling.inputs);

    expect(outcome.verdict).not.toBe("AFFECTED");
    expect(outcome.family).toBe("A");
    expect(outcome.proofPackageInstance).toBe(
      sibling.instances.get("node_modules/vuln-lib"),
    );
    expect(outcome.proofPackageInstance).not.toContain("other-lib");
    expectExactlyOneProof(outcome);
  });

  it("a lookalike target node in a sibling root cannot supply family C's witness", async () => {
    // The mutation inserts a node with the advisory's export name, at the
    // same structural shape, inside a DIFFERENT package root. Family C's
    // witness must still come from the finding's own authoritative public
    // entry, so the verdict and the reported target are unchanged.
    const lookalikeRoot = `${familyC.root}/node_modules/impostor-lib`;
    const outcome = await runProof(
      mutate(familyC.inputs, {
        graph: graphWithNode(familyC.inputs.graph, {
          id: `${lookalikeRoot}/index.js#vulnerable@1:1`,
          kind: "function",
          module: `${lookalikeRoot}/index.js`,
          name: "vulnerable",
          location: { file: `${lookalikeRoot}/index.js`, line: 1, column: 1 },
        }),
      }),
    );

    expect(outcome.family).toBe("C");
    expect(outcome.proofTarget).toEqual({
      module: "vuln-lib",
      export: "vulnerable",
    });
    expectExactlyOneProof(outcome);
  });

  it("removing the authoritative target withdraws family C rather than substituting a lookalike", async () => {
    // The sharp version of the previous case: the real target node is
    // REMOVED and a same-named node in a sibling root is added in the
    // same breath. If attribution could fall back to "some node with this
    // name", this is where it would -- and a NOT_AFFECTED would then be
    // certified against a symbol in a package the advisory is not about.
    const lookalikeRoot = `${familyC.root}/node_modules/impostor-lib`;
    const outcome = await runProof(
      mutate(familyC.inputs, {
        graph: graphWithNode(
          graphWithoutNode(
            familyC.inputs.graph,
            `${familyC.root}/node_modules/vuln-lib/index.js#vulnerable@1:1`,
          ),
          {
            id: `${lookalikeRoot}/index.js#vulnerable@1:1`,
            kind: "function",
            module: `${lookalikeRoot}/index.js`,
            name: "vulnerable",
            location: {
              file: `${lookalikeRoot}/index.js`,
              line: 1,
              column: 1,
            },
          },
        ),
      }),
    );

    expect(outcome.verdict).toBe("UNKNOWN");
    expect(outcome.family).toBe("NONE");
    expect(outcome.unknownReasons.map((reason) => reason.reason)).toContain(
      "vulnerable_target_unresolved",
    );
    expectExactlyOneProof(outcome);
  });

  it("a target whose module resolves OUTSIDE the finding's instance establishes nothing", async () => {
    // Site B's ownership gate, reached as a mutation: the advisory's
    // module still resolves, but to a file that does not belong to this
    // finding's package instance. Neither an authoritative target nor a
    // negative proof may be built from it.
    const outcome = await runProof(
      mutate(familyA.inputs, {
        packageInstance: `${familyA.root}/node_modules/a-package-that-owns-nothing`,
      }),
    );

    expect(outcome.verdict).toBe("UNKNOWN");
    expect(outcome.reasons.join(" ")).toContain(
      "does not belong to this finding's package instance",
    );
    expectExactlyOneProof(outcome);
  });
});

// ====================================================================
// ANALYSISPROOFCONTEXT MUTATIONS (F4 § 11) AND IMMUTABILITY (F4 § 12)
// ====================================================================

describe("F4 AnalysisProofContext mutations: every mismatch fails closed", () => {
  /**
   * A DONOR project: same layout, different root, nothing loaded. Its
   * closure is complete and -- trivially, because the paths are another
   * project's -- contains none of the victim's install locations. That is
   * exactly the shape that once forged a family-A NOT_AFFECTED.
   */
  async function donor(): Promise<MaterializedProof> {
    return workspace.materialize(FAMILY_A_PROJECT);
  }

  it("a foreign closure is DROPPED, not read as absence evidence", async () => {
    const victim = familyC;
    const other = await donor();

    const outcome = await runProofWithContext(
      victim.inputs,
      contextFor(
        mutate(victim.inputs, {
          moduleLoadClosure: other.inputs.moduleLoadClosure,
        }),
      ),
    );

    expect(outcome.verdict).toBe("UNKNOWN");
    expect(outcome.family).toBe("NONE");
    expect(outcome.unknownReasons.map((reason) => reason.reason)).toContain(
      "module_load_closure_unavailable",
    );
    expectExactlyOneProof(outcome);
  });

  it("a foreign GRAPH cannot certify this project's instance", async () => {
    const victim = familyC;
    const other = await donor();

    const outcome = await runProofWithContext(
      victim.inputs,
      contextFor(mutate(victim.inputs, { graph: other.inputs.graph })),
    );

    // The donor graph does not cover these entrypoints, so the context
    // also drops the closure -- one integrity failure, one conservative
    // answer.
    expect(outcome.verdict).toBe("UNKNOWN");
    expect(outcome.family).toBe("NONE");
    expectExactlyOneProof(outcome);
  });

  it("swapping the entrypoints AND the closure together still forges nothing", async () => {
    // The root check alone is defeatable by moving the pair together;
    // the graph-coverage check is what closes it.
    const victim = familyC;
    const other = await donor();

    const outcome = await runProofWithContext(
      victim.inputs,
      contextFor(
        mutate(victim.inputs, {
          entrypoints: other.inputs.entrypoints,
          moduleLoadClosure: other.inputs.moduleLoadClosure,
        }),
      ),
    );

    expect(outcome.verdict).toBe("UNKNOWN");
    expect(outcome.family).toBe("NONE");
    expectExactlyOneProof(outcome);
  });

  it("a STALE context -- same project, earlier entrypoint set -- is a different proof context", async () => {
    // Not a foreign project at all: the same files, analyzed over a
    // different root set. "Unreachable from these roots" is not
    // transferable to other roots, and the binding must say so.
    const stale = await workspace.materialize({
      ...FAMILY_C_PROJECT,
      files: {
        ...FAMILY_C_PROJECT.files,
        "src/other.js":
          "function other(){ return 2; }\nmodule.exports = { other };\n",
      },
      entries: ["src/other.js"],
    });

    const outcome = await runProofWithContext(
      stale.inputs,
      contextFor(
        mutate(stale.inputs, {
          moduleLoadClosure: closureWithRoots(closureOf(stale), [
            `${stale.root}/src/index.js`,
          ]),
        }),
      ),
    );

    expect(outcome.verdict).toBe("UNKNOWN");
    expect(outcome.family).toBe("NONE");
    expectExactlyOneProof(outcome);
  });

  it("a mutated graphTruncated inside the context is honoured, not ignored", async () => {
    const outcome = await runProofWithContext(
      familyC.inputs,
      contextFor(mutate(familyC.inputs, { graphTruncated: true })),
    );

    expect(outcome.verdict).toBe("UNKNOWN");
    expect(outcome.unknownReasons.map((reason) => reason.reason)).toContain(
      "call_graph_truncated",
    );
  });

  it("an UNBRANDED object cast into the parameter withdraws every proof", async () => {
    // The type system rejects this at compile time; the runtime mark is
    // what catches a caller who reaches for a cast once it does.
    const fabricated = {
      projectRoot: familyC.inputs.projectRoot,
      resolver: familyC.inputs.resolver,
      entrypoints: familyC.inputs.entrypoints,
      knownPackageRoots: familyC.inputs.knownPackageRoots,
      graph: familyC.inputs.graph,
      graphTruncated: false,
      moduleLoadClosure: familyC.inputs.moduleLoadClosure,
    } as unknown as AnalysisProofContext;

    expect(isAnalysisProofContext(fabricated)).toBe(false);

    const outcome = await runProofWithContext(familyC.inputs, fabricated);

    expect(outcome.verdict).toBe("UNKNOWN");
    expect(outcome.family).toBe("NONE");
    expectExactlyOneProof(outcome);
  });

  it("a THAWED copy of a real context loses the mark and fails closed", async () => {
    // Spreading a genuine context copies its enumerable fields and leaves
    // the non-enumerable mark behind. A caller who does this to "just
    // change one field" gets a conservative answer, not a forged one.
    const real = contextFor(familyC.inputs);
    const thawed = { ...real } as unknown as AnalysisProofContext;

    expect(isAnalysisProofContext(real)).toBe(true);
    expect(isAnalysisProofContext(thawed)).toBe(false);

    const outcome = await runProofWithContext(familyC.inputs, thawed);
    expect(outcome.verdict).toBe("UNKNOWN");
    expect(outcome.family).toBe("NONE");
  });

  it("proof-critical fields cannot be rewritten after construction", async () => {
    // F4 § 12. The context is frozen, so a post-hoc write cannot redefine
    // what a proof was established over. Asserted as OBSERVED behavior
    // (strict mode throws) rather than assumed.
    const context = contextFor(familyC.inputs);

    expect(Object.isFrozen(context)).toBe(true);
    expect(() => {
      (context as { graphTruncated: boolean }).graphTruncated = true;
    }).toThrow();
    expect(() => {
      (context as { moduleLoadClosure: undefined }).moduleLoadClosure =
        undefined;
    }).toThrow();
    expect(Object.isFrozen(context.entrypoints)).toBe(true);
    expect(() => {
      (context.entrypoints as Entrypoint[]).push({
        filePath: "/injected.js",
        source: "configured",
        reason: "f4",
      });
    }).toThrow();

    // The verdict is unchanged by the attempts.
    const outcome = await runProofWithContext(familyC.inputs, context);
    expect(outcome.family).toBe("C");
  });

  it("the NESTED closure object is mutable, and that is contained rather than exploitable", async () => {
    // Honest statement of the residual (F4 § 12): `Object.freeze` is
    // shallow, so the ModuleLoadClosure the context holds is still a
    // mutable object. Whether that is a vulnerability depends on reach,
    // and the reach is the point: the closure is built by the scan,
    // handed to the context, and never exposed on the Finding, so there
    // is no route from an analyzed PROJECT's contents to a write on it.
    // The only writer is code inside the process that already holds the
    // context -- i.e. code that could call `buildFinding` with anything it
    // liked in the first place.
    //
    // Recorded as a test, not redesigned: a deep freeze would copy every
    // closure on every scan to close a hole nothing can reach through.
    // What IS asserted is that such a write cannot go unnoticed -- it
    // changes the verdict, in the safe direction.
    const context = contextFor(familyC.inputs);
    const closure = context.moduleLoadClosure!;
    expect(Object.isFrozen(closure)).toBe(false);

    const before = await runProofWithContext(familyC.inputs, context);
    expect(before.family).toBe("C");

    // A write that WEAKENS the evidence must weaken the verdict too.
    const tampered = contextFor(
      mutate(familyC.inputs, {
        moduleLoadClosure: closureIncomplete(closure, "parse_failure"),
      }),
    );
    const after = await runProofWithContext(familyC.inputs, tampered);
    expect(after.verdict).toBe("UNKNOWN");
  });

  it("ATTACK: a blocker DELETED IN PLACE after the context was built does change the answer", async () => {
    // The sharpest form of the residual above, and the one worth stating
    // as a result rather than a caveat: not "could someone weaken the
    // evidence", but "could someone STRENGTHEN it after the fact" -- take
    // a scan whose closure genuinely recorded a loader mutation, and
    // delete that record from the live object the frozen context holds.
    //
    // The answer is YES, it changes the verdict. That is what shallow
    // freezing means, demonstrated instead of assumed.
    //
    // It is NOT fixed here, and the reason is reach rather than
    // convenience. This write has no attacker. The closure is constructed
    // by the scan, handed to the context, and never published on a
    // `Finding`, so nothing an analyzed PROJECT contains -- which is the
    // only untrusted input VulnTrace has -- can reach it. The sole party
    // able to perform this write is code already holding the context,
    // which could equally have called `buildFinding` with a fabricated
    // closure to begin with. A deep freeze would copy every closure on
    // every scan to close a door that opens onto nothing, and F4's scope
    // is explicit that production changes need a concrete exploit.
    //
    // What this test buys is that the situation cannot change silently:
    // if a future change ever DOES expose the closure to untrusted input,
    // this assertion is the statement of what that would then mean.
    const loaderMutated = await workspace.materialize({
      files: {
        ...INSTALLED_LIB,
        "src/index.js":
          'const { safe } = require("vuln-lib");\n' +
          'require.extensions[".js"] = function(){};\n' +
          "function main(){ return safe(1); }\nmodule.exports = { main };\n",
      },
      entries: ["src/index.js"],
      installs: ["node_modules/vuln-lib"],
      findingInstall: "node_modules/vuln-lib",
    });

    // The genuine, unmutated answer: a real loader hook, honestly blocking.
    const context = contextFor(loaderMutated.inputs);
    const honest = await runProofWithContext(loaderMutated.inputs, context);
    expect(honest.verdict).toBe("UNKNOWN");
    expect(honest.unknownReasons.map((reason) => reason.reason)).toContain(
      "loader_hook_mutation",
    );

    // Now delete the blocker IN PLACE, through the frozen context.
    const live = context.moduleLoadClosure!;
    expect(live.complete).toBe(false);
    expect(live.incompleteness.length).toBeGreaterThan(0);
    const writable = live as unknown as {
      incompleteness: unknown[];
      complete: boolean;
    };
    writable.incompleteness = [];
    writable.complete = true;

    const forged = await runProofWithContext(loaderMutated.inputs, context);

    // Recorded as the OBSERVED consequence, not asserted as desirable.
    expect(forged.verdict).toBe("NOT_AFFECTED");
    expect(forged.family).toBe("C");
    expectExactlyOneProof(forged);
  });

  it("the taxonomy is downstream of every verdict, never an input to one", async () => {
    // F4 § 18 / attack K. A structural property, asserted behaviorally: a
    // verdict that CARRIES a negative proof has no `unknownReasons` at
    // all, and every UNKNOWN has them. The taxonomy is therefore only
    // ever written after a decision, never read before one -- which is
    // what makes every taxonomy assertion in this suite observational and
    // the proof invariant independent of it.
    for (const proof of [familyA, familyB, familyC]) {
      const outcome = await runProof(proof.inputs);
      expect(outcome.verdict).toBe("NOT_AFFECTED");
      expect(outcome.unknownReasons).toEqual([]);
    }

    const degraded = await runProof(
      mutate(familyC.inputs, { moduleLoadClosure: undefined }),
    );
    expect(degraded.verdict).toBe("UNKNOWN");
    expect(degraded.unknownReasons.length).toBeGreaterThan(0);
  });
});

// ====================================================================
// UNKNOWN MONOTONICITY (F4 § 19) AND RESTORATION (F4 § 20)
// ====================================================================

describe("F4 monotonicity: added uncertainty can never restore confidence", () => {
  const LADDERS: readonly {
    readonly family: ProofFamily;
    readonly baseline: () => MaterializedProof;
    readonly steps: readonly {
      readonly name: string;
      readonly apply: (
        inputs: ProofInputs,
        base: MaterializedProof,
      ) => ProofInputs;
    }[];
  }[] = [
    {
      family: "C",
      baseline: () => familyC,
      steps: [
        {
          name: "closure absent",
          apply: (inputs) => mutate(inputs, { moduleLoadClosure: undefined }),
        },
        {
          name: "+ graph truncated",
          apply: (inputs) => mutate(inputs, { graphTruncated: true }),
        },
        {
          name: "+ unresolved edge in the reachable subgraph",
          apply: (inputs, base) =>
            mutate(inputs, {
              graph: graphWithUnresolvedEdge(
                inputs.graph,
                base.entryFiles,
                "unsupported_construct",
              ),
            }),
        },
        {
          name: "+ target node removed",
          apply: (inputs, base) =>
            mutate(inputs, {
              graph: graphWithoutNode(
                inputs.graph,
                `${base.root}/node_modules/vuln-lib/index.js#vulnerable@1:1`,
              ),
            }),
        },
      ],
    },
    {
      family: "B",
      baseline: () => familyB,
      steps: [
        {
          name: "closure incomplete",
          apply: (inputs, base) =>
            mutate(inputs, {
              moduleLoadClosure: closureIncomplete(
                closureOf(base),
                "parse_failure",
              ),
            }),
        },
        {
          name: "+ widening construct reachable",
          apply: (inputs, base) =>
            mutate(inputs, {
              graph: graphWithWideningEdge(inputs.graph, base.entryFiles),
            }),
        },
        {
          name: "+ graph truncated",
          apply: (inputs) => mutate(inputs, { graphTruncated: true }),
        },
      ],
    },
  ];

  for (const ladder of LADDERS) {
    it(`family ${ladder.family}: each additional uncertainty keeps the verdict at UNKNOWN`, async () => {
      const base = ladder.baseline();
      const start = await runProof(base.inputs);
      expect(start.verdict).toBe("NOT_AFFECTED");
      expect(start.family).toBe(ladder.family);

      let inputs = base.inputs;
      const trail: string[] = [];
      for (const step of ladder.steps) {
        inputs = step.apply(inputs, base);
        trail.push(step.name);
        const outcome = await runProof(inputs);

        expect(
          outcome.verdict,
          `after [${trail.join(", ")}] the verdict recovered:\n${describeOutcome(outcome)}`,
        ).toBe("UNKNOWN");
        expect(outcome.family).toBe("NONE");
        expectExactlyOneProof(outcome);
      }
    });
  }

  it("family A: piling uncertainty onto an already-withdrawn proof never brings it back", async () => {
    // Family A's first step is deliberately one that hands over to family
    // C (the audited takeover), so this ladder also proves the SECOND
    // uncertainty cannot resurrect A -- it can only take C away too.
    let inputs = mutate(familyA.inputs, {
      moduleLoadClosure: closureIncomplete(
        closureOf(familyA),
        "traversal_truncated",
      ),
    });
    const afterFirst = await runProof(inputs);
    expect(afterFirst.family).toBe("C");

    inputs = mutate(inputs, { graphTruncated: true });
    const afterSecond = await runProof(inputs);
    expect(afterSecond.verdict).toBe("UNKNOWN");
    expect(afterSecond.family).toBe("NONE");

    inputs = mutate(inputs, { moduleLoadClosure: undefined });
    const afterThird = await runProof(inputs);
    expect(afterThird.verdict).toBe("UNKNOWN");
    expect(afterThird.family).toBe("NONE");
    expectExactlyOneProof(afterThird);
  });
});

describe("F4 restoration: the mutation is causal, not incidental", () => {
  const RESTORATIONS: readonly {
    readonly family: ProofFamily;
    readonly baseline: () => MaterializedProof;
    readonly mutation: string;
    readonly apply: (
      inputs: ProofInputs,
      base: MaterializedProof,
    ) => ProofInputs;
  }[] = [
    {
      family: "A",
      baseline: () => familyA,
      mutation: "closure absent",
      apply: (inputs) => mutate(inputs, { moduleLoadClosure: undefined }),
    },
    {
      family: "B",
      baseline: () => familyB,
      mutation: "closure incomplete",
      apply: (inputs, base) =>
        mutate(inputs, {
          moduleLoadClosure: closureIncomplete(
            closureOf(base),
            "parse_failure",
          ),
        }),
    },
    {
      family: "B",
      baseline: () => familyB,
      mutation: "graph truncated",
      apply: (inputs) => mutate(inputs, { graphTruncated: true }),
    },
    {
      family: "C",
      baseline: () => familyC,
      mutation: "reachable subgraph incomplete",
      apply: (inputs, base) =>
        mutate(inputs, {
          graph: graphWithUnresolvedEdge(
            inputs.graph,
            base.entryFiles,
            "unsupported_construct",
          ),
        }),
    },
  ];

  for (const restoration of RESTORATIONS) {
    it(`family ${restoration.family} / ${restoration.mutation}: remove -> UNKNOWN -> restore -> the SAME family`, async () => {
      const base = restoration.baseline();

      const before = await runProof(base.inputs);
      expect(before.family).toBe(restoration.family);

      const mutated = await runProof(restoration.apply(base.inputs, base));
      expect(mutated.family).not.toBe(restoration.family);
      expect(mutated.verdict).toBe("UNKNOWN");

      // Restoring means handing back the ORIGINAL inputs, unchanged -- the
      // mutation was a copy, so this is a genuine restore rather than an
      // inverse operation that might not be one.
      const after = await runProof(base.inputs);
      expect(after.verdict).toBe("NOT_AFFECTED");
      expect(after.family).toBe(restoration.family);
      expect(after.proofPackageInstance).toBe(before.proofPackageInstance);
      expect(after.proofTarget).toEqual(before.proofTarget);
    });
  }
});

// ====================================================================
// COMPOSITION ATTACKS (F4 § 23)
// ====================================================================

describe("F4 composition: two bad inputs never cancel into confidence", () => {
  const COMPOSITIONS: readonly {
    readonly name: string;
    readonly baseline: () => MaterializedProof;
    readonly apply: (
      inputs: ProofInputs,
      base: MaterializedProof,
    ) => ProofInputs;
    /**
     * `false` for the one composition that legitimately hands over rather
     * than degrading. Its own invariant -- that the surviving proof names
     * the MUTATED instance and never borrows the baseline's identity -- is
     * asserted separately below.
     */
    readonly expectUnknown?: boolean;
  }[] = [
    {
      name: "closure absent + graph truncated",
      baseline: () => familyC,
      apply: (inputs) =>
        mutate(inputs, {
          moduleLoadClosure: undefined,
          graphTruncated: true,
        }),
    },
    {
      name: "wrong instance + lookalike target node",
      baseline: () => familyC,
      // Both halves are identity attacks, and neither creates confidence
      // about the baseline's instance: the advisory's package name still
      // selects `vuln-lib`, so the inserted `impostor-lib` node is not a
      // candidate at all, and the instance mismatch withdraws family C.
      // What remains is a family-B absence proof ABOUT THE IMPOSTOR PATH
      // -- vacuously true, since nothing is installed there, and audited
      // for identity below rather than asserted to be UNKNOWN.
      expectUnknown: false,
      apply: (inputs, base) =>
        mutate(inputs, {
          packageInstance: `${base.root}/node_modules/impostor-lib`,
          graph: graphWithNode(inputs.graph, {
            id: `${base.root}/node_modules/impostor-lib/index.js#vulnerable@1:1`,
            kind: "function",
            module: `${base.root}/node_modules/impostor-lib/index.js`,
            name: "vulnerable",
            location: {
              file: `${base.root}/node_modules/impostor-lib/index.js`,
              line: 1,
              column: 1,
            },
          }),
        }),
    },
    {
      name: "closure says loaded + closure incomplete",
      baseline: () => familyA,
      apply: (inputs, base) =>
        mutate(inputs, {
          moduleLoadClosure: closureIncomplete(
            closureLoads(closureOf(base), inputs.packageInstance!),
            "parse_failure",
          ),
        }),
    },
    {
      name: "loader mutation recorded + target unreachable",
      baseline: () => familyC,
      apply: (inputs, base) =>
        mutate(inputs, {
          moduleLoadClosure: closureWithBlocker(
            closureOf(base),
            "loader_hook_mutation",
          ),
          graph: graphWithoutNode(
            inputs.graph,
            `${base.root}/node_modules/vuln-lib/index.js#safe@2:1`,
          ),
        }),
    },
    {
      name: "widening edge + closure truncated",
      baseline: () => familyB,
      apply: (inputs, base) =>
        mutate(inputs, {
          graph: graphWithWideningEdge(inputs.graph, base.entryFiles),
          moduleLoadClosure: closureIncomplete(
            closureOf(base),
            "traversal_truncated",
          ),
        }),
    },
    {
      name: "foreign closure + wrong instance",
      baseline: () => familyA,
      apply: (inputs, base) =>
        mutate(inputs, {
          moduleLoadClosure: closureWithRoots(closureOf(base), [
            "/elsewhere/index.js",
          ]),
          packageInstance: `${base.root}/node_modules/impostor-lib`,
        }),
    },
  ];

  for (const composition of COMPOSITIONS) {
    it(`${composition.name} -> no negative proof survives`, async () => {
      const base = composition.baseline();
      const before = await runProof(base.inputs);
      const outcome = await runProof(composition.apply(base.inputs, base));

      expect(
        outcome.family,
        `the original family survived a COMPOSITE mutation:\n${describeOutcome(outcome)}`,
      ).not.toBe(before.family);
      expectExactlyOneProof(outcome);

      if (composition.expectUnknown ?? true) {
        expect(outcome.verdict).toBe("UNKNOWN");
        expect(outcome.family).toBe("NONE");
      } else {
        // The takeover case: whatever answers must be about the MUTATED
        // identity, never the baseline's. That is the property "two bad
        // inputs did not cancel into confidence" actually means here.
        expect(outcome.proofPackageInstance).not.toBe(
          base.inputs.packageInstance,
        );
        expect(outcome.proofTarget).toBeUndefined();
      }

      ledger.record({
        family: before.family,
        mutation: `composite:${composition.name}`,
        classification:
          outcome.verdict === "UNKNOWN"
            ? "invalidated_to_unknown"
            : "invalidated_by_takeover",
        verdict: outcome.verdict,
        resultingFamily: outcome.family,
      });
    });
  }
});

// ====================================================================
// THE CONTRACTS, RE-ASSERTED UNDER MUTATION (F4 § 9, § 10)
// ====================================================================

describe("F4 contracts hold under every mutation the suite performed", () => {
  it("VT-CONTRACT-01: no mutation produced a proof-less or double-proof NOT_AFFECTED", () => {
    // `expectExactlyOneProof` ran on every single outcome above. This
    // records that the coverage was universal rather than sampled, by
    // asserting the ledger is non-trivially populated -- an empty ledger
    // would make the per-row checks vacuous.
    const records = ledger.all();
    expect(records.length).toBeGreaterThan(30);
    expect(new Set(records.map((record) => record.family))).toEqual(
      new Set(["A", "B", "C"]),
    );
  });

  it("VT-CONTRACT-02: every surviving family C proof names the REACHABLE SUBGRAPH", async () => {
    // The renamed field, asserted on a proof produced under mutation
    // rather than only on a pristine baseline. `callGraphComplete` -- the
    // overstated name this replaced -- must not reappear.
    const survivors = [
      await runProof(familyC.inputs),
      await runProof(
        mutate(familyA.inputs, {
          moduleLoadClosure: closureIncomplete(
            closureOf(familyA),
            "traversal_truncated",
          ),
        }),
      ),
      await runProof(
        mutate(familyC.inputs, {
          moduleLoadClosure: closureForgets(
            closureOf(familyC),
            familyC.inputs.packageInstance!,
          ),
        }),
      ),
    ];

    for (const outcome of survivors) {
      const proof = outcome.finding?.evidence?.confirmedUnreachableTarget;
      expect(proof?.reachableSubgraphComplete).toBe(true);
      expect(Object.keys(proof ?? {})).not.toContain("callGraphComplete");
      expect(JSON.stringify(outcome.finding)).not.toContain(
        "callGraphComplete",
      );
    }
  });

  it("family B's evidence never reintroduces callGraphComplete either", async () => {
    const outcome = await runProof(familyB.inputs);
    const proof = outcome.finding?.evidence?.confirmedAbsentInstance;
    expect(proof?.graphTruncated).toBe(false);
    expect(proof?.moduleLoadClosureComplete).toBe(true);
    expect(Object.keys(proof ?? {})).not.toContain("callGraphComplete");
  });
});

// ====================================================================
// THE FALSE-NOT_AFFECTED METRIC (F4 § 28)
// ====================================================================

describe("F4 mutation summary", () => {
  it("reports the distribution, and zero unsafe survivals", () => {
    const summary = ledger.summary();

    // The number that matters. Everything else is descriptive.
    expect(
      summary.unsafe_survival,
      `an invalidated proof survived its own mutation:\n${JSON.stringify(
        ledger
          .all()
          .filter((record) => record.classification === "unsafe_survival"),
        undefined,
        2,
      )}`,
    ).toBe(0);

    // The suite must actually have DONE something -- a harness that
    // silently stopped running its matrix would otherwise report a
    // perfect score.
    expect(summary.total).toBeGreaterThan(30);
    expect(summary.invalidated_to_unknown).toBeGreaterThan(0);
    expect(summary.invalidated_by_takeover).toBeGreaterThan(0);
    expect(summary.invalidated_to_affected).toBeGreaterThan(0);
    expect(summary.not_a_prerequisite).toBeGreaterThan(0);

    // Printed so the record's numbers can be regenerated rather than
    // hand-maintained.
    console.log("F4 mutation summary:", JSON.stringify(summary, undefined, 2));
  });
});
