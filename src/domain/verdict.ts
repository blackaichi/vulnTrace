import type { Evidence } from "./evidence.js";
import type { VulnerableSymbolTarget } from "./target.js";

/**
 * The three allowed verdicts (see docs/SDD.md § 5, AGENTS.md). `UNKNOWN`
 * must never be coerced into `NOT_AFFECTED`.
 */
export type Verdict = "AFFECTED" | "NOT_AFFECTED" | "UNKNOWN";

/**
 * A single scan finding: one vulnerability matched against one installed
 * package/version, with its verdict and (when available) the
 * vulnerable-behavior target and evidence that produced it
 * (see docs/SDD.md § 6, § 24, schemas/result.schema.json).
 *
 * Not modeled as a discriminated union on `verdict`: every documented
 * example and the checked-in schema use the same flat shape regardless of
 * verdict (only `confidence`/`target`/`evidence` presence varies in
 * practice — e.g. an `UNKNOWN` from an unresolved vulnerable target has no
 * `target` yet), so a union would add ceremony without a real type-safety
 * gain here. Contrast with {@link ReachabilityResult} in graph.ts, where
 * the payload genuinely differs per state.
 */
export interface Finding {
  readonly vulnerability: string;
  readonly package: string;
  readonly version: string;
  readonly verdict: Verdict;
  readonly confidence?: number;
  readonly target?: VulnerableSymbolTarget;
  readonly evidence?: Evidence;
}
