import { execFileSync } from "node:child_process";
import { parseCalledMarkers } from "./hit.js";

/**
 * Real Node's answer for one project/command, captured once and reused
 * for both the loud check's sibling assertions (AGENTS.md § G: "a case
 * cannot assert an expected verdict without also recording the real-Node
 * ground truth it rests on") and the case's own expectations.
 *
 * `calledMarkers` is the {@link parseCalledMarkers} convention this
 * harness's fixtures are written in: "the ground truth as the set of
 * marked functions that actually ran" (task H-0 step 1). `stdout`/
 * `stderr`/`threw` are kept alongside it because not every case can use
 * the marker convention (a custom ground-truth command may print
 * something else entirely, or the real, correct behavior IS to throw --
 * see docs/audits/2026-09-premise-sweep-round-1.md's `groundTruth`,
 * which formats a thrown error as its own ground-truth line rather than
 * treating it as a harness failure).
 */
export interface GroundTruthResult {
  readonly command: readonly [string, ...string[]];
  readonly calledMarkers: ReadonlySet<string>;
  readonly stdout: string;
  readonly stderr: string;
  readonly threw: boolean;
}

/**
 * Runs `command` in a REAL Node process (never this process's own `vm`,
 * never the analyzer) with `cwd` set to `projectDir`, and reduces it to a
 * {@link GroundTruthResult}. A non-zero exit is captured as `threw: true`
 * with whatever stdout/stderr the process produced before it exited --
 * itself sometimes the correct ground truth (a case whose real behavior is
 * to throw), so this never itself throws for that reason alone.
 */
export function runGroundTruth(
  projectDir: string,
  command: readonly [string, ...string[]],
  options?: { readonly timeoutMs?: number },
): GroundTruthResult {
  const [exe, ...args] = command;
  try {
    const stdout = execFileSync(exe, args, {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: options?.timeoutMs ?? 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      command,
      calledMarkers: parseCalledMarkers(stdout),
      stdout,
      stderr: "",
      threw: false,
    };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    const stdout = failure.stdout ?? "";
    return {
      command,
      calledMarkers: parseCalledMarkers(stdout),
      stdout,
      stderr: failure.stderr ?? "",
      threw: true,
    };
  }
}

/** The default ground-truth command for a string entrypoint: `node <entryFile>`. */
export function nodeEntryCommand(
  entryFile: string,
): readonly [string, ...string[]] {
  return ["node", entryFile];
}

/** The default ground-truth command for a `{file, symbol}` entrypoint: call the exported symbol directly. */
export function nodeSymbolEntryCommand(
  entryFile: string,
  symbol: string,
): readonly [string, ...string[]] {
  return [
    "node",
    "-e",
    `Promise.resolve(require('./${entryFile}').${symbol}()).catch(e => console.log('threw', e.message))`,
  ];
}
