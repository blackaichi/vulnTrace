import { existsSync, readFileSync, realpathSync } from "node:fs";
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
 * Canonicalizes a package-instance root to one comparable PHYSICAL
 * identity, regardless of whether it was reached through a logical
 * `node_modules` path, a pnpm store symlink, an npm workspace/`file:`
 * link, or an npm-link-style install (VT-307c-fix-4; see the VT-307d
 * soundness review's Blocker A). Node's own module loader (without
 * `--preserve-symlinks`) resolves and caches by realpath, so this mirrors
 * real runtime identity, not a VulnTrace-specific convention: two logical
 * references that realpath to the same physical directory really are the
 * same loaded code at runtime.
 *
 * Every {@link PackageInstanceId} in this codebase MUST be produced by
 * this function (via {@link identifyModule} or directly by a caller that
 * already has a package-instance root, e.g. `cli/scan.ts`'s
 * dependency-graph-derived location) — never compared before it, and
 * never re-derived by a caller reaching for `fs.realpathSync` on its own.
 * One shared authority is what makes the same physical instance compare
 * equal everywhere: the dependency graph/finding side, the resolver/call
 * graph side, and `ModuleLoadClosure` membership.
 *
 * Best-effort by necessity: `fs.realpathSync` requires the path to
 * actually exist and be readable. A package-instance root VulnTrace's own
 * resolver or dependency graph just discovered normally does exist and
 * canonicalizes successfully. When it doesn't (removed between discovery
 * and this call, a permission error, or -- in tests -- a path that was
 * never real to begin with), this falls back to a normalized absolute
 * path rather than throwing: ordinary analysis must not crash over a
 * canonicalization nicety. Canonical equality is GUARANTEED only when both
 * sides' realpath succeeds; when one side falls back, two references to
 * the same physical instance compare equal only if their raw paths
 * already matched (no worse than before this function existed).
 */
export function canonicalizePackageInstancePath(rawPath: string): string {
  const absolute = path.resolve(rawPath);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

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
 * `node_modules` segment at all AND that lies inside `projectRoot` -- e.g.
 * the scanned project's own source, which has no installed-package
 * identity to derive. When `projectRoot` is supplied and the file
 * genuinely escapes it with no `node_modules` segment anywhere, falls back
 * to {@link identifyExternalPackageInstance} (VT-307c-fix-4 Part 9): an npm
 * workspace/`file:` link whose real physical target lives entirely outside
 * `node_modules` would otherwise silently lose its package identity, which
 * the VT-307d soundness review flagged as unsafe for a future absence
 * proof (an undiscoverable instance can never be confirmed absent OR
 * present).
 *
 * `packageInstance` in both branches is always canonicalized via
 * {@link canonicalizePackageInstancePath} (VT-307c-fix-4): the raw,
 * path-derived segment above is frequently already a physical path (the
 * call-graph/closure resolver follows symlinks itself), but canonicalizing
 * it unconditionally, rather than only when a caller happens to already
 * have a physical path, is what makes this the single shared identity
 * authority the VT-307d review requires -- a caller must never be able to
 * get a non-canonical answer by constructing its own resolved-file string.
 */
export function identifyModule(
  resolvedFile: string,
  projectRoot?: string,
): ModuleIdentity {
  const lastIndex = resolvedFile.lastIndexOf(NODE_MODULES_SEGMENT);
  if (lastIndex === -1) {
    return (
      (projectRoot &&
        identifyExternalPackageInstance(resolvedFile, projectRoot)) || {
        resolvedFile,
      }
    );
  }

  const afterNodeModules = resolvedFile.slice(
    lastIndex + NODE_MODULES_SEGMENT.length,
  );
  const segments = afterNodeModules.split("/");
  const isScoped = segments[0]?.startsWith("@") && segments.length > 1;
  const nameSegments = isScoped ? segments.slice(0, 2) : segments.slice(0, 1);
  const pathDerivedName = nameSegments.join("/") || undefined;

  if (!pathDerivedName) {
    return (
      (projectRoot &&
        identifyExternalPackageInstance(resolvedFile, projectRoot)) || {
        resolvedFile,
      }
    );
  }

  const rawInstanceLength =
    lastIndex + NODE_MODULES_SEGMENT.length + nameSegments.join("/").length;
  const packageInstance = canonicalizePackageInstancePath(
    resolvedFile.slice(0, rawInstanceLength),
  );

  const packageName =
    readInstalledPackageName(packageInstance) ?? pathDerivedName;

  return {
    packageName,
    packageInstance,
    resolvedFile,
  };
}

/**
 * Identifies the owning package instance for a resolved file that has NO
 * `node_modules` segment anywhere in its path (VT-307c-fix-4 Part 9) --
 * the shape of an npm workspace member or a `file:`/`npm link`-style
 * dependency whose physical target lives entirely outside any
 * `node_modules` directory (e.g. a monorepo's sibling `packages/foo`,
 * reached only via a `node_modules/foo` symlink that TypeScript's resolver
 * already followed before this function ever sees the path).
 *
 * Gated on `resolvedFile` genuinely escaping `projectRoot`'s own directory
 * tree -- never merely on "some ancestor happens to have a package.json"
 * -- specifically so this can NEVER misattribute package identity to the
 * scanned project's own source. An ordinary project file (`src/index.ts`)
 * is, by definition, always inside `projectRoot`; walking its ancestors
 * for a `package.json` would otherwise find the project's own manifest and
 * wrongly treat the whole project as "a package it depends on". A file
 * that has escaped `projectRoot` entirely, by contrast, can only have done
 * so through a real symlink/link the analyzed project's own dependency
 * tree established, which is exactly the case this exists to cover.
 *
 * The nearest ancestor directory containing a `package.json`, walking up
 * from `resolvedFile`, is treated as the package root -- mirroring how a
 * real npm/Node package boundary is defined by convention, since there is
 * no `node_modules/<name>` segment here to read a name out of instead.
 * Returns `undefined` (no identity) if no such ancestor is found before
 * the filesystem root, or if `resolvedFile` never actually escapes
 * `projectRoot` in the first place.
 */
function identifyExternalPackageInstance(
  resolvedFile: string,
  projectRoot: string,
): ModuleIdentity | undefined {
  const canonicalProjectRoot = canonicalizePackageInstancePath(projectRoot);
  const canonicalResolvedFile = canonicalizePackageInstancePath(resolvedFile);

  const relativeToProject = path.relative(
    canonicalProjectRoot,
    canonicalResolvedFile,
  );
  const isInsideProject =
    relativeToProject === "" ||
    (!relativeToProject.startsWith("..") &&
      !path.isAbsolute(relativeToProject));
  if (isInsideProject) {
    return undefined;
  }

  let dir = path.dirname(canonicalResolvedFile);
  let previous: string | undefined;
  while (dir !== previous) {
    if (existsSync(path.join(dir, "package.json"))) {
      const packageName = readInstalledPackageName(dir) ?? path.basename(dir);
      return { packageName, packageInstance: dir, resolvedFile };
    }
    previous = dir;
    dir = path.dirname(dir);
  }
  return undefined;
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
    readonly projectRoot?: string;
  },
): ResolvedTarget {
  const moduleId = identifyModule(resolvedFile, options?.projectRoot);

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
