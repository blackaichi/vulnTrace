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
export interface Evidence {
  readonly path: readonly string[];
  readonly reasons?: readonly string[];
}
