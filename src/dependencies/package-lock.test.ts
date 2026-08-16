import { describe, expect, it } from "vitest";
import {
  PackageLockFileNotFoundError,
  PackageLockSyntaxError,
  PackageLockUnsupportedVersionError,
  PackageLockValidationError,
} from "./package-lock-errors.js";
import {
  derivePackageName,
  loadPackageLockFile,
  parsePackageLock,
  parsePackageLockText,
} from "./package-lock.js";

describe("derivePackageName", () => {
  it("returns undefined for the root entry", () => {
    expect(derivePackageName("")).toBeUndefined();
  });

  it("derives a simple top-level package name", () => {
    expect(derivePackageName("node_modules/fixture-lib")).toBe("fixture-lib");
  });

  it("derives the innermost package name for a nested install", () => {
    expect(derivePackageName("node_modules/foo/node_modules/bar")).toBe("bar");
  });

  it("preserves scoped package names as a single segment", () => {
    expect(derivePackageName("node_modules/@scope/bar")).toBe("@scope/bar");
    expect(derivePackageName("node_modules/foo/node_modules/@scope/bar")).toBe(
      "@scope/bar",
    );
  });

  it("returns undefined for a non-node_modules path (e.g. a workspace member)", () => {
    expect(derivePackageName("packages/foo")).toBeUndefined();
  });
});

describe("parsePackageLock: extraction", () => {
  it("extracts dependencies with versions and per-package declared relationships", () => {
    const lock = parsePackageLock({
      name: "root-project",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "root-project",
          version: "1.0.0",
          dependencies: { foo: "^1.0.0" },
        },
        "node_modules/foo": {
          version: "1.2.0",
          dependencies: { bar: "^2.0.0" },
        },
        "node_modules/bar": {
          version: "2.1.0",
        },
      },
    });

    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[""]?.dependencies).toEqual({ foo: "^1.0.0" });
    expect(lock.packages["node_modules/foo"]?.version).toBe("1.2.0");
    expect(lock.packages["node_modules/foo"]?.dependencies).toEqual({
      bar: "^2.0.0",
    });
    expect(lock.packages["node_modules/bar"]?.version).toBe("2.1.0");
  });

  it("preserves multiple installed versions of the same package as distinct entries", () => {
    const lock = parsePackageLock({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { foo: "^2.0.0" } },
        "node_modules/foo": { version: "2.0.0" },
        "node_modules/legacy-consumer/node_modules/foo": { version: "1.0.0" },
      },
    });

    expect(lock.packages["node_modules/foo"]?.version).toBe("2.0.0");
    expect(
      lock.packages["node_modules/legacy-consumer/node_modules/foo"]?.version,
    ).toBe("1.0.0");
  });

  it("preserves dev/optional/peer flags", () => {
    const lock = parsePackageLock({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/dev-only": { version: "1.0.0", dev: true },
        "node_modules/opt-only": { version: "1.0.0", optional: true },
        "node_modules/peer-only": { version: "1.0.0", peer: true },
      },
    });

    expect(lock.packages["node_modules/dev-only"]?.dev).toBe(true);
    expect(lock.packages["node_modules/opt-only"]?.optional).toBe(true);
    expect(lock.packages["node_modules/peer-only"]?.peer).toBe(true);
  });

  it("defaults missing per-entry dependency maps to empty objects, deterministically", () => {
    const a = parsePackageLock({
      lockfileVersion: 3,
      packages: { "": {}, "node_modules/foo": { version: "1.0.0" } },
    });
    const b = parsePackageLock({
      lockfileVersion: 3,
      packages: { "": {}, "node_modules/foo": { version: "1.0.0" } },
    });

    expect(a).toEqual(b);
    expect(a.packages["node_modules/foo"]?.dependencies).toEqual({});
  });
});

describe("parsePackageLock: validation", () => {
  it("rejects a lockfile missing lockfileVersion", () => {
    expect(() => parsePackageLock({ packages: {} })).toThrow(
      PackageLockValidationError,
    );
  });

  it("rejects a lockfile missing the packages map", () => {
    expect(() => parsePackageLock({ lockfileVersion: 3 })).toThrow(
      PackageLockValidationError,
    );
  });

  it("rejects a non-string dependency version specifier", () => {
    expect(() =>
      parsePackageLock({
        lockfileVersion: 3,
        packages: { "": { dependencies: { foo: 123 } } },
      }),
    ).toThrow(PackageLockValidationError);
  });

  it("rejects legacy lockfileVersion 1 with a specific, actionable error", () => {
    expect(() =>
      parsePackageLock({
        lockfileVersion: 1,
        dependencies: { foo: { version: "1.0.0" } },
      }),
    ).toThrow(PackageLockUnsupportedVersionError);
  });
});

describe("parsePackageLockText", () => {
  it("throws PackageLockSyntaxError for malformed JSON", () => {
    expect(() => parsePackageLockText("{ not valid json")).toThrow(
      PackageLockSyntaxError,
    );
  });
});

describe("loadPackageLockFile", () => {
  it("throws PackageLockFileNotFoundError for a missing file", () => {
    expect(() =>
      loadPackageLockFile("/does/not/exist/package-lock.json"),
    ).toThrow(PackageLockFileNotFoundError);
  });
});
