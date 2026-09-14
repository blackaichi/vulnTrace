import { describe, expect, it } from "vitest";
import { isClosureWideningReason, type DynamicCallReason } from "./graph.js";
import {
  aggregateUncertainty,
  classifyUncertaintyReason,
  UNCERTAINTY_CATEGORIES,
  UNCERTAINTY_REASON_CATEGORY,
  UNCERTAINTY_REASONS,
  type UncertaintyReason,
} from "./uncertainty.js";

/**
 * FOUNDATION F3 -- the taxonomy's own properties, independent of any
 * verdict.
 *
 * Everything here is about the MAPPING: that it covers every reason, that
 * it is not secretly the widening boolean wearing a hat, that aggregation
 * preserves every blocker and picks no favourite, and that its output
 * ordering is a function of the taxonomy rather than of observation order.
 *
 * The verdict-level consequences -- that classification never moves a
 * verdict, that RWB-05 stays UNKNOWN, that out-of-range stays a
 * no-finding -- live in `verdict.f3-uncertainty-taxonomy.test.ts` and
 * `cli/scan.f3-no-finding.test.ts`, because those need a real graph and a
 * real scan to mean anything.
 */

/** Every `DynamicCallReason`, listed here so a new one fails this file too. */
const ALL_DYNAMIC_CALL_REASONS: readonly DynamicCallReason[] = [
  "dynamic_member_access",
  "dynamic_require",
  "dynamic_import",
  "eval",
  "unresolved_module",
  "unresolved_target",
  "unsupported_construct",
  "declaration_only_resolution",
  "aliased_require",
  "create_require",
  "function_constructor",
  "aliased_eval",
  "module_require",
  "module_internal_load",
  "vm_execution",
  "worker_execution",
  "child_process_execution",
  "loader_hook_mutation",
  "loader_capability_escape",
];

describe("F3: the taxonomy covers every reason exactly once", () => {
  it("classifies every DynamicCallReason", () => {
    for (const reason of ALL_DYNAMIC_CALL_REASONS) {
      expect(UNCERTAINTY_REASON_CATEGORY[reason]).toBeDefined();
      expect(UNCERTAINTY_CATEGORIES).toContain(
        UNCERTAINTY_REASON_CATEGORY[reason],
      );
    }
  });

  it("maps every declared reason into a declared category, with no orphans in either direction", () => {
    const mapped = Object.keys(UNCERTAINTY_REASON_CATEGORY).sort();
    expect(mapped).toEqual([...UNCERTAINTY_REASONS].sort());

    // Every category is actually USED. A category nothing maps to is a
    // category nobody validated the meaning of, and it would show up in a
    // corpus measurement as a permanent zero that looks like good news.
    const used = new Set(Object.values(UNCERTAINTY_REASON_CATEGORY));
    for (const category of UNCERTAINTY_CATEGORIES) {
      expect(used).toContain(category);
    }
  });

  it("declares no duplicate tokens", () => {
    expect(new Set(UNCERTAINTY_REASONS).size).toBe(UNCERTAINTY_REASONS.length);
    expect(new Set(UNCERTAINTY_CATEGORIES).size).toBe(
      UNCERTAINTY_CATEGORIES.length,
    );
  });
});

describe("F3 § 13: category and closure-widening are ORTHOGONAL", () => {
  /**
   * The single most important negative property in this file.
   *
   * `isClosureWideningReason` is a SOUNDNESS boundary the proof rules
   * consume; the category is an explanation for humans and dashboards. If
   * one could be derived from the other, a future edit to either would
   * silently move the other -- and the one that moves verdicts is the
   * widening boolean.
   *
   * Proven by exhibiting both cross-pairs, so the two axes are
   * demonstrably independent rather than merely intended to be.
   */
  it("has widening reasons in several different categories", () => {
    const wideningCategories = new Set(
      ALL_DYNAMIC_CALL_REASONS.filter(isClosureWideningReason).map(
        (reason) => UNCERTAINTY_REASON_CATEGORY[reason],
      ),
    );
    expect(wideningCategories.size).toBeGreaterThan(1);
    expect(wideningCategories).toContain("capability_escape");
    // `unresolved_module` widens -- an unknown module can require anything
    // -- but the uncertainty is about which module it IS.
    expect(wideningCategories).toContain("identity_unresolved");
    // `declaration_only_resolution` widens too, and is neither of those:
    // the module resolved, onto a file with no executable bodies.
    expect(wideningCategories).toContain("analysis_precondition_unmet");
  });

  it("has non-widening reasons in several different categories", () => {
    const nonWideningCategories = new Set(
      ALL_DYNAMIC_CALL_REASONS.filter(
        (reason) => !isClosureWideningReason(reason),
      ).map((reason) => UNCERTAINTY_REASON_CATEGORY[reason]),
    );
    expect(nonWideningCategories.size).toBeGreaterThan(1);
    expect(nonWideningCategories).toContain("unmodeled_construct");
    expect(nonWideningCategories).toContain("value_uncertainty");
    expect(nonWideningCategories).toContain("identity_unresolved");
  });

  it("does not put every widening reason in capability_escape, nor every escape in widening", () => {
    // If the two axes were the same fact, these two sets would be equal.
    const widening = new Set(
      ALL_DYNAMIC_CALL_REASONS.filter(isClosureWideningReason),
    );
    const escapes = new Set(
      ALL_DYNAMIC_CALL_REASONS.filter(
        (reason) => UNCERTAINTY_REASON_CATEGORY[reason] === "capability_escape",
      ),
    );
    expect(widening).not.toEqual(escapes);
    expect([...widening].some((reason) => !escapes.has(reason))).toBe(true);
  });
});

describe("F3 § 9/§ 7: capability escapes are never filed as coverage gaps", () => {
  /**
   * Self-review attack D. Filing `eval` under `unmodeled_construct` would
   * put permanently unfixable work at the top of the P1-B roadmap, which
   * is the one decision this taxonomy exists to inform.
   */
  const ESCAPES: readonly UncertaintyReason[] = [
    "eval",
    "aliased_eval",
    "function_constructor",
    "vm_execution",
    "worker_execution",
    "child_process_execution",
    "dynamic_require",
    "dynamic_import",
    "aliased_require",
    "create_require",
    "module_require",
    "module_internal_load",
    "loader_hook_mutation",
    "loader_capability_escape",
  ];

  for (const reason of ESCAPES) {
    it(`classifies ${reason} as capability_escape, not unmodeled_construct`, () => {
      expect(UNCERTAINTY_REASON_CATEGORY[reason]).toBe("capability_escape");
    });
  }

  it("keeps budget exhaustion out of unmodeled_construct (attack E)", () => {
    // A configured bound is closed by changing configuration and by
    // nothing else; calling it a syntax gap would send someone to write a
    // parser for a problem that has no parser.
    expect(UNCERTAINTY_REASON_CATEGORY.traversal_truncated).toBe(
      "budget_exceeded",
    );
    expect(UNCERTAINTY_REASON_CATEGORY.call_graph_truncated).toBe(
      "budget_exceeded",
    );
    expect(UNCERTAINTY_REASON_CATEGORY.workspace_enumeration_truncated).toBe(
      "budget_exceeded",
    );
  });

  it("keeps a parse failure out of unmodeled_construct", () => {
    // The analyzer is not declining a syntax it recognises; it never
    // obtained a usable AST. Filing it as a coverage gap would put "fix
    // the user's broken file" on the frontend roadmap.
    expect(UNCERTAINTY_REASON_CATEGORY.parse_failure).toBe(
      "analysis_precondition_unmet",
    );
  });

  it("classifies F2's module_load_closure_unavailable as analysis state, not a construct (§ 12)", () => {
    expect(UNCERTAINTY_REASON_CATEGORY.module_load_closure_unavailable).toBe(
      "analysis_precondition_unmet",
    );
  });
});

describe("F3 § 19/§ 20: aggregation preserves every blocker", () => {
  it("keeps multiple independent blockers rather than picking one", () => {
    const aggregated = aggregateUncertainty([
      "eval",
      "dynamic_member_access",
      "unsupported_construct",
    ]);
    expect(aggregated.map((entry) => entry.reason).sort()).toEqual([
      "dynamic_member_access",
      "eval",
      "unsupported_construct",
    ]);
    // No entry is marked primary, dominant, or first-among-equals: the
    // shape has no field that could express it.
    for (const entry of aggregated) {
      expect(Object.keys(entry).sort()).toEqual([
        "category",
        "count",
        "reason",
      ]);
    }
  });

  it("deduplicates with counts instead of repeating (attack F)", () => {
    const aggregated = aggregateUncertainty([
      "unsupported_construct",
      "unsupported_construct",
      "unsupported_construct",
      "eval",
    ]);
    expect(aggregated).toEqual([
      {
        category: "unmodeled_construct",
        reason: "unsupported_construct",
        count: 3,
      },
      { category: "capability_escape", reason: "eval", count: 1 },
    ]);
  });

  it("returns an empty array for no observations, never a placeholder", () => {
    expect(aggregateUncertainty([])).toEqual([]);
  });
});

describe("F3 § 27: aggregation output is byte-deterministic", () => {
  /**
   * Attack G. These arrays are produced from graph edge order, blocker
   * order and instance enumeration order, none of which is a stable
   * property of a project. Reversing an input must not permute an output.
   */
  const OBSERVED: readonly UncertaintyReason[] = [
    "eval",
    "unsupported_construct",
    "dynamic_member_access",
    "traversal_truncated",
    "unresolved_module",
    "unsupported_construct",
    "parse_failure",
  ];

  it("is invariant under input reversal", () => {
    const forward = aggregateUncertainty(OBSERVED);
    const backward = aggregateUncertainty([...OBSERVED].reverse());
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });

  it("is invariant under shuffling", () => {
    const reference = JSON.stringify(aggregateUncertainty(OBSERVED));
    // A deterministic pseudo-shuffle, so this test cannot itself flake.
    for (let rotation = 1; rotation < OBSERVED.length; rotation += 1) {
      const rotated = [
        ...OBSERVED.slice(rotation),
        ...OBSERVED.slice(0, rotation),
      ];
      expect(JSON.stringify(aggregateUncertainty(rotated))).toBe(reference);
    }
  });

  it("orders by taxonomy declaration order, NOT by count", () => {
    // Chosen so the two orderings genuinely DISAGREE: `eval` is observed
    // twenty times and `unsupported_construct` once, but
    // `unmodeled_construct` is declared before `capability_escape`, so the
    // RARE one comes first. Sorting by count would make a scan's bytes
    // depend on how often a construct happened to appear -- which is a
    // property of the code being scanned, not of the finding.
    const aggregated = aggregateUncertainty([
      ...Array<UncertaintyReason>(20).fill("eval"),
      "unsupported_construct",
    ]);
    expect(aggregated.map((entry) => [entry.reason, entry.count])).toEqual([
      ["unsupported_construct", 1],
      ["eval", 20],
    ]);
  });

  it("orders categories exactly as UNCERTAINTY_CATEGORIES declares them", () => {
    const oneOfEach: UncertaintyReason[] = [
      "traversal_truncated", // budget_exceeded        (declared last)
      "eval", // capability_escape      (declared third)
      "unsupported_construct", // unmodeled_construct    (declared first)
      "parse_failure", // analysis_precondition  (declared fifth)
      "unresolved_module", // identity_unresolved    (declared fourth)
      "dynamic_member_access", // value_uncertainty      (declared second)
    ];
    expect(aggregateUncertainty(oneOfEach).map((e) => e.category)).toEqual([
      ...UNCERTAINTY_CATEGORIES,
    ]);
  });
});

describe("F3 § 28: an unknown runtime value is never silently dropped", () => {
  /**
   * Attack I, and attack H's runtime half. The compile-time half is
   * enforced by the `Record` and the type constraints in
   * `analysis/uncertainty.ts`, and was verified directly by adding a probe
   * member to `DynamicCallReason` and confirming all four sites fail to
   * build. This is the other half: a value that reaches here anyway.
   */
  it("classifies an unrecognized reason as capability_escape, the most severe class", () => {
    const rogue = "some_future_reason_nobody_classified" as UncertaintyReason;
    expect(classifyUncertaintyReason(rogue)).toEqual({
      category: "capability_escape",
      reason: "unclassified_uncertainty_reason",
      count: 1,
    });
  });

  it("keeps an unrecognized reason in the aggregate rather than discarding it", () => {
    const rogue = "some_future_reason_nobody_classified" as UncertaintyReason;
    const aggregated = aggregateUncertainty([rogue, "eval", rogue]);

    // Three observations in, three observations out: the rogue value is
    // counted, not dropped. Dropping would understate uncertainty, which
    // is the one direction this analyzer must never err in.
    expect(aggregated.reduce((sum, entry) => sum + entry.count, 0)).toBe(3);
    expect(aggregated).toContainEqual({
      category: "capability_escape",
      reason: "unclassified_uncertainty_reason",
      count: 2,
    });
  });

  it("does not throw on a rogue value", () => {
    // This runs inside a scan whose contract is that uncertainty becomes
    // UNKNOWN rather than an exception. Crashing an end user's scan over
    // an internal enum slip would be strictly worse than the conservative
    // classification the analyzer already knows how to produce.
    expect(() =>
      aggregateUncertainty(["definitely not a reason" as UncertaintyReason]),
    ).not.toThrow();
  });
});
