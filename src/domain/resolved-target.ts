import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { DependencyNode } from "./dependency.js";

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
 * Every installed dependency's canonical physical root, mapped to the
 * package name the dependency graph/lockfile itself declares for it
 * (VT-307c-fix-4b; see the VT-307d review's Blocker A follow-up).
 *
 * This is the DEPENDENCY-PROVENANCE authority a resolved file with no
 * `node_modules` segment must be checked against before it can be
 * attributed to any installed package instance -- see
 * {@link identifyKnownPackageInstance}. A physical root's mere presence on
 * disk, or having its own `package.json`, is NEVER sufficient by itself
 * (that was VT-307c-fix-4's own now-superseded approach, which could not
 * distinguish an npm workspace member from the scanned project's own
 * source merely by asking "is this inside or outside projectRoot" -- both
 * questions have nothing to do with whether the directory is actually an
 * INSTALLED DEPENDENCY). Provenance -- "the dependency graph itself named
 * this exact location as an install target" -- is the only question that
 * can never misfire on ordinary project source: the scanned project's own
 * `package.json` is never one of `DependencyNode.locations`, so it can
 * never enter this map no matter how it's structured on disk.
 */
export type KnownPackageRoots = ReadonlyMap<PackageInstanceId, string>;

/**
 * Builds {@link KnownPackageRoots} from the full dependency graph
 * (VT-307c-fix-4b) -- every `DependencyNode`'s every `location`,
 * canonicalized through the exact same {@link canonicalizePackageInstancePath}
 * formula `cli/scan.ts` already uses for a finding's own `packageInstance`,
 * so the two sides are guaranteed to produce identical keys for the same
 * physical install.
 *
 * Intended to be built exactly ONCE per scan (this does one `realpathSync`
 * per install location, not per source file later checked against it) and
 * threaded through as explicit context -- never rebuilt ad hoc, and never
 * read from an implicit global/singleton (see this task's own Part 4).
 */
export function buildKnownPackageRoots(
  nodes: readonly DependencyNode[],
  projectRoot: string,
): KnownPackageRoots {
  const roots = new Map<string, string>();
  for (const node of nodes) {
    for (const location of node.locations) {
      const canonicalRoot = canonicalizePackageInstancePath(
        path.resolve(projectRoot, location),
      );
      roots.set(canonicalRoot, node.name);
    }
  }
  return roots;
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
 * `node_modules` segment at all AND whose containing directory tree
 * matches no entry in `knownPackageRoots` -- e.g. the scanned project's
 * own source, which is never itself one of the dependency graph's own
 * install locations no matter how its directories happen to be arranged.
 * When `knownPackageRoots` is supplied, falls back to
 * {@link identifyKnownPackageInstance} (VT-307c-fix-4b, superseding
 * VT-307c-fix-4's own now-unsound `projectRoot`-containment check -- see
 * that function's doc comment): an npm workspace member, a `file:`
 * dependency, or any other linked install whose real physical target has
 * no `node_modules` segment of its own would otherwise silently lose its
 * package identity, unsound REGARDLESS of whether that physical target
 * happens to live inside or outside the scanned project's own directory
 * tree (the VT-307d review's Blocker A: an in-tree linked target, e.g. an
 * npm workspace scanned from its own monorepo root, is the common case
 * fix-4's `projectRoot`-escape check silently missed).
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
  knownPackageRoots?: KnownPackageRoots,
): ModuleIdentity {
  const lastIndex = resolvedFile.lastIndexOf(NODE_MODULES_SEGMENT);
  if (lastIndex === -1) {
    return (
      (knownPackageRoots &&
        identifyKnownPackageInstance(resolvedFile, knownPackageRoots)) || {
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
      (knownPackageRoots &&
        identifyKnownPackageInstance(resolvedFile, knownPackageRoots)) || {
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
 * `node_modules` segment anywhere in its path (VT-307c-fix-4b) -- the
 * shape of an npm workspace member or a `file:`/`npm link`-style
 * dependency whose physical target lives entirely outside any
 * `node_modules` directory (e.g. a monorepo's sibling `packages/foo`, or
 * an in-tree `vendor/foo`, reached only via a `node_modules/foo` symlink
 * that TypeScript's resolver already followed before this function ever
 * sees the path).
 *
 * Gated on DEPENDENCY PROVENANCE, never on filesystem containment or the
 * mere presence of a `package.json`: walks up from `resolvedFile` looking
 * for the nearest ancestor directory that is itself a key in
 * `knownPackageRoots` -- i.e. a canonical root the dependency graph itself
 * named as an install location (see {@link buildKnownPackageRoots}). This
 * is what fix-4's own `projectRoot`-escape check got wrong: "is this
 * inside or outside the scanned project's own directory" has nothing to
 * do with "is this an installed dependency" -- an npm workspace scanned
 * from its own monorepo root has every workspace member INSIDE
 * `projectRoot`, which fix-4's check therefore silently refused to
 * attribute (the VT-307d review's Blocker A). Provenance instead can never
 * misfire on ordinary project source: the scanned project's own
 * `package.json` is never a `DependencyNode` location, so it can never
 * appear in `knownPackageRoots` regardless of where it physically sits.
 *
 * Walking up (rather than an exact-match-only lookup) is necessary because
 * `resolvedFile` is usually a file WITHIN the package
 * (`packages/foo/lib/deep/file.js`), not the package root itself. Stopping
 * at the FIRST known root found also makes this most-specific-root-wins by
 * construction: a nested known root (e.g. `packages/foo/node_modules/bar`)
 * is always reached before its own less-specific ancestor (`packages/foo`)
 * during the same upward walk, so a file under `bar` can never be
 * misattributed to `foo`.
 *
 * Returns `undefined` (no identity) if no ancestor directory is a known
 * root before the filesystem root is reached.
 */
function identifyKnownPackageInstance(
  resolvedFile: string,
  knownPackageRoots: KnownPackageRoots,
): ModuleIdentity | undefined {
  const canonicalResolvedFile = canonicalizePackageInstancePath(resolvedFile);

  let dir = path.dirname(canonicalResolvedFile);
  let previous: string | undefined;
  while (dir !== previous) {
    const lockfileName = knownPackageRoots.get(dir);
    if (lockfileName !== undefined) {
      const packageName = readInstalledPackageName(dir) ?? lockfileName;
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
    readonly knownPackageRoots?: KnownPackageRoots;
  },
): ResolvedTarget {
  const moduleId = identifyModule(resolvedFile, options?.knownPackageRoots);

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
