import type { DynamicCallReason } from "./graph.js";

/**
 * FOUNDATION F3 -- the structured uncertainty taxonomy.
 *
 * WHAT THIS IS NOT. It is not a verdict input. Nothing in this file is
 * read by any branch that decides AFFECTED, NOT_AFFECTED or UNKNOWN, and
 * nothing in it may ever become one. The verdict set stays exactly the
 * three values in `domain/verdict.ts`, and `UNKNOWN` stays first-class
 * (docs/adr/0002-unknown-first-class.md). Classification here is
 * OBSERVATIONAL: it explains a decision the proof rules already made,
 * using the same evidence those rules saw.
 *
 * WHAT IT IS FOR. Before F3, an UNKNOWN carried an untyped `string[]` of
 * prose -- `"unsupported_construct at node_modules/foo/index.js:12"`,
 * `"could not resolve module \"qs\": ..."` -- and a candidate that
 * produced no finding at all carried nothing whatsoever. A machine could
 * not answer "how much of my UNKNOWN surface is an analyzer coverage gap I
 * could close, versus an `eval` nobody can ever close?", which is exactly
 * the question that has to be answered before any frontend-completeness
 * work is prioritized (P1-B), and exactly the question RWF-002 needs data
 * for.
 *
 * WHY THESE SIX CLASSES. Each one names a DIFFERENT KIND OF WORK, which is
 * the only property that makes a taxonomy worth having:
 *
 * - `unmodeled_construct`: the analyzer SAW the construct, knows what it
 *   is, and has not implemented it. Closeable by frontend work. This is
 *   the class P1-B is prioritized from, which is why nothing that is not
 *   genuinely closeable may be filed here (see `parse_failure` below for
 *   the case this rule excludes).
 * - `value_uncertainty`: the construct IS modeled, but the value or
 *   destination is not statically unique. Closeable only by analysis
 *   precision work (constant propagation, alias analysis), never by
 *   adding syntax support.
 * - `capability_escape`: the runtime can reach outside anything a bounded
 *   static analysis established. Largely NOT closeable -- it is a property
 *   of the language, not of this analyzer. Separating it from
 *   `unmodeled_construct` is the single most important split here: filing
 *   `eval` as a coverage gap would put permanent, unfixable work at the
 *   top of a roadmap.
 * - `identity_unresolved`: an identity fact -- which package, which
 *   instance, which version, which public entry, which target -- was never
 *   established. Closeable by metadata and resolution work.
 * - `analysis_precondition_unmet`: something the decision DEPENDS ON was
 *   never established at all, as opposed to established-but-ambiguous.
 *   The source could not be parsed, no runtime implementation was ever
 *   obtained, no vulnerable-symbol rule exists, or a required analysis
 *   artifact (the `ModuleLoadClosure`) was unavailable.
 * - `budget_exceeded`: a CONFIGURED bound stopped the work. Closeable by
 *   changing configuration, and by nothing else.
 *
 * WHY SIX AND NOT THE FIVE F3 PROPOSED. F3 named five classes and said to
 * audit semantics before forcing internal reasons into them. The audit
 * found three reasons -- `parse_failure`, `declaration_only_resolution`
 * and `module_load_closure_unavailable` -- that fit none of the five
 * honestly, and that share one nature: a PRECONDITION of the analysis was
 * never established. Folding them into `unmodeled_construct` would have
 * been the mechanical answer and would have corrupted the one measurement
 * F3 exists to produce (its § 32 P1-B ranking), since none of the three is
 * a syntax the frontend could learn. Folding them into `budget_exceeded`
 * would have claimed a configured limit stopped work that no limit
 * touched. They are a sixth class.
 *
 * ORTHOGONAL TO WIDENING. `isClosureWideningReason` (domain/graph.ts)
 * answers a different question -- "could this construct load a module the
 * graph never discovered?" -- and is a SOUNDNESS boundary consumed by the
 * proof rules. A reason can be widening and `capability_escape` (`eval`),
 * widening and `identity_unresolved` (`unresolved_module`), widening and
 * `analysis_precondition_unmet` (`declaration_only_resolution`), or
 * non-widening and `unmodeled_construct` (`unsupported_construct`).
 * Neither classification may ever be derived from the other.
 */
export const UNCERTAINTY_CATEGORIES = [
  "unmodeled_construct",
  "value_uncertainty",
  "capability_escape",
  "identity_unresolved",
  "analysis_precondition_unmet",
  "budget_exceeded",
] as const;

/**
 * One of the six classes above. Declaration order in
 * {@link UNCERTAINTY_CATEGORIES} is also the canonical OUTPUT order (see
 * {@link aggregateUncertainty}), so it must not be reshuffled casually --
 * a scan's structured reasons are byte-compared in the determinism suite.
 */
export type UncertaintyCategory = (typeof UNCERTAINTY_CATEGORIES)[number];

/**
 * The SPECIFIC reason, one level below {@link UncertaintyCategory}.
 *
 * Every {@link DynamicCallReason} appears here VERBATIM, deliberately:
 * those tokens are already the analyzer's own vocabulary for "why this
 * edge is unresolved", they already appear in `diagnostics` prose, and
 * renaming them at the taxonomy boundary would force every consumer to
 * maintain a translation table for no gain. The type-level assertion
 * further down makes that inclusion structural rather than a convention.
 *
 * Declaration order is the canonical tie-break ordering within a category.
 */
export const UNCERTAINTY_REASONS = [
  // --- Unresolved call-graph edges (every DynamicCallReason, verbatim) ---
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

  // --- Module-load closure incompleteness, beyond the edge reasons ---
  "parse_failure",
  "traversal_truncated",

  // --- Availability of the closure itself (FOUNDATION F2) ---
  "module_load_closure_unavailable",

  // --- Verdict-stage blockers (analysis/verdict.ts) ---
  "vulnerable_target_unresolved",
  "advisory_version_applicability_indeterminate",
  "no_vulnerable_symbol_rule",
  "no_entrypoints_available",
  "call_graph_truncated",
  "closure_widening_construct_reachable",
  "package_instance_absence_uncorroborated",
  "entrypoint_root_incomplete",
  "unreachability_not_positively_established",

  // --- Scan-stage, package/workspace identity (cli/scan.ts) ---
  "installed_version_unavailable",
  "installed_version_conflicted",
  "installed_manifest_untrusted",
  "workspace_declaration_uninterpretable",
  "workspace_pattern_unsupported",
  "workspace_enumeration_truncated",
  "workspace_layout_unsupported",

  // --- The runtime floor; see `classifyUncertaintyReason` ---
  "unclassified_uncertainty_reason",
] as const;

export type UncertaintyReason = (typeof UNCERTAINTY_REASONS)[number];

/**
 * The single mapping table (F3 § 13: "prefer compiler-enforced
 * Record/switch"). A `Record` over the full reason union means adding a
 * reason without classifying it is a COMPILE ERROR naming the missing key,
 * not a silent fallthrough.
 */
export const UNCERTAINTY_REASON_CATEGORY: Record<
  UncertaintyReason,
  UncertaintyCategory
> = {
  // -- unmodeled_construct: the analyzer could model this and does not. --
  //
  // `unsupported_construct` is the call graph's own catch-all for a callee
  // expression shape it has no rule for. It is NON-widening (the value it
  // reaches is already in scope, in a module already loaded), which is
  // precisely why it is a coverage gap rather than an escape: the work to
  // close it is bounded and local.
  unsupported_construct: "unmodeled_construct",
  // Both workspace shapes are genuine, closeable frontend gaps: a `pkg-*`
  // or brace pattern is documented npm workspace syntax this analyzer
  // declines to interpret, and a `pnpm-workspace.yaml` layout is a file it
  // declines to read. Someone could implement either, deterministically.
  workspace_pattern_unsupported: "unmodeled_construct",
  workspace_layout_unsupported: "unmodeled_construct",

  // -- value_uncertainty: modeled construct, non-unique destination. --
  //
  // `foo[key]()` where `key` is not a literal. The analyzer understands
  // the construct perfectly; what it cannot do is pick one of the values
  // already in scope. No amount of syntax support closes this -- only
  // value analysis does. Deliberately NOT capability_escape: this call
  // cannot introduce a module the graph never saw (see
  // isClosureWideningReason, which classifies it non-widening for exactly
  // this reason).
  dynamic_member_access: "value_uncertainty",

  // -- capability_escape: the runtime can leave the analyzed world. --
  //
  // Every one of these can load or execute code that graph construction
  // had no way to discover. They are grouped by CONSEQUENCE, not by
  // syntax, which is why `require(x)` sits here rather than in
  // value_uncertainty: the unknown value is a module specifier, so the
  // uncertainty is not bounded to anything already discovered. F3 § 8 is
  // explicit that capability escapes must not be filed as value
  // uncertainty, and F3 § 9 lists dynamic code loading as an escape.
  dynamic_require: "capability_escape",
  dynamic_import: "capability_escape",
  eval: "capability_escape",
  aliased_require: "capability_escape",
  create_require: "capability_escape",
  function_constructor: "capability_escape",
  aliased_eval: "capability_escape",
  module_require: "capability_escape",
  module_internal_load: "capability_escape",
  vm_execution: "capability_escape",
  worker_execution: "capability_escape",
  child_process_execution: "capability_escape",
  loader_hook_mutation: "capability_escape",
  loader_capability_escape: "capability_escape",
  // The VT-300 guard's own blocker: a widening construct is reachable from
  // an entrypoint, so this instance's absence from the call graph stopped
  // being evidence. The blocker IS the escape, stated at the verdict layer.
  closure_widening_construct_reachable: "capability_escape",

  // -- identity_unresolved: an identity fact was never established. --
  //
  // `unresolved_module`: the SPECIFIER could not be resolved, so which
  // module it names is unknown. (It is also widening -- an unknown module
  // can require anything -- which is a separate axis.)
  unresolved_module: "identity_unresolved",
  // `unresolved_target`: the module resolved; the EXPORT lookup inside it
  // did not. The binding from an advisory's name to a callable is exactly
  // the "target binding unavailable" case F3 § 10 names.
  unresolved_target: "identity_unresolved",
  vulnerable_target_unresolved: "identity_unresolved",
  // Version IS an applicability identity fact: without it, no advisory
  // range can be evaluated against this instance.
  advisory_version_applicability_indeterminate: "identity_unresolved",
  installed_version_unavailable: "identity_unresolved",
  installed_version_conflicted: "identity_unresolved",
  installed_manifest_untrusted: "identity_unresolved",
  // A declaration this analyzer cannot interpret at all leaves the set of
  // local packages -- their names, their roots -- unestablished. Distinct
  // from `workspace_pattern_unsupported`, where the declaration parsed and
  // one pattern shape was declined.
  workspace_declaration_uninterpretable: "identity_unresolved",
  // P0-Z: the configured entrypoint's exported callable could not be
  // rooted, so the public entry surface the proof spans is unestablished.
  // F3 § 10 names "public entry cannot be established" explicitly.
  entrypoint_root_incomplete: "identity_unresolved",

  // -- analysis_precondition_unmet: a dependency of the decision was
  //    never established (as opposed to established-but-ambiguous). --
  //
  // A file that would not parse: its loads and calls were never
  // enumerated, so nothing about it is known. NOT `unmodeled_construct`
  // -- the analyzer is not declining a syntax it recognises, it never
  // obtained a usable AST -- and filing it as one would put "fix the
  // user's broken file" on the frontend roadmap.
  parse_failure: "analysis_precondition_unmet",
  // Resolution SUCCEEDED, onto a `.d.ts`. Identity is established; what is
  // missing is executable source. That is why this is not
  // `identity_unresolved`.
  declaration_only_resolution: "analysis_precondition_unmet",
  // FOUNDATION F2. The closure artifact the negative proof depends on did
  // not exist for this scan. F3 § 12 asked for identity/analysis-state
  // rather than unmodeled_construct; this is the analysis-state half.
  // Classification does not touch its blocking behavior, which stays
  // exactly as F2 left it.
  module_load_closure_unavailable: "analysis_precondition_unmet",
  // No rule means no model of what this advisory's dangerous behavior IS.
  // Reachability has nothing to search for -- a missing precondition, not
  // a failure to resolve one.
  no_vulnerable_symbol_rule: "analysis_precondition_unmet",
  // Nothing to search FROM. Same shape, other end of the search.
  no_entrypoints_available: "analysis_precondition_unmet",
  // Family B's corroborating closure was absent, incomplete, or reported
  // the instance as loaded. The corroboration precondition is unmet; the
  // call graph's own observation is unchanged.
  package_instance_absence_uncorroborated: "analysis_precondition_unmet",
  // Family C's own precondition guard (VT-CONTRACT-02): the search ran,
  // but no target was searched to exhaustion with an authoritative
  // unreachable result, so there is no witness to carry the proof. Not
  // believed reachable in production -- it is written as a guard precisely
  // so that if it ever is, it degrades to UNKNOWN with a named reason
  // rather than to a NOT_AFFECTED with no evidence.
  unreachability_not_positively_established: "analysis_precondition_unmet",

  // -- budget_exceeded: a CONFIGURED bound stopped the work. --
  //
  // Distinct from every class above: the analyzer knows exactly how to do
  // this work and was told not to. Raising a limit closes it; no code
  // change does.
  traversal_truncated: "budget_exceeded",
  call_graph_truncated: "budget_exceeded",
  workspace_enumeration_truncated: "budget_exceeded",

  // -- the runtime floor. --
  unclassified_uncertainty_reason: "capability_escape",
};

/**
 * Structural proof that every {@link DynamicCallReason} is a classified
 * {@link UncertaintyReason} (F3 § 13, § 28: the mapping is exhaustive, and
 * an unmapped future value is a COMPILE-TIME failure).
 *
 * Adding a `DynamicCallReason` without adding it to
 * {@link UNCERTAINTY_REASONS} and {@link UNCERTAINTY_REASON_CATEGORY}
 * makes THIS declaration the error, naming the missing token, before any
 * test runs.
 */
const everyDynamicCallReasonIsClassified: Record<
  DynamicCallReason,
  UncertaintyCategory
> = UNCERTAINTY_REASON_CATEGORY;
void everyDynamicCallReasonIsClassified;

/**
 * One classified uncertainty, with how many times it was observed.
 *
 * `count` is why {@link aggregateUncertainty} groups rather than lists: a
 * real reachability search over a package like `node-forge` produces
 * hundreds of unresolved edges carrying a handful of distinct reasons, and
 * a consumer needs "47 x unsupported_construct", not 47 rows. The per-edge
 * prose is NOT discarded to make room for this -- it stays, verbatim, in
 * `evidence.reasons` (F3 § 6: do not remove useful specific details).
 */
export interface UncertaintyClassification {
  readonly category: UncertaintyCategory;
  readonly reason: UncertaintyReason;
  /** Occurrences observed for this exact (category, reason) pair; always >= 1. */
  readonly count: number;
}

const CATEGORY_ORDER = new Map<UncertaintyCategory, number>(
  UNCERTAINTY_CATEGORIES.map((category, index) => [category, index]),
);
const REASON_ORDER = new Map<UncertaintyReason, number>(
  UNCERTAINTY_REASONS.map((reason, index) => [reason, index]),
);

const KNOWN_REASONS: ReadonlySet<string> = new Set<string>(UNCERTAINTY_REASONS);

/**
 * Maps a specific reason onto its category, failing CLOSED at runtime.
 *
 * Two separate guarantees, mirroring `isClosureWideningReason`'s own
 * contract (domain/graph.ts, FOUNDATION F2-B):
 *
 * 1. COMPILE TIME. A new {@link UncertaintyReason} with no entry in
 *    {@link UNCERTAINTY_REASON_CATEGORY} is a build error.
 *
 * 2. RUNTIME. A value that is not a known reason is NEVER DROPPED (F3
 *    § 28). It is reported as `unclassified_uncertainty_reason` under
 *    `capability_escape` -- the most severe class -- because an
 *    unrecognized reason is one nobody has reasoned about, and the only
 *    safe assumption about an unreasoned-about construct is the one that
 *    understates nothing. Deliberately does not throw: this runs inside a
 *    scan whose contract is that uncertainty becomes UNKNOWN, not an
 *    exception.
 *
 * Unreachable in production today -- every caller passes a value from a
 * type-closed internal union and no deserialization boundary carries one
 * -- and that is a property of today's code, not a guarantee about
 * tomorrow's.
 */
export function classifyUncertaintyReason(
  reason: UncertaintyReason,
): UncertaintyClassification {
  if (!KNOWN_REASONS.has(reason)) {
    return {
      category: UNCERTAINTY_REASON_CATEGORY.unclassified_uncertainty_reason,
      reason: "unclassified_uncertainty_reason",
      count: 1,
    };
  }
  return { category: UNCERTAINTY_REASON_CATEGORY[reason], reason, count: 1 };
}

/**
 * Groups observed reasons into the canonical, byte-deterministic array
 * that reaches output (F3 § 19, § 27).
 *
 * THREE properties, each load-bearing:
 *
 * - GROUPED, NOT PICKED. One UNKNOWN routinely has several independent
 *   blockers. F3 § 20 forbids inventing a "primary reason": selecting one
 *   would hide the others behind an arbitrary priority, and a consumer
 *   deciding what to fix needs all of them. Every distinct reason
 *   survives, with its count.
 * - DEDUPLICATED. The same reason observed 47 times is one reason observed
 *   47 times, not 47 reasons.
 * - ORDERED BY DECLARATION, NOT BY OBSERVATION. Sorting on
 *   {@link UNCERTAINTY_CATEGORIES}/{@link UNCERTAINTY_REASONS} index --
 *   never on count, never on first-seen -- is what makes the output
 *   independent of graph edge order, blocker order and instance
 *   enumeration order. Ordering by count would make a scan's bytes depend
 *   on how many times a construct happened to appear, which is exactly the
 *   instability F3 § 27 tests for by reversing those orders.
 */
export function aggregateUncertainty(
  observed: readonly UncertaintyReason[],
): readonly UncertaintyClassification[] {
  const counts = new Map<UncertaintyReason, number>();
  for (const raw of observed) {
    const { reason } = classifyUncertaintyReason(raw);
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([reason, count]) => ({
      category: UNCERTAINTY_REASON_CATEGORY[reason],
      reason,
      count,
    }))
    .sort(
      (a, b) =>
        (CATEGORY_ORDER.get(a.category) ?? 0) -
          (CATEGORY_ORDER.get(b.category) ?? 0) ||
        (REASON_ORDER.get(a.reason) ?? 0) - (REASON_ORDER.get(b.reason) ?? 0),
    );
}
