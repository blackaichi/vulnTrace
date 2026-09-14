import type { DynamicCallReason } from "../domain/graph.js";
import type { UncertaintyReason } from "../domain/uncertainty.js";
import type {
  CallGraphNegativeProofBlocker,
  ClosureIncompletenessReason,
  ModuleLoadClosureUnavailableBlocker,
} from "./module-load-closure.js";

/**
 * FOUNDATION F3 -- the analysis layer's half of the taxonomy mapping.
 *
 * Kept OUT of `domain/uncertainty.ts` for the layering reason AGENTS.md
 * states directly ("keep domain models independent from CLI and
 * providers", and by the same argument from analysis internals):
 * `ClosureIncompletenessReason` and `CallGraphNegativeProofBlocker` are
 * declared in `analysis/module-load-closure.ts`, so a domain module that
 * imported them in order to classify them would invert the dependency. The
 * domain module names the reason TOKENS -- which are only string literals
 * -- and this module is where those tokens are PROVEN to cover the
 * analysis layer's own typed vocabularies.
 *
 * Everything here is a type-level assertion plus two total functions.
 * There is no runtime branch to get wrong: because every member of both
 * vocabularies is already an {@link UncertaintyReason}, the mapping is the
 * identity, and the only thing worth enforcing is that it STAYS the
 * identity as those unions grow. That enforcement is the point -- F3 § 28
 * requires an unmapped future value to be a compile-time failure rather
 * than a silent drop, and a `switch` that happened to list today's members
 * would satisfy that far more weakly than a constraint on the union
 * itself.
 */

/**
 * Fails to instantiate unless `T` is entirely within
 * {@link UncertaintyReason}.
 *
 * A constraint rather than a value: it costs nothing at runtime, it cannot
 * be defeated by a cast the way an `Object.fromEntries(...) as Record<...>`
 * table can, and the error it produces names the offending member.
 */
type AssertIsUncertaintyReason<T extends UncertaintyReason> = T;

/**
 * F3 § 14 -- every {@link ClosureIncompletenessReason} is a classified
 * {@link UncertaintyReason}, enforced at COMPILE TIME.
 *
 * `ClosureIncompletenessReason` is `DynamicCallReason | "parse_failure" |
 * "traversal_truncated"`. The `DynamicCallReason` half is already proven
 * classified in `domain/uncertainty.ts`; this covers the two the closure
 * adds on its own and -- more usefully -- keeps covering them if that
 * union grows a third. Adding a reason there without adding it to
 * `UNCERTAINTY_REASONS` makes THIS alias the build error.
 *
 * The specific reason is deliberately PRESERVED rather than collapsed into
 * its category (F3 § 14: "preserve precise specific reason"). A consumer
 * that only wants the class can look the token up in
 * `UNCERTAINTY_REASON_CATEGORY`; a consumer that needs to know it was
 * `parse_failure` specifically -- the difference between "a file in this
 * project will not parse" and "a configured limit stopped the walk" --
 * must still be able to.
 */
export type ClosureIncompletenessUncertaintyReason =
  AssertIsUncertaintyReason<ClosureIncompletenessReason>;

/**
 * F3 § 12 -- `module_load_closure_unavailable`, the blocker FOUNDATION F2
 * introduced, is a classified {@link UncertaintyReason}.
 *
 * Its CATEGORY is `analysis_precondition_unmet` (see the table in
 * `domain/uncertainty.ts` for why: F3 § 12 asked for identity/analysis
 * state rather than `unmodeled_construct`, and closure absence is the
 * analysis-state half -- an artifact the proof depends on was never
 * built).
 *
 * Its BLOCKING BEHAVIOR is untouched, and this file is part of why that is
 * structurally true rather than merely intended: nothing here is imported
 * by `callGraphNegativeProofBlockers`, or by any branch in
 * `analysis/verdict.ts` that decides a verdict. The guard fires exactly
 * when F2 made it fire; F3 only gives the resulting UNKNOWN a
 * machine-readable name for why.
 */
export type ModuleLoadClosureUnavailableUncertaintyReason =
  AssertIsUncertaintyReason<ModuleLoadClosureUnavailableBlocker>;

/**
 * Maps a {@link CallGraphNegativeProofBlocker} onto its specific
 * {@link UncertaintyReason}.
 *
 * The identity, by construction: the blocker vocabulary is
 * `DynamicCallReason | "parse_failure" | "traversal_truncated" |
 * "module_load_closure_unavailable"`, and F3 puts all four groups into
 * `UNCERTAINTY_REASONS` verbatim so that a reader comparing a
 * `diagnostics` line against a structured reason sees the SAME token in
 * both (F3 § 16: no duplicated contradictory wording).
 *
 * The PARAMETER TYPE is what does the work. If the blocker union ever
 * grows a member that is not an `UncertaintyReason`, this signature stops
 * typechecking.
 */
export function blockerUncertaintyReason(
  blocker: CallGraphNegativeProofBlocker,
): UncertaintyReason {
  return blocker;
}

/**
 * Maps a {@link DynamicCallReason} -- the reason an individual call edge
 * is unresolved -- onto its specific {@link UncertaintyReason} (F3 § 13).
 *
 * Also the identity, and also load-bearing as a TYPE. Callers in
 * `analysis/verdict.ts` read `ReachabilityResult`'s `unresolvedEdges`,
 * which carry the typed reason, and pass it through here rather than
 * re-deriving a token by parsing the prose `blockers` strings the same
 * results carry. Parsing the prose would couple the taxonomy to a message
 * format and would silently produce garbage the day a message is reworded.
 */
export function edgeUncertaintyReason(
  reason: DynamicCallReason,
): UncertaintyReason {
  return reason;
}
