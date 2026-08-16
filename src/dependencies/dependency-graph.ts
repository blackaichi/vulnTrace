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
 */
export function buildDependencyGraph(
  packageJson: PackageJson,
  packageLock: PackageLock,
): DependencyNode[] {
  const directNames = new Set([
    ...Object.keys(packageJson.dependencies),
    ...Object.keys(packageJson.devDependencies),
    ...Object.keys(packageJson.peerDependencies),
    ...Object.keys(packageJson.optionalDependencies),
  ]);

  const dependencyPathByPath = computeDependencyPaths(packageLock.packages);
  const nodes: DependencyNode[] = [];

  for (const [entryPath, entry] of Object.entries(packageLock.packages)) {
    if (entryPath === "") {
      continue;
    }

    const name = entry.name ?? derivePackageName(entryPath);
    const { version } = entry;

    // A dependency we cannot identify by name or resolved version cannot
    // form a valid DependencyNode; this is inherent to unversioned/local
    // links (e.g. unsupported workspace members), not a parsing failure.
    if (!name || !version) {
      continue;
    }

    const dependencyPath = dependencyPathByPath.get(entryPath);

    nodes.push({
      id: `npm:${entryPath}`,
      name,
      version,
      ecosystem: "npm",
      direct: isTopLevelPath(entryPath) && directNames.has(name),
      locations: [entryPath],
      dependencyPaths: dependencyPath ? [dependencyPath] : [],
      purl: toPurl(name, version),
    });
  }

  return nodes;
}
