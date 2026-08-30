/**
 * THE NEGATIVE-PROOF CONTRACT (VT-307e).
 *
 * `NOT_AFFECTED` is a positive claim, never the absence of a positive one.
 * VulnTrace has exactly three ways to make it, and every one of them must
 * satisfy all of:
 *
 *  1. vulnerability applicability is already established -- the advisory
 *     applies, the installed version is in a vulnerable range, a rule with
 *     targets exists, and the target was established;
 *  2. where the claim is instance-specific, the exact canonical
 *     `PackageInstanceId` is authoritative -- never a package name, a
 *     version, or a name+version pair;
 *  3. the finding carries an explicit evidence OBJECT for that proof, not
 *     merely a reason string;
 *  4. every completeness condition that proof depends on holds;
 *  5. no uncertainty capable of invalidating THAT proof is outstanding.
 *
 * Point 5 is deliberately proof-specific rather than global. A single
 * "everything was complete" boolean would be trivially sound and nearly
 * useless: it would let a limit on one traversal veto a conclusion drawn
 * from another, and would hide WHICH condition actually mattered. The three
 * families therefore carry different guards:
 *
 * | family | claim                                  | evidence                               | guards |
 * | ------ | -------------------------------------- | -------------------------------------- | ------ |
 * | A      | the instance cannot be LOADED at all   | {@link ConfirmedAbsentFromModuleLoadClosure} | gate-eligible closure; `complete === true` (ALL reasons, `traversal_truncated` included); non-empty roots; exact instance OUT; resolved target belongs to that instance |
 * | B      | the graph never TRAVERSED the instance | {@link ConfirmedAbsentInstance}         | `graphTruncated === false`; VT-300's reachable closure-widening guard; no closure condition that could hide the instance's loading; AND a gate-eligible, complete `ModuleLoadClosure` independently corroborates the absence (VT-307e hardening -- see below) |
 * | C      | the resolved target is never CALLED    | {@link ConfirmedUnreachableTarget}      | target resolved AND attributed; exhaustive search with zero unresolved edges in the reachable subgraph; `graphTruncated === false`; no closure condition that could hide a call path |
 *
 * Families B and C both reason from what the CALL GRAPH did not contain, so
 * they share one extra guard that family A does not need and family A's own
 * `complete` flag does not express -- see
 * `invalidatesCallGraphNegativeProof` in analysis/module-load-closure.ts for
 * the per-reason partition and, in particular, for why
 * `traversal_truncated` is the one condition that blocks A but NOT B or C.
 *
 * Exactly one of the three evidence objects appears on any NOT_AFFECTED
 * finding, and each reason string maps 1:1 to one family.
 *
 * What NONE of them claim: universal runtime impossibility. Every proof is
 * relative to VulnTrace's declared supported model -- see
 * {@link SUPPORTED_MODEL_EXCLUSIONS} for the enumerated exclusions, which
 * apply to all three families.
 */

/**
 * Supporting evidence for a verdict: the resolved source-location path and
 * human-readable justifications (see docs/SDD.md § 6).
 *
 * Discrepancy note (recorded per AGENTS.md "record the discrepancy"): SDD
 * § 6's own example shows `path`/`reasons` flat alongside `verdict`/
 * `target`, while § 24's JSON output example and the checked-in
 * schemas/result.schema.json both nest evidence under a separate `evidence`
 * key on the finding. This module follows § 24 + the checked-in schema, as
 * the more concrete and binding artifacts, and nests `Evidence` inside
 * {@link Finding} (see verdict.ts) rather than flattening it.
 */
/**
 * Positive analytical evidence that one exact installed package instance
 * cannot be loaded at all from the scan's configured entrypoints (VT-307d).
 *
 * This is a MODULE-LOAD absence proof, and deliberately its own field
 * rather than a reuse of anything already on {@link Evidence}. It is NOT
 * call-graph absence: "the call graph never bound a call into this
 * package" is a statement about what calls resolved, which systematically
 * under-reports loading (every open export-resolution gap makes a
 * genuinely-loaded package look untouched -- RWB-08's `ms` IS loaded and
 * still never appears as a call-bound instance). This field says something
 * strictly stronger and structurally different: the module-load closure
 * over the configured entrypoints was traversed to exhaustion, and this
 * install location is not in it, so nothing the entrypoints load can reach
 * its code at all.
 *
 * Deliberately NOT merged into `reasons`: a reader (human or downstream
 * tool) must be able to tell a positively-proved absence from a
 * human-readable justification string without parsing prose.
 *
 * SCOPE OF THE CLAIM. This is absence under VulnTrace's DECLARED SUPPORTED
 * module-loading model, never a claim of universal runtime impossibility.
 * It does not model, and does not claim anything about any of
 * {@link SUPPORTED_MODEL_EXCLUSIONS} -- the single, shared enumeration of
 * what this model leaves out, kept there rather than restated here so no
 * consumer that has to DISCLOSE the scope of a negative proof can drift
 * out of agreement with it. In-source loader/runtime capabilities ARE
 * modeled -- they
 * widen the closure and make it incomplete, which withdraws this evidence
 * entirely rather than weakening it.
 *
 * It proves PACKAGE-LOAD absence only. It says nothing about which symbols
 * inside a package that IS loaded are reachable, so it can never justify a
 * verdict for a loaded instance.
 */
export interface ConfirmedAbsentFromModuleLoadClosure {
  /**
   * The exact canonical installed instance proved absent -- an install
   * LOCATION (`PackageInstanceId`), never a package name, a version, or a
   * name+version pair. Two installs of the same name at the same version
   * in different locations are different instances with independent
   * answers, and collapsing them is precisely how a reached instance's
   * code could be declared unloadable.
   */
  readonly packageInstance: string;
  /**
   * The configured entrypoint FILES the proof is relative to. The claim is
   * meaningless without them -- "not loadable" is always "not loadable
   * from these roots" -- and they are non-empty by construction (a
   * root-less closure is never gate-eligible).
   */
  readonly entrypointRoots: readonly string[];
  /**
   * Always `true`. Recorded explicitly, rather than left implicit, because
   * closure COMPLETENESS is the entire load-bearing precondition: against
   * an incomplete closure, absence proves nothing at all, and a reader
   * should be able to see that the requirement was met rather than infer
   * it from the evidence's presence.
   */
  readonly closureComplete: true;
}

/**
 * Positive analytical evidence that one exact installed package instance
 * was never traversed by the call graph, under conditions establishing
 * that absence actually means something (VT-212/VT-300, hardened VT-307e).
 *
 * PROOF FAMILY B, and deliberately its own evidence type (VT-307e). Before
 * VT-307e this proof shared family C's reason string, so a consumer could
 * not tell "the analyzer never saw this install location" from "the
 * analyzer saw the code and found no path to the symbol" -- two materially
 * different claims with different preconditions.
 *
 * VT-307e HARDENING (its own final audit reproduced a false NOT_AFFECTED
 * here). This evidence originally asserted `callGraphComplete: true` on
 * the strength of `graphTruncated === false` alone -- but a non-truncated
 * call graph is not a complete one: the call graph's own discovery never
 * follows a re-export DECLARATION (`export * from "pkg"`) as an edge at
 * all (VT-307c-fix-8 added that traversal to `ModuleLoadClosure` ONLY), so
 * a package instance reached solely through a re-export chain can be
 * genuinely loaded and called while remaining entirely absent from a
 * merely-non-truncated call graph. Concretely reproduced: two installs of
 * one package name/version, a `consumer` package doing
 * `export * from "pkg"` to the nested one, an entrypoint importing the
 * top-level install directly (so the graph discovers THAT instance) and
 * calling the vulnerable export through `consumer` (so the nested
 * instance's code genuinely runs) -- the nested instance was absent from a
 * non-truncated call graph while being both loaded and called.
 *
 * This proof is therefore no longer sufficient on the call graph alone. It
 * additionally requires independent corroboration from a gate-eligible,
 * COMPLETE {@link ModuleLoadClosure} that ALSO does not contain this exact
 * instance -- the SAME closure-membership fact {@link ConfirmedAbsentFromModuleLoadClosure}
 * relies on, reached here because the call graph discovered some OTHER
 * instance of this package name (Site A), not because it discovered none
 * at all (Site B, family A's own domain). `callGraphComplete` is retired
 * rather than kept as a now-half-true field: it asserted a completeness
 * the call graph never actually had, and simply requiring closure
 * corroboration alongside it would leave that same misleading name in the
 * output. The two fields below name exactly, and only, what is actually
 * established.
 *
 * Distinct from {@link ConfirmedAbsentFromModuleLoadClosure}: THAT proof
 * says the instance cannot be LOADED at all, established directly by the
 * module-load traversal, and is reached at Site B when the call graph
 * discovered NO instance of the package name whatsoever. THIS one says the
 * CALL GRAPH never traversed this exact instance while some OTHER instance
 * of the same name was discovered (Site A), corroborated by the same kind
 * of closure evidence but reached through a different code path with an
 * additional guard (VT-300's closure-widening check) that family A does
 * not need.
 */
export interface ConfirmedAbsentInstance {
  /** The exact canonical install LOCATION never traversed -- never a name or version. */
  readonly packageInstance: string;
  /** The configured entrypoint files the traversal started from. */
  readonly entrypointRoots: readonly string[];
  /**
   * Always `false`: a truncated call graph cannot support this proof
   * (VT-202). Named for exactly what it establishes -- that the call
   * graph's traversal did not hit a resource limit -- and nothing more;
   * see this type's own doc comment for why that is NOT the same claim as
   * "the call graph is complete".
   */
  readonly graphTruncated: false;
  /**
   * Always `true`: the independent {@link ModuleLoadClosure} corroboration
   * VT-307e added is the load-bearing half of this proof. Without it,
   * `graphTruncated === false` alone reproducibly permits a false
   * NOT_AFFECTED (see this type's own doc comment) -- so this field is
   * never omitted or defaulted, and `confirmedAbsentInstance` is never
   * constructed without it having been checked.
   */
  readonly moduleLoadClosureComplete: true;
}

/**
 * Positive analytical evidence that a RESOLVED, ATTRIBUTED vulnerable
 * target has no call path from any configured entrypoint.
 *
 * PROOF FAMILY C. Unlike families A and B this says nothing about whether
 * the package is present or loaded -- it may well be both. It says the
 * specific symbol is never called, established by an exhaustive search
 * that encountered no unresolved edge anywhere in the entrypoint's
 * reachable subgraph.
 */
export interface ConfirmedUnreachableTarget {
  /** The vulnerable target this proof is about, restated so the evidence stands alone. */
  readonly target: { readonly module: string; readonly export: string };
  /** The configured entrypoint files the search started from. */
  readonly entrypointRoots: readonly string[];
  /** Always `true`: a truncated call graph cannot support this proof (VT-202). */
  readonly callGraphComplete: true;
}

export interface Evidence {
  readonly path: readonly string[];
  readonly reasons?: readonly string[];
  /**
   * Present only on a NOT_AFFECTED reached through VT-307d's module-load
   * absence proof (see {@link ConfirmedAbsentFromModuleLoadClosure}).
   */
  readonly confirmedAbsentFromModuleLoadClosure?: ConfirmedAbsentFromModuleLoadClosure;
  /**
   * Present only on a NOT_AFFECTED reached through proof family B (see
   * {@link ConfirmedAbsentInstance}). Mutually exclusive with the other
   * two proof evidences -- exactly one negative-proof evidence object
   * appears on any NOT_AFFECTED finding.
   *
   * That exclusivity is a runtime property of `buildFinding`'s three
   * mutually-exclusive early returns, and since VT-CONTRACT-01 it is also
   * enforced structurally by the SERIALIZED contract:
   * `schemas/result.schema.json` accepts a NOT_AFFECTED only with exactly
   * one of these three present, and rejects any of them on an AFFECTED or
   * UNKNOWN. These fields stay individually optional here because the
   * three families are genuinely three shapes and a discriminated union
   * would buy compile-time exclusivity at the cost of churn across every
   * construction and read site; the invariant is enforced where a
   * regression could actually escape -- at serialization.
   */
  readonly confirmedAbsentInstance?: ConfirmedAbsentInstance;
  /**
   * Present only on a NOT_AFFECTED reached through proof family C (see
   * {@link ConfirmedUnreachableTarget}).
   */
  readonly confirmedUnreachableTarget?: ConfirmedUnreachableTarget;
}

/**
 * VulnTrace's DECLARED SUPPORTED MODULE-LOADING MODEL: the enumerated
 * constructs every negative proof in this file is explicitly relative to,
 * and therefore claims nothing about.
 *
 * The single source of this list (VT-HTML-01). It was previously stated
 * only as prose inside {@link ConfirmedAbsentFromModuleLoadClosure}'s doc
 * comment, which is invisible to anything that has to SHOW a reader what a
 * NOT_AFFECTED does and does not mean -- and a second, hand-copied list in
 * a renderer is exactly how such a disclosure drifts out of agreement with
 * the contract it describes. Every consumer that discloses the scope of a
 * negative proof (the HTML report today; anything else later) must read it
 * from here rather than restating it.
 *
 * These are exclusions of the MODEL, not of a particular scan: no evidence
 * object, no completeness flag, and no verdict can retire one. In-source
 * loader/runtime capabilities are deliberately NOT in this list -- those
 * ARE modeled, and they withdraw a proof entirely (by making the closure
 * incomplete) rather than sitting outside it.
 */
export const SUPPORTED_MODEL_EXCLUSIONS: readonly string[] = [
  "NODE_OPTIONS",
  "an externally supplied --require preload",
  "an external --loader / ESM hook",
  "native addon behavior",
  "loader monkey-patching originating in code this scan never analyzed",
  "execution that begins somewhere other than the configured entrypoints",
];

/**
 * The one-sentence framing that {@link SUPPORTED_MODEL_EXCLUSIONS} belongs
 * to, kept beside the list so a consumer cannot show the exclusions
 * without the claim they qualify (or vice versa).
 */
export const SUPPORTED_MODEL_STATEMENT =
  "Every NOT_AFFECTED verdict is a positive claim established under VulnTrace's declared supported module-loading model, never a claim of universal runtime impossibility.";
