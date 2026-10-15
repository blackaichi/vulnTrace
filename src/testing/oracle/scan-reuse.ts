import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { VulnerabilityProvider } from "../../domain/vulnerability.js";
import type { ProjectSpec } from "./project.js";
import { syntheticProviderSpec } from "./provider.js";
import {
  observationOf,
  type OracleScanOptions,
  type ScanObservation,
} from "./scan.js";

/**
 * BL-089 — A CONTROL'S SCAN, REUSED WITHIN ONE RUN.
 *
 * Many oracle cases share their controls (a suite builds them with one
 * helper), so the same control project is scanned again and again under
 * the same provider and options. {@link scanWithReuse} lets a CONTROL
 * variant reuse the scan of an earlier control variant whose inputs are
 * byte-identical, within the same run. The case's own variant is never
 * reused (`case.ts` passes no key for it), and the loud-fixture check and
 * the real-Node ground truth still run for every variant — only the scan
 * is shared.
 *
 * THE KEY ({@link scanReuseKey}) is a SHA-256 of everything a scan reads
 * besides the analyzer, the environment and the directories above the
 * temporary project, which are those of the same run:
 *
 * - the project: every file's path and content and every symlink's path
 *   and target, in the order they are written (two specs that write the
 *   same path twice in different orders are different);
 * - the provider's answers, as data — only a {@link syntheticProvider}
 *   unchanged since it was built has them (`syntheticProviderSpec`); any
 *   other provider is code, and its scans are never reused;
 * - the scan option `cveFilter`. A scan with any other option set
 *   (`configPathOverride`, `outputPath`, `cacheDir`, or `noCache: false`,
 *   each of which reads or writes a path outside the project; `format:
 *   "html"`, whose output cannot be re-rooted as data) is never reused,
 *   nor is one with an option this module does not know.
 *
 * WITHIN ONE RUN, NEVER BEYOND IT. The store is this module's memory:
 * vitest isolates test files, so it lives for one test file of one run.
 * Nothing is written to disk, so no cache entry can outlive the analyzer
 * code that produced it.
 *
 * RE-ROOTED, NOT COPIED. A scan's output names its temporary directory
 * (`scan.project`, and any path outside the project) and carries a fresh
 * random `scan.id`. A reused scan is the earlier one's output with the
 * earlier directory's unique name (`vulntrace-oracle-XXXXXX`, in whatever
 * spelling) replaced by this variant's, and a fresh `scan.id`, parsed by
 * the harness's one parser (`observationOf`); its `timings` are the
 * earlier scan's, as measured. That is a fresh scan's output only if the
 * analysis does not depend on the directory's name beyond printing it:
 * `VT_ORACLE_SCAN_REUSE=verify` scans anyway and fails unless the reused
 * observation and the fresh one are identical apart from `scan.id` and
 * the `timings` durations, which BL-089 ran over the whole oracle suite.
 * `VT_ORACLE_SCAN_REUSE=off` disables reuse.
 */

export type ScanReuseMode = "on" | "off" | "verify";

/** `VT_ORACLE_SCAN_REUSE`: `on` (the default), `off` or `verify`. */
export function scanReuseMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ScanReuseMode {
  const value = env.VT_ORACLE_SCAN_REUSE;
  if (value === undefined || value === "" || value === "on") return "on";
  if (value === "off" || value === "verify") return value;
  throw new Error(
    `VT_ORACLE_SCAN_REUSE must be "on", "off" or "verify" (got ${JSON.stringify(value)})`,
  );
}

/** The scan options a reused scan may have; any other set option forbids reuse. */
const KEYED_OPTIONS: ReadonlySet<string> = new Set([
  "cveFilter",
  "format",
  "noCache",
]);

const DURATION = /Ms$/;

/** The reuse key of one scan, or `undefined` when it must not be reused. */
export function scanReuseKey(
  project: ProjectSpec,
  provider: VulnerabilityProvider,
  options: OracleScanOptions | undefined,
): string | undefined {
  const providerSpec = syntheticProviderSpec(provider);
  if (providerSpec === undefined) return undefined;
  for (const [name, value] of Object.entries(options ?? {})) {
    if (value !== undefined && !KEYED_OPTIONS.has(name)) return undefined;
  }
  if (options?.noCache === false) return undefined;
  if ((options?.format ?? "json") !== "json") return undefined;
  return createHash("sha256")
    .update(
      JSON.stringify({
        files: Object.entries(project.files),
        symlinks: Object.entries(project.symlinks ?? {}),
        provider: providerSpec,
        cveFilter: options?.cveFilter ?? null,
      }),
    )
    .digest("hex");
}

interface Stored {
  readonly observation: ScanObservation;
  /** The temporary directory's unique name, or `undefined` when the scan is not reusable. */
  readonly dirName: string | undefined;
}

const store = new Map<string, Promise<Stored>>();
const counts = { scanned: 0, reused: 0, verified: 0 };

/** How many keyed scans ran, were reused and were verified in this module's lifetime. */
export function scanReuseCounts(): Readonly<typeof counts> {
  return { ...counts };
}

/** Forgets every stored scan (for the module's own suite). */
export function resetScanReuse(): void {
  store.clear();
  counts.scanned = 0;
  counts.reused = 0;
  counts.verified = 0;
}

function scanIdOf(observation: ScanObservation): string | undefined {
  const id = observation.output?.scan?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * `observation`, scanned in a directory named `fromName`, as it would read
 * scanned in one named `toName`, with a fresh scan ID.
 */
export function rerootObservation(
  observation: ScanObservation,
  fromName: string,
  toName: string,
  options: OracleScanOptions | undefined,
): ScanObservation {
  const move = (text: string): string => text.split(fromName).join(toName);
  let stdout = move(observation.stdout);
  const id = scanIdOf(observation);
  if (id !== undefined) stdout = stdout.split(id).join(randomUUID());
  return observationOf(
    {
      exitCode: observation.exitCode,
      stdout,
      stderr: move(observation.stderr),
      possibleEdgeProblems: observation.possibleEdgeProblems.map(move),
    },
    options,
  );
}

/**
 * Where a reused and a fresh observation differ, apart from `scan.id` and
 * the `timings` durations (the only two things two scans of the same
 * inputs may differ in); `undefined` when they do not.
 */
export function observationDifference(
  reused: ScanObservation,
  fresh: ScanObservation,
): string | undefined {
  const masked = (o: ScanObservation): string => {
    let stdout: unknown = o.stdout;
    if (o.output !== undefined) {
      const parsed = JSON.parse(o.stdout) as {
        scan?: { id?: unknown };
        timings?: Record<string, unknown>;
      };
      if (parsed.scan !== undefined) parsed.scan.id = "<scan-id>";
      for (const name of Object.keys(parsed.timings ?? {})) {
        if (DURATION.test(name)) parsed.timings![name] = "<duration>";
      }
      stdout = parsed;
    }
    return JSON.stringify({
      exitCode: o.exitCode,
      stdout,
      stderr: o.stderr,
      possibleEdgeProblems: o.possibleEdgeProblems,
    });
  };
  const a = masked(reused);
  const b = masked(fresh);
  if (a === b) return undefined;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  return `reused and fresh scans differ at character ${i}: reused …${a.slice(Math.max(0, i - 80), i + 80)}… fresh …${b.slice(Math.max(0, i - 80), i + 80)}…`;
}

/**
 * Scans through `scan` in `dir`, or reuses the scan stored under `key`
 * (see this module's header). `key` undefined: always scans, stores
 * nothing.
 */
export async function scanWithReuse(args: {
  readonly key: string | undefined;
  readonly dir: string;
  readonly project: ProjectSpec;
  readonly options: OracleScanOptions | undefined;
  readonly scan: () => Promise<ScanObservation>;
  readonly mode?: ScanReuseMode;
}): Promise<{
  readonly observation: ScanObservation;
  readonly reused: boolean;
}> {
  const { key, dir, project, options, scan } = args;
  const mode = args.mode ?? scanReuseMode();
  if (key === undefined || mode === "off") {
    return { observation: await scan(), reused: false };
  }
  const dirName = path.basename(dir);
  const earlier = store.get(key);
  if (earlier !== undefined) {
    const stored = await earlier.catch(() => undefined);
    if (stored?.dirName !== undefined) {
      const reused = rerootObservation(
        stored.observation,
        stored.dirName,
        dirName,
        options,
      );
      if (mode === "verify") {
        const fresh = await scan();
        const difference = observationDifference(reused, fresh);
        if (difference !== undefined) {
          throw new Error(`oracle scan reuse, verify mode: ${difference}`);
        }
        counts.verified += 1;
        return { observation: fresh, reused: false };
      }
      counts.reused += 1;
      return { observation: reused, reused: true };
    }
    counts.scanned += 1;
    return { observation: await scan(), reused: false };
  }
  const pending = (async (): Promise<Stored> => {
    const observation = await scan();
    // The directory's name is random; should the project itself contain
    // it, re-rooting would rewrite project content too, so do not reuse.
    const reusable =
      dirName.length >= 8 && !JSON.stringify(project).includes(dirName);
    return { observation, dirName: reusable ? dirName : undefined };
  })();
  store.set(key, pending);
  counts.scanned += 1;
  try {
    return { observation: (await pending).observation, reused: false };
  } catch (error) {
    store.delete(key);
    throw error;
  }
}
