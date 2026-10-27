import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeProject, type ProjectSpec } from "./project.js";
import {
  childEnvironment,
  harnessSourceDigest,
  realNodeCacheCounts,
  realNodeCacheMode,
  realNodeRunKey,
  runRealNode,
  runRealNodeSync,
  type RealNodeRun,
} from "./real-node-cache.js";

/**
 * BL-117 — real Node's answers cached on disk, attacked on each rule.
 *
 * A mis-keyed entry would hand a case another project's ground truth, so
 * every input a process reads must move the key: the project's bytes,
 * paths and symlinks, the arguments, the environment, the executable, a
 * `package.json` above the project. Whatever the key cannot name (a
 * `node_modules` above the project, `NODE_PATH`) must forbid caching, and
 * so must a run that did not exit by itself or that wrote into its
 * project. A served result is re-rooted to its own directory, and
 * `verify` fails on a stored result that differs from a fresh run.
 */

let root: string;
let cacheDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "vt-real-node-cache-test-"));
  cacheDir = path.join(root, "cache");
  vi.stubEnv("VT_ORACLE_NODE_CACHE_DIR", cacheDir);
  vi.stubEnv("VT_ORACLE_NODE_CACHE", "on");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** A fresh project directory named as `withTempProject` names one, under `parent`. */
function projectDir(
  spec: ProjectSpec,
  parent = path.join(root, "projects"),
): string {
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(path.join(parent, "vulntrace-oracle-"));
  writeProject(dir, spec);
  return dir;
}

function nodeRun(
  dir: string,
  script: string,
  extra?: Partial<RealNodeRun>,
): RealNodeRun {
  return {
    file: "node",
    args: ["-e", script],
    cwd: dir,
    env: childEnvironment(),
    timeoutMs: 15_000,
    stdin: "ignore",
    ...extra,
  };
}

const SPEC: ProjectSpec = {
  files: {
    "index.js": "console.log('a');\n",
    "lib/x.js": "module.exports = 1;\n",
  },
  symlinks: { "link.js": "index.js" },
};

function entries(): string[] {
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir, { recursive: true, encoding: "utf-8" }).filter(
    (f) => f.endsWith(".json"),
  );
}

describe("realNodeCacheMode", () => {
  it("is on by default, off under CI, and refuses an unknown value", () => {
    expect(realNodeCacheMode({})).toBe("on");
    expect(realNodeCacheMode({ CI: "true" })).toBe("off");
    expect(realNodeCacheMode({ CI: "false" })).toBe("on");
    expect(realNodeCacheMode({ CI: "true", VT_ORACLE_NODE_CACHE: "on" })).toBe(
      "on",
    );
    expect(realNodeCacheMode({ VT_ORACLE_NODE_CACHE: "off" })).toBe("off");
    expect(realNodeCacheMode({ VT_ORACLE_NODE_CACHE: "verify" })).toBe(
      "verify",
    );
    expect(() => realNodeCacheMode({ VT_ORACLE_NODE_CACHE: "yes" })).toThrow(
      /VT_ORACLE_NODE_CACHE/,
    );
  });
});

describe("childEnvironment", () => {
  it("keeps what Node and the fixtures read, and nothing that varies per worker, worktree or session", () => {
    const env = childEnvironment(
      { VT_SILENT: "1" },
      {
        PATH: "/bin",
        HOME: "/h",
        LC_ALL: "C",
        NODE_OPTIONS: "--x",
        VT_NEVER_SET: "y",
        VT_ORACLE_NODE_CACHE: "verify",
        VITEST_WORKER_ID: "3",
        PWD: "/repo/worktree",
        npm_config_local_prefix: "/repo/worktree",
        FORCE_COLOR: "1",
      },
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      LC_ALL: "C",
      NODE_OPTIONS: "--x",
      VT_NEVER_SET: "y",
      VT_SILENT: "1",
    });
  });

  it("is the whole environment the child sees", () => {
    vi.stubEnv("VT_BL117_PROBE", "seen");
    vi.stubEnv("BL117_NOT_KEPT", "leaked");
    const dir = projectDir({ files: {} });
    const result = runRealNodeSync(
      nodeRun(
        dir,
        "console.log(JSON.stringify([process.env.VT_BL117_PROBE, process.env.BL117_NOT_KEPT, process.env.VT_ORACLE_NODE_CACHE]))",
      ),
    );
    expect(JSON.parse(result.stdout)).toEqual(["seen", null, null]);
  });
});

describe("realNodeRunKey: every input moves the key", () => {
  const SCRIPT = "console.log(1)";

  it("is the same for the same bytes in two directories, whatever their random names", () => {
    expect(realNodeRunKey(nodeRun(projectDir(SPEC), SCRIPT))).toBe(
      realNodeRunKey(nodeRun(projectDir(SPEC), SCRIPT)),
    );
  });

  it("moves with one byte of a file, a file's path, an added file, a symlink's target and a mode", () => {
    const base = realNodeRunKey(nodeRun(projectDir(SPEC), SCRIPT));
    const variants: ProjectSpec[] = [
      { ...SPEC, files: { ...SPEC.files, "index.js": "console.log('b');\n" } },
      {
        ...SPEC,
        files: {
          "index.js": SPEC.files["index.js"]!,
          "lib/y.js": "module.exports = 1;\n",
        },
      },
      { ...SPEC, files: { ...SPEC.files, "extra.js": "" } },
      { ...SPEC, symlinks: { "link.js": "lib/x.js" } },
      { files: SPEC.files },
    ];
    const keys = variants.map((spec) =>
      realNodeRunKey(nodeRun(projectDir(spec), SCRIPT)),
    );
    const modeDir = projectDir(SPEC);
    chmodSync(path.join(modeDir, "index.js"), 0o755);
    keys.push(realNodeRunKey(nodeRun(modeDir, SCRIPT)));
    for (const key of keys) expect(key).toBeDefined();
    expect(new Set([base, ...keys]).size).toBe(keys.length + 1);
  });

  it("moves with the arguments, the environment, the stdin mode and the timeout", () => {
    const dir = projectDir(SPEC);
    const base = realNodeRunKey(nodeRun(dir, SCRIPT));
    const keys = [
      realNodeRunKey(nodeRun(dir, "console.log(2)")),
      realNodeRunKey(
        nodeRun(dir, SCRIPT, { env: childEnvironment({ VT_SILENT: "1" }) }),
      ),
      realNodeRunKey(nodeRun(dir, SCRIPT, { stdin: "pipe" })),
      realNodeRunKey(nodeRun(dir, SCRIPT, { timeoutMs: 10_000 })),
    ];
    expect(new Set([base, ...keys]).size).toBe(5);
  });

  it("is undefined for any executable but the Node running this process, a shim on PATH included (key review F4)", () => {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const shim = path.join(bin, "node");
    writeFileSync(
      shim,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    );
    chmodSync(shim, 0o755);
    const dir = projectDir(SPEC);
    expect(
      realNodeRunKey(
        nodeRun(dir, SCRIPT, { env: { ...childEnvironment(), PATH: bin } }),
      ),
    ).toBeUndefined();
    expect(
      realNodeRunKey(nodeRun(dir, SCRIPT, { file: shim })),
    ).toBeUndefined();
    const link = path.join(root, "link");
    mkdirSync(link);
    symlinkSync(process.execPath, path.join(link, "node"));
    expect(
      realNodeRunKey(
        nodeRun(dir, SCRIPT, { env: { ...childEnvironment(), PATH: link } }),
      ),
    ).toBeDefined();
  });

  it("is undefined when a Node variable but NODE_ENV is set: it may name a file outside the key (key review F3)", () => {
    const dir = projectDir(SPEC);
    for (const [name, value] of [
      ["NODE_OPTIONS", "--require /x/hook.js"],
      ["NODE_ICU_DATA", "/x"],
      ["NODE_PATH", "/x"],
      ["UV_THREADPOOL_SIZE", "2"],
    ]) {
      expect(
        realNodeRunKey(
          nodeRun(dir, SCRIPT, {
            env: { ...childEnvironment(), [name!]: value! },
          }),
        ),
        name,
      ).toBeUndefined();
    }
    const plain = realNodeRunKey(nodeRun(dir, SCRIPT));
    const nodeEnv = realNodeRunKey(
      nodeRun(dir, SCRIPT, {
        env: { ...childEnvironment(), NODE_ENV: "bl117" },
      }),
    );
    expect(nodeEnv).toBeDefined();
    expect(nodeEnv).not.toBe(plain);
  });

  it("no file's bytes can imitate the entries after it (key review F1)", () => {
    const probe = projectDir({ files: { a: "" } });
    const mode = String(statSync(path.join(probe, "a")).mode);
    const index = 'console.log(require("fs").readdirSync(".").join(","))';
    const y = projectDir({
      files: { a: "hello", b: "world", "index.js": index },
    });
    const x = projectDir({
      files: { a: `hello\0F\0b\0${mode}\0world`, "index.js": index },
    });
    expect(realNodeRunKey(nodeRun(x, SCRIPT))).not.toBe(
      realNodeRunKey(nodeRun(y, SCRIPT)),
    );
  });

  it("moves with the harness's own source, and not with its tests", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const copy = path.join(root, "harness");
    mkdirSync(copy);
    for (const name of readdirSync(here)) {
      if (name.endsWith(".ts"))
        copyFileSync(path.join(here, name), path.join(copy, name));
    }
    const base = harnessSourceDigest(copy);
    expect(base).toBe(harnessSourceDigest(here));
    writeFileSync(path.join(copy, "extra.test.ts"), "// a test\n");
    expect(harnessSourceDigest(copy)).toBe(base);
    // One byte flipped, the length kept.
    const bytes = readFileSync(path.join(copy, "hit.ts"));
    bytes[0] = bytes[0]! ^ 1;
    writeFileSync(path.join(copy, "hit.ts"), bytes);
    expect(harnessSourceDigest(copy)).not.toBe(base);
  });

  it("moves with a package.json above the project, by its bytes", () => {
    const parent = path.join(root, "above");
    const before = realNodeRunKey(nodeRun(projectDir(SPEC, parent), SCRIPT));
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    const cjs = realNodeRunKey(nodeRun(projectDir(SPEC, parent), SCRIPT));
    writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}');
    const esm = realNodeRunKey(nodeRun(projectDir(SPEC, parent), SCRIPT));
    expect(new Set([before, cjs, esm]).size).toBe(3);
  });

  it("is undefined when a node_modules above the project, NODE_PATH or the directory's own name is in reach", () => {
    const parent = path.join(root, "nm");
    const clean = projectDir(SPEC, parent);
    expect(realNodeRunKey(nodeRun(clean, SCRIPT))).toBeDefined();
    mkdirSync(path.join(root, "node_modules"));
    expect(realNodeRunKey(nodeRun(clean, SCRIPT))).toBeUndefined();
    rmSync(path.join(root, "node_modules"), { recursive: true });
    expect(
      realNodeRunKey(
        nodeRun(clean, SCRIPT, {
          env: { ...childEnvironment(), NODE_PATH: "/x" },
        }),
      ),
    ).toBeUndefined();
    writeFileSync(path.join(clean, "names-itself.js"), path.basename(clean));
    expect(realNodeRunKey(nodeRun(clean, SCRIPT))).toBeUndefined();
  });

  it("is undefined when the kernel resolves a link outside the project though its spelling stays inside, or a link dangles (key review F2)", () => {
    expect(
      realNodeRunKey(
        nodeRun(
          projectDir({
            files: { "index.js": "" },
            symlinks: { d: ".", "e.js": "d/../outside.js" },
          }),
          SCRIPT,
        ),
      ),
    ).toBeUndefined();
    expect(
      realNodeRunKey(
        nodeRun(
          projectDir({ files: {}, symlinks: { "x.js": "missing.js" } }),
          SCRIPT,
        ),
      ),
    ).toBeUndefined();
  });

  it("is undefined when a symlink in the project points outside it, where the fingerprint does not reach", () => {
    expect(
      realNodeRunKey(
        nodeRun(projectDir({ ...SPEC, symlinks: { dep: "../../.." } }), SCRIPT),
      ),
    ).toBeUndefined();
    expect(
      realNodeRunKey(
        nodeRun(
          projectDir({ ...SPEC, symlinks: { dep: os.tmpdir() } }),
          SCRIPT,
        ),
      ),
    ).toBeUndefined();
    expect(
      realNodeRunKey(
        nodeRun(
          projectDir({ ...SPEC, symlinks: { "a/b/dep": "../../lib" } }),
          SCRIPT,
        ),
      ),
    ).toBeDefined();
  });
});

describe("realNodeRunKey: key review, round 2", () => {
  const SCRIPT = "console.log(1)";

  it("walks the real path above the project as well as the spelled one, and keys both parents (N1)", () => {
    const real = path.join(root, "real");
    mkdirSync(path.join(real, "sub"), { recursive: true });
    const spelled = path.join(root, "tmplink");
    symlinkSync(path.join(real, "sub"), spelled);
    const viaLink = (): string | undefined =>
      realNodeRunKey(nodeRun(projectDir(SPEC, spelled), SCRIPT));
    const direct = realNodeRunKey(
      nodeRun(projectDir(SPEC, path.join(real, "sub")), SCRIPT),
    );
    const before = viaLink();
    expect(before).toBeDefined();
    expect(before).not.toBe(direct);
    writeFileSync(path.join(real, "package.json"), '{"type":"module"}');
    const withManifest = viaLink();
    expect(withManifest).toBeDefined();
    expect(withManifest).not.toBe(before);
    rmSync(path.join(real, "package.json"));
    // The same spelled parent, another real one: a printed `__filename`
    // names the real parent, which re-rooting does not rewrite.
    mkdirSync(path.join(real, "other"));
    rmSync(spelled);
    symlinkSync(path.join(real, "other"), spelled);
    expect(viaLink()).not.toBe(before);
    mkdirSync(path.join(real, "node_modules"));
    expect(viaLink()).toBeUndefined();
  });

  it("keys the libraries Node reports in process.versions (U2)", () => {
    const dir = projectDir(SPEC);
    const before = realNodeRunKey(nodeRun(dir, SCRIPT));
    const saved = process.versions;
    try {
      Object.defineProperty(process, "versions", {
        value: { ...saved, icu: `${String(saved.icu)}-other` },
        configurable: true,
      });
      expect(realNodeRunKey(nodeRun(dir, SCRIPT))).not.toBe(before);
    } finally {
      Object.defineProperty(process, "versions", {
        value: saved,
        configurable: true,
      });
    }
  });

  it.skipIf(process.platform === "win32")(
    "is undefined when the project holds a FIFO, whose content is not named (U3)",
    () => {
      const dir = projectDir(SPEC);
      execFileSync("mkfifo", [path.join(dir, "pipe")]);
      expect(realNodeRunKey(nodeRun(dir, SCRIPT))).toBeUndefined();
    },
  );
});

describe("runRealNodeSync and runRealNode", () => {
  const PRINTS_ITS_DIRECTORY =
    "console.log(require('path').basename(process.cwd())); process.stderr.write('e:' + require('path').basename(process.cwd())); process.exitCode = 3";

  for (const [name, run] of [
    ["sync", (r: RealNodeRun) => Promise.resolve(runRealNodeSync(r))],
    ["async", runRealNode],
  ] as const) {
    it(`${name}: stores a run, then serves it re-rooted to the new directory`, async () => {
      const first = projectDir(SPEC);
      const second = projectDir(SPEC);
      const fresh = await run(
        nodeRun(first, PRINTS_ITS_DIRECTORY, { stdin: "pipe" }),
      );
      expect(fresh).toMatchObject({ status: 3, cached: false });
      expect(fresh.stdout.trim()).toBe(path.basename(first));
      expect(entries()).toHaveLength(1);
      const served = await run(
        nodeRun(second, PRINTS_ITS_DIRECTORY, { stdin: "pipe" }),
      );
      expect(served).toMatchObject({ status: 3, signal: null, cached: true });
      expect(served.stdout.trim()).toBe(path.basename(second));
      expect(served.stderr).toBe(`e:${path.basename(second)}`);
    });

    it(`${name}: stores nothing for a timeout`, async () => {
      const result = await run(
        nodeRun(projectDir(SPEC), "setTimeout(() => {}, 10000)", {
          timeoutMs: 300,
          stdin: "pipe",
        }),
      );
      expect(result.status).toBeNull();
      expect(result.signal).not.toBeNull();
      expect(entries()).toEqual([]);
    });
  }

  it("stores nothing for a run that writes into its project, and runs it again next time", () => {
    const script =
      "require('fs').writeFileSync('out.txt', 'x'); console.log('wrote')";
    const first = projectDir(SPEC);
    expect(runRealNodeSync(nodeRun(first, script)).cached).toBe(false);
    expect(entries()).toEqual([]);
    const second = projectDir(SPEC);
    expect(runRealNodeSync(nodeRun(second, script)).cached).toBe(false);
    expect(existsSync(path.join(second, "out.txt"))).toBe(true);
  });

  it("stores nothing for a run after which a folder above the project reads differently (U1)", () => {
    const script =
      "require('fs').writeFileSync('../package.json', '{\"type\":\"module\"}'); console.log('wrote above')";
    const dir = projectDir(SPEC);
    expect(runRealNodeSync(nodeRun(dir, script)).cached).toBe(false);
    expect(existsSync(path.join(path.dirname(dir), "package.json"))).toBe(true);
    expect(entries()).toEqual([]);
  });

  it("off: runs every time and writes no entry", () => {
    vi.stubEnv("VT_ORACLE_NODE_CACHE", "off");
    expect(
      runRealNodeSync(nodeRun(projectDir(SPEC), "console.log(1)")).cached,
    ).toBe(false);
    expect(
      runRealNodeSync(nodeRun(projectDir(SPEC), "console.log(1)")).cached,
    ).toBe(false);
    expect(existsSync(cacheDir)).toBe(false);
  });

  it("verify: runs anyway, and fails on a stored result that differs from the fresh one", () => {
    const script = "console.log('truth')";
    runRealNodeSync(nodeRun(projectDir(SPEC), script));
    const [entry] = entries();
    vi.stubEnv("VT_ORACLE_NODE_CACHE", "verify");
    const before = realNodeCacheCounts().verified;
    const verified = runRealNodeSync(nodeRun(projectDir(SPEC), script));
    expect(verified.cached).toBe(false);
    expect(realNodeCacheCounts().verified).toBe(before + 1);
    const file = path.join(cacheDir, entry!);
    const stored = JSON.parse(readFileSync(file, "utf-8")) as {
      stdout: string;
    };
    stored.stdout = "a planted answer\n";
    writeFileSync(file, JSON.stringify(stored));
    expect(() => runRealNodeSync(nodeRun(projectDir(SPEC), script))).toThrow(
      /verify mode.*differs from its stored result/,
    );
  });

  it("verify: a Node warning's process ID is not a difference", () => {
    const script = 'process.emitWarning("bl117"); console.log("truth")';
    const first = runRealNodeSync(nodeRun(projectDir(SPEC), script));
    expect(first.stderr).toMatch(/\(node:\d+\) Warning: bl117/);
    vi.stubEnv("VT_ORACLE_NODE_CACHE", "verify");
    expect(runRealNodeSync(nodeRun(projectDir(SPEC), script)).stdout).toBe(
      "truth\n",
    );
  });

  it("an entry that is not well-formed, or is stored under another key, is never served", () => {
    const script = "console.log('truth')";
    runRealNodeSync(nodeRun(projectDir(SPEC), script));
    const file = path.join(cacheDir, entries()[0]!);
    const stored = JSON.parse(readFileSync(file, "utf-8")) as Record<
      string,
      unknown
    >;
    for (const planted of [
      "{",
      JSON.stringify({ ...stored, key: "0".repeat(64), stdout: "planted\n" }),
      JSON.stringify({ ...stored, status: null, stdout: "planted\n" }),
      JSON.stringify({ ...stored, format: 0, stdout: "planted\n" }),
    ]) {
      writeFileSync(file, planted);
      const result = runRealNodeSync(nodeRun(projectDir(SPEC), script));
      expect(result.cached).toBe(false);
      expect(result.stdout).toBe("truth\n");
    }
  });
});

describe("the harness's every real-Node process goes through this module", () => {
  it("no other non-test module of src/testing/oracle/ imports node:child_process", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const spawning = readdirSync(here)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) =>
        /from "(node:)?child_process"/.test(
          readFileSync(path.join(here, name), "utf-8"),
        ),
      );
    expect(spawning).toEqual(["real-node-cache.ts"]);
  });
});
