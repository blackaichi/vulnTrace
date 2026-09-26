import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A whole project as a flat set of file contents, keyed by path relative
 * to the project root. This is deliberately the SAME shape every harness
 * in docs/audits/ already used (`writeProject`'s `Record<string, string>`
 * in round 1, `write()`'s `files` map in round 2's `intake2.ts`): it is
 * the one representation that already demonstrably supports every shape
 * those audits needed --- app files, one or more `node_modules` installs
 * at arbitrary depth (including a same-name-same-version twin at a
 * different install path), ESM `package.json` manifests, `rules.yml` /
 * `vulntrace.yml`, an optional `tsconfig.json`, and a verbatim or
 * generated `package-lock.json` --- without inventing a second, narrower
 * abstraction on top of the filesystem.
 *
 * `symlinks` is separate from `files` (not a special file content) because
 * a symlink is not a file WRITE, and because the two most soundness-
 * relevant symlink shapes (a `file:` dependency, a workspace member linked
 * into `node_modules`) point at directories, not regular files.
 */
export interface ProjectSpec {
  readonly files: Readonly<Record<string, string>>;
  /**
   * Path (relative to the project root) -> symlink target, given exactly
   * as `symlinkSync`'s `target` argument (resolved relative to the
   * symlink's OWN directory, matching how `node_modules/<name>` links and
   * `file:`/workspace links are really created on disk).
   */
  readonly symlinks?: Readonly<Record<string, string>>;
}

/** Writes every file and symlink in `spec` under `dir`, which must already exist. */
export function writeProject(dir: string, spec: ProjectSpec): void {
  for (const [relativePath, content] of Object.entries(spec.files)) {
    const filePath = path.join(dir, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  for (const [relativePath, target] of Object.entries(spec.symlinks ?? {})) {
    const linkPath = path.join(dir, relativePath);
    mkdirSync(path.dirname(linkPath), { recursive: true });
    symlinkSync(target, linkPath);
  }
}

/**
 * HERMETIC: every project lives in its own fresh OS-temp directory
 * (`mkdtempSync`'s random suffix makes concurrent callers collision-free,
 * so this is safe under vitest's parallel workers), and is always removed
 * afterward -- including when `fn` throws, which is exactly when a
 * reproduction case is expected to throw (a failed control, a failed
 * loud-fixture check).
 *
 * Never place the fixture under the repository tree: `tests/validation/
 * validation.test.ts` (VT-302/RWF-010) documents that a fixture scanned in
 * place inherits this repository as an ancestor directory, and
 * `ts.resolveModuleName`'s upward `node_modules` walk is not bounded by
 * the scanned project root, so a bare specifier can silently resolve into
 * THIS repository's `node_modules` instead of the fixture's own vendored
 * tree. `os.tmpdir()` is outside the repository by construction.
 */
export async function withTempProject<T>(
  spec: ProjectSpec,
  fn: (dir: string) => T | Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-oracle-"));
  try {
    writeProject(dir, spec);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Merges several file maps left-to-right (a later map's keys win), for composing shared fragments. */
export function mergeFiles(
  ...parts: ReadonlyArray<Readonly<Record<string, string>>>
): Record<string, string> {
  return Object.assign({}, ...parts) as Record<string, string>;
}
