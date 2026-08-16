/**
 * A single resolved dependency in the project's dependency graph. Multiple
 * `DependencyNode`s may share a `name` with different `version`s, since the
 * graph must support multiple installed versions of the same package
 * (see docs/SDD.md § 11).
 */
export interface DependencyNode {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly ecosystem: "npm";
  readonly direct: boolean;
  readonly locations: readonly string[];
  readonly dependencyPaths: readonly (readonly string[])[];
  readonly purl?: string;
}
