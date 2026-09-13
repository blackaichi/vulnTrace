import path from "node:path";
import type { DependencyNode } from "../domain/dependency.js";
import {
  canonicalizePackageInstancePath,
  readInstalledManifestIdentity,
  type InstalledManifestIdentity,
  type InstalledVersionClaim,
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
/**
 * One canonical physical root whose discovery records DISAGREE about the
 * version (P1-A5 remediation).
 *
 * Reported, not resolved. {@link reconcileInstanceMetadata} already fails
 * closed for this case -- the instance's version becomes `undefined`, no
 * provider query is made for it, and no verdict is derived from a version
 * nothing established. That is the sound outcome, and it is also a SILENT
 * one: the instance simply contributes nothing to the report, so a reader
 * cannot tell "this package is fine" from "this project's own metadata
 * contradicts itself about this package and the question was never asked".
 *
 * This record is what lets the CLI say the second thing out loud. It
 * changes no verdict and creates no finding (AGENTS.md: every uncertainty
 * must be represented explicitly).
 */
export interface PackageInstanceVersionConflict {
  readonly packageInstance: PackageInstanceId;
  /** The name this instance is reported under, for a readable message. */
  readonly packageName: string;
  /** Every distinct claimed version, sorted, so the report is stable. */
  readonly declaredVersions: readonly string[];
  /**
   * Which authorities contributed a version anywhere on this root, sorted
   * and deduplicated -- the UNION over {@link versionClaims}. Lets a
   * renderer say in one clause whether the installed package is involved
   * at all, without walking the per-version detail.
   */
  readonly sources: readonly VersionSource[];
  /**
   * Each conflicting version paired with the authorities that claimed it,
   * ordered by version. This is what makes the diagnostic's provenance
   * TRUE rather than merely plausible.
   */
  readonly versionClaims: readonly PackageInstanceVersionClaim[];
}

/**
 * Which authority claimed a version for a canonical root.
 *
 * - `"declared"`  — the dependency graph, i.e. this project's own
 *                   dependency metadata (`package.json` + the lockfile it
 *                   resolved to). Deliberately NOT called "lockfile": the
 *                   graph is what this layer is handed, and nothing here
 *                   guarantees a given node came from a lockfile entry.
 * - `"workspace"` — the repository's own `workspaces` declaration.
 * - `"installed"` — the manifest of the package actually installed at that
 *                   physical root.
 *
 * The distinction exists for the CONFLICT MESSAGE and nothing else:
 * neither source outranks the other in
 * {@link reconcileInstanceMetadata}, which is the whole point (Foundation
 * F1 § 10).
 *
 * Note that `"installed"` can contribute AT MOST ONE version to a root --
 * a directory has one manifest -- so a conflict can never be
 * installed-only. Every conflict involves at least one declared or
 * workspace claim.
 */
export type VersionSource = "declared" | "workspace" | "installed";

/**
 * One concrete version claimed for a root, and every authority that
 * claimed it.
 *
 * This is the shape the conflict message is rendered from. A flat list of
 * versions cannot say WHERE each came from, and a flat list of sources
 * cannot say WHICH version each vouched for -- and it is exactly that
 * pairing a reader needs, because "the lockfile says 1.0.0 and the
 * installed package says 2.0.0" and "two lockfile entries disagree and the
 * disk agrees with one of them" are different problems with different
 * fixes.
 */
export interface PackageInstanceVersionClaim {
  readonly version: string;
  /** Every authority claiming this version, sorted, deduplicated. */
  readonly sources: readonly VersionSource[];
}

/**
 * One canonical physical root where a package IS installed but its own
 * manifest cannot be read (Foundation F1-B § 18).
 *
 * Reported, and failed closed on. This is not the same as a root with no
 * manifest at all: there, nothing is installed and the project's declared
 * version stands unopposed. Here something occupies the directory and the
 * analyzer cannot establish WHAT -- so a declared version can no longer be
 * confirmed to describe the code that is actually there, and evaluating an
 * advisory range against it would be a confident answer about a package
 * whose identity is unknown. The version becomes `undefined`, exactly as
 * for a contradiction, and this record is what keeps the resulting silence
 * legible.
 */
export interface PackageInstanceManifestUncertainty {
  readonly packageInstance: PackageInstanceId;
  readonly packageName: string;
  /**
   * Why the installed manifest's version could not be used. Carried
   * through so the message can say which actually happened: a manifest
   * that parsed fine but carries `"version": 123` was READ perfectly well,
   * and reporting it as unreadable is false.
   */
  readonly reason: "unreadable" | "unusable-version";
  /**
   * Every version the project's own dependency metadata declared for this
   * root, sorted -- the claim that could not be confirmed. Possibly empty.
   */
  readonly declaredVersions: readonly string[];
}

export interface PackageInstanceRegistry {
  /** Every instance, ordered by canonical root, deduplicated by it. */
  readonly instances: readonly CandidatePackageInstance[];
  /**
   * Every canonical root whose records contradicted each other about the
   * version, ordered by canonical root. Exactly one entry per root, however
   * many contradictory records it had.
   */
  readonly versionConflicts: readonly PackageInstanceVersionConflict[];
  /**
   * Every canonical root that has an installed manifest the analyzer could
   * not read, ordered by canonical root. Disjoint in cause from
   * {@link versionConflicts} but identical in consequence: no established
   * version, no provider query, no applicability decision.
   */
  readonly untrustedManifests: readonly PackageInstanceManifestUncertainty[];
  /**
   * Every distinct ownership name, each mapped to the instances that may
   * be selected by it, ordered by canonical root.
   */
  readonly byOwnershipName: ReadonlyMap<
    string,
    readonly CandidatePackageInstance[]
  >;
}

/**
 * ONE discovery record about ONE canonical physical root, before any
 * reconciliation. Several of these can describe the same root: a lockfile
 * entry, the repository's `workspaces` declaration, and the
 * `node_modules` symlink npm writes beside a workspace member are three
 * records about one physical package.
 */
interface InstanceRecord {
  readonly ownershipNames: ReadonlySet<string>;
  readonly packageName: string;
  readonly version?: string;
  readonly provenance: "dependency-graph" | "workspace";
  readonly declaredLocation: string;
}

/**
 * Reconciles every discovery record about one canonical root into one
 * {@link CandidatePackageInstance}.
 *
 * ## Version — the only field with a soundness consequence
 *
 * Version drives advisory applicability, so how disagreement is resolved
 * decides whether a finding exists at all. The rule is stated over the SET
 * of versions the authorities actually CLAIM -- every discovery record,
 * plus the package installed at that root (Foundation F1-B):
 *
 * - exactly one distinct claimed version -> that version;
 * - two or more distinct claimed versions -> `undefined`;
 * - none claimed -> `undefined`;
 * - an installed manifest that exists and cannot be read -> `undefined`,
 *   whatever the records claim.
 *
 * ## The installed package is an authority, and it does not outrank one
 *
 * The lockfile says what SHOULD be installed; the manifest at the root says
 * what IS. A divergent `node_modules` makes them disagree, and before F1-B
 * only the first was consulted -- so an advisory range was evaluated
 * against a version that described no code on disk, producing a confident
 * AFFECTED about an absent version in one direction and no finding at all
 * about a genuinely vulnerable installed one in the other.
 *
 * Neither direction is fixed by picking a winner. Preferring the manifest
 * makes every uninstalled dependency (a lockfile entry with nothing on
 * disk -- most of them, in an un-installed checkout) lose its version;
 * preferring the lockfile is the defect. So the manifest joins the SET on
 * equal terms and a contradiction fails closed, exactly as a contradiction
 * between two records already did. The analyzer's claim is not "I know
 * which of these is right" -- it is "this project's own metadata does not
 * agree with itself, and I will not compute a confident answer from it".
 *
 * Being a property of the set, this is order-independent by construction
 * rather than by care, and a conflict cannot be walked back: records
 * saying `1.0.0`, then `2.0.0`, then `1.0.0` again contradict each other
 * whichever order they arrive in, and a later agreeing record does not
 * un-contradict the earlier pair. A fold comparing "incoming against
 * current" would restore `1.0.0` there; this cannot.
 *
 * Conflict FAILS CLOSED to `undefined`, never to a chosen winner. First,
 * last, highest, lowest and lexicographic are all arbitrary, and each one
 * silently converts "the project's own metadata contradicts itself about
 * this directory" into a confident AFFECTED or NOT_AFFECTED computed from
 * a version nothing established. `undefined` instead flows through the
 * existing contract -- indeterminate applicability, UNKNOWN -- which is
 * the answer the analyzer already knows how to justify.
 *
 * ## Silence is NOT conflict
 *
 * A record with no `version` makes no competing claim, and is therefore
 * not part of the distinct-version set. Neither does an ABSENT installed
 * manifest: a declared root with nothing materialized at it is the
 * ordinary state of an un-installed checkout -- 1064 of this repository's
 * own 6584 lockfile entries, measured -- and treating "not installed" as
 * "disagrees" would delete most of the analyzer's coverage to describe
 * nothing at all. An UNREADABLE manifest is the opposite case and is NOT
 * silence: something is installed there and the analyzer cannot establish
 * what, so the declared version can no longer be confirmed to describe it.
 * This matters constantly and the alternative would be a large, pointless
 * coverage loss: an ordinary npm workspace member is routinely described
 * by a lockfile entry that carries its version AND a manifest that omits
 * one, and treating that as a contradiction would make every such package
 * UNKNOWN. It also matches
 * how every other fallback in this codebase reads a silent source --
 * `identifyModule` prefers a manifest name and falls back to the path,
 * `buildDependencyGraph` calls a versionless link entry "inherent to
 * unversioned/local links" -- none of which treats "this source does not
 * know" as "this source disagrees".
 *
 * ## Everything else
 *
 * `ownershipNames` is the union: each record's naming authority is
 * additive, and an advisory may select the instance by any of them.
 * `provenance` prefers `"dependency-graph"` when any record has it (the
 * older and more specific authority). `packageName` and `declaredLocation`
 * are explainability only; each is chosen by a total order over the
 * records rather than by arrival, so neither can vary with enumeration
 * order.
 */
function reconcileInstanceMetadata(
  packageInstance: PackageInstanceId,
  records: readonly InstanceRecord[],
  installed: InstalledVersionClaim,
): {
  readonly instance: CandidatePackageInstance;
  /** Present only when two or more distinct versions were claimed. */
  readonly conflict?: PackageInstanceVersionConflict;
  /** Present only when a manifest is installed and could not be read. */
  readonly untrustedManifest?: PackageInstanceManifestUncertainty;
} {
  const ownershipNames = new Set<string>();
  const declaredVersions = new Set<string>();
  // version -> every authority that claimed it. Built alongside the sets
  // rather than reconstructed afterwards: provenance that is re-derived
  // later is provenance that can drift from what actually happened, which
  // is the defect this pairing exists to prevent.
  const claimSources = new Map<string, Set<VersionSource>>();
  const claim = (version: string, source: VersionSource): void => {
    const existing = claimSources.get(version);
    if (existing) {
      existing.add(source);
    } else {
      claimSources.set(version, new Set([source]));
    }
  };

  for (const entry of records) {
    for (const name of entry.ownershipNames) {
      ownershipNames.add(name);
    }
    if (entry.version !== undefined) {
      declaredVersions.add(entry.version);
      claim(
        entry.version,
        entry.provenance === "workspace" ? "workspace" : "declared",
      );
    }
  }

  // The installed package's own claim joins the SET on equal terms. It is
  // not appended to the records above because it is a property of the
  // ROOT, not of any one discovery record: however many lockfile entries
  // and workspace patterns named this directory, there is exactly one
  // package installed in it, and it says one thing about itself.
  if (installed.kind === "declared") {
    claim(installed.version, "installed");
  }
  const claimedVersions = new Set(claimSources.keys());

  // Two independent reasons to have no established version, with the same
  // consequence. `untrusted` is not folded into the conflict set as a
  // pseudo-version: it is an ABSENCE of a readable claim, and a set of
  // claimed versions must contain only versions something actually
  // claimed.
  const untrusted = installed.kind === "untrusted";
  const version =
    !untrusted && claimedVersions.size === 1
      ? [...claimedVersions][0]
      : undefined;

  const fromDependencyGraph = records.filter(
    (entry) => entry.provenance === "dependency-graph",
  );
  const preferred =
    fromDependencyGraph.length > 0 ? fromDependencyGraph : records;
  const sorted = [...preferred].sort((a, b) =>
    a.declaredLocation < b.declaredLocation
      ? -1
      : a.declaredLocation > b.declaredLocation
        ? 1
        : a.packageName < b.packageName
          ? -1
          : a.packageName > b.packageName
            ? 1
            : 0,
  );
  const representative = sorted[0];

  const packageName =
    representative?.packageName ?? [...ownershipNames][0] ?? "";

  const instance: CandidatePackageInstance = {
    packageInstance,
    ownershipNames,
    packageName,
    ...(version !== undefined ? { version } : {}),
    ecosystem: "npm",
    provenance:
      fromDependencyGraph.length > 0 ? "dependency-graph" : "workspace",
    declaredLocation: representative?.declaredLocation ?? packageInstance,
  };

  // Each condition below is exactly the one that produced the `undefined`
  // above, so the report can never disagree with the reconciliation.
  // Deliberately NOT `version === undefined`: a root nothing ever declared
  // a version for (size 0) is silent, not contradictory, and must not be
  // reported as either.
  const untrustedManifest =
    installed.kind === "untrusted"
      ? {
          packageInstance,
          packageName,
          reason: installed.reason,
          declaredVersions: [...declaredVersions].sort(),
        }
      : undefined;

  if (claimedVersions.size <= 1) {
    return { instance, ...(untrustedManifest ? { untrustedManifest } : {}) };
  }
  return {
    instance,
    ...(untrustedManifest ? { untrustedManifest } : {}),
    conflict: {
      packageInstance,
      packageName,
      // Sorted, so the message does not depend on which record arrived
      // first; a repeated value collapses because this is a Set.
      declaredVersions: [...claimedVersions].sort(),
      sources: [
        ...new Set([...claimSources.values()].flatMap((each) => [...each])),
      ].sort(),
      versionClaims: [...claimSources.entries()]
        .map(([version, sources]) => ({
          version,
          sources: [...sources].sort(),
        }))
        .sort((a, b) =>
          a.version < b.version ? -1 : a.version > b.version ? 1 : 0,
        ),
    },
  };
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

  // One manifest read per canonical root per scan, not one per lookup --
  // and ONE read for both fields it answers. Reading the same file twice
  // (once for the name authority, once for the version claim) would double
  // this phase's filesystem work for no new information, and could in
  // principle observe two different files if the tree changed underneath
  // the scan.
  const manifests = new Map<string, InstalledManifestIdentity>();
  const manifestOf = (canonicalRoot: string): InstalledManifestIdentity => {
    const cached = manifests.get(canonicalRoot);
    if (cached !== undefined) {
      return cached;
    }
    const read = readInstalledManifestIdentity(canonicalRoot);
    manifests.set(canonicalRoot, read);
    return read;
  };

  // Discovery records, GROUPED BY canonical physical root -- collected
  // first, reconciled second (see {@link reconcileInstanceMetadata}).
  //
  // Collecting before deciding is what makes the result a function of the
  // record SET rather than of the order the records arrived in. The
  // previous shape decided on arrival ("first record to claim a root keeps
  // it"), which is correct for IDENTITY -- one physical root is one
  // instance either way -- but silently made every piece of METADATA a
  // function of enumeration order. Version is the one that matters: it
  // drives advisory applicability, so a contradictory lockfile could turn
  // a finding into no finding purely by reordering its own entries.
  const recordsByRoot = new Map<string, InstanceRecord[]>();
  const record = (root: string, entry: InstanceRecord): void => {
    const existing = recordsByRoot.get(root);
    if (existing) {
      existing.push(entry);
    } else {
      recordsByRoot.set(root, [entry]);
    }
  };

  for (const node of dependencyNodes) {
    for (const location of node.locations) {
      const packageInstance = canonicalizePackageInstancePath(
        path.resolve(projectRoot, location),
      );
      const ownershipNames = new Set<string>([node.name]);
      // P1-A3's alias ownership, unchanged: the installed package's own
      // declared name still joins the selection set alongside the
      // lockfile's. Reconciling versions does not narrow WHICH advisories
      // may select this instance.
      const manifestName = manifestOf(packageInstance).name;
      if (manifestName !== undefined) {
        ownershipNames.add(manifestName);
      }
      record(packageInstance, {
        ownershipNames,
        packageName: node.name,
        version: node.version,
        provenance: "dependency-graph",
        declaredLocation: location,
      });
    }
  }

  for (const workspacePackage of workspacePackages) {
    const packageInstance = canonicalizePackageInstancePath(
      workspacePackage.canonicalRoot,
    );
    // A workspace root's identity comes from its own manifest and nowhere
    // else. With no declared name there is nothing an advisory could
    // select it by, and guessing one from the directory name is exactly
    // the path-shape inference P1-A4 forbids -- so it contributes no
    // record. It keeps whatever ATTRIBUTION `KnownPackageRoots` already
    // gives it; this only declines to let an advisory select it.
    const manifestName =
      workspacePackage.packageName ?? manifestOf(packageInstance).name;
    if (manifestName === undefined) {
      continue;
    }
    record(packageInstance, {
      ownershipNames: new Set([manifestName]),
      packageName: manifestName,
      // Carried through as-is, `undefined` included: a private workspace
      // package with no `"version"` has no version, and borrowing one from
      // an installed sibling of the same name is the exact identity
      // collapse P1-A5 exists to prevent.
      version: workspacePackage.version,
      provenance: "workspace",
      declaredLocation: path.relative(projectRoot, packageInstance) || ".",
    });
  }

  const byRoot = new Map<string, CandidatePackageInstance>();
  const versionConflicts: PackageInstanceVersionConflict[] = [];
  const untrustedManifests: PackageInstanceManifestUncertainty[] = [];
  for (const [packageInstance, records] of recordsByRoot) {
    const reconciled = reconcileInstanceMetadata(
      packageInstance,
      records,
      // Read here, for EVERY root, rather than only where a record is
      // missing a version: the installed package is an authority in its
      // own right, and consulting it only when the declared metadata is
      // silent is exactly the "declared version wins unopposed" behavior
      // F1-B exists to remove.
      manifestOf(packageInstance).version,
    );
    byRoot.set(packageInstance, reconciled.instance);
    if (reconciled.conflict) {
      versionConflicts.push(reconciled.conflict);
    }
    if (reconciled.untrustedManifest) {
      untrustedManifests.push(reconciled.untrustedManifest);
    }
  }
  const byInstanceRoot = (
    a: { readonly packageInstance: string },
    b: { readonly packageInstance: string },
  ): number =>
    a.packageInstance < b.packageInstance
      ? -1
      : a.packageInstance > b.packageInstance
        ? 1
        : 0;
  versionConflicts.sort(byInstanceRoot);
  untrustedManifests.sort(byInstanceRoot);

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

  return { instances, versionConflicts, untrustedManifests, byOwnershipName };
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
