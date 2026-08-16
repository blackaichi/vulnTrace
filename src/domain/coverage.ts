/**
 * What a scan actually analyzed. Required context for interpreting a
 * verdict: `NOT_AFFECTED` with high coverage means something different from
 * `NOT_AFFECTED` with a large unresolved region (see docs/SDD.md § 8).
 */
export interface Coverage {
  readonly files: number;
  readonly modulesResolved: number;
  readonly modulesUnresolved: number;
  readonly functions: number;
  readonly callsResolved: number;
  readonly callsDynamic: number;
}

/**
 * A human-readable explanation of one specific analysis blocker (see
 * docs/SDD.md § 8). Complements {@link Coverage}'s aggregate counts with
 * concrete per-blocker detail: "NOT_AFFECTED + high coverage" vs.
 * "NOT_AFFECTED + large unresolved region" (§8's own example) is only
 * actionable if the unresolved region can be explained, not merely
 * counted. `source` identifies which stage of the scan produced this
 * diagnostic (e.g. `"entrypoints"`, `"call-graph"`, `"vulnerabilities"`),
 * not a specific file — see each producer for its own detail.
 */
export interface Diagnostic {
  readonly source: string;
  readonly message: string;
}
