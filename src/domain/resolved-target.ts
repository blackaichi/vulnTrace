/**
 * Identifies a concrete installed instance of a package on disk (see
 * SDD-v0.2.md § 4.2): the same package name at two different install
 * locations -- e.g. `node_modules/foo` vs
 * `node_modules/bar/node_modules/foo` -- MUST remain distinct identities,
 * never collapsed into one merely because both have `"name": "foo"` in
 * their own `package.json`. This is already how `DependencyNode.locations`
 * (dependencies/dependency-graph.ts) keeps installed instances distinct at
 * the dependency-graph layer; this is the equivalent concept for a
 * resolved call-graph/verdict target.
 */
export type PackageInstanceId = string;

/**
 * Identifies the concrete module instance a resolved file belongs to (see
 * SDD-v0.2.md § 4, § 4.1): not merely a package name, but package name,
 * package instance/root, and the concrete resolved file together.
 */
export interface ModuleIdentity {
  readonly packageName?: string;
  readonly packageInstance?: PackageInstanceId;
  readonly resolvedFile: string;
}

/**
 * A single resolved vulnerable-symbol target, carrying enough identity to
 * distinguish it from a different installed instance of the same package
 * name (see SDD-v0.2.md § 4). The exact shape mirrors the SDD's own
 * conceptual type; `resolutionEvidence` is a flat reason trail rather than
 * a richer structured type, matching how evidence is modeled elsewhere in
 * this codebase (see domain/evidence.ts) -- the SDD itself notes "the
 * exact TypeScript representation may evolve; the semantics are
 * normative."
 */
export interface ResolvedTarget {
  readonly packageName?: string;
  readonly packageInstance?: PackageInstanceId;
  readonly packageVersion?: string;
  readonly moduleId: ModuleIdentity;
  readonly resolvedFile: string;
  readonly exportedSymbol?: string;
  readonly symbolId?: string;
  readonly resolutionEvidence: readonly string[];
}

const NODE_MODULES_SEGMENT = "/node_modules/";

/**
 * Derives a {@link ModuleIdentity} from a resolved file's own absolute
 * path, using its LAST `node_modules/<name>` segment (see
 * SDD-v0.2.md § 4.2's own example): a file nested inside
 * `node_modules/bar/node_modules/foo/...` is identified by the
 * `.../node_modules/bar/node_modules/foo` instance, distinct from a
 * top-level `.../node_modules/foo` install of the same package name.
 * Handles scoped packages (`@scope/name`) as a single name segment.
 *
 * Mirrors `derivePackageName` (dependencies/package-lock.ts), which does
 * the equivalent derivation for lockfile-relative install paths (e.g.
 * `"node_modules/foo/node_modules/@scope/bar"`) rather than resolved
 * filesystem paths -- kept separate rather than shared, since the two
 * operate on different path shapes (lockfile keys vs. real resolved file
 * paths) and unifying them would couple the dependency-graph layer to the
 * call-graph/verdict layer for no real benefit.
 *
 * Returns just `{ resolvedFile }` (no package identity) for a file with no
 * `node_modules` segment at all -- e.g. the scanned project's own source,
 * which has no installed-package identity to derive.
 */
export function identifyModule(resolvedFile: string): ModuleIdentity {
  const lastIndex = resolvedFile.lastIndexOf(NODE_MODULES_SEGMENT);
  if (lastIndex === -1) {
    return { resolvedFile };
  }

  const afterNodeModules = resolvedFile.slice(
    lastIndex + NODE_MODULES_SEGMENT.length,
  );
  const segments = afterNodeModules.split("/");
  const isScoped = segments[0]?.startsWith("@") && segments.length > 1;
  const nameSegments = isScoped ? segments.slice(0, 2) : segments.slice(0, 1);
  const packageName = nameSegments.join("/") || undefined;

  if (!packageName) {
    return { resolvedFile };
  }

  const instanceLength =
    lastIndex + NODE_MODULES_SEGMENT.length + nameSegments.join("/").length;

  return {
    packageName,
    packageInstance: resolvedFile.slice(0, instanceLength),
    resolvedFile,
  };
}

/**
 * Builds a full {@link ResolvedTarget} from a resolved file and
 * (optionally) the export/symbol it addresses. `moduleId` and the
 * top-level `packageName`/`packageInstance` are always kept consistent,
 * both derived from the same {@link identifyModule} call.
 */
export function buildResolvedTarget(
  resolvedFile: string,
  options?: {
    readonly exportedSymbol?: string;
    readonly symbolId?: string;
    readonly packageVersion?: string;
    readonly resolutionEvidence?: readonly string[];
  },
): ResolvedTarget {
  const moduleId = identifyModule(resolvedFile);

  return {
    packageName: moduleId.packageName,
    packageInstance: moduleId.packageInstance,
    packageVersion: options?.packageVersion,
    moduleId,
    resolvedFile,
    exportedSymbol: options?.exportedSymbol,
    symbolId: options?.symbolId,
    resolutionEvidence: options?.resolutionEvidence ?? [],
  };
}
