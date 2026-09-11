/**
 * P0-Z AUDIT HARNESS (audit scaffolding; not shipped analyzer behavior).
 *
 * Builds a throwaway project on disk from an in-memory file map, runs the
 * real `runScanCommand` over it, and -- for the differential oracle --
 * executes the same tree under real Node, so an analyzer verdict can be
 * compared against what the runtime actually did.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";
import { runScanCommand } from "../cli/scan.js";

export type Files = Record<string, string>;

export interface RuleTarget {
  module: string;
  export: string;
  kind?: string;
}

export interface ScanSpec {
  files: Files;
  entrypoints: string[];
  pkgName: string;
  targets: RuleTarget[];
  /** Version the advisory is fixed in; default far future = always vulnerable. */
  fixedIn?: string;
}

export interface AuditFinding {
  vulnerability: string;
  package: string;
  version: string;
  verdict: "AFFECTED" | "NOT_AFFECTED" | "UNKNOWN";
  target?: { module: string; symbol: string };
  evidence?: {
    path?: string[];
    reasons?: string[];
    confirmedAbsentFromModuleLoadClosure?: { packageInstance?: string };
    confirmedAbsentInstance?: { packageInstance?: string };
    confirmedUnreachableTarget?: { target?: unknown };
  };
}

const created: string[] = [];

export function cleanupAll(): void {
  for (const d of created.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
}

export function materialize(files: Files, prefix = "p0z-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function provider(
  byName: Record<string, readonly RawVulnerability[]>,
): VulnerabilityProvider {
  return {
    queryPackage: (q: PackageQuery) => Promise.resolve(byName[q.name] ?? []),
  };
}

export interface ScanOutcome {
  findings: AuditFinding[];
  stderr: string[];
  exitCode: number;
  dir: string;
}

/** Runs the real scan pipeline over a materialized project. */
export async function scan(spec: ScanSpec): Promise<ScanOutcome> {
  const dir = materialize(spec.files);

  const ghsa = `GHSA-p0z-${spec.pkgName}`;
  const vuln: RawVulnerability = {
    id: ghsa,
    aliases: [],
    affected: [
      {
        package: { ecosystem: "npm", name: spec.pkgName },
        ranges: [
          {
            type: "SEMVER",
            events: [{ introduced: "0" }, { fixed: spec.fixedIn ?? "9999.0.0" }],
          },
        ],
      },
    ],
    references: [],
  };

  const cfgDir = materialize({}, "p0z-cfg-");
  const rulesPath = path.join(cfgDir, "rules.yml");
  writeFileSync(
    rulesPath,
    "rules:\n" +
      `  - id: ${ghsa}\n` +
      "    package:\n" +
      `      name: ${spec.pkgName}\n` +
      "    targets:\n" +
      spec.targets
        .map(
          (t) =>
            `      - module: ${JSON.stringify(t.module)}\n` +
            `        export: ${JSON.stringify(t.export)}\n` +
            `        kind: ${t.kind ?? "function"}\n` +
            "        confidence: 1.0\n",
        )
        .join(""),
  );
  const configPath = path.join(cfgDir, "vulntrace.yml");
  writeFileSync(
    configPath,
    "analysis:\n  entrypoints:\n" +
      spec.entrypoints.map((e) => `    - ${JSON.stringify(e)}\n`).join("") +
      `rules:\n  files:\n    - ${JSON.stringify(rulesPath)}\n`,
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runScanCommand({
    projectPathArg: dir,
    configPathOverride: configPath,
    provider: provider({ [spec.pkgName]: [vuln] }),
    noCache: true,
    io: { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) },
  });

  let findings: AuditFinding[] = [];
  try {
    findings = (JSON.parse(stdout.join("")) as { findings: AuditFinding[] })
      .findings;
  } catch {
    findings = [];
  }
  return { findings, stderr, exitCode, dir };
}

/** Executes the same file map under real Node; returns emitted event lines. */
export function runNode(
  files: Files,
  entry: string,
): { ok: boolean; events: string[]; err: string } {
  const dir = materialize(files, "p0z-node-");
  try {
    const out = execFileSync(process.execPath, [path.join(dir, entry)], {
      encoding: "utf8",
      timeout: 20000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, events: out.split("\n").filter(Boolean), err: "" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return {
      ok: false,
      events: (err.stdout ?? "").split("\n").filter(Boolean),
      err: (err.stderr ?? "").split("\n").slice(0, 2).join(" | "),
    };
  }
}

/** Which negative-proof family a finding carries, or null. */
export function family(f: AuditFinding): "A" | "B" | "C" | null {
  const e = f.evidence;
  if (!e) return null;
  if (e.confirmedAbsentFromModuleLoadClosure) return "A";
  if (e.confirmedAbsentInstance) return "B";
  if (e.confirmedUnreachableTarget) return "C";
  return null;
}

/** Compact one-line description of a finding, for audit tables. */
export function describe1(f: AuditFinding | undefined): string {
  if (!f) return "NO_FINDING";
  const fam = family(f);
  return `${f.verdict}${fam ? `/Family${fam}` : ""}`;
}

/** Standard minimal project scaffolding for a single dependency. */
export function pkgScaffold(
  appName: string,
  dep: string,
  depVersion: string,
  type: "module" | "commonjs" = "commonjs",
): Files {
  return {
    "package.json": JSON.stringify(
      {
        name: appName,
        version: "1.0.0",
        type,
        dependencies: { [dep]: depVersion },
      },
      null,
      2,
    ),
    "package-lock.json": JSON.stringify(
      {
        name: appName,
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: appName,
            version: "1.0.0",
            dependencies: { [dep]: depVersion },
          },
          [`node_modules/${dep}`]: { version: depVersion },
        },
      },
      null,
      2,
    ),
  };
}
