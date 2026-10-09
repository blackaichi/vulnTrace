import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTsProject } from "./ts-project.js";
import { createModuleResolver } from "./module-resolver.js";

/**
 * Task C-1 (docs/tasks/C-1-runtime-resolution-mode.md): ADR 0010
 * invariant C2 at the resolver. "Every resolution that decides which file
 * Node loads uses Node's algorithm, whatever the project's tsconfig says";
 * a tsconfig `paths` / `baseUrl` mapping that disagrees with Node makes the
 * specifier unresolved (§ 3; REMEDIATION-PLAN § 6.1 decision 7).
 *
 * Ground truth is real `node`, run on the same files. The end-to-end
 * verdicts are tests/oracle/c1-runtime-resolution.test.ts; the options
 * authority itself (no resolution reads the tsconfig's mode) is the
 * Foundation census, src/testing/runtime-resolution-census.test.ts.
 */

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-c1-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
}

/** What real `node` prints for `src/index.js`, or the error code it throws. */
function realNode(root: string): string {
  try {
    return execFileSync("node", [path.join(root, "src", "index.js")], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    return `THROWS ${/code: '(\w+)'/.exec(stderr)?.[1] ?? "?"}`;
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * PRM-33's package: `main` is `legacy.js`, the `exports` map's `require`
 * target is `cjs/impl.cjs`. Each file prints which one it is.
 */
const PRM33_FILES: Readonly<Record<string, string>> = {
  "node_modules/wrap/package.json": JSON.stringify({
    name: "wrap",
    version: "1.0.0",
    main: "./legacy.js",
    exports: { ".": { require: "./cjs/impl.cjs" } },
  }),
  "node_modules/wrap/legacy.js": `exports.which = "legacy";\n`,
  "node_modules/wrap/cjs/impl.cjs": `exports.which = "impl";\n`,
  "src/index.js": `console.log(require("wrap").which);\n`,
};

/** ADR 0010 § 1, C2's mechanically checkable table. */
const MODULES = [
  "commonjs",
  "es2015",
  "es2020",
  "es2022",
  "esnext",
  "node16",
  "nodenext",
  "preserve",
] as const;
const MODULE_RESOLUTIONS = [
  undefined,
  "node10",
  "node16",
  "nodenext",
  "bundler",
] as const;
const TABLE = MODULES.flatMap((module) =>
  MODULE_RESOLUTIONS.map((moduleResolution) => ({ module, moduleResolution })),
);

describe("C2: the resolution-mode table (ADR 0010 § 1)", () => {
  it("covers every module x moduleResolution pair: 40 tsconfigs", () => {
    expect(TABLE).toHaveLength(40);
  });

  it.each(TABLE)(
    "module $module, moduleResolution $moduleResolution: the file real node loads",
    async ({ module, moduleResolution }) => {
      const root = tempProject();
      write(root, {
        ...PRM33_FILES,
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            allowJs: true,
            module,
            ...(moduleResolution !== undefined ? { moduleResolution } : {}),
          },
        }),
      });
      expect(realNode(root), "real node's ground truth").toBe("impl");

      const resolver = createModuleResolver(loadTsProject(root));
      const result = await resolver.resolve(
        "wrap",
        path.join(root, "src", "index.js"),
      );

      expect(result).toMatchObject({
        kind: "resolved",
        resolvedFileName: path.join(root, "node_modules/wrap/cjs/impl.cjs"),
      });
    },
  );
});

describe("C2: a tsconfig paths / baseUrl mapping is checked against Node", () => {
  it("a paths entry shadowing an installed package is unresolved, naming both answers (RWF-083)", async () => {
    const root = tempProject();
    write(root, {
      "node_modules/wrap/package.json": JSON.stringify({
        name: "wrap",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/wrap/index.js": `exports.which = "node_modules";\n`,
      "src/shim/wrap.js": `exports.which = "shim";\n`,
      "src/index.js": `console.log(require("wrap").which);\n`,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          allowJs: true,
          module: "nodenext",
          baseUrl: ".",
          paths: { wrap: ["src/shim/wrap.js"] },
        },
      }),
    });
    expect(realNode(root)).toBe("node_modules");

    const result = await createModuleResolver(loadTsProject(root)).resolve(
      "wrap",
      path.join(root, "src", "index.js"),
    );

    expect(result.kind).toBe("unresolved");
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain(path.join(root, "node_modules/wrap/index.js"));
    expect(reason).toContain(path.join(root, "src/shim/wrap.js"));
  });

  it("a bare baseUrl shadowing an installed package is unresolved (RWF-083)", async () => {
    const root = tempProject();
    write(root, {
      "node_modules/lib/package.json": JSON.stringify({
        name: "lib",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/lib/index.js": `exports.which = "node_modules";\n`,
      "src/lib/index.js": `exports.which = "baseUrl";\n`,
      "src/index.js": `console.log(require("lib").which);\n`,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          allowJs: true,
          module: "commonjs",
          moduleResolution: "node10",
          baseUrl: "./src",
        },
      }),
    });
    expect(realNode(root)).toBe("node_modules");

    const result = await createModuleResolver(loadTsProject(root)).resolve(
      "lib",
      path.join(root, "src", "index.js"),
    );

    expect(result.kind).toBe("unresolved");
  });

  it("a paths alias Node cannot resolve at all is unresolved, never the mapped file", async () => {
    const root = tempProject();
    write(root, {
      "src/lib/wrapper.js": `exports.which = "alias";\n`,
      "src/index.js": `console.log(require("@lib/wrapper.js").which);\n`,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          allowJs: true,
          module: "nodenext",
          baseUrl: ".",
          paths: { "@lib/*": ["src/lib/*"] },
        },
      }),
    });
    expect(realNode(root)).toBe("THROWS MODULE_NOT_FOUND");

    const result = await createModuleResolver(loadTsProject(root)).resolve(
      "@lib/wrapper.js",
      path.join(root, "src", "index.js"),
    );

    expect(result.kind).toBe("unresolved");
    expect((result as { reason: string }).reason).toContain(
      path.join(root, "src/lib/wrapper.js"),
    );
  });

  it("a mapping that names the file Node loads stays resolved (precision control)", async () => {
    const root = tempProject();
    write(root, {
      "node_modules/wrap/package.json": JSON.stringify({
        name: "wrap",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/wrap/index.js": `exports.which = "node_modules";\n`,
      "src/index.js": `console.log(require("wrap").which);\n`,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          allowJs: true,
          module: "nodenext",
          baseUrl: ".",
          paths: { wrap: ["node_modules/wrap/index.js"] },
        },
      }),
    });
    expect(realNode(root)).toBe("node_modules");

    const result = await createModuleResolver(loadTsProject(root)).resolve(
      "wrap",
      path.join(root, "src", "index.js"),
    );

    expect(result).toMatchObject({
      kind: "resolved",
      resolvedFileName: path.join(root, "node_modules/wrap/index.js"),
    });
  });

  it("a relative specifier a baseUrl does not touch stays resolved (precision control)", async () => {
    const root = tempProject();
    write(root, {
      "src/util.js": `exports.which = "util";\n`,
      "src/index.js": `console.log(require("./util").which);\n`,
      "tsconfig.json": JSON.stringify({
        compilerOptions: { allowJs: true, module: "commonjs", baseUrl: "." },
      }),
    });
    expect(realNode(root)).toBe("util");

    const result = await createModuleResolver(loadTsProject(root)).resolve(
      "./util",
      path.join(root, "src", "index.js"),
    );

    expect(result).toMatchObject({
      kind: "resolved",
      resolvedFileName: path.join(root, "src/util.js"),
    });
  });
});

describe("C2: the declaration-only fallback never reads main for a package with exports", () => {
  it("a types-only exports map is declaration-only, never main's file", async () => {
    const root = tempProject();
    write(root, {
      "node_modules/p/package.json": JSON.stringify({
        name: "p",
        version: "1.0.0",
        main: "./lib/legacy.js",
        exports: { ".": { types: "./index.d.ts" } },
      }),
      "node_modules/p/index.d.ts": `export declare const which: string;\n`,
      "node_modules/p/lib/legacy.js": `exports.which = "legacy";\n`,
      "src/index.js": `console.log(require("p").which);\n`,
    });
    // Node never consults `main` once `exports` exists: no condition
    // matches, so the load fails.
    expect(realNode(root)).toBe("THROWS ERR_PACKAGE_PATH_NOT_EXPORTED");

    const result = await createModuleResolver(loadTsProject(root)).resolve(
      "p",
      path.join(root, "src", "index.js"),
    );

    expect(result).toMatchObject({
      kind: "declaration",
      resolvedFileName: path.join(root, "node_modules/p/index.d.ts"),
    });
  });
});
