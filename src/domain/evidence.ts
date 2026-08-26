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
 * | B      | the graph never TRAVERSED the instance | {@link ConfirmedAbsentInstance}         | `graphTruncated === false`; VT-300's reachable closure-widening guard; no closure condition that could hide the instance's loading |
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
 * {@link ConfirmedAbsentFromModuleLoadClosure} for the enumerated
 * exclusions, which apply to all three families.
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
 * It does not model, and does not claim anything about: `NODE_OPTIONS`, an
 * external `--require`, an external `--loader`/ESM hook, native addon
 * behavior, loader monkey-patching originating in code this scan never
 * analyzed, or execution that begins somewhere other than the configured
 * entrypoints. In-source loader/runtime capabilities ARE modeled -- they
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
 * was never traversed by the call graph at all (VT-212/VT-300), under a
 * call graph complete enough for that absence to mean something.
 *
 * PROOF FAMILY B, and deliberately its own evidence type (VT-307e). Before
 * VT-307e this proof shared family C's reason string, so a consumer could
 * not tell "the analyzer never saw this install location" from "the
 * analyzer saw the code and found no path to the symbol" -- two materially
 * different claims with different preconditions.
 *
 * Distinct from {@link ConfirmedAbsentFromModuleLoadClosure}: THAT proof
 * says the instance cannot be LOADED at all, established by an independent
 * module-load traversal. THIS one says the CALL GRAPH never traversed it,
 * which is weaker and carries different guards -- it additionally requires
 * that nothing reachable from an entrypoint could load the instance at
 * runtime (VT-300's closure-widening guard) and that the graph itself was
 * not truncated.
 */
export interface ConfirmedAbsentInstance {
  /** The exact canonical install LOCATION never traversed -- never a name or version. */
  readonly packageInstance: string;
  /** The configured entrypoint files the traversal started from. */
  readonly entrypointRoots: readonly string[];
  /** Always `true`: a truncated call graph cannot support this proof (VT-202). */
  readonly callGraphComplete: true;
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
   */
  readonly confirmedAbsentInstance?: ConfirmedAbsentInstance;
  /**
   * Present only on a NOT_AFFECTED reached through proof family C (see
   * {@link ConfirmedUnreachableTarget}).
   */
  readonly confirmedUnreachableTarget?: ConfirmedUnreachableTarget;
}
