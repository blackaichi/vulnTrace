import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { FileOsvCacheStore, computeOsvCacheKey } from "../cache/index.js";
import type {
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";
import { readOwnVersion } from "../shared/own-version.js";
import { validateScanOutput } from "./output.js";
import { runScanCommand } from "./scan.js";

/**
 * Task B-3 -- the OSV cache, end to end through a real scan.
 *
 * A cached answer is served INSTEAD of the provider's, with zero provider
 * queries. So a served answer that is not the provider's current one is a
 * silent drop whenever it holds fewer advisories:
 *
 *  - AUD-06: nothing expired, so an answer cached before an advisory was
 *    published was served forever;
 *  - AUD-07: the cache lived inside the scanned project
 *    (`<project>/.vulntrace-cache/osv`), under a key computed from public
 *    inputs, and was read back unvalidated -- a committed `[]` suppressed
 *    every advisory, and a wrong-shaped entry crashed or misled the scan;
 *  - PRM-35: a cache write failure aborted the scan as a "vulnerability
 *    provider failure", exit 4.
 *
 * The fixture is loud: `vuln-lib` exports `danger`, the export the rule
 * targets, and the application calls it, so the provider's advisory, once
 * it reaches the verdict layer, is AFFECTED. An answer served from a
 * stale, planted or malformed entry is a missing finding.
 *
 * `XDG_CACHE_HOME` is pointed at a fresh temporary directory for every
 * test, so no test here reads or writes the developer's real cache.
 */

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

let savedXdgCacheHome: string | undefined;
let xdgCacheHome: string;

beforeEach(() => {
  savedXdgCacheHome = process.env.XDG_CACHE_HOME;
  xdgCacheHome = tempDir("vulntrace-b3-xdg-");
  process.env.XDG_CACHE_HOME = xdgCacheHome;
});

afterEach(() => {
  vi.useRealTimers();
  if (savedXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = savedXdgCacheHome;
  }
});

const ADVISORY_ID = "GHSA-b3-cache";

const ADVISORY: RawVulnerability = {
  id: ADVISORY_ID,
  affected: [
    {
      package: { ecosystem: "npm", name: "vuln-lib" },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "9.0.0" }] },
      ],
    },
  ],
};

const RULES =
  "rules:\n" +
  `  - id: ${ADVISORY_ID}\n` +
  `    package:\n` +
  `      name: vuln-lib\n` +
  `    targets:\n` +
  `      - module: vuln-lib\n` +
  `        export: danger\n` +
  `        kind: function\n` +
  `        confidence: 1.0\n`;

const LIB_SOURCE =
  "function danger(x){ return x; }\n" +
  "function safe(x){ return x; }\n" +
  "module.exports = { danger, safe };\n";

function config(cacheBlock = ""): string {
  return (
    "analysis:\n  entrypoints:\n    - src/index.js\n" +
    "rules:\n  files:\n    - rules.yml\n" +
    cacheBlock
  );
}

/**
 * An app calling `vuln-lib@1.0.0`'s `danger`. With `nestedVersion`, a
 * second exact instance at that version is installed and called too, so
 * the scan makes two provider queries.
 */
function projectWithLib(
  options: { readonly nestedVersion?: string; readonly config?: string } = {},
): string {
  const { nestedVersion } = options;
  const twin = nestedVersion !== undefined;
  const dependencies: Record<string, string> = {
    "vuln-lib": "1.0.0",
    ...(twin ? { host: "1.0.0" } : {}),
  };
  const files: Record<string, string> = {
    "vulntrace.yml": options.config ?? config(),
    "rules.yml": RULES,
    "package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies,
    }),
    "package-lock.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "app", version: "1.0.0", dependencies },
        "node_modules/vuln-lib": { version: "1.0.0" },
        ...(twin
          ? {
              "node_modules/host": { version: "1.0.0" },
              "node_modules/host/node_modules/vuln-lib": {
                version: nestedVersion,
              },
            }
          : {}),
      },
    }),
    "src/index.js":
      'const lib = require("vuln-lib");\n' +
      (twin ? 'const host = require("host");\n' : "") +
      "function main(input) {\n" +
      (twin ? "  host.run(input);\n" : "") +
      "  return lib.danger(input);\n}\n" +
      "module.exports = { main };\n",
    "node_modules/vuln-lib/package.json": JSON.stringify({
      name: "vuln-lib",
      version: "1.0.0",
    }),
    "node_modules/vuln-lib/index.js": LIB_SOURCE,
  };
  if (twin) {
    files["node_modules/host/package.json"] = JSON.stringify({
      name: "host",
      version: "1.0.0",
    });
    files["node_modules/host/index.js"] =
      'const lib = require("vuln-lib");\n' +
      "function run(x){ return lib.danger(x); }\n" +
      "module.exports = { run };\n";
    files["node_modules/host/node_modules/vuln-lib/package.json"] =
      JSON.stringify({ name: "vuln-lib", version: nestedVersion });
    files["node_modules/host/node_modules/vuln-lib/index.js"] = LIB_SOURCE;
  }
  const root = tempDir("vulntrace-b3-project-");
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return root;
}

/** A provider whose `vuln-lib` answer the test changes between scans, counting `vuln-lib` queries. */
function mutableProvider(initial: readonly RawVulnerability[]) {
  const state = { answer: initial, calls: 0 };
  const provider: VulnerabilityProvider = {
    queryPackage(query) {
      if (query.name !== "vuln-lib") {
        return Promise.resolve([]);
      }
      state.calls++;
      return Promise.resolve(state.answer);
    },
  };
  return { provider, state };
}

/** The key the scan computes for `vuln-lib@<version>`'s query. */
function libKey(version = "1.0.0"): string {
  return computeOsvCacheKey({
    toolVersion: readOwnVersion(),
    query: { ecosystem: "npm", name: "vuln-lib", version },
  });
}

interface Output {
  readonly findings: readonly {
    readonly vulnerability: string;
    readonly verdict: string;
    readonly packageInstance?: string;
  }[];
  readonly diagnostics: readonly {
    readonly source: string;
    readonly message: string;
  }[];
}

interface ScanResult {
  readonly exit: number;
  readonly output: Output;
  readonly stderr: string;
}

async function scan(
  root: string,
  provider: VulnerabilityProvider,
  options: { readonly cacheDir?: string } = {},
): Promise<ScanResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = await runScanCommand({
    projectPathArg: root,
    configPathOverride: path.join(root, "vulntrace.yml"),
    provider,
    ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  });
  const parsed: unknown = JSON.parse(stdout.join("") || "null");
  expect(parsed, stderr.join("")).not.toBeNull();
  expect(validateScanOutput(parsed)).toEqual([]);
  return { exit, output: parsed as Output, stderr: stderr.join("") };
}

function verdicts(output: Output): readonly string[] {
  return output.findings
    .filter((finding) => finding.vulnerability === ADVISORY_ID)
    .map((finding) => finding.verdict);
}

function cacheDiagnostics(output: Output): readonly string[] {
  return output.diagnostics
    .filter((diagnostic) => diagnostic.source === "cache")
    .map((diagnostic) => diagnostic.message);
}

/** Every file under `dir`, relative, recursively; `[]` when it does not exist. */
function filesUnder(dir: string, prefix = ""): readonly string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? filesUnder(path.join(dir, entry.name), path.join(prefix, entry.name))
        : entry.isFile()
          ? [path.join(prefix, entry.name)]
          : [],
    )
    .sort();
}

const HOUR_MS = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);

describe("B-3 / AUD-06: a cached answer expires", () => {
  it("an answer cached more than 24 hours ago is re-queried, and the advisory published since is found", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    const root = projectWithLib();
    const cacheDir = tempDir("vulntrace-b3-cache-");
    const { provider, state } = mutableProvider([]);

    const cold = await scan(root, provider, { cacheDir });
    expect(cold.exit).toBe(0);
    expect(verdicts(cold.output)).toEqual([]);

    state.answer = [ADVISORY];
    vi.setSystemTime(T0 + 25 * HOUR_MS);
    const later = await scan(root, provider, { cacheDir });

    expect(state.calls).toBe(2);
    expect(later.exit).toBe(1);
    expect(verdicts(later.output)).toEqual(["AFFECTED"]);
  });

  it("control: an answer cached less than 24 hours ago is still served from the cache", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    const root = projectWithLib();
    const cacheDir = tempDir("vulntrace-b3-cache-");
    const { provider, state } = mutableProvider([]);

    await scan(root, provider, { cacheDir });
    state.answer = [ADVISORY];
    vi.setSystemTime(T0 + 23 * HOUR_MS);
    const warm = await scan(root, provider, { cacheDir });

    expect(state.calls).toBe(1);
    expect(verdicts(warm.output)).toEqual([]);
  });

  it("`vulnerabilities.cache.ttlHours` sets the expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    const root = projectWithLib({
      config: config("vulnerabilities:\n  cache:\n    ttlHours: 1\n"),
    });
    const cacheDir = tempDir("vulntrace-b3-cache-");
    const { provider, state } = mutableProvider([]);

    const cold = await scan(root, provider, { cacheDir });
    expect(cold.exit).toBe(0);
    state.answer = [ADVISORY];
    vi.setSystemTime(T0 + 2 * HOUR_MS);
    const later = await scan(root, provider, { cacheDir });

    expect(state.calls).toBe(2);
    expect(verdicts(later.output)).toEqual(["AFFECTED"]);
  });

  it("an entry stamped in the future is not served", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 + 48 * HOUR_MS });
    const root = projectWithLib();
    const cacheDir = tempDir("vulntrace-b3-cache-");
    const { provider, state } = mutableProvider([]);
    await scan(root, provider, { cacheDir });

    state.answer = [ADVISORY];
    vi.setSystemTime(T0);
    const earlier = await scan(root, provider, { cacheDir });

    expect(state.calls).toBe(2);
    expect(verdicts(earlier.output)).toEqual(["AFFECTED"]);
  });
});

describe("B-3 / AUD-07: the scanned project cannot supply the cached answer", () => {
  it("an empty answer planted at the old in-project location, under the exact key, is never read", async () => {
    const root = projectWithLib();
    // Written by this build's own store, so the entry is valid for the
    // build under test (a bare array on the base, an envelope after B-3):
    // the test cannot pass merely because the entry's format changed.
    new FileOsvCacheStore(path.join(root, ".vulntrace-cache", "osv")).set(
      libKey(),
      [],
    );
    const { provider, state } = mutableProvider([ADVISORY]);

    const result = await scan(root, provider);

    expect(state.calls).toBe(1);
    expect(result.exit).toBe(1);
    expect(verdicts(result.output)).toEqual(["AFFECTED"]);
  });

  it("the default cache is the user cache directory, and the scan writes nothing into the project", async () => {
    const root = projectWithLib();
    const before = filesUnder(root);
    const { provider } = mutableProvider([ADVISORY]);

    await scan(root, provider);

    expect(filesUnder(root)).toEqual(before);
    expect(filesUnder(path.join(xdgCacheHome, "vulntrace", "osv"))).toEqual([
      `${libKey()}.json`,
    ]);
  });

  it("a user cache directory inside the scanned project is refused: the scan runs uncached, with a diagnostic", async () => {
    const root = projectWithLib();
    const inside = path.join(root, "cache-home");
    process.env.XDG_CACHE_HOME = inside;
    new FileOsvCacheStore(path.join(inside, "vulntrace", "osv")).set(
      libKey(),
      [],
    );
    const { provider, state } = mutableProvider([ADVISORY]);

    const first = await scan(root, provider);
    const second = await scan(root, provider);

    expect(state.calls).toBe(2);
    expect(verdicts(first.output)).toEqual(["AFFECTED"]);
    expect(verdicts(second.output)).toEqual(["AFFECTED"]);
    expect(cacheDiagnostics(first.output)).toHaveLength(1);
    expect(cacheDiagnostics(first.output)[0]).toMatch(
      /inside the scanned project/,
    );
    expect(JSON.stringify(first.output)).not.toContain(inside);
  });

  it("a user cache directory reached through a symlink into the scanned project is refused", async () => {
    const root = projectWithLib();
    const inside = path.join(root, "cache-home");
    mkdirSync(inside);
    const link = path.join(tempDir("vulntrace-b3-link-"), "cache-home");
    symlinkSync(inside, link);
    process.env.XDG_CACHE_HOME = link;
    new FileOsvCacheStore(path.join(link, "vulntrace", "osv")).set(
      libKey(),
      [],
    );
    const { provider, state } = mutableProvider([ADVISORY]);

    const result = await scan(root, provider);

    expect(state.calls).toBe(1);
    expect(verdicts(result.output)).toEqual(["AFFECTED"]);
    expect(cacheDiagnostics(result.output)).toHaveLength(1);
  });

  it("an explicit cache directory inside the scanned project is refused the same way", async () => {
    const root = projectWithLib();
    const cacheDir = path.join(root, "my-cache");
    new FileOsvCacheStore(cacheDir).set(libKey(), []);
    const { provider, state } = mutableProvider([ADVISORY]);

    const result = await scan(root, provider, { cacheDir });

    expect(state.calls).toBe(1);
    expect(verdicts(result.output)).toEqual(["AFFECTED"]);
    expect(cacheDiagnostics(result.output)).toHaveLength(1);
  });

  it.each([
    ["a number", "5"],
    ["null", "null"],
    ["an object", "{}"],
    ["an array holding a non-record", "[5]"],
    ["a bare array of records (no envelope)", JSON.stringify([ADVISORY])],
    ["truncated JSON", '{"format":'],
    [
      "an envelope with no fetch time",
      JSON.stringify({ format: "x", key: "y", vulns: [] }),
    ],
  ])(
    "a malformed entry under the exact key (%s) is a miss: re-queried, never served or fatal",
    async (_label, content) => {
      const root = projectWithLib();
      const cacheDir = tempDir("vulntrace-b3-cache-");
      writeFileSync(path.join(cacheDir, `${libKey()}.json`), content);
      const { provider, state } = mutableProvider([ADVISORY]);

      const result = await scan(root, provider, { cacheDir });

      expect(state.calls).toBe(1);
      expect(result.exit).toBe(1);
      expect(verdicts(result.output)).toEqual(["AFFECTED"]);
    },
  );

  it("a well-formed entry written for another query is not served under this query's key", async () => {
    const root = projectWithLib();
    const cacheDir = tempDir("vulntrace-b3-cache-");
    const other = libKey("2.0.0");
    new FileOsvCacheStore(cacheDir).set(other, []);
    const written = readdirSync(cacheDir).filter((name) =>
      name.startsWith(other),
    );
    expect(written).toEqual([`${other}.json`]);
    writeFileSync(
      path.join(cacheDir, `${libKey()}.json`),
      readFileSync(path.join(cacheDir, `${other}.json`), "utf-8"),
    );
    const { provider, state } = mutableProvider([ADVISORY]);

    const result = await scan(root, provider, { cacheDir });

    expect(state.calls).toBe(1);
    expect(verdicts(result.output)).toEqual(["AFFECTED"]);
  });
});

describe("B-3 / PRM-35: a cache write failure is a diagnostic, never exit 4", () => {
  it("an unwritable cache directory leaves the uncached scan's exit code and findings, with one `cache` diagnostic", async () => {
    const root = projectWithLib({ nestedVersion: "2.0.0" });
    const notADirectory = path.join(tempDir("vulntrace-b3-file-"), "file");
    writeFileSync(notADirectory, "");
    const cacheDir = path.join(notADirectory, "osv");
    const { provider, state } = mutableProvider([ADVISORY]);

    const result = await scan(root, provider, { cacheDir });

    expect(state.calls).toBe(2);
    expect(result.exit).toBe(1);
    expect(verdicts(result.output)).toEqual(["AFFECTED", "AFFECTED"]);
    expect(result.stderr).not.toMatch(/vulnerability provider failure/);
    expect(cacheDiagnostics(result.output)).toHaveLength(1);
    expect(cacheDiagnostics(result.output)[0]).toMatch(/3 answers/);
    // The JSON output may be shared: the cache directory (a user path) and
    // the error naming it are on stderr only (B-3's audit, finding 3).
    expect(JSON.stringify(result.output)).not.toContain(notADirectory);
    expect(result.stderr).toContain(cacheDir);
  });
});
