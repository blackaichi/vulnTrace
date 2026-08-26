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

export interface Evidence {
  readonly path: readonly string[];
  readonly reasons?: readonly string[];
  /**
   * Present only on a NOT_AFFECTED reached through VT-307d's module-load
   * absence proof (see {@link ConfirmedAbsentFromModuleLoadClosure}).
   */
  readonly confirmedAbsentFromModuleLoadClosure?: ConfirmedAbsentFromModuleLoadClosure;
}
