/**
 * Where a discovered entrypoint came from (see docs/SDD.md § 19).
 * `explicit` is a plain caller-supplied file-path override (e.g. a future
 * CLI `--entrypoint` flag), distinct from `configured` (VulnTrace's own
 * `vulntrace.yml` `analysis.entrypoints`).
 */
export type EntrypointSource =
  "configured" | "package_main" | "package_bin" | "explicit";

/**
 * A file selected as a starting point for reachability analysis (see
 * docs/SDD.md § 19). `reason` preserves evidence for why this file was
 * selected, so a finding can explain how its entrypoint was chosen, not
 * just what it resolved to (docs/SDD.md § 36: "Evidence > Guessing").
 */
export interface Entrypoint {
  readonly filePath: string;
  readonly source: EntrypointSource;
  readonly reason: string;
  /** For `package_bin`: which `bin` command name this entrypoint implements. */
  readonly binName?: string;
}
