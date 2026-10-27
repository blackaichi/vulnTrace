import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultOsvCacheDir } from "../../cache/cache-location.js";

/**
 * BL-117 — REAL NODE'S ANSWERS, CACHED ON DISK, LOCALLY.
 *
 * Every real-Node process the oracle harness runs goes through
 * {@link runRealNode} or {@link runRealNodeSync}: the loud-fixture check,
 * the ground truth and the builtin probes. None of them runs the analyzer,
 * so a process's result is a function of what it is given. When this
 * module can name everything it is given, it keeps the result on disk and
 * serves it to a later run that gives the same. The analyzer's own scan
 * is never cached here (BL-089's within-run reuse of a control's scan is
 * `scan-reuse.ts`, and is separate).
 *
 * THE KEY ({@link realNodeRunKey}) is a SHA-256 of:
 *
 * - this harness's own source: every non-test `.ts` file of
 *   `src/testing/oracle/`, by name and bytes;
 * - the executable, resolved through the child's `PATH` as `execFile`
 *   resolves it, by real path and file identity (device, inode, size,
 *   modification and change times), its release and `process.versions`
 *   (the libraries it may take from the system). Only the Node
 *   running this process is cached: any other executable, a version
 *   manager's shim included, may run something its own file does not
 *   show;
 * - the arguments, the stdin mode and the timeout;
 * - the child's whole environment. That environment is
 *   {@link childEnvironment}'s, never this process's: only the variables
 *   it names reach the child, so no variable outside the key can change
 *   the answer, cached or not;
 * - the working directory: every entry under it, one record each, by
 *   relative path, type, mode and the SHA-256 of its bytes (a symlink by
 *   its target), and its parent's path;
 * - every `package.json` above it, by path and bytes (Node reads the
 *   nearest one for a file's module type), on both the spelled path and
 *   the real one (Node resolves from the real one), and both parents.
 *
 * A run is NOT cached when what it could read cannot be named that way:
 * a `node_modules` directory above the working directory (on either
 * path), a working directory whose real name is not its spelled one, a
 * FIFO, socket or device in it, a global module
 * folder (`$HOME/.node_modules`, `$HOME/.node_libraries`,
 * `<prefix>/lib/node`), any `NODE_*` or `UV_*` variable but `NODE_ENV`
 * (`NODE_OPTIONS`, `NODE_PATH`, `NODE_ICU_DATA` … can name files outside
 * the key), a symlink in the working directory that the kernel resolves
 * outside it (or that dangles), or a working directory whose entries
 * mention its own (random) name. Nor is a result cached
 * that did not end in an exit status (a timeout, a signal, a spawn
 * failure, an output overflow), or after which the key reads differently
 * (the key is computed again once the process ends): a process that wrote
 * into its working directory, whose later variant's scan and ground truth
 * read that directory so that a skipped run would hand them a different
 * one, or a change above it during the run.
 *
 * What the key cannot see: a process that reads the clock, randomness,
 * its process ID, the network, or a file outside the working directory
 * and the folders above (the system's time-zone data under `TZ`, say).
 * The oracle's fixtures do not; `verify` mode (below) is how that is
 * checked rather than assumed. `PATH` is keyed as text: under `npm run`
 * it names the worktree's `node_modules/.bin`, so each worktree fills its
 * own entries (a cost, not a defect).
 *
 * RE-ROOTED. The working directory is a fresh `mkdtemp` directory with a
 * random name, which a process's output may print (a stack trace, a
 * `__filename`). A served result is the stored one with the stored
 * directory's name replaced by this one's, as `scan-reuse.ts` does. The
 * replacement is literal: a name printed transformed (upper-cased, say)
 * is served as the stored run printed it. No fixture prints one; the
 * ground truth's markers are fixed strings.
 *
 * MODES, `VT_ORACLE_NODE_CACHE`: `on` serves and stores; `off` runs every
 * process and touches no file; `verify` runs every process, fails when a
 * stored result differs from the fresh one (apart from the process ID in
 * a Node warning's `(node:<pid>)` prefix), and stores a fresh result that
 * has no entry yet. Unset, the mode is `off` when the `CI` variable is set
 * (CI runs uncached, by the project owner's decision of 2026-10-27) and
 * `on` otherwise. The cache lives in the user cache directory's
 * `vulntrace/oracle-node-runs` (beside the OSV cache, `cache-location.ts`),
 * or in `VT_ORACLE_NODE_CACHE_DIR` when that is set; it is never pruned,
 * and deleting it is always safe.
 */

export type RealNodeCacheMode = "on" | "off" | "verify";

/** `VT_ORACLE_NODE_CACHE`: `on`, `off` or `verify`; unset, `off` under CI and `on` otherwise. */
export function realNodeCacheMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RealNodeCacheMode {
  const value = env.VT_ORACLE_NODE_CACHE;
  if (value === undefined || value === "") {
    return env.CI !== undefined && env.CI !== "" && env.CI !== "false"
      ? "off"
      : "on";
  }
  if (value === "on" || value === "off" || value === "verify") return value;
  throw new Error(
    `VT_ORACLE_NODE_CACHE must be "on", "off" or "verify" (got ${JSON.stringify(value)})`,
  );
}

/** Where entries are kept, or `undefined` when no absolute directory can be named. */
export function realNodeCacheDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const explicit = env.VT_ORACLE_NODE_CACHE_DIR;
  if (explicit !== undefined && explicit !== "") {
    return path.isAbsolute(explicit) ? explicit : undefined;
  }
  const osv = defaultOsvCacheDir();
  return osv === undefined
    ? undefined
    : path.join(path.dirname(osv), "oracle-node-runs");
}

/**
 * The variables a real-Node child is given, whatever the mode: the ones
 * Node, the shell's tools and the fixtures need, and nothing that varies
 * from one vitest worker, worktree or session to the next. Every child
 * the harness runs is given exactly this, so the cache key holds the
 * whole environment that can reach the child.
 */
export function childEnvironment(
  extra: Readonly<Record<string, string>> = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !keptVariable(name)) continue;
    kept[name] = value;
  }
  return { ...kept, ...extra };
}

const KEPT_VARIABLES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "PATHEXT",
  "COMSPEC",
  "ComSpec",
]);

function keptVariable(name: string): boolean {
  if (KEPT_VARIABLES.has(name)) return true;
  if (name.startsWith("LC_")) return true;
  if (name.startsWith("NODE_") || name.startsWith("UV_")) return true;
  // The project's own variables, except this harness's configuration,
  // which is never the child's business.
  return name.startsWith("VT_") && !name.startsWith("VT_ORACLE_");
}

export interface RealNodeRun {
  /** The executable, as `execFile` takes it (`"node"`, resolved through `PATH`). */
  readonly file: string;
  readonly args: readonly string[];
  /** A fresh temporary directory the run may read (`project.ts`'s `withTempProject`). */
  readonly cwd: string;
  /** The child's whole environment: {@link childEnvironment}'s. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** `"ignore"`: no stdin; `"pipe"`: an empty one, closed at once. */
  readonly stdin: "ignore" | "pipe";
}

/** How a real-Node process ended. `status` is `null` when it did not exit by itself. */
export interface RealNodeResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** A spawn or wait failure (`ETIMEDOUT`, `ENOENT`, `ENOBUFS` …), as Node reported it. */
  readonly error?: string;
  /** Whether this result is a stored one, re-rooted. */
  readonly cached: boolean;
}

const FORMAT = 1;
const MAX_BUFFER = 1024 * 1024;
const HERE = path.dirname(fileURLToPath(import.meta.url));

let harnessHash: string | undefined;

/** This harness's own source: every non-test `.ts` file beside this one. */
function harnessSourceHash(): string {
  harnessHash ??= harnessSourceDigest(HERE);
  return harnessHash;
}

/** Every non-test `.ts` file of `dir`, by name and bytes (exported for this module's suite). */
export function harnessSourceDigest(dir: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const bytes = readFileSync(path.join(dir, name));
    const digest = createHash("sha256").update(bytes).digest("hex");
    hash.update(`${JSON.stringify([name, digest])}\n`);
  }
  return hash.digest("hex");
}

/** `file` resolved as `execFile` resolves it: through the child's `PATH` unless it names a path. */
function resolveExecutable(
  file: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
): string | undefined {
  if (file.includes("/") || file.includes(path.sep)) {
    const candidate = path.resolve(cwd, file);
    return isExecutableFile(candidate) ? candidate : undefined;
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.resolve(cwd, dir, file);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    return (
      stat.isFile() &&
      (process.platform === "win32" || (stat.mode & 0o111) !== 0)
    );
  } catch {
    return false;
  }
}

/** Whether `resolved` is, by real path, the Node binary running this process. */
function isThisNode(resolved: string): boolean {
  try {
    return realpathSync(resolved) === realpathSync(process.execPath);
  } catch {
    return false;
  }
}

/** The executable's identity: real path, file identity and release (it is this process's Node). */
function executableIdentity(resolved: string): unknown {
  const real = realpathSync(resolved);
  const stat = statSync(real);
  return {
    real,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    release: `${process.version} ${process.arch} ${process.platform}`,
    // Every bundled or shared library's version (ICU, OpenSSL …), which a
    // distribution's Node may take from the system (round 2, U2).
    versions: process.versions,
  };
}

interface DirectoryScan {
  /** Every entry, sorted: relative path, type, mode and bytes (a symlink by its target). */
  readonly fingerprint: string;
  /** Whether an entry's name, bytes or symlink target mentions `needle`. */
  readonly mentions: boolean;
  /** Whether an entry reaches what the fingerprint does not: a symlink resolved outside `dir`, or a special file. */
  readonly escapes: boolean;
}

/** One walk of `dir`: its fingerprint, and whether it mentions `needle` or links outside itself. */
function scanDirectory(dir: string, needle: string): DirectoryScan {
  const hash = createHash("sha256");
  const realDir = realpathSync(dir);
  let mentions = false;
  let escapes = false;
  // One JSON line per entry, a file by the SHA-256 of its bytes: no entry's
  // bytes can imitate the entries after it (BL-117's key review, F1).
  const entry = (fields: readonly unknown[]): void => {
    hash.update(`${JSON.stringify(fields)}\n`);
  };
  const walk = (relative: string): void => {
    const absolute = path.join(dir, relative);
    for (const name of readdirSync(absolute).sort()) {
      const childRelative = relative === "" ? name : `${relative}/${name}`;
      const child = path.join(dir, childRelative);
      if (name.includes(needle)) mentions = true;
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(child);
        entry(["L", childRelative, target]);
        if (target.includes(needle)) mentions = true;
        // Where the kernel resolves the link, not where its spelling
        // points: `d -> .` makes `d/../x` leave the directory (F2). A
        // dangling link is outside too: what it names may appear later.
        let real: string | undefined;
        try {
          real = realpathSync(child);
        } catch {
          real = undefined;
        }
        const inside =
          real === undefined ? undefined : path.relative(realDir, real);
        if (
          inside === undefined ||
          inside.startsWith("..") ||
          path.isAbsolute(inside)
        ) {
          escapes = true;
        }
      } else if (stat.isDirectory()) {
        entry(["D", childRelative, stat.mode]);
        walk(childRelative);
      } else if (stat.isFile()) {
        const bytes = readFileSync(child);
        entry([
          "F",
          childRelative,
          stat.mode,
          createHash("sha256").update(bytes).digest("hex"),
        ]);
        if (bytes.toString("latin1").includes(needle)) mentions = true;
      } else {
        // A FIFO, socket or device: its content is not named (round 2, U3).
        entry(["O", childRelative, stat.mode]);
        escapes = true;
      }
    }
  };
  walk("");
  return { fingerprint: hash.digest("hex"), mentions, escapes };
}

/**
 * What the folders above `cwd` and the global module folders hand a Node
 * process: every `package.json` above it, by bytes; `undefined` when a
 * module folder outside the key is reachable.
 */
function surroundingsFingerprint(
  cwd: string,
  resolvedExecutable: string,
  env: Readonly<Record<string, string>>,
): unknown {
  // A Node variable may name a file the key does not hold
  // (`NODE_OPTIONS=--require <file>`, `NODE_ICU_DATA`, `NODE_PATH` …:
  // BL-117's key review, F3). Only `NODE_ENV`, a plain value, is keyed.
  if (
    Object.keys(env).some(
      (name) =>
        (name.startsWith("NODE_") && name !== "NODE_ENV") ||
        name.startsWith("UV_"),
    )
  ) {
    return undefined;
  }
  const home = env.HOME;
  const globalFolders = [
    ...(home !== undefined && home !== ""
      ? [path.join(home, ".node_modules"), path.join(home, ".node_libraries")]
      : []),
    path.join(
      path.dirname(path.dirname(realpathSync(resolvedExecutable))),
      "lib",
      "node",
    ),
  ];
  if (globalFolders.some((folder) => existsSync(folder))) return undefined;
  // Node resolves from the real path (`process.cwd()` is `getcwd()`, a
  // main file is resolved through its real path), and from the spelled one
  // under `--preserve-symlinks-main`: both chains are walked and keyed
  // (BL-117's key review, round 2, N1).
  const realCwd = realpathSync(cwd);
  if (path.basename(realCwd) !== path.basename(cwd)) return undefined;
  const manifests: [string, string][] = [];
  for (const start of new Set([path.dirname(cwd), path.dirname(realCwd)])) {
    let dir = start;
    for (;;) {
      if (existsSync(path.join(dir, "node_modules"))) return undefined;
      const manifest = path.join(dir, "package.json");
      if (existsSync(manifest)) {
        manifests.push([
          manifest,
          createHash("sha256").update(readFileSync(manifest)).digest("hex"),
        ]);
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return {
    parent: path.dirname(cwd),
    realParent: path.dirname(realCwd),
    manifests,
  };
}

/**
 * The key of `run`, or `undefined` when what it could read cannot be named
 * (this module's header). Throws only when the working directory cannot
 * be read.
 */
export function realNodeRunKey(run: RealNodeRun): string | undefined {
  const dirName = path.basename(run.cwd);
  if (dirName.length < 8) return undefined;
  if (run.args.some((arg) => arg.includes(dirName))) return undefined;
  const resolved = resolveExecutable(run.file, run.cwd, run.env);
  // Only the Node running this process is keyed: a version manager's shim
  // keeps its own file identity while it runs another release (F4).
  if (resolved === undefined || !isThisNode(resolved)) return undefined;
  const surroundings = surroundingsFingerprint(run.cwd, resolved, run.env);
  if (surroundings === undefined) return undefined;
  const scan = scanDirectory(run.cwd, dirName);
  if (scan.mentions || scan.escapes) return undefined;
  return createHash("sha256")
    .update(
      JSON.stringify({
        format: FORMAT,
        harness: harnessSourceHash(),
        executable: executableIdentity(resolved),
        file: run.file,
        args: run.args,
        stdin: run.stdin,
        timeoutMs: run.timeoutMs,
        env: Object.entries(run.env).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
        cwd: scan.fingerprint,
        surroundings,
      }),
    )
    .digest("hex");
}

interface StoredEntry {
  readonly format: number;
  readonly key: string;
  readonly dirName: string;
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const counts = { served: 0, ran: 0, stored: 0, uncacheable: 0, verified: 0 };

/** What this module did in this process: served, ran, stored, uncacheable and verified runs. */
export function realNodeCacheCounts(): Readonly<typeof counts> {
  return { ...counts };
}

function entryPath(dir: string, key: string): string {
  return path.join(dir, key.slice(0, 2), `${key}.json`);
}

function readEntry(dir: string, key: string): StoredEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(entryPath(dir, key), "utf-8"));
  } catch {
    return undefined;
  }
  const e = parsed as Partial<StoredEntry> | null;
  if (
    e === null ||
    typeof e !== "object" ||
    e.format !== FORMAT ||
    e.key !== key ||
    typeof e.dirName !== "string" ||
    e.dirName.length < 8 ||
    typeof e.status !== "number" ||
    !Number.isInteger(e.status) ||
    typeof e.stdout !== "string" ||
    typeof e.stderr !== "string"
  ) {
    return undefined;
  }
  return e as StoredEntry;
}

/** Writes `entry` atomically (a temporary file, then a rename), so a concurrent reader never sees half of it. */
function writeEntry(dir: string, entry: StoredEntry): void {
  const file = entryPath(dir, entry.key);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(entry));
    renameSync(temporary, file);
  } catch {
    rmSync(temporary, { force: true });
  }
}

function served(entry: StoredEntry, dirName: string): RealNodeResult {
  const move = (text: string): string =>
    text.split(entry.dirName).join(dirName);
  return {
    status: entry.status,
    signal: null,
    stdout: move(entry.stdout),
    stderr: move(entry.stderr),
    cached: true,
  };
}

/**
 * Node prefixes a process warning with its process ID, `(node:<pid>)`,
 * which differs between any two runs, fresh or not (found by BL-117's
 * whole-suite `verify` run: PRM-15's `MODULE_TYPELESS_PACKAGE_JSON`
 * warning). `verify` compares with it masked.
 */
const PROCESS_ID = /\(node:\d+\)/g;

function difference(
  stored: RealNodeResult,
  fresh: RealNodeResult,
): string | undefined {
  const masked = (value: unknown): unknown =>
    typeof value === "string"
      ? value.replace(PROCESS_ID, "(node:<pid>)")
      : value;
  for (const field of [
    "status",
    "signal",
    "stdout",
    "stderr",
    "error",
  ] as const) {
    if (masked(stored[field]) !== masked(fresh[field])) {
      return `${field}: stored ${JSON.stringify(stored[field])}, fresh ${JSON.stringify(fresh[field])}`;
    }
  }
  return undefined;
}

interface Plan {
  readonly mode: RealNodeCacheMode;
  readonly dir: string | undefined;
  readonly key: string | undefined;
}

function plan(run: RealNodeRun): Plan {
  const mode = realNodeCacheMode();
  if (mode === "off") return { mode, dir: undefined, key: undefined };
  const dir = realNodeCacheDir();
  const key = dir === undefined ? undefined : realNodeRunKey(run);
  if (key === undefined) counts.uncacheable += 1;
  return { mode, dir, key };
}

/** A stored result to serve now, if the plan allows one. */
function lookup(p: Plan, run: RealNodeRun): RealNodeResult | undefined {
  if (p.mode !== "on" || p.dir === undefined || p.key === undefined)
    return undefined;
  const entry = readEntry(p.dir, p.key);
  if (entry === undefined) return undefined;
  counts.served += 1;
  return served(entry, path.basename(run.cwd));
}

/** After a fresh run: verify it against a stored entry, and store it when it may be. */
function record(p: Plan, run: RealNodeRun, fresh: RealNodeResult): void {
  counts.ran += 1;
  if (p.dir === undefined || p.key === undefined) return;
  const dirName = path.basename(run.cwd);
  const existing = readEntry(p.dir, p.key);
  if (p.mode === "verify" && existing !== undefined) {
    const diff = difference(served(existing, dirName), {
      ...fresh,
      cached: true,
    });
    if (diff !== undefined) {
      throw new Error(
        `real-Node cache, verify mode: ${run.file} ${run.args.join(" ").slice(0, 200)} in ${run.cwd} differs from its stored result (${diff})`,
      );
    }
    counts.verified += 1;
    return;
  }
  if (existing !== undefined) return;
  if (
    fresh.status === null ||
    fresh.signal !== null ||
    fresh.error !== undefined
  )
    return;
  // Everything the key names, read again after the run: the project, the
  // folders above it, the executable. A process that wrote into its
  // project, or a change around it during the run, is not stored (round
  // 2, U1).
  if (realNodeRunKey(run) !== p.key) {
    counts.uncacheable += 1;
    return;
  }
  writeEntry(p.dir, {
    format: FORMAT,
    key: p.key,
    dirName,
    status: fresh.status,
    stdout: fresh.stdout,
    stderr: fresh.stderr,
  });
  counts.stored += 1;
}

/** Runs `run` in real Node, synchronously, or serves its stored result (this module's header). */
export function runRealNodeSync(run: RealNodeRun): RealNodeResult {
  const p = plan(run);
  const hit = lookup(p, run);
  if (hit !== undefined) return hit;
  const child = spawnSync(run.file, [...run.args], {
    cwd: run.cwd,
    env: run.env,
    encoding: "utf-8",
    timeout: run.timeoutMs,
    maxBuffer: MAX_BUFFER,
    stdio: [run.stdin, "pipe", "pipe"],
  });
  const errorCode = (child.error as NodeJS.ErrnoException | undefined)?.code;
  const fresh: RealNodeResult = {
    status: child.status,
    signal: child.signal,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    ...(child.error === undefined
      ? {}
      : { error: errorCode ?? String(child.error) }),
    cached: false,
  };
  record(p, run, fresh);
  return fresh;
}

/** {@link runRealNodeSync}, without blocking: probes run several at once. */
export async function runRealNode(run: RealNodeRun): Promise<RealNodeResult> {
  const p = plan(run);
  const hit = lookup(p, run);
  if (hit !== undefined) return hit;
  const fresh = await new Promise<RealNodeResult>((resolve) => {
    const child = execFile(
      run.file,
      [...run.args],
      {
        cwd: run.cwd,
        env: run.env,
        encoding: "utf-8",
        timeout: run.timeoutMs,
        maxBuffer: MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        const failure = error as
          | (Error & {
              code?: number | string;
              signal?: string | null;
              killed?: boolean;
            })
          | null;
        resolve({
          status:
            failure === null
              ? 0
              : typeof failure.code === "number"
                ? failure.code
                : null,
          signal: failure?.signal ?? null,
          stdout,
          stderr,
          ...(failure !== null && typeof failure.code !== "number"
            ? { error: String(failure.code ?? failure.message) }
            : {}),
          cached: false,
        });
      },
    );
    if (run.stdin === "pipe") child.stdin?.end();
  });
  record(p, run, fresh);
  return fresh;
}
