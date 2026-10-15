/**
 * BL-089 — THE DIFFERENTIAL'S BASE-SIDE CACHE.
 *
 * `scripts/differential.mjs` collects the base side by scanning the whole
 * corpus with the base commit's analyzer, which takes minutes, and a task
 * runs it more than once (after the fix, after each audit round, on the
 * final HEAD). Between those runs the base side usually reads exactly the
 * same bytes, so its snapshot can be reused — but only when that is
 * established, because a stale base snapshot reports a wrong base verdict
 * and so hides, or invents, a verdict change. This module computes the
 * key that establishes it, and stores and finds snapshots under it.
 *
 * THE KEY is a SHA-256 over named parts, each digested on its own (so a
 * test, or a person, can see which part moved):
 *
 * - `format`: this cache's format and the snapshot format;
 * - `base`: the base commit's full SHA (the base analyzer — `src/`,
 *   `schemas/`, `package.json`, `package-lock.json`, `tsconfig.json` — is
 *   immutable under it);
 * - `selection`: `--corpus`, `--case` and `--use-head-dependencies`;
 * - `runtime`: the Node version, platform and architecture;
 * - `driver`: `scripts/differential.mjs` and this file;
 * - `instrument`: what the base side takes from this tree, laid over the
 *   base analyzer (`src/testing/`, `scripts/differential-lib.mjs`,
 *   `tests/differential/`, `vitest.differential.config.ts`), byte for
 *   byte, untracked files included;
 * - `corpus`: every file under `tests/validation/` and
 *   `tests/adversarial/` (fixtures, cases, expected verdicts, the OSV
 *   snapshot, and everything else there — deliberately the whole trees, so
 *   that the collector reading one more file can never fall outside the
 *   key);
 * - `around`: what a scan can read ABOVE a scanned project. The analyzer
 *   models Node's upward lookups (the nearest `package.json` scope, the
 *   `node_modules` walk to the filesystem root), the adversarial corpora
 *   are scanned in place inside this checkout, and the validation corpus
 *   in a copy under the OS temp directory. So: for every directory between
 *   a corpus tree and the checkout root, its direct files and its
 *   `node_modules` in full; for every directory above the checkout root,
 *   and for the temp directory and every directory above it, its
 *   `package.json` and its `node_modules` in full.
 *
 * Hashing reads the filesystem, not git: an uncommitted change is a
 * change. A file is hashed with its content and executable bit, a symlink
 * with its target text. A symlink that resolves outside the hashed inputs,
 * or an entry that is neither a file, a directory nor a symlink, makes the
 * run UNCACHEABLE: the base side is collected, and the report says why.
 *
 * ONE EXCEPTION, NAMED. In a hashed `node_modules`, the top-level entries
 * `.cache` and `.vite` are hashed by name only, not by content: they are
 * tool caches (vitest writes `node_modules/.vite` on every run), so
 * hashing their content would make every run a miss. Node reads them only
 * for a bare specifier that begins with a dot (`require(".vite")`), which
 * no corpus file uses — measured when this was written (BL-089) — and
 * which a new corpus file would need to introduce.
 *
 * WHAT IS NEVER CACHED. The head side; a base collection that was not
 * clean (vitest exited non-zero, see `collect` in `differential.mjs`); a
 * run with `--no-cache`. A snapshot found under the key is checked again
 * on read (cache format, key, snapshot format) and ignored if anything
 * disagrees.
 *
 * Plain ESM, so the driver runs it under bare `node`; its types live in
 * the matching `.d.mts` file and its suite is
 * `src/testing/differential-cache.test.ts`.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const CACHE_FORMAT = "vulntrace-differential-base-cache/1";

/** The corpus trees, relative to the checkout root. */
export const CORPUS_PATHS = ["tests/validation", "tests/adversarial"];

/** Top-level `node_modules` entries hashed by name only (see the header). */
export const NODE_MODULES_TOOL_CACHES = [".cache", ".vite"];

/** How many cached snapshots to keep; older ones are removed on write. */
export const CACHE_KEEP = 8;

export class UncacheableError extends Error {}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function isWithin(file, roots) {
  return roots.some((root) => file === root || file.startsWith(root + path.sep));
}

/**
 * Feeds a canonical description of `abs` (a file, a symlink or a whole
 * directory tree) into `hash`, under `label`. A path that does not exist
 * is described as missing — its appearing later is a change.
 */
function hashEntry(hash, abs, label, within) {
  const walk = (file, rel) => {
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      hash.update(`${label}/${rel}\0missing\0`);
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(file);
      hash.update(`${label}/${rel}\0symlink\0${target}\0`);
      if (!isWithin(path.resolve(path.dirname(file), target), within)) {
        throw new UncacheableError(
          `${file} is a symlink to ${target}, outside every hashed input`,
        );
      }
      return;
    }
    if (stat.isDirectory()) {
      hash.update(`${label}/${rel}\0dir\0`);
      const inNodeModules = path.basename(file) === "node_modules";
      for (const name of readdirSync(file).sort()) {
        const childRel = rel === "" ? name : `${rel}/${name}`;
        if (inNodeModules && NODE_MODULES_TOOL_CACHES.includes(name)) {
          hash.update(`${label}/${childRel}\0named\0`);
          continue;
        }
        walk(path.join(file, name), childRel);
      }
      return;
    }
    if (stat.isFile()) {
      const exec = (stat.mode & 0o111) !== 0 ? "x" : "-";
      hash.update(`${label}/${rel}\0file\0${exec}\0${sha256(readFileSync(file))}\0`);
      return;
    }
    throw new UncacheableError(
      `${file} is neither a file, a directory nor a symlink`,
    );
  };
  walk(abs, "");
}

/**
 * The direct files (and symlinks) of `dir`, not its subdirectories, except
 * those in `skip` (hashed under their own part already).
 */
function hashDirectFiles(hash, dir, label, within, skip) {
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch {
    hash.update(`${label}\0missing\0`);
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    if (skip.includes(file)) continue;
    const stat = lstatSync(file);
    if (stat.isDirectory()) continue;
    hashEntry(hash, file, `${label}/${name}`, within);
  }
}

/** Every directory from `dir` up to the filesystem root, `dir` first. */
function selfAndAncestors(dir) {
  const out = [];
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    out.push(current);
    if (path.dirname(current) === current) return out;
  }
}

/**
 * The cache key of a base-side collection, or why there is none.
 *
 * @param {import("./differential-cache.d.mts").BaseKeyInput} input
 * @returns {import("./differential-cache.d.mts").BaseKey}
 */
export function baseCacheKey(input) {
  const repoRoot = path.resolve(input.repoRoot);
  const tmpRoot = path.resolve(input.tmpRoot);
  const corpusPaths = input.corpusPaths ?? CORPUS_PATHS;
  // Hashed trees: a symlink must resolve into one of them.
  const nodeModulesDirs = [];
  const aroundRepo = []; // directories between a corpus tree and repoRoot
  for (const rel of corpusPaths) {
    for (const dir of selfAndAncestors(path.dirname(path.join(repoRoot, rel)))) {
      if (!isWithin(dir, [repoRoot])) break;
      if (!aroundRepo.includes(dir)) aroundRepo.push(dir);
    }
  }
  const aboveRepo = selfAndAncestors(path.dirname(repoRoot));
  const aroundTmp = selfAndAncestors(tmpRoot).filter(
    (dir) => !aboveRepo.includes(dir) && !aroundRepo.includes(dir),
  );
  for (const dir of [...aroundRepo, ...aboveRepo, ...aroundTmp]) {
    nodeModulesDirs.push(path.join(dir, "node_modules"));
  }
  const within = [
    ...input.instrumentPaths.map((rel) => path.join(repoRoot, rel)),
    ...corpusPaths.map((rel) => path.join(repoRoot, rel)),
    ...nodeModulesDirs,
  ];

  const parts = [];
  const part = (name, feed) => {
    const hash = createHash("sha256");
    feed(hash);
    parts.push({ name, digest: hash.digest("hex") });
  };
  try {
    part("format", (h) =>
      h.update(JSON.stringify([CACHE_FORMAT, input.snapshotFormat])),
    );
    part("base", (h) => h.update(input.baseSha));
    part("selection", (h) =>
      h.update(
        JSON.stringify([
          input.selection.corpora ?? null,
          input.selection.cases ?? null,
          input.selection.useHeadDependencies === true,
        ]),
      ),
    );
    part("runtime", (h) => h.update(JSON.stringify(input.runtime)));
    part("driver", (h) => {
      for (const rel of input.driverPaths) {
        hashEntry(h, path.join(repoRoot, rel), rel, within);
      }
    });
    part("instrument", (h) => {
      for (const rel of input.instrumentPaths) {
        hashEntry(h, path.join(repoRoot, rel), rel, within);
      }
    });
    part("corpus", (h) => {
      for (const rel of corpusPaths) {
        hashEntry(h, path.join(repoRoot, rel), rel, within);
      }
    });
    part("around", (h) => {
      const ownPart = [...input.driverPaths, ...input.instrumentPaths].map(
        (rel) => path.join(repoRoot, rel),
      );
      for (const dir of aroundRepo) {
        const label = path.relative(repoRoot, dir) || ".";
        hashDirectFiles(h, dir, `repo:${label}`, within, ownPart);
        hashEntry(h, path.join(dir, "node_modules"), `repo:${label}/node_modules`, within);
      }
      for (const dir of [...aboveRepo, ...aroundTmp]) {
        hashEntry(h, path.join(dir, "package.json"), `${dir}/package.json`, within);
        hashEntry(h, path.join(dir, "node_modules"), `${dir}/node_modules`, within);
      }
    });
  } catch (error) {
    if (error instanceof UncacheableError) {
      return { cacheable: false, reason: error.message };
    }
    throw error;
  }
  const key = sha256(parts.map((p) => `${p.name}=${p.digest}`).join("\n"));
  return { cacheable: true, key, parts };
}

function entryPath(cacheDir, key) {
  return path.join(cacheDir, `base-${key}.json`);
}

/**
 * The snapshot stored under `key`, or `undefined`. An entry whose cache
 * format, key or snapshot format disagrees is removed and not returned.
 */
export function readCachedBase(cacheDir, key, snapshotFormat) {
  const file = entryPath(cacheDir, key);
  if (!existsSync(file)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(file, "utf-8"));
    if (
      entry.cacheFormat === CACHE_FORMAT &&
      entry.key === key &&
      entry.snapshot?.format === snapshotFormat
    ) {
      return entry;
    }
  } catch {
    // An unreadable entry is no entry.
  }
  rmSync(file, { force: true });
  return undefined;
}

/** Stores `snapshot` under `key` atomically, and keeps the newest {@link CACHE_KEEP} entries. */
export function writeCachedBase(cacheDir, key, entry) {
  mkdirSync(cacheDir, { recursive: true });
  const file = entryPath(cacheDir, key);
  const partial = `${file}.partial`;
  writeFileSync(
    partial,
    JSON.stringify({ cacheFormat: CACHE_FORMAT, key, ...entry }) + "\n",
  );
  renameSync(partial, file);
  const entries = readdirSync(cacheDir)
    .filter((name) => /^base-[0-9a-f]{64}\.json$/.test(name))
    .map((name) => ({ name, mtime: statSync(path.join(cacheDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of entries.slice(CACHE_KEEP)) {
    rmSync(path.join(cacheDir, stale.name), { force: true });
  }
  return file;
}
