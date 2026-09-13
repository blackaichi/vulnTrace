import path from "node:path";
import type { DependencyNode } from "../domain/dependency.js";
import {
  canonicalizePackageInstancePath,
  readInstalledPackageName,
  type PackageInstanceId,
} from "../domain/resolved-target.js";
import type { WorkspacePackage } from "./workspaces.js";

/**
 * ONE concrete package instance an advisory may apply to (P1-A5).
 *
 * `packageInstance` -- the CANONICAL PHYSICAL ROOT -- is the identity, and
 * the only identity. Not the name, not the version, not the pair: two
 * installs of `foo@1.2.0` at `node_modules/foo` and
 * `packages/app/node_modules/foo` are two instances with two independent
 * verdicts, and a symlink and its physical target are ONE instance. That
 * is not a VulnTrace convention -- Node itself resolves and caches by
 * realpath, so it is what really runs (see
 * {@link canonicalizePackageInstancePath}).
 *
 * `ownershipNames` is the set of package names by which an advisory may
 * SELECT this instance. It is a set rather than a single name because
 * identity (what package is this?) and install handle (where/under what
 * directory does it live?) are different questions for an npm alias
 * (`"foo-alias": "npm:foo@1.2.0"`), and the two authorities that answer
 * them -- the lockfile entry's own `name` and the installed package's own
 * manifest `"name"` -- can disagree. Selecting on either is deliberate and
 * conservative: over-selecting a candidate can only ever cost an extra
 * UNKNOWN, because the instance-scoped target resolution downstream
 * (P1-A3's `resolveAuthoritativePackageEntries`) independently refuses to
 * anchor an advisory at an instance whose own manifest does not own the
 * name. Under-selecting, by contrast, silently loses a vulnerable
 * instance. No new ownership rule is invented here: the manifest-name
 * authority is exactly `readInstalledPackageName`, the same reader P1-A3
 * already made the alias-ownership authority.
 *
 * `version` is METADATA, never identity, and is deliberately optional: an
 * instance whose version cannot be established (a private, versionless
 * workspace package -- P1-A4's genuine case) is still a real instance that
 * must be analyzed. It must NEVER be filled in from a sibling instance of
 * the same name; `undefined` means indeterminate applicability, which is
 * the sound answer, and inventing a version is how one instance's verdict
 * silently becomes another's.
 */
export interface CandidatePackageInstance {
  readonly packageInstance: PackageInstanceId;
  readonly ownershipNames: ReadonlySet<string>;
  /** The name to report and to query the vulnerability provider with. */
  readonly packageName: string;
  readonly version?: string;
  readonly ecosystem: "npm";
  /**
   * How this instance became known. Explainability only -- it never
   * changes identity, selection, or applicability. `"dependency-graph"`
   * wins the label when both authorities named the same canonical root,
   * because it is the older and more specific one.
   */
  readonly provenance: "dependency-graph" | "workspace";
  /**
   * The LOGICAL location this instance was declared at (a lockfile install
   * path, or a workspace root relative to the project), for explainability.
   * Never used for comparison: `packageInstance` is the only identity.
   */
  readonly declaredLocation: string;
}

/**
 * Every candidate package instance in one scan, indexed for advisory
 * lookup. Built EXACTLY ONCE per scan and threaded through, never rebuilt
 * per advisory (see {@link buildPackageInstanceRegistry}).
 */
export interface PackageInstanceRegistry {
  /** Every instance, ordered by canonical root, deduplicated by it. */
  readonly instances: readonly CandidatePackageInstance[];
  /**
   * Every distinct ownership name, each mapped to the instances that may
   * be selected by it, ordered by canonical root.
   */
  readonly byOwnershipName: ReadonlyMap<
    string,
    readonly CandidatePackageInstance[]
  >;
}

function compareByRoot(
  a: CandidatePackageInstance,
  b: CandidatePackageInstance,
): number {
  return a.packageInstance < b.packageInstance
    ? -1
    : a.packageInstance > b.packageInstance
      ? 1
      : 0;
}

/**
 * Builds the scan's {@link PackageInstanceRegistry} by CONVERGING the two
 * authorities that can name a package root -- the dependency graph (every
 * `DependencyNode`'s every `location`) and the repository's own
 * `workspaces` declaration (P1-A4's `discoverWorkspacePackages`) -- on the
 * canonical physical root.
 *
 * Convergence, not concatenation, is the point. An npm workspace member is
 * routinely named by BOTH: once by the lockfile's own `packages/foo` entry
 * and once by workspace discovery, plus a third time as the
 * `node_modules/foo` symlink that points at it. All three are one physical
 * package and must produce ONE instance with ONE verdict, or the report
 * grows phantom duplicates that a reader cannot distinguish from genuine
 * twins. `canonicalizePackageInstancePath` realpaths, so the symlink and
 * its target collapse for free; the map below collapses the remaining two.
 *
 * The converse is equally load-bearing and is NOT dedupe: two genuinely
 * separate physical copies -- `packages/twinlib` and
 * `node_modules/twinlib`, same name, same version, different directories
 * -- stay two instances. Same name+version is never a reason to merge.
 *
 * Enumeration is authoritative-metadata-driven throughout: a lockfile
 * install path or a declared workspace root. It NEVER scans the filesystem
 * looking for directories named after a package (P1-A5 § INSTANCE
 * ENUMERATION), and it never infers an instance from source text.
 */
export function buildPackageInstanceRegistry(options: {
  readonly dependencyNodes: readonly DependencyNode[];
  readonly projectRoot: string;
  readonly workspacePackages?: readonly WorkspacePackage[];
}): PackageInstanceRegistry {
  const { dependencyNodes, projectRoot, workspacePackages = [] } = options;

  // One manifest read per canonical root per scan, not one per lookup.
  const manifestNames = new Map<string, string | undefined>();
  const manifestNameOf = (canonicalRoot: string): string | undefined => {
    if (!manifestNames.has(canonicalRoot)) {
      manifestNames.set(canonicalRoot, readInstalledPackageName(canonicalRoot));
    }
    return manifestNames.get(canonicalRoot);
  };

  const byRoot = new Map<string, CandidatePackageInstance>();

  for (const node of dependencyNodes) {
    for (const location of node.locations) {
      const packageInstance = canonicalizePackageInstancePath(
        path.resolve(projectRoot, location),
      );
      // The dependency graph is the more specific authority, so the FIRST
      // node to claim a canonical root keeps it. `buildDependencyGraph`
      // emits one node per lockfile entry and lockfile keys are unique, so
      // two entries can only collide here by resolving to the same
      // physical directory -- in which case they are the same instance and
      // merging is correct, not a lost node.
      if (byRoot.has(packageInstance)) {
        continue;
      }
      const ownershipNames = new Set<string>([node.name]);
      const manifestName = manifestNameOf(packageInstance);
      if (manifestName !== undefined) {
        ownershipNames.add(manifestName);
      }
      byRoot.set(packageInstance, {
        packageInstance,
        ownershipNames,
        packageName: node.name,
        version: node.version,
        ecosystem: node.ecosystem,
        provenance: "dependency-graph",
        declaredLocation: location,
      });
    }
  }

  for (const workspacePackage of workspacePackages) {
    const packageInstance = canonicalizePackageInstancePath(
      workspacePackage.canonicalRoot,
    );
    if (byRoot.has(packageInstance)) {
      // Already named by the dependency graph -- the SAME physical package,
      // reached through a second authority. One instance, one verdict.
      continue;
    }
    // A workspace root's identity comes from its own manifest and nowhere
    // else. With no declared name there is nothing an advisory could
    // select it by, and guessing one from the directory name is exactly
    // the path-shape inference P1-A4 forbids -- so it is not a candidate.
    // It keeps whatever ATTRIBUTION `KnownPackageRoots` already gives it;
    // this only declines to let an advisory select it.
    const manifestName =
      workspacePackage.packageName ?? manifestNameOf(packageInstance);
    if (manifestName === undefined) {
      continue;
    }
    byRoot.set(packageInstance, {
      packageInstance,
      ownershipNames: new Set([manifestName]),
      packageName: manifestName,
      // Deliberately carried through as-is, `undefined` included: a
      // private workspace package with no `"version"` has no version, and
      // borrowing one from an installed sibling of the same name is the
      // exact identity collapse P1-A5 exists to prevent.
      version: workspacePackage.version,
      ecosystem: "npm",
      provenance: "workspace",
      declaredLocation: path.relative(projectRoot, packageInstance) || ".",
    });
  }

  const instances = [...byRoot.values()].sort(compareByRoot);

  const byOwnershipName = new Map<string, CandidatePackageInstance[]>();
  for (const instance of instances) {
    for (const name of instance.ownershipNames) {
      const existing = byOwnershipName.get(name);
      if (existing) {
        existing.push(instance);
      } else {
        byOwnershipName.set(name, [instance]);
      }
    }
  }

  return { instances, byOwnershipName };
}

/**
 * Every candidate instance an advisory about `advisoryPackageName` may
 * apply to, ordered by canonical root (P1-A5 § ADVISORY EXPANSION
 * ALGORITHM).
 *
 * This answers ONLY "which exact instances does this advisory's package
 * name select?". It deliberately does not evaluate version ranges, resolve
 * targets, or reason about reachability: each returned instance is then
 * analyzed independently and completely on its own, which is what keeps
 * one instance's evidence from ever answering for another's.
 *
 * The returned order is deterministic (canonical root) and carries no
 * meaning: no caller may treat the first element as a representative. It
 * exists so a scan's output is reproducible, not so anything can be
 * skipped.
 */
export function findApplicablePackageInstances(
  registry: PackageInstanceRegistry,
  advisoryPackageName: string,
): readonly CandidatePackageInstance[] {
  return registry.byOwnershipName.get(advisoryPackageName) ?? [];
}

/**
 * The distinct `name@version` pairs the vulnerability provider must be
 * queried for, to discover every advisory that could apply to ANY instance
 * of `advisoryPackageName`.
 *
 * One query per distinct installed version, never one per instance: twins
 * at the same version share an answer, and repeating the query would be
 * pure network cost with no new information. Instances with no established
 * version contribute no query -- there is nothing to ask about -- but they
 * are still evaluated against whatever the siblings' queries return, which
 * is how a versionless instance reaches its own honest UNKNOWN instead of
 * silently disappearing from the report.
 *
 * Sorted, so the query order (and therefore the cache-population order and
 * any provider-failure message) does not depend on enumeration order.
 */
export function advisoryQueryVersions(
  instances: readonly CandidatePackageInstance[],
): readonly string[] {
  const versions = new Set<string>();
  for (const instance of instances) {
    if (instance.version !== undefined) {
      versions.add(instance.version);
    }
  }
  return [...versions].sort();
}

/**
 * Renders a canonical package-instance root for OUTPUT (P1-A5 § RESULT
 * IDENTITY).
 *
 * Project-relative, POSIX-separated, when the instance lives inside the
 * scanned project -- `node_modules/foo` vs `packages/app/node_modules/foo`
 * is exactly the distinction a reader needs, and it is reproducible across
 * machines and checkouts, which an absolute path is not. An instance
 * outside the project root (a pnpm content-addressed store, an
 * `npm link`ed checkout elsewhere on disk) keeps its absolute canonical
 * path, because there is no shorter honest way to name it.
 *
 * Presentation only. This string is never compared, never parsed back, and
 * never used to establish identity: `packageInstance` itself remains the
 * one canonical identity everywhere inside the analyzer.
 */
export function describePackageInstance(
  packageInstance: PackageInstanceId,
  projectRoot: string,
): string {
  const canonicalProjectRoot = canonicalizePackageInstancePath(projectRoot);
  const relative = path.relative(canonicalProjectRoot, packageInstance);
  if (relative === "") {
    return ".";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return packageInstance;
  }
  return relative.split(path.sep).join("/");
}
