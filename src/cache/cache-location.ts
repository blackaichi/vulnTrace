import { lstatSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where the OSV cache lives (task B-3, AUD-07, decision 8).
 *
 * A served cache entry stands in for the provider's answer, and a
 * well-formed `[]` ("no advisories") cannot be told from a planted one by
 * validation. So the one property that keeps a scanned project from
 * supplying its own provider answers is the location: the cache is the
 * user's, never inside the project. Before B-3 it defaulted to
 * `<project>/.vulntrace-cache/osv`, under a key computed from public
 * inputs, and a committed `[]` suppressed every advisory for that query.
 */

export interface CacheLocationEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homedir: () => string;
}

const PROCESS_ENVIRONMENT: CacheLocationEnvironment = {
  env: process.env,
  platform: process.platform,
  homedir: os.homedir,
};

/**
 * The user cache directory's `vulntrace/osv`: `$XDG_CACHE_HOME` when it is
 * an absolute path (the XDG Base Directory specification says a relative
 * value is invalid and must be ignored), else `%LOCALAPPDATA%` on Windows,
 * else `~/.cache`. `undefined` when no absolute base can be determined: a
 * relative one would resolve against the working directory, which may be
 * the scanned project.
 */
export function defaultOsvCacheDir(
  environment: CacheLocationEnvironment = PROCESS_ENVIRONMENT,
): string | undefined {
  const { env, platform } = environment;
  const pathFor = platform === "win32" ? path.win32 : path.posix;
  const xdg = env.XDG_CACHE_HOME;
  let base: string | undefined;
  if (xdg !== undefined && xdg !== "" && pathFor.isAbsolute(xdg)) {
    base = xdg;
  } else if (
    platform === "win32" &&
    env.LOCALAPPDATA !== undefined &&
    env.LOCALAPPDATA !== "" &&
    pathFor.isAbsolute(env.LOCALAPPDATA)
  ) {
    base = env.LOCALAPPDATA;
  } else {
    let home: string;
    try {
      home = environment.homedir();
    } catch {
      return undefined;
    }
    if (home === "" || !pathFor.isAbsolute(home)) {
      return undefined;
    }
    base = pathFor.join(home, ".cache");
  }
  return pathFor.join(base, "vulntrace", "osv");
}

/** Whether a directory entry exists at `target`, a dangling symlink included. */
function entryExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real path of `target`, through its nearest existing ancestor: the
 * part that exists is resolved through every symlink, and the rest (no
 * entry yet, so not a link) is appended. A dangling symlink is an entry,
 * so resolving it throws rather than being read as a plain name.
 */
function realPathThroughExistingAncestor(target: string): string {
  let existing = path.resolve(target);
  const rest: string[] = [];
  while (!entryExists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      break;
    }
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync.native(existing), ...rest);
}

/**
 * Whether the cache directory `cacheDir` is, or resolves through a symlink
 * to somewhere, inside `projectRoot` (or is the project root itself). The
 * caller refuses such a directory. Fails closed: when either path cannot
 * be resolved, it answers `true`.
 */
export function isCacheDirInsideProject(
  cacheDir: string,
  projectRoot: string,
): boolean {
  let cache: string;
  let project: string;
  try {
    cache = realPathThroughExistingAncestor(cacheDir);
    project = realpathSync.native(projectRoot);
  } catch {
    return true;
  }
  const relative = path.relative(project, cache);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
