import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  canonicalizePackageInstancePath,
  readInstalledManifestIdentity,
} from "../domain/resolved-target.js";

/**
 * One package directory found on disk under a `node_modules` directory
 * (task B-4, AUD-08, decision 9).
 *
 * `canonicalRoot` is the identity, exactly as for a registry instance: it
 * is produced by the same {@link canonicalizePackageInstancePath}, so a
 * root found here and a root the lockfile names compare equal exactly when
 * they are one physical package. `name` and `version` are what the
 * package's own manifest says, for the report only.
 */
export interface InstalledPackageOnDisk {
  readonly canonicalRoot: string;
  readonly name?: string;
  readonly version?: string;
}

export interface InstalledTreeEnumeration {
  /** Every package directory found, sorted by canonical root. */
  readonly packages: readonly InstalledPackageOnDisk[];
  /** True when the bound stopped the walk; `packages` is then partial. */
  readonly truncated: boolean;
  /**
   * Every path the walk could not read for a reason other than its absence
   * (a permission error, an I/O error), sorted. `packages` is then partial
   * too: what is behind such a path is unknown, never "nothing".
   */
  readonly unreadable: readonly string[];
}

/**
 * The most filesystem operations one enumeration performs: each directory
 * listed (a `node_modules`, an `@scope`) and each entry examined as a
 * candidate package (a stat, a realpath, a manifest read). A bound on
 * WORK, as workspace discovery's is (`MAX_DIRECTORIES_EXAMINED`): reaching
 * it is reported, never silently treated as a complete answer.
 */
export const MAX_INSTALLED_TREE_DIRECTORIES = 50_000;

/**
 * An error that means "nothing is there": the path does not exist, a
 * component is not a directory, or a link resolves in a loop. Anything
 * else (`EACCES`, `EIO`, ...) means something may be there and could not
 * be read (the independent audit of B-4, finding 1).
 */
function isAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

/**
 * Enumerates the packages installed on disk under the `node_modules` of
 * each start root, and recursively under each found package's own
 * `node_modules` (task B-4, AUD-08, decision 9).
 *
 * This is the installed tree the lockfile is cross-checked against. Before
 * B-4 nothing looked at it: the inventory was the lockfile alone, so a
 * package installed and loaded but absent from the lockfile -- hoisted, or
 * nested where it shadows a listed copy -- was never queried and never
 * reported, while Node ran it.
 *
 * It names candidates for a REPORT, never instances: the registry stays
 * built from authoritative metadata only (P1-A5 § INSTANCE ENUMERATION),
 * and a package found here and nowhere else becomes an
 * `unreportedCandidates` entry, not an advisory target. That is decision
 * 9's resolution, and it is why a directory-shape walk is acceptable here
 * when it is not for the registry.
 *
 * Which directories count follows npm's layout, which is what installs
 * packages: any directory under `node_modules` is a package (Node loads
 * `node_modules/x/index.js` with no manifest), an `@scope` directory holds
 * packages one level deeper, and a dot-entry (`.bin`,
 * `.package-lock.json`, `.cache`) is bookkeeping. That is narrower than
 * what Node can load: Node also loads `require(".hid")` from a dot-named
 * directory and `require("@solo")` from an `@`-named directory that is
 * itself a package, neither of which npm writes. Those are not walked; one
 * the module-load closure loads is still reported by the closure's
 * cross-check (the independent audit of B-4, finding 2). Links are
 * followed by realpath, as Node does. A found package's own `node_modules`
 * is walked only when it lies inside `projectRoot`: a link out of the
 * project (an `npm link`ed checkout) is reported but not descended into;
 * a package loaded from out there is caught by the module-load closure's
 * cross-check instead.
 */
export function enumerateInstalledPackages(options: {
  readonly projectRoot: string;
  readonly startRoots: readonly string[];
  readonly maxDirectories?: number;
}): InstalledTreeEnumeration {
  const maxDirectories =
    options.maxDirectories ?? MAX_INSTALLED_TREE_DIRECTORIES;
  const projectRoot = canonicalizePackageInstancePath(options.projectRoot);
  const inProject = (root: string): boolean => {
    const relative = path.relative(projectRoot, root);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  };

  const found = new Map<string, InstalledPackageOnDisk>();
  const walked = new Set<string>();
  const queue: string[] = [];
  for (const start of options.startRoots) {
    const canonical = canonicalizePackageInstancePath(start);
    if (!walked.has(canonical)) {
      walked.add(canonical);
      queue.push(canonical);
    }
  }

  let examined = 0;
  let truncated = false;
  const unreadable = new Set<string>();
  const spend = (): boolean => {
    if (examined >= maxDirectories) {
      truncated = true;
      return false;
    }
    examined += 1;
    return true;
  };
  const list = (directory: string): string[] | undefined => {
    if (!spend()) {
      return undefined;
    }
    try {
      return readdirSync(directory);
    } catch (error) {
      if (!isAbsence(error)) {
        unreadable.add(directory);
      }
      return undefined;
    }
  };

  const admit = (candidate: string): void => {
    if (!spend()) {
      return;
    }
    let directory: boolean;
    try {
      // Follows a symlink: a link to a package directory is how npm
      // installs a workspace member or a `file:` dependency. A dangling
      // link installs nothing.
      directory = statSync(candidate).isDirectory();
    } catch (error) {
      if (!isAbsence(error)) {
        unreadable.add(candidate);
      }
      return;
    }
    if (!directory) {
      return;
    }
    const canonicalRoot = canonicalizePackageInstancePath(candidate);
    if (canonicalRoot === projectRoot || found.has(canonicalRoot)) {
      return;
    }
    const manifest = readInstalledManifestIdentity(canonicalRoot);
    found.set(canonicalRoot, {
      canonicalRoot,
      ...(manifest.name !== undefined ? { name: manifest.name } : {}),
      ...(manifest.version.kind === "declared"
        ? { version: manifest.version.version }
        : {}),
    });
    if (!walked.has(canonicalRoot) && inProject(canonicalRoot)) {
      walked.add(canonicalRoot);
      queue.push(canonicalRoot);
    }
  };

  // An index, not `shift()`: a large tree queues every package once.
  for (let next = 0; next < queue.length && !truncated; next++) {
    const owner = queue[next]!;
    const nodeModules = path.join(owner, "node_modules");
    const names = list(nodeModules);
    if (names === undefined) {
      continue;
    }
    for (const name of names.sort()) {
      if (name.startsWith(".")) {
        continue;
      }
      const entry = path.join(nodeModules, name);
      if (name.startsWith("@")) {
        const scoped = list(entry);
        if (scoped === undefined) {
          continue;
        }
        for (const child of scoped.sort()) {
          if (!child.startsWith(".")) {
            admit(path.join(entry, child));
          }
        }
        continue;
      }
      admit(entry);
    }
  }

  return {
    packages: [...found.values()].sort((a, b) =>
      a.canonicalRoot < b.canonicalRoot
        ? -1
        : a.canonicalRoot > b.canonicalRoot
          ? 1
          : 0,
    ),
    truncated,
    unreadable: [...unreadable].sort(),
  };
}
