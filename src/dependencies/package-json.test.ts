import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PackageJsonFileNotFoundError,
  PackageJsonSyntaxError,
  PackageJsonValidationError,
} from "./package-json-errors.js";
import {
  loadPackageJsonFile,
  parsePackageJson,
  parsePackageJsonText,
} from "./package-json.js";

describe("parsePackageJson: reading fields", () => {
  it("reads name/version/scripts/dependencies/exports/imports", () => {
    const pkg = parsePackageJson({
      name: "foo",
      version: "1.2.3",
      scripts: { build: "tsc" },
      dependencies: { bar: "^1.0.0" },
      devDependencies: { baz: "^2.0.0" },
      exports: { ".": "./index.js" },
      imports: { "#internal": "./internal.js" },
    });

    expect(pkg.name).toBe("foo");
    expect(pkg.version).toBe("1.2.3");
    expect(pkg.scripts.build).toBe("tsc");
    expect(pkg.dependencies.bar).toBe("^1.0.0");
    expect(pkg.devDependencies.baz).toBe("^2.0.0");
    expect(pkg.exports).toEqual({ ".": "./index.js" });
    expect(pkg.imports).toEqual({ "#internal": "./internal.js" });
  });

  it("defaults missing dependency maps and scripts to empty objects, deterministically", () => {
    const a = parsePackageJson({});
    const b = parsePackageJson({});

    expect(a).toEqual(b);
    expect(a.dependencies).toEqual({});
    expect(a.devDependencies).toEqual({});
    expect(a.peerDependencies).toEqual({});
    expect(a.optionalDependencies).toEqual({});
    expect(a.scripts).toEqual({});
  });

  it("allows name and version to be absent (e.g. private workspace roots)", () => {
    const pkg = parsePackageJson({ private: true });

    expect(pkg.name).toBeUndefined();
    expect(pkg.version).toBeUndefined();
  });

  it("silently drops unrecognized fields rather than rejecting them", () => {
    const pkg = parsePackageJson({
      name: "foo",
      license: "MIT",
      eslintConfig: { extends: "airbnb" },
    });

    expect(pkg.name).toBe("foo");
    expect((pkg as Record<string, unknown>).eslintConfig).toBeUndefined();
  });

  it("rejects a non-string dependency version specifier", () => {
    expect(() => parsePackageJson({ dependencies: { foo: 123 } })).toThrow(
      PackageJsonValidationError,
    );
  });
});

describe("parsePackageJsonText", () => {
  it("throws PackageJsonSyntaxError for malformed JSON", () => {
    expect(() => parsePackageJsonText("{ not valid json")).toThrow(
      PackageJsonSyntaxError,
    );
  });
});

describe("loadPackageJsonFile", () => {
  it("throws PackageJsonFileNotFoundError for a missing file", () => {
    expect(() => loadPackageJsonFile("/does/not/exist/package.json")).toThrow(
      PackageJsonFileNotFoundError,
    );
  });
});

describe("no package script is ever executed", () => {
  it("reads a scripts entry as inert data, never running it", () => {
    const marker = path.join(
      os.tmpdir(),
      `vulntrace-no-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    try {
      const json = JSON.stringify({
        name: "malicious-fixture",
        version: "1.0.0",
        scripts: {
          postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'pwned')"`,
        },
      });

      const pkg = parsePackageJsonText(json);

      expect(pkg.scripts.postinstall).toContain("writeFileSync");
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (existsSync(marker)) {
        rmSync(marker);
      }
    }
  });
});
