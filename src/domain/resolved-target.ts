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
 * A LOCAL package root — a package that is part of the scanned repository
 * rather than installed into it: an npm/Yarn/pnpm workspace member, or any
 * other package root established by authoritative repository metadata
 * (P1-A4).
 *
 * This exists so {@link buildKnownPackageRoots} can admit such a root
 * WITHOUT the domain layer having to know how it was discovered. The
 * discovery authority lives in `dependencies/workspaces.ts`; this is only
 * the shape it hands over — a canonical root and the name its own manifest
 * declares. Crucially it is still the ROOT that is identity here, exactly
 * as for an installed instance: `packageName` is carried for the
 * advisory-name match and for explainability, and can never merge two
 * distinct roots or split one.
 *
 * A caller must never synthesize one of these from a directory that merely
 * looks like a package. Admitting an arbitrary directory as a package root
 * is precisely the failure `KnownPackageRoots` was introduced to prevent
 * (see this type's own doc comment above).
 */
export interface LocalPackageRoot {
  readonly canonicalRoot: string;
  readonly packageName: string;
}

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
  localPackageRoots: readonly LocalPackageRoot[] = [],
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
  for (const local of localPackageRoots) {
    const canonicalRoot = canonicalizePackageInstancePath(local.canonicalRoot);
    // The dependency graph is the older and more specific authority for a
    // root it already named, so it is never overwritten here. This matters
    // only for the map's NAME value, and only as a tie-break that no
    // downstream answer actually depends on: `identifyKnownPackageInstance`
    // prefers the package's own manifest name over this value either way.
    // Not overwriting keeps the merge order-independent.
    if (!roots.has(canonicalRoot)) {
      roots.set(canonicalRoot, local.packageName);
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
 *
 * Exported (P1-A3) because it is also the ALIAS-OWNERSHIP authority:
 * `code-intelligence/package-entry.ts` may substitute an instance's install
 * DIRECTORY for an advisory's package name only when that instance's own
 * manifest declares the advisory's name -- the package itself saying "I am
 * `foo`", never a path-shape guess. Kept here, as one reader, rather than
 * duplicated there.
 */
export function readInstalledPackageName(
  packageInstance: string,
): string | undefined {
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
 * What the package ACTUALLY INSTALLED at a canonical root says about its
 * own version (Foundation F1-B).
 *
 * Four outcomes, deliberately distinguished, because collapsing any two of
 * them is a soundness bug in one direction or a large, pointless coverage
 * loss in the other:
 *
 * - `absent`    — there is no manifest at that root. The root is DECLARED
 *                 (a lockfile entry, a workspace pattern) but nothing is
 *                 materialized there, which is the ordinary state of a
 *                 project whose dependencies are not installed. Nothing is
 *                 installed, so nothing contradicts the declaration.
 * - `untrusted` — a manifest IS installed there and its own version claim
 *                 cannot be used. Some package occupies that directory and
 *                 the analyzer cannot establish which one, which is NOT the
 *                 same as nothing being installed. The `reason` separates
 *                 the two ways this happens, because they are different
 *                 facts about the project and a reader fixes them
 *                 differently: `"unreadable"` — the file could not be read
 *                 or parsed at all; `"unusable-version"` — the file read
 *                 and parsed perfectly well, and its `"version"` is present
 *                 but not a usable string. Saying the manifest "could not
 *                 be read" of the second case is simply false.
 * - `silent`    — the manifest parsed and simply declares no version. It
 *                 makes no competing claim (a private workspace package is
 *                 routinely versionless), so a declared version stands.
 * - `declared`  — a concrete version, the package's own statement about
 *                 itself.
 *
 * Separate from {@link readInstalledPackageName} rather than merged with
 * it: that reader answers a question with a sound FALLBACK (an unreadable
 * manifest simply yields no name, and the path-derived name still applies),
 * while this one answers a question where "unreadable" and "not there" have
 * opposite consequences and must not be folded into one `undefined`.
 */
export type InstalledVersionClaim =
  | { readonly kind: "absent" }
  | {
      readonly kind: "untrusted";
      readonly reason: "unreadable" | "unusable-version";
    }
  | { readonly kind: "silent" }
  | { readonly kind: "declared"; readonly version: string };

/** One read of `<packageInstance>/package.json`, name and version claim. */
export interface InstalledManifestIdentity {
  /** The package's own declared name, when present and valid. */
  readonly name?: string;
  readonly version: InstalledVersionClaim;
}

/**
 * Reads a canonical package root's own installed manifest ONCE, yielding
 * both the name authority {@link readInstalledPackageName} already
 * establishes and the version claim {@link InstalledVersionClaim} defines.
 *
 * One read rather than two: the registry needs both fields for the same
 * root, and a second `readFileSync` of the same file would double the
 * filesystem work of every scan for no new information.
 *
 * A directory that cannot be listed at all (`ENOENT`, `ENOTDIR`) has no
 * manifest and is `absent`. Every other read failure means a manifest is
 * there and could not be consumed, which is `untrusted` — the distinction
 * the type exists for.
 */
export function readInstalledManifestIdentity(
  packageInstance: string,
): InstalledManifestIdentity {
  let text: string;
  try {
    text = readFileSync(path.join(packageInstance, "package.json"), "utf-8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      version:
        code === "ENOENT" || code === "ENOTDIR"
          ? { kind: "absent" }
          : { kind: "untrusted", reason: "unreadable" },
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { version: { kind: "untrusted", reason: "unreadable" } };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { version: { kind: "untrusted", reason: "unreadable" } };
  }

  const name = (raw as { name?: unknown }).name;
  const identity = typeof name === "string" && name.length > 0 ? { name } : {};

  // `"version"` entirely absent is SILENCE; present-but-unusable (a
  // number, `null`, the empty string) is a claim this analyzer cannot
  // read, and reading it as silence would let a declared version stand
  // unopposed against a manifest that is in fact saying something.
  if (!("version" in raw)) {
    return { ...identity, version: { kind: "silent" } };
  }
  const version = (raw as { version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) {
    // The manifest read and parsed; only this field is unusable.
    return {
      ...identity,
      version: { kind: "untrusted", reason: "unusable-version" },
    };
  }
  return { ...identity, version: { kind: "declared", version } };
}

/**
 * ONE scan's memo for module-identity attribution (Foundation F5).
 *
 * Purely a PERFORMANCE artifact: every answer it returns is the answer
 * {@link identifyModule} would have computed, for the exact same inputs,
 * on the same filesystem. It introduces no new identity rule, no new
 * fallback and no new uncertainty, and it is deliberately incapable of
 * changing which {@link PackageInstanceId} a file is attributed to -- see
 * the key discipline below.
 *
 * WHY IT EXISTS. `identifyModule` is called once per GRAPH NODE per
 * resolved advisory target (`analysis/verdict.ts`'s `graphPackageInstances`)
 * and once per loaded file when the module-load closure enumerates its
 * package instances. Each call performs one `realpathSync` and one
 * `package.json` read. Measured on this repository's real-package
 * validation corpus at the F5 baseline: 2,870 `identifyModule` calls over
 * 175 distinct files, 2,991 `realpathSync` calls over 82 distinct inputs,
 * and 2,830 manifest reads over 45 distinct roots -- 94%, 97% and 98%
 * pure repetition respectively. The single worst shape in that corpus is
 * one 690-node graph built from TWO files (lodash), which alone accounts
 * for ~700 of each. The multiplier is `findings x targets x graph nodes`
 * and is unbounded in the graph's size, so it is the asymptotic cost that
 * matters here, not the corpus's own absolute milliseconds.
 *
 * KEY COMPLETENESS -- the property that makes this sound.
 * `identifyModule(resolvedFile, knownPackageRoots)` is a pure function of
 * exactly those two arguments and the filesystem. The cache therefore
 * BINDS one {@link KnownPackageRoots} registry at construction and keys
 * everything else on the exact, whole `resolvedFile` string. A caller that
 * asks with a DIFFERENT registry is not served from the cache at all (see
 * {@link identifyModule}'s own reference check) -- it falls through to the
 * uncached computation, which is the pre-F5 behavior. There is no partial
 * key here: not a package name, not a basename, not a version, not a
 * directory prefix. Two installs of the same name and version at different
 * physical roots are two different `resolvedFile` strings resolving to two
 * different canonical roots, and nothing in this cache can bring them
 * together.
 *
 * FAILURE IS NEVER CACHED. Only a SUCCESSFUL `realpathSync` and a
 * PRESENT, valid manifest name are stored. A canonicalization that fell
 * back to the normalized absolute path, and a manifest that was missing,
 * unreadable, malformed or nameless, are both re-attempted on every
 * subsequent request -- exactly as an uncached scan would. This is the
 * one place where a cache could turn a transient failure into a permanent
 * one, and it deliberately does not: absence of information is never
 * memoized as information.
 *
 * LIFETIME AND OWNERSHIP. Created once in `cli/scan.ts`'s
 * `runScanCommand`, immediately after the scan's `KnownPackageRoots`
 * registry exists and before anything consumes it, threaded explicitly
 * into the module-load closure builder and the scan's
 * `AnalysisProofContext`, and discarded when the scan returns. There is no
 * module-scope state here and nothing survives a scan: two scans in one
 * process share nothing, because each `runScanCommand` call creates its
 * own.
 *
 * BOUNDS. Entries are bounded by the scan's own input scale: at most one
 * per distinct resolved file the analysis reached (`identities`), and at
 * most one per distinct canonical package root beneath them
 * (`canonicalPaths`, `manifestNames`). Nothing here is keyed by anything
 * an advisory, a rule or a package name contributes, so no adversarial
 * string can grow it beyond the file set the analyzer already holds in
 * memory.
 */
export interface ScanModuleIdentityCache {
  /**
   * The registry this cache's answers were computed against. Compared by
   * REFERENCE at every use: a different registry means a different
   * function, so its answers are never served from here.
   */
  readonly knownPackageRoots: KnownPackageRoots | undefined;
  /** `resolvedFile` -> the identity `identifyModule` computed for it. */
  readonly identities: Map<string, ModuleIdentity>;
  /** `path.resolve(rawPath)` -> a SUCCESSFUL `realpathSync` result. Fallbacks are absent by design. */
  readonly canonicalPaths: Map<string, string>;
  /** canonical package root -> a PRESENT, valid manifest `"name"`. Absences are absent by design. */
  readonly manifestNames: Map<string, string>;
  /** Observable operation counts, so a test can assert redundant work really was removed. */
  readonly operations: ScanIdentityOperations;
}

/**
 * Filesystem operations this cache actually performed, and the requests it
 * served without them.
 *
 * Exposed deliberately rather than kept private: F5's claim is an
 * OPERATION-COUNT claim ("100 identity requests for the same path cost one
 * `realpathSync`, not 100"), and a claim like that has to be assertable by
 * a deterministic test rather than by a wall-clock measurement that a busy
 * machine can invalidate. These are counters on a per-scan object, not
 * global telemetry, and nothing in the analyzer reads them.
 */
export interface ScanIdentityOperations {
  /** `realpathSync` calls actually issued through this cache. */
  realpathCalls: number;
  /** `<root>/package.json` reads actually issued through this cache. */
  manifestReads: number;
  /** `identifyModule` requests answered from {@link ScanModuleIdentityCache.identities}. */
  identityHits: number;
  /** `identifyModule` requests that had to be computed. */
  identityMisses: number;
}

/**
 * Creates the one identity cache for one scan, bound to that scan's
 * {@link KnownPackageRoots}.
 *
 * `knownPackageRoots` is taken here, at construction, rather than accepted
 * per call: binding it once is what makes the per-call key complete
 * without every caller having to remember to include it. Pass the SAME
 * registry value the scan threads everywhere else -- a cache built against
 * a different registry simply never serves that caller (it is bypassed,
 * not consulted and overridden), so a mismatch costs performance and can
 * never cost correctness.
 */
export function createScanModuleIdentityCache(
  knownPackageRoots: KnownPackageRoots | undefined,
): ScanModuleIdentityCache {
  return {
    knownPackageRoots,
    identities: new Map<string, ModuleIdentity>(),
    canonicalPaths: new Map<string, string>(),
    manifestNames: new Map<string, string>(),
    operations: {
      realpathCalls: 0,
      manifestReads: 0,
      identityHits: 0,
      identityMisses: 0,
    },
  };
}

/**
 * {@link canonicalizePackageInstancePath}, memoized for one scan.
 *
 * Identical in every observable respect, with one deliberate asymmetry: a
 * SUCCESSFUL realpath is remembered, a FALLBACK is not. Remembering a
 * fallback would mean a path that was momentarily unreadable stays
 * non-canonical for the rest of the scan even once it becomes readable --
 * a cache turning a transient failure into a durable one, which is
 * precisely the error-caching hazard this must not have. Re-attempting
 * costs one `realpathSync` per request in a case that does not arise for
 * a package root the analyzer's own resolver or dependency graph just
 * discovered.
 */
function canonicalizeThroughCache(
  rawPath: string,
  cache: ScanModuleIdentityCache | undefined,
): string {
  if (!cache) {
    return canonicalizePackageInstancePath(rawPath);
  }
  const absolute = path.resolve(rawPath);
  const memoized = cache.canonicalPaths.get(absolute);
  if (memoized !== undefined) {
    return memoized;
  }
  cache.operations.realpathCalls += 1;
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    // Not memoized -- see this function's own doc comment.
    return absolute;
  }
  cache.canonicalPaths.set(absolute, canonical);
  return canonical;
}

/**
 * {@link readInstalledPackageName}, memoized for one scan.
 *
 * Memoizing the ONE name authority rather than introducing a second one:
 * `readInstalledPackageName` remains the only reader of an installed
 * package's own declared name (`code-intelligence/package-entry.ts`'s
 * alias-ownership gate calls the same function), and this wrapper changes
 * nothing about what it answers. It is deliberately NOT unified with
 * `dependencies/package-instances.ts`'s own per-scan manifest memo: that
 * one memoizes {@link readInstalledManifestIdentity}, which answers a
 * DIFFERENT question with four distinguished outcomes for the version
 * claim, and folding the two would mean one of the two call sites silently
 * acquiring the other's error semantics.
 *
 * As with canonicalization, only a PRESENT, valid name is remembered. A
 * missing, unreadable, malformed or nameless manifest is re-read, so an
 * absence is never frozen in.
 */
function manifestNameThroughCache(
  packageInstance: string,
  cache: ScanModuleIdentityCache | undefined,
): string | undefined {
  if (!cache) {
    return readInstalledPackageName(packageInstance);
  }
  const memoized = cache.manifestNames.get(packageInstance);
  if (memoized !== undefined) {
    return memoized;
  }
  cache.operations.manifestReads += 1;
  const name = readInstalledPackageName(packageInstance);
  if (name !== undefined) {
    cache.manifestNames.set(packageInstance, name);
  }
  return name;
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
 *
 * `cache` (Foundation F5) is a PERFORMANCE argument and nothing else. It
 * is optional everywhere, it is consulted only when it was built against
 * this exact `knownPackageRoots` registry, and every answer it can return
 * is an answer this function already computed for the same
 * `resolvedFile`. Omitting it, or passing one bound to a different
 * registry, changes no result -- only how many `realpathSync` and
 * `package.json` calls the scan makes. See {@link ScanModuleIdentityCache}
 * for the key discipline and for why failures are deliberately never
 * memoized.
 */
export function identifyModule(
  resolvedFile: string,
  knownPackageRoots?: KnownPackageRoots,
  cache?: ScanModuleIdentityCache,
): ModuleIdentity {
  // The cache is consulted ONLY when it was built against this exact
  // registry (reference equality -- see {@link ScanModuleIdentityCache}).
  // A mismatch is not an error and is never "resolved" by overriding one
  // side with the other: the request simply falls through to the uncached
  // computation below, which is byte-for-byte the pre-F5 behavior. That
  // is what makes a wrongly-threaded cache a performance loss and never a
  // correctness one.
  const usable =
    cache && cache.knownPackageRoots === knownPackageRoots ? cache : undefined;

  if (usable) {
    const memoized = usable.identities.get(resolvedFile);
    if (memoized !== undefined) {
      usable.operations.identityHits += 1;
      return memoized;
    }
    usable.operations.identityMisses += 1;
  }

  const identity = computeModuleIdentity(
    resolvedFile,
    knownPackageRoots,
    usable,
  );
  usable?.identities.set(resolvedFile, identity);
  return identity;
}

/**
 * {@link identifyModule}'s own body, with the memo lookup lifted out.
 *
 * Separated so the cached and uncached paths are literally the same code
 * rather than two implementations that have to be kept in agreement --
 * the failure mode a performance cache most easily introduces. `cache` is
 * used here only to avoid REDUNDANT filesystem work inside one
 * computation (canonicalization and the manifest-name read); it never
 * decides an outcome.
 */
function computeModuleIdentity(
  resolvedFile: string,
  knownPackageRoots: KnownPackageRoots | undefined,
  cache: ScanModuleIdentityCache | undefined,
): ModuleIdentity {
  const lastIndex = resolvedFile.lastIndexOf(NODE_MODULES_SEGMENT);
  if (lastIndex === -1) {
    return (
      (knownPackageRoots &&
        identifyKnownPackageInstance(
          resolvedFile,
          knownPackageRoots,
          cache,
        )) || {
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
        identifyKnownPackageInstance(
          resolvedFile,
          knownPackageRoots,
          cache,
        )) || {
        resolvedFile,
      }
    );
  }

  const rawInstanceLength =
    lastIndex + NODE_MODULES_SEGMENT.length + nameSegments.join("/").length;
  const packageInstance = canonicalizeThroughCache(
    resolvedFile.slice(0, rawInstanceLength),
    cache,
  );

  const packageName =
    manifestNameThroughCache(packageInstance, cache) ?? pathDerivedName;

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
  cache?: ScanModuleIdentityCache,
): ModuleIdentity | undefined {
  const canonicalResolvedFile = canonicalizeThroughCache(resolvedFile, cache);

  let dir = path.dirname(canonicalResolvedFile);
  let previous: string | undefined;
  while (dir !== previous) {
    const lockfileName = knownPackageRoots.get(dir);
    if (lockfileName !== undefined) {
      const packageName = manifestNameThroughCache(dir, cache) ?? lockfileName;
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
