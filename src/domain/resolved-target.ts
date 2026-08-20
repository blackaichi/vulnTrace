import { readFileSync } from "node:fs";
import path from "node:path";

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
 * Reads a package instance's own `package.json` `"name"` field, when
 * present and valid (VT-306, RWF-009). This is the authoritative package
 * *identity* for an npm-aliased install (`"semver-vulnerable":
 * "npm:semver@7.5.1"`), whose install *directory* name (`semver-vulnerable`)
 * never matches the aliased package's own declared name (`semver`) --
 * identity (what package is this?) and instance/location (where is this
 * installed copy?) are different concepts (see this module's own header
 * comment). Mirrors `analysis/verdict.ts`'s `readInstalledVersion` (same
 * file, same fallback discipline, kept as a separate reader rather than
 * merged -- the two exist at different layers and are read for different
 * purposes): a missing or malformed `package.json` is ordinary, expected
 * state for a real scanned project (not VulnTrace's own configuration), so
 * this degrades to `undefined` rather than throwing, letting the caller
 * fall back to the path-derived name.
 */
function readInstalledPackageName(packageInstance: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(path.join(packageInstance, "package.json"), "utf-8"),
    );
    const name = (raw as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derives a {@link ModuleIdentity} from a resolved file's own absolute
 * path, using its LAST `node_modules/<name>` segment (see
 * SDD-v0.2.md § 4.2's own example) to locate the owning installed package
 * *instance* -- a file nested inside `node_modules/bar/node_modules/foo/...`
 * belongs to the `.../node_modules/bar/node_modules/foo` instance, distinct
 * from a top-level `.../node_modules/foo` install of the same package
 * name. Handles scoped packages (`@scope/name`) as a single name segment.
 * `packageInstance` (the install location) is always this path-derived
 * value -- an alias never changes *where* a package is installed, only
 * what it should be called.
 *
 * `packageName` (the package *identity*, VT-306/RWF-009), by contrast,
 * prefers that instance's own `package.json` `"name"` field via
 * {@link readInstalledPackageName} when it's present and valid, falling
 * back to the path-derived segment only when it isn't (e.g. package.json
 * is missing, unreadable, or has no `name`) -- this is the same
 * conservative fallback direction already used elsewhere in this codebase
 * for package metadata that may not be available (e.g.
 * `analysis/verdict.ts`'s `readInstalledVersion`), not a new UNKNOWN
 * source: the path-derived name remains a defined value even when
 * package.json can't be read, so this never manufactures an UNKNOWN merely
 * because metadata was unavailable. A valid `package.json` name is never
 * overridden by the path-derived guess.
 *
 * Deliberately NOT shared with `derivePackageName`
 * (dependencies/package-lock.ts), which performs the equivalent
 * *path-derivation* for lockfile-relative install paths (a different input
 * shape, and already only a fallback there too -- the dependency-graph
 * layer's real identity source is the lockfile entry's own explicit
 * `name` field, which npm always writes for an alias). Both layers now
 * derive package identity from the same underlying authority --- the
 * package's own declared name (lockfile entry / installed package.json,
 * respectively) --- with path-derivation as the fallback in both, even
 * though the two authorities are read from different files.
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
  const pathDerivedName = nameSegments.join("/") || undefined;

  if (!pathDerivedName) {
    return { resolvedFile };
  }

  const instanceLength =
    lastIndex + NODE_MODULES_SEGMENT.length + nameSegments.join("/").length;
  const packageInstance = resolvedFile.slice(0, instanceLength);

  const packageName =
    readInstalledPackageName(packageInstance) ?? pathDerivedName;

  return {
    packageName,
    packageInstance,
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
