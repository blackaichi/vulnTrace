import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CacheLocationEnvironment,
  defaultOsvCacheDir,
  isCacheDirInsideProject,
} from "./cache-location.js";

/**
 * Task B-3 (AUD-07, decision 8): the OSV cache is the user's, never the
 * scanned project's. Before B-3 it defaulted to
 * `<project>/.vulntrace-cache/osv`, and a committed `[]` under the exact
 * key suppressed every advisory for that query.
 */

function environment(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = "linux",
  home = "/home/user",
): CacheLocationEnvironment {
  return { env, platform, homedir: () => home };
}

describe("defaultOsvCacheDir", () => {
  it("uses an absolute XDG_CACHE_HOME", () => {
    expect(defaultOsvCacheDir(environment({ XDG_CACHE_HOME: "/var/c" }))).toBe(
      "/var/c/vulntrace/osv",
    );
  });

  it.each(["relative/cache", "./cache", ""])(
    "ignores a non-absolute XDG_CACHE_HOME (%j) and falls back to ~/.cache",
    (xdg) => {
      expect(defaultOsvCacheDir(environment({ XDG_CACHE_HOME: xdg }))).toBe(
        "/home/user/.cache/vulntrace/osv",
      );
    },
  );

  it("falls back to ~/.cache when XDG_CACHE_HOME is unset", () => {
    expect(defaultOsvCacheDir(environment({}))).toBe(
      "/home/user/.cache/vulntrace/osv",
    );
  });

  it("uses %LOCALAPPDATA% on Windows", () => {
    expect(
      defaultOsvCacheDir(
        environment(
          { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
          "win32",
          "C:\\Users\\u",
        ),
      ),
    ).toBe("C:\\Users\\u\\AppData\\Local\\vulntrace\\osv");
  });

  it("falls back to the home directory on Windows without %LOCALAPPDATA%", () => {
    expect(defaultOsvCacheDir(environment({}, "win32", "C:\\Users\\u"))).toBe(
      "C:\\Users\\u\\.cache\\vulntrace\\osv",
    );
  });

  it.each(["", "relative-home"])(
    "is undefined when no absolute base can be determined (home %j): a relative one would resolve against the working directory",
    (home) => {
      expect(
        defaultOsvCacheDir(environment({}, "linux", home)),
      ).toBeUndefined();
    },
  );

  it("is undefined when the home directory cannot be read", () => {
    expect(
      defaultOsvCacheDir({
        env: {},
        platform: "linux",
        homedir: () => {
          throw new Error("no home");
        },
      }),
    ).toBeUndefined();
  });
});

describe("isCacheDirInsideProject", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "vulntrace-cache-location-"));
    dirs.push(dir);
    return dir;
  }

  it("is true for the base's default, `<project>/.vulntrace-cache/osv`, created or not", () => {
    const project = tempDir();

    expect(
      isCacheDirInsideProject(
        path.join(project, ".vulntrace-cache", "osv"),
        project,
      ),
    ).toBe(true);
    mkdirSync(path.join(project, ".vulntrace-cache", "osv"), {
      recursive: true,
    });
    expect(
      isCacheDirInsideProject(
        path.join(project, ".vulntrace-cache", "osv"),
        project,
      ),
    ).toBe(true);
  });

  it("is true for the project root itself", () => {
    const project = tempDir();

    expect(isCacheDirInsideProject(project, project)).toBe(true);
  });

  it("is false for a sibling directory, including one whose name extends the project's", () => {
    const parent = tempDir();
    const project = path.join(parent, "app");
    mkdirSync(project);

    expect(
      isCacheDirInsideProject(path.join(parent, "app-cache", "osv"), project),
    ).toBe(false);
    expect(isCacheDirInsideProject(path.join(parent, "other"), project)).toBe(
      false,
    );
  });

  it("is false for a parent of the project", () => {
    const parent = tempDir();
    const project = path.join(parent, "app");
    mkdirSync(project);

    expect(isCacheDirInsideProject(parent, project)).toBe(false);
  });

  it("is true for a path that reaches into the project through a symlink", () => {
    const project = tempDir();
    mkdirSync(path.join(project, "inside"));
    const link = path.join(tempDir(), "link");
    symlinkSync(path.join(project, "inside"), link);

    expect(isCacheDirInsideProject(path.join(link, "osv"), project)).toBe(true);
  });

  it("is true when the project is reached through a symlink and the cache through its real path", () => {
    const real = tempDir();
    const link = path.join(tempDir(), "project-link");
    symlinkSync(real, link);

    expect(isCacheDirInsideProject(path.join(real, "c"), link)).toBe(true);
  });

  it("fails closed (true) for a path through a dangling symlink, whatever it would point to", () => {
    const project = tempDir();
    const link = path.join(tempDir(), "dangling");
    symlinkSync(path.join(project, "not-yet"), link);

    expect(isCacheDirInsideProject(path.join(link, "osv"), project)).toBe(true);
  });

  it("fails closed (true) when the project root cannot be resolved", () => {
    const parent = tempDir();

    expect(
      isCacheDirInsideProject(
        path.join(parent, "cache"),
        path.join(parent, "missing"),
      ),
    ).toBe(true);
  });
});
