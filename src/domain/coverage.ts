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
