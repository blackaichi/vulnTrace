import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { canonicalizePackageInstancePath } from "../domain/resolved-target.js";

/**
 * One local workspace package discovered from a monorepo root's own
 * authoritative `workspaces` declaration (P1-A4).
 *
 * `canonicalRoot` is the IDENTITY. Not the name, not the version, not the
 * declaration that admitted it: two workspace packages that declare the
 * same `"name"` and `"version"` are two packages, and a workspace package
 * and a separately installed copy of the same name and version are two
 * packages. That is not a VulnTrace convention — it is what real Node does
 * (`fixtures/workspaces/verify.cjs` asserts both directions out of
 * process), because Node loads and caches by realpath.
 *
 * `packageName` and `version` are METADATA, read from the package's own
 * manifest when present. They exist for explainability and for the
 * advisory-name match, never to establish or collapse identity.
 */
export interface WorkspacePackage {
  readonly canonicalRoot: string;
  readonly packageName?: string;
  readonly version?: string;
  /** The workspace pattern that admitted this root, for explainability. */
  readonly pattern: string;
}

/**
 * The result of interpreting a monorepo root's `workspaces` declaration.
 *
 * `unsupported` is deliberately a first-class, reported outcome rather
 * than an empty result: a declaration VulnTrace cannot interpret must
 * FAIL CLOSED (discover nothing from it) while still being visible, so a
 * reader can tell "this repo declares no workspaces" apart from "this
 * repo declares workspaces in a form this analyzer does not support".
 * Conflating those two is how an analyzer silently loses a package and
 * then reports a confident negative about it.
 */
export interface WorkspaceDiscovery {
  readonly packages: readonly WorkspacePackage[];
  readonly unsupported: readonly string[];
}

const EMPTY: WorkspaceDiscovery = { packages: [], unsupported: [] };

/**
 * Upper bound on how deep a `**` pattern may walk below its own literal
 * prefix, and on how many directories one discovery may examine in total.
 *
 * P1-A4 § PERFORMANCE forbids an unbounded repository-wide scan. The
 * literal prefix of each declared pattern is what bounds the search
 * DOMAIN; these two caps bound the WORK inside that domain, so a
 * pathological tree (a deeply nested or symlink-cycled monorepo) cannot
 * turn discovery into an unbounded walk. Exceeding either cap fails the
 * pattern closed rather than returning a partial, order-dependent subset —
 * a truncated list would make discovery depend on readdir order, which is
 * exactly what must never decide identity.
 */
const MAX_DESCENDANT_DEPTH = 8;
const MAX_DIRECTORIES_EXAMINED = 4096;

/**
 * A workspace pattern reduced to a bounded DIRECTORY ENUMERATION.
 *
 * This is deliberately not a glob engine (P1-A4 § NON-GOALS: "Do NOT
 * create a broad custom glob implementation"). Only three shapes are
 * interpreted, each of which is a plain directory listing rooted at the
 * pattern's own literal prefix:
 *
 * - `literal`     — `"packages/foo"`: that one directory.
 * - `children`    — `"packages/*"`: the immediate subdirectories of
 *                   `packages`.
 * - `descendants` — `"packages/**"`: subdirectories below `packages`, to a
 *                   bounded depth.
 *
 * Everything else is UNSUPPORTED and discovers nothing: negations
 * (`"!packages/x"`), wildcards anywhere but the final segment
 * (a wildcard segment followed by more segments), `?`, character classes,
 * brace expansion,
 * extglobs, absolute patterns, and any pattern containing `..`. Those
 * forms are legal in npm/Yarn and this analyzer does not implement them;
 * guessing at a subset of their meaning would silently either miss a
 * package (a target disappears, and a negative verdict is then built on
 * its absence) or admit a directory the declaration never covered.
 */
type WorkspacePattern =
  | { readonly kind: "literal"; readonly prefix: string }
  | { readonly kind: "children"; readonly prefix: string }
  | { readonly kind: "descendants"; readonly prefix: string };

/** Characters that make a pattern a glob shape this module does not implement. */
const UNSUPPORTED_PATTERN_CHARACTERS = /[?[\]{}()!+@]/;

/**
 * Reduces one declared workspace pattern to a {@link WorkspacePattern}, or
 * `undefined` when its shape is not supported (see that type's contract).
 */
export function interpretWorkspacePattern(
  pattern: string,
): WorkspacePattern | undefined {
  if (pattern.length === 0) {
    return undefined;
  }
  if (path.isAbsolute(pattern) || pattern.startsWith("/")) {
    return undefined;
  }
  if (UNSUPPORTED_PATTERN_CHARACTERS.test(pattern)) {
    return undefined;
  }

  // Normalize the separator but NOT the pattern's segments: `path.normalize`
  // would collapse `..`, which must be refused rather than resolved.
  const segments = pattern.split(/[\\/]+/).filter((segment) => segment !== ".");
  if (segments.length === 0) {
    return undefined;
  }
  if (segments.some((segment) => segment === "..")) {
    return undefined;
  }

  const last = segments[segments.length - 1] ?? "";
  const leading = segments.slice(0, -1);

  // A wildcard is only ever interpreted in the FINAL segment. A `*` earlier
  // in the pattern means something this module does not implement.
  if (leading.some((segment) => segment.includes("*"))) {
    return undefined;
  }

  if (last === "*") {
    return { kind: "children", prefix: leading.join(path.sep) };
  }
  if (last === "**") {
    return { kind: "descendants", prefix: leading.join(path.sep) };
  }
  if (last.includes("*")) {
    // A partial wildcard (`"pkg-*"`, `"*-lib"`) is a real glob match this
    // module does not implement.
    return undefined;
  }

  return { kind: "literal", prefix: [...leading, last].join(path.sep) };
}

/**
 * Reads the raw `workspaces` value of a manifest and returns the declared
 * patterns, or `undefined` when the declaration's SHAPE is not one this
 * module interprets.
 *
 * Both npm/Yarn spellings are authoritative and both are accepted:
 *
 * ```json
 * { "workspaces": ["packages/*"] }
 * { "workspaces": { "packages": ["packages/*"] } }
 * ```
 *
 * The object form's other keys (Yarn's `nohoist`, for instance) are
 * ignored: they affect where a package manager PLACES files, which this
 * module never predicts — it reads what is actually on disk.
 *
 * Returns `undefined` (not `[]`) for an uninterpretable declaration so the
 * caller can report it as unsupported rather than as "no workspaces".
 */
export function readWorkspacePatterns(
  workspaces: unknown,
): readonly string[] | undefined {
  if (workspaces === undefined || workspaces === null) {
    return [];
  }
  const candidate = Array.isArray(workspaces)
    ? workspaces
    : typeof workspaces === "object" &&
        Array.isArray((workspaces as { packages?: unknown }).packages)
      ? (workspaces as { packages: unknown[] }).packages
      : undefined;

  if (candidate === undefined) {
    return undefined;
  }
  if (!candidate.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return candidate as readonly string[];
}

/** Reads a manifest's `name`/`version`, or `{}` when it cannot be read. */
function readManifestIdentity(packageRoot: string): {
  name?: string;
  version?: string;
  exists: boolean;
} {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf-8"),
    );
    const name = (raw as { name?: unknown }).name;
    const version = (raw as { version?: unknown }).version;
    return {
      name: typeof name === "string" && name.length > 0 ? name : undefined,
      version: typeof version === "string" ? version : undefined,
      exists: true,
    };
  } catch {
    return { exists: false };
  }
}

/** Immediate subdirectories of `directory`, or `undefined` if unreadable. */
function subdirectories(directory: string): string[] | undefined {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
}

/**
 * A directory name a workspace pattern must never descend into or admit.
 *
 * `node_modules` is the important one: `"packages/**"` must not scoop up
 * every installed dependency underneath a workspace member and declare it
 * a WORKSPACE package. Installed packages already have their own identity
 * authority (the dependency graph and the `node_modules` path shape);
 * admitting them here would be a second, divergent authority for the same
 * question.
 */
function isExcludedDirectory(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

/** Candidate directories for one interpreted pattern, or `undefined` if the walk exceeded its bounds. */
function enumerateCandidates(
  projectRoot: string,
  pattern: WorkspacePattern,
  budget: { examined: number },
): string[] | undefined {
  const base = pattern.prefix
    ? path.resolve(projectRoot, pattern.prefix)
    : path.resolve(projectRoot);

  if (pattern.kind === "literal") {
    budget.examined += 1;
    return [base];
  }

  const results: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    if (budget.examined >= MAX_DIRECTORIES_EXAMINED) {
      return undefined;
    }
    budget.examined += 1;

    const names = subdirectories(current.dir);
    if (names === undefined) {
      continue;
    }
    for (const name of names) {
      if (isExcludedDirectory(name)) {
        continue;
      }
      const child = path.join(current.dir, name);
      results.push(child);
      if (
        pattern.kind === "descendants" &&
        current.depth + 1 < MAX_DESCENDANT_DEPTH
      ) {
        queue.push({ dir: child, depth: current.depth + 1 });
      }
    }
    if (pattern.kind === "children") {
      break;
    }
  }

  if (pattern.kind === "descendants" && queue.length > 0) {
    // The depth cap stopped the walk with work still pending: the pattern's
    // domain is larger than this module will enumerate. Fail it closed
    // rather than return the subset that happened to fit.
    return undefined;
  }

  return results;
}

/**
 * Discovers the local workspace packages of a monorepo from its root
 * manifest's own `workspaces` declaration (P1-A4 § WORKSPACE DISCOVERY).
 *
 * ## What makes a directory a workspace package here
 *
 * Two things, both required, neither of them a guess:
 *
 * 1. The monorepo root's own `package.json` declares a `workspaces`
 *    pattern that covers it — AUTHORITATIVE METADATA, written by the
 *    repository, not inferred from directory shape; and
 * 2. the directory really contains a readable `package.json`.
 *
 * A directory that merely *looks* like a package (a `src/` tree, a
 * `node_modules`-ish layout, a name that matches a dependency) is never a
 * workspace package. This is the same discipline `KnownPackageRoots`
 * already applies to installed packages, where dependency-graph
 * PROVENANCE — not filesystem containment — is what admits a root (see
 * `domain/resolved-target.ts`).
 *
 * The scanned project's OWN root is never returned, even if a pattern
 * would match it: the monorepo root is not one of its own child packages
 * (P1-A4 self-review § E). Nor is anything inside a `node_modules`
 * directory: installed packages have their own identity authority, and a
 * second authority for the same question is a worse failure mode than one.
 *
 * ## What this deliberately does NOT do
 *
 * It does not read `workspace:`/`file:`/`link:` dependency specifiers to
 * decide anything. Those may support discovery in principle, but the
 * actual resolved path is what carries identity (P1-A4 § WORKSPACE
 * DEPENDENCY PROTOCOL), and that comes from the real module resolver, not
 * from a manifest string this module would have to interpret.
 *
 * It does not run a package manager, install anything, or solve a
 * lockfile. It reads two kinds of file, both as data: the root manifest
 * and each candidate's manifest.
 *
 * Discovery is NOT reachability. A package returned here is a package
 * whose identity VulnTrace can now state exactly; whether any of its files
 * are ever loaded is `ModuleLoadClosure`'s separate question, and nothing
 * here answers it (P1-A4 § MODULE LOAD CLOSURE).
 *
 * Results are sorted by canonical root, so no caller can depend on
 * readdir/declaration order.
 */
export function discoverWorkspacePackages(
  projectRoot: string,
): WorkspaceDiscovery {
  const rootManifest = readRawManifest(projectRoot);
  if (rootManifest === undefined) {
    return EMPTY;
  }

  const patterns = readWorkspacePatterns(
    (rootManifest as { workspaces?: unknown }).workspaces,
  );
  if (patterns === undefined) {
    return {
      packages: [],
      unsupported: [
        `the root manifest's "workspaces" declaration is not a supported shape (expected an array of patterns, or an object with a "packages" array)`,
      ],
    };
  }
  if (patterns.length === 0) {
    return EMPTY;
  }

  const canonicalProjectRoot = canonicalizePackageInstancePath(projectRoot);
  const budget = { examined: 0 };
  const byRoot = new Map<string, WorkspacePackage>();
  const unsupported: string[] = [];

  for (const pattern of patterns) {
    const interpreted = interpretWorkspacePattern(pattern);
    if (interpreted === undefined) {
      unsupported.push(
        `workspace pattern "${pattern}" is not a supported shape and was ignored`,
      );
      continue;
    }

    const candidates = enumerateCandidates(projectRoot, interpreted, budget);
    if (candidates === undefined) {
      unsupported.push(
        `workspace pattern "${pattern}" exceeded this analyzer's discovery bounds and was ignored`,
      );
      continue;
    }

    for (const candidate of candidates) {
      // Only the portion BELOW the project root may disqualify a
      // candidate. Checking the absolute path instead would let any
      // ancestor directory outside the repository -- a checkout under
      // `~/.config`, a CI workspace under `/.cache`, a git worktree under
      // `.claude/worktrees` -- silently disqualify every workspace package
      // in an otherwise ordinary monorepo, and workspace discovery would
      // then find nothing at all for a reason having nothing to do with
      // the repository being scanned.
      const relative = path.relative(projectRoot, candidate);
      if (
        relative
          .split(path.sep)
          .some((segment) => segment !== "" && isExcludedDirectory(segment))
      ) {
        continue;
      }
      const identity = readManifestIdentity(candidate);
      if (!identity.exists) {
        continue;
      }
      const canonicalRoot = canonicalizePackageInstancePath(candidate);
      if (canonicalRoot === canonicalProjectRoot) {
        continue;
      }
      // First pattern to admit a root wins the `pattern` label only; the
      // ROOT is what carries identity, and the result is sorted below, so
      // this cannot change WHICH packages are returned.
      if (!byRoot.has(canonicalRoot)) {
        byRoot.set(canonicalRoot, {
          canonicalRoot,
          packageName: identity.name,
          version: identity.version,
          pattern,
        });
      }
    }
  }

  return {
    packages: [...byRoot.values()].sort((a, b) =>
      a.canonicalRoot < b.canonicalRoot
        ? -1
        : a.canonicalRoot > b.canonicalRoot
          ? 1
          : 0,
    ),
    unsupported,
  };
}

/** Reads and JSON-parses a directory's `package.json`, or `undefined`. */
function readRawManifest(directory: string): unknown | undefined {
  try {
    return JSON.parse(
      readFileSync(path.join(directory, "package.json"), "utf-8"),
    ) as unknown;
  } catch {
    return undefined;
  }
}
