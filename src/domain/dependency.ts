/**
 * A single resolved dependency in the project's dependency graph. Multiple
 * `DependencyNode`s may share a `name` with different `version`s, since the
 * graph must support multiple installed versions of the same package
 * (see docs/SDD.md § 11).
 *
 * `version` is optional (task B-4, PRM-34): a lockfile entry with no
 * version -- a `file:` dependency whose manifest declares none, a
 * versionless workspace member -- is still an installed package. Dropping
 * it dropped every advisory about it; an absent version is instead
 * indeterminate applicability downstream, and it is never filled in from
 * another node of the same name.
 */
export interface DependencyNode {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly ecosystem: "npm";
  readonly direct: boolean;
  readonly locations: readonly string[];
  readonly dependencyPaths: readonly (readonly string[])[];
  readonly purl?: string;
}
