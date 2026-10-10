import type { DependencyNode } from "../domain/dependency.js";
import type { PackageJson } from "./package-json.js";
import { derivePackageName } from "./package-lock.js";
import type { PackageLock, PackageLockEntry } from "./package-lock.js";

/**
 * True if an install path sits directly under the project root's own
 * `node_modules` — i.e. is not nested inside another package's
 * `node_modules` (see docs/SDD.md § 11). Used to distinguish a package's
 * directly installed copy from a differently-versioned transitive copy of
 * the same name nested elsewhere.
 */
export function isTopLevelPath(entryPath: string): boolean {
  if (!entryPath.startsWith("node_modules/")) {
    return false;
  }
  return !entryPath.slice("node_modules/".length).includes("node_modules/");
}

function allDeclaredDependencyNames(
  entry: Pick<
    PackageLockEntry,
    | "dependencies"
    | "devDependencies"
    | "peerDependencies"
    | "optionalDependencies"
  >,
): string[] {
  return [
    ...Object.keys(entry.dependencies),
    ...Object.keys(entry.devDependencies),
    ...Object.keys(entry.peerDependencies),
    ...Object.keys(entry.optionalDependencies),
  ];
}

/**
 * Resolves which installed lockfile entry satisfies a dependency named
 * `depName`, declared by the package installed at `consumerPath`, by
 * following npm/Node's own nearest-ancestor `node_modules` resolution
 * algorithm (search the consumer's own `node_modules`, then each
 * ancestor's, up to the project root) rather than assuming a flat mapping.
 * This is what lets the same package name correctly resolve to different
 * installed versions depending on where the dependency is declared from
 * (see docs/SDD.md § 11: "must support multiple installed versions").
 */
export function resolveDependency(
  consumerPath: string,
  depName: string,
  packages: Readonly<Record<string, PackageLockEntry>>,
): string | undefined {
  let current = consumerPath;

  for (;;) {
    const candidate =
      current === ""
        ? `node_modules/${depName}`
        : `${current}/node_modules/${depName}`;

    if (candidate in packages) {
      return candidate;
    }

    if (current === "") {
      return undefined;
    }

    const boundary = current.lastIndexOf("/node_modules/");
    current = boundary === -1 ? "" : current.slice(0, boundary);
  }
}

function toPurl(name: string, version: string): string {
  if (name.startsWith("@") && name.includes("/")) {
    const separatorIndex = name.indexOf("/");
    const scope = name.slice(1, separatorIndex);
    const packageName = name.slice(separatorIndex + 1);
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

interface QueueItem {
  readonly path: string;
  readonly chain: readonly string[];
}

/**
 * Walks the lockfile's declared-dependency edges breadth-first from the
 * project root, recording the shortest discovered chain of package names
 * to each reachable entry. BFS visits each entry at most once, so this
 * naturally yields one (shortest) path per entry rather than enumerating
 * every diamond-dependency path — a deliberate MVP scoping choice (see
 * TASK-007 completion report) to keep this deterministic and bounded
 * without combinatorial blowup on large graphs.
 */
function computeDependencyPaths(
  packages: Readonly<Record<string, PackageLockEntry>>,
): Map<string, readonly string[]> {
  const dependencyPathByPath = new Map<string, readonly string[]>();
  const visited = new Set<string>([""]);
  const queue: QueueItem[] = [{ path: "", chain: [] }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    const entry = packages[current.path];
    if (!entry) {
      continue;
    }

    for (const depName of allDeclaredDependencyNames(entry)) {
      const resolved = resolveDependency(current.path, depName, packages);

      if (!resolved || visited.has(resolved)) {
        continue;
      }

      visited.add(resolved);
      const chain = [...current.chain, depName];
      dependencyPathByPath.set(resolved, chain);
      queue.push({ path: resolved, chain });
    }
  }

  return dependencyPathByPath;
}

/**
 * A lockfile entry no authority names (task B-4, PRM-34): no `name` of its
 * own, outside `node_modules` (so no path to derive one from), no single
 * name its linking `node_modules/<name>` entries agree on, and no
 * readable manifest name. No advisory can be asked for or selected by it,
 * so it is reported as an identity gap rather than dropped.
 */
export interface UnidentifiedLockEntry {
  /** The lockfile install path, e.g. `vendor/anon`. */
  readonly entryPath: string;
  readonly version?: string;
  /** Every name a linking entry gave it, sorted; possibly empty. */
  readonly linkNames: readonly string[];
}

export interface DependencyInventory {
  readonly nodes: DependencyNode[];
  readonly unidentified: readonly UnidentifiedLockEntry[];
}

export interface DependencyInventoryOptions {
  /**
   * Reads the `"name"` of the manifest at a lockfile install path, or
   * `undefined` when there is none or it cannot be read. Consulted only for
   * a nameless entry outside `node_modules`. Absent, no manifest is read.
   */
  readonly readManifestName?: (entryPath: string) => string | undefined;
}

/**
 * The names the lockfile's `link: true` entries give each link target,
 * keyed by the target's install path (`resolved`). npm writes a `file:`
 * dependency as a link `node_modules/<name>` whose `resolved` is the
 * target's own entry path (measured with npm 10.9.0 in task B-4).
 */
function linkNamesByTarget(
  packages: Readonly<Record<string, PackageLockEntry>>,
): Map<string, Set<string>> {
  const byTarget = new Map<string, Set<string>>();
  for (const [entryPath, entry] of Object.entries(packages)) {
    if (entry.link !== true || entry.resolved === undefined) {
      continue;
    }
    const name = derivePackageName(entryPath);
    if (name === undefined) {
      continue;
    }
    const names = byTarget.get(entry.resolved) ?? new Set<string>();
    names.add(name);
    byTarget.set(entry.resolved, names);
  }
  return byTarget;
}

/**
 * Builds the normalized dependency graph (see docs/SDD.md § 11) by
 * combining:
 * - package.json: the authoritative set of directly-declared dependency
 *   names (author intent);
 * - package-lock.json: the actually-resolved graph topology (versions,
 *   install locations, transitive edges).
 *
 * One {@link DependencyNode} is produced per lockfile entry (i.e. per
 * distinct install location), so multiple installed versions of the same
 * package name naturally become multiple `DependencyNode`s, each with its
 * own `direct` classification and `dependencyPaths`.
 *
 * Task B-4 (PRM-34): no entry that is a package is dropped any more.
 *
 * - A versionless entry is a node with no version. Before B-4 it was
 *   `continue`d as "inherent to unversioned/local links", which held for
 *   a link entry and for nothing else: a `file:` dependency whose manifest
 *   has no version, and a workspace member, are packages.
 * - A versionless `link: true` entry is not itself a package -- it is the
 *   `node_modules` symlink to one, and its target has its own entry -- so
 *   it stays out, exactly as before. Its name names the target.
 * - A nameless entry outside `node_modules` is named by its own manifest
 *   (the identity authority, as for an npm alias), else by the one name
 *   its linking entries agree on. npm omits `name` when the manifest has
 *   none, or when the manifest's name, the directory's name and the name
 *   it is linked under all agree (measured with npm 10.9.0, six shapes),
 *   so this is the ordinary `file:` dependency, not an edge case. Two
 *   disagreeing
 *   linking names with no manifest name are not chosen between: the entry
 *   is {@link UnidentifiedLockEntry}, as is one nothing names at all.
 */
export function buildDependencyInventory(
  packageJson: PackageJson,
  packageLock: PackageLock,
  options: DependencyInventoryOptions = {},
): DependencyInventory {
  const directNames = new Set([
    ...Object.keys(packageJson.dependencies),
    ...Object.keys(packageJson.devDependencies),
    ...Object.keys(packageJson.peerDependencies),
    ...Object.keys(packageJson.optionalDependencies),
  ]);

  const dependencyPathByPath = computeDependencyPaths(packageLock.packages);
  const linkNames = linkNamesByTarget(packageLock.packages);
  const nodes: DependencyNode[] = [];
  const unidentified: UnidentifiedLockEntry[] = [];

  for (const [entryPath, entry] of Object.entries(packageLock.packages)) {
    if (entryPath === "") {
      continue;
    }

    const { version } = entry;

    // A link is the symlink to a package, not a package: its target has
    // its own entry. A link entry that does carry a version was a node
    // before B-4 and stays one.
    if (entry.link === true && version === undefined) {
      continue;
    }

    const name = entry.name ?? derivePackageName(entryPath);
    let resolvedName = name;
    if (resolvedName === undefined) {
      const fromLinks = [...(linkNames.get(entryPath) ?? [])].sort();
      resolvedName =
        options.readManifestName?.(entryPath) ??
        (fromLinks.length === 1 ? fromLinks[0] : undefined);
      if (resolvedName === undefined) {
        unidentified.push({
          entryPath,
          ...(version !== undefined ? { version } : {}),
          linkNames: fromLinks,
        });
        continue;
      }
    }

    const dependencyPath = dependencyPathByPath.get(entryPath);

    nodes.push({
      id: `npm:${entryPath}`,
      name: resolvedName,
      ...(version !== undefined ? { version } : {}),
      ecosystem: "npm",
      direct: isTopLevelPath(entryPath) && directNames.has(resolvedName),
      locations: [entryPath],
      dependencyPaths: dependencyPath ? [dependencyPath] : [],
      ...(version !== undefined ? { purl: toPurl(resolvedName, version) } : {}),
    });
  }

  unidentified.sort((a, b) =>
    a.entryPath < b.entryPath ? -1 : a.entryPath > b.entryPath ? 1 : 0,
  );
  return { nodes, unidentified };
}

/**
 * The nodes of {@link buildDependencyInventory}. A caller that must account
 * for every entry -- the scan -- uses the inventory, whose `unidentified`
 * list this drops.
 */
export function buildDependencyGraph(
  packageJson: PackageJson,
  packageLock: PackageLock,
  options: DependencyInventoryOptions = {},
): DependencyNode[] {
  return buildDependencyInventory(packageJson, packageLock, options).nodes;
}
