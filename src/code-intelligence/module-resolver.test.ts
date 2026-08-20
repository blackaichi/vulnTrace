import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTsProject } from "./ts-project.js";
import { createModuleResolver } from "./module-resolver.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-resolver-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("createModuleResolver: relative imports", () => {
  it("resolves a relative specifier to a sibling file", async () => {
    const root = tempProject();
    write(root, "src/index.ts", "export {};\n");
    const utilPath = write(root, "src/util.ts", "export const x = 1;\n");

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve(
      "./util",
      path.join(root, "src", "index.ts"),
    );

    expect(result).toMatchObject({
      kind: "resolved",
      resolvedFileName: utilPath,
      isExternalLibraryImport: false,
    });
  });
});

describe("createModuleResolver: package imports", () => {
  it("resolves a bare package specifier via package.json main", async () => {
    const root = tempProject();
    write(root, "src/index.ts", "export {};\n");
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0", main: "lib/index.js" }),
    );
    const mainFile = write(
      root,
      "node_modules/foo/lib/index.js",
      "module.exports = {};\n",
    );

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve(
      "foo",
      path.join(root, "src", "index.ts"),
    );

    expect(result).toMatchObject({
      kind: "resolved",
      resolvedFileName: mainFile,
      isExternalLibraryImport: true,
      packageId: { name: "foo", version: "1.0.0" },
    });
  });

  it("resolves a deep package subpath when the package has no exports field (legacy resolution)", async () => {
    const root = tempProject();
    write(root, "src/index.ts", "export {};\n");
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0", main: "index.js" }),
    );
    write(root, "node_modules/foo/index.js", "module.exports = {};\n");
    const deepFile = write(
      root,
      "node_modules/foo/lib/deep.js",
      "module.exports = {};\n",
    );

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve(
      "foo/lib/deep",
      path.join(root, "src", "index.ts"),
    );

    expect(result).toMatchObject({
      kind: "resolved",
      resolvedFileName: deepFile,
    });
  });
});

describe("createModuleResolver: package.json exports", () => {
  it("resolves the root export via a simple string exports field", async () => {
    const root = tempProject();
    write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      }),
    );
    write(root, "src/index.ts", "export {};\n");
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0", exports: "./index.js" }),
    );
    const indexFile = write(
      root,
      "node_modules/foo/index.js",
      "module.exports = {};\n",
    );

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve(
      "foo",
      path.join(root, "src", "index.ts"),
    );

    expect(result).toMatchObject({
      kind: "resolved",
      resolvedFileName: indexFile,
    });
  });

  it("restricts subpath access when exports only declares the root", async () => {
    const root = tempProject();
    write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      }),
    );
    write(root, "src/index.ts", "export {};\n");
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0", exports: "./index.js" }),
    );
    write(root, "node_modules/foo/index.js", "module.exports = {};\n");
    // Present on disk, but NOT reachable: the exports field restricts
    // package consumers to only what it explicitly lists (unlike legacy
    // main-based resolution, which allows any subpath that exists).
    write(root, "node_modules/foo/secret.js", "module.exports = {};\n");

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve(
      "foo/secret",
      path.join(root, "src", "index.ts"),
    );

    expect(result.kind).toBe("unresolved");
  });

  it("resolves a declared subpath export", async () => {
    const root = tempProject();
    write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      }),
    );
    write(root, "src/index.ts", "export {};\n");
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({
        name: "foo",
        version: "1.0.0",
        exports: { ".": "./index.js", "./feature": "./lib/feature.js" },
      }),
    );
    write(root, "node_modules/foo/index.js", "module.exports = {};\n");
    const featureFile = write(
      root,
      "node_modules/foo/lib/feature.js",
      "module.exports = {};\n",
    );

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve(
      "foo/feature",
      path.join(root, "src", "index.ts"),
    );

    expect(result).toMatchObject({
      kind: "resolved",
      resolvedFileName: featureFile,
    });
  });
});

describe("createModuleResolver: ESM/CJS boundary via conditional exports", () => {
  function setUpConditionalPackage(root: string): { esm: string; cjs: string } {
    write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      }),
    );
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({
        name: "foo",
        version: "1.0.0",
        exports: {
          ".": { import: "./esm/index.js", require: "./cjs/index.js" },
        },
      }),
    );
    const esm = write(root, "node_modules/foo/esm/index.js", "export {};\n");
    const cjs = write(
      root,
      "node_modules/foo/cjs/index.js",
      "module.exports = {};\n",
    );
    return { esm, cjs };
  }

  it("picks the 'import' condition for an ESM importer (.mts)", async () => {
    const root = tempProject();
    const { esm } = setUpConditionalPackage(root);
    const importer = write(root, "src/index.mts", "export {};\n");

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve("foo", importer);

    expect(result).toMatchObject({ kind: "resolved", resolvedFileName: esm });
  });

  it("picks the 'require' condition for a CommonJS importer (.cts)", async () => {
    const root = tempProject();
    const { cjs } = setUpConditionalPackage(root);
    const importer = write(root, "src/index.cts", "export {};\n");

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve("foo", importer);

    expect(result).toMatchObject({ kind: "resolved", resolvedFileName: cjs });
  });

  it("picks the 'import' condition for a .ts file in a package.json type:module package", async () => {
    const root = tempProject();
    const { esm } = setUpConditionalPackage(root);
    write(root, "package.json", JSON.stringify({ type: "module" }));
    const importer = write(root, "src/index.ts", "export {};\n");

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve("foo", importer);

    expect(result).toMatchObject({ kind: "resolved", resolvedFileName: esm });
  });

  it("picks the 'require' condition for a .ts file with no package.json type (CJS default)", async () => {
    const root = tempProject();
    const { cjs } = setUpConditionalPackage(root);
    const importer = write(root, "src/index.ts", "export {};\n");

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve("foo", importer);

    expect(result).toMatchObject({ kind: "resolved", resolvedFileName: cjs });
  });
});

describe("createModuleResolver: TypeScript path mapping", () => {
  it("resolves an aliased specifier via baseUrl + paths", async () => {
    const root = tempProject();
    write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@app/*": ["src/*"] },
        },
      }),
    );
    const utilPath = write(root, "src/util.ts", "export const x = 1;\n");
    write(root, "src/index.ts", "export {};\n");

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve(
      "@app/util",
      path.join(root, "src", "index.ts"),
    );

    expect(result).toMatchObject({
      kind: "resolved",
      resolvedFileName: utilPath,
    });
  });
});

describe("createModuleResolver: declaration vs. runtime resolution (VT-304, RWF-005/R-4)", () => {
  it("prefers a sibling runtime implementation over the package's own .d.ts (trim-newlines shape)", async () => {
    const root = tempProject();
    write(root, "src/index.js", "export {};\n");
    // No "main" field at all -- mirrors the real trim-newlines@3.0.0
    // package.json, which relies on Node's implicit "./index.js" default.
    write(
      root,
      "node_modules/decl-and-runtime/package.json",
      JSON.stringify({ name: "decl-and-runtime", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/decl-and-runtime/index.d.ts",
      "export declare function vulnerable(x: string): string;\n",
    );
    const runtimeFile = write(
      root,
      "node_modules/decl-and-runtime/index.js",
      "module.exports = { vulnerable(x) { return x; } };\n",
    );

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve(
      "decl-and-runtime",
      path.join(root, "src", "index.js"),
    );

    expect(result).toMatchObject({
      kind: "resolved",
      resolvedFileName: runtimeFile,
    });
  });

  it("returns declaration-only, never a fabricated runtime file, for a types-only package", async () => {
    const root = tempProject();
    write(root, "src/index.ts", "export {};\n");
    write(
      root,
      "node_modules/types-only/package.json",
      JSON.stringify({ name: "types-only", version: "1.0.0" }),
    );
    const declFile = write(
      root,
      "node_modules/types-only/index.d.ts",
      "export declare function vulnerable(x: string): string;\n",
    );

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve(
      "types-only",
      path.join(root, "src", "index.ts"),
    );

    expect(result).toMatchObject({
      kind: "declaration",
      resolvedFileName: declFile,
    });
  });

  it("uses the real runtime package when the original specifier also resolves to a separate @types/* declaration", async () => {
    const root = tempProject();
    write(root, "src/index.ts", "export {};\n");
    write(
      root,
      "node_modules/has-types-pkg/package.json",
      JSON.stringify({
        name: "has-types-pkg",
        version: "1.0.0",
        main: "index.js",
      }),
    );
    const runtimeFile = write(
      root,
      "node_modules/has-types-pkg/index.js",
      "module.exports = { vulnerable(x) { return x; } };\n",
    );
    write(
      root,
      "node_modules/@types/has-types-pkg/package.json",
      JSON.stringify({ name: "@types/has-types-pkg", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/@types/has-types-pkg/index.d.ts",
      "export declare function vulnerable(x: string): string;\n",
    );

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve(
      "has-types-pkg",
      path.join(root, "src", "index.ts"),
    );

    // Never derived by stripping "@types/" from the resolved path --
    // TypeScript's own re-resolution of the *original* specifier is what
    // finds the real package (see module-resolver.ts's own doc comment).
    expect(result).toMatchObject({
      kind: "resolved",
      resolvedFileName: runtimeFile,
    });
  });

  it("returns declaration-only when only a separate @types/* package is installed and no real runtime package exists", async () => {
    const root = tempProject();
    write(root, "src/index.ts", "export {};\n");
    write(
      root,
      "node_modules/@types/no-runtime-pkg/package.json",
      JSON.stringify({ name: "@types/no-runtime-pkg", version: "1.0.0" }),
    );
    const declFile = write(
      root,
      "node_modules/@types/no-runtime-pkg/index.d.ts",
      "export declare function vulnerable(x: string): string;\n",
    );

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve(
      "no-runtime-pkg",
      path.join(root, "src", "index.ts"),
    );

    expect(result).toMatchObject({
      kind: "declaration",
      resolvedFileName: declFile,
    });
  });

  it("recognizes .d.mts declaration files the same way as .d.ts", async () => {
    const root = tempProject();
    write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      }),
    );
    write(root, "package.json", JSON.stringify({ type: "module" }));
    write(root, "src/index.mts", "export {};\n");
    write(
      root,
      "node_modules/mts-only/package.json",
      JSON.stringify({
        name: "mts-only",
        version: "1.0.0",
        type: "module",
        // Points at a runtime file that was never actually shipped --
        // only its declaration counterpart exists. Mirrors real ESM
        // types-only packages, which is what makes TS's own resolution
        // algorithm land on the .d.mts at all here (a bare extensionless
        // specifier lookup does not, on its own, probe .d.mts/.mjs).
        main: "./index.mjs",
      }),
    );
    const declFile = write(
      root,
      "node_modules/mts-only/index.d.mts",
      "export declare function vulnerable(x: string): string;\n",
    );

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve(
      "mts-only",
      path.join(root, "src", "index.mts"),
    );

    expect(result).toMatchObject({
      kind: "declaration",
      resolvedFileName: declFile,
    });
  });

  it("recognizes .d.cts declaration files the same way as .d.ts", async () => {
    const root = tempProject();
    write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      }),
    );
    write(root, "src/index.cts", "export {};\n");
    write(
      root,
      "node_modules/cts-only/package.json",
      JSON.stringify({
        name: "cts-only",
        version: "1.0.0",
        // See the .d.mts test above for why an explicit main pointing at
        // a never-shipped runtime file is what makes resolution land on
        // the declaration file at all.
        main: "./index.cjs",
      }),
    );
    const declFile = write(
      root,
      "node_modules/cts-only/index.d.cts",
      "export declare function vulnerable(x: string): string;\n",
    );

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve(
      "cts-only",
      path.join(root, "src", "index.cts"),
    );

    expect(result).toMatchObject({
      kind: "declaration",
      resolvedFileName: declFile,
    });
  });
});

describe("createModuleResolver: resolution failure", () => {
  it("returns an explicit unresolved result, never throws, for a nonexistent module", async () => {
    const root = tempProject();
    write(root, "src/index.ts", "export {};\n");

    const resolver = createModuleResolver(loadTsProject(root));
    const result = await resolver.resolve(
      "definitely-does-not-exist",
      path.join(root, "src", "index.ts"),
    );

    expect(result.kind).toBe("unresolved");
    if (result.kind === "unresolved") {
      expect(result.specifier).toBe("definitely-does-not-exist");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
