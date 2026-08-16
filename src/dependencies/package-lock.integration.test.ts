import { describe, expect, it } from "vitest";
import { fixturePath } from "../testing/fixtures.js";
import { derivePackageName, loadPackageLockFile } from "./package-lock.js";

describe("loadPackageLockFile against a real fixture", () => {
  it("reads fixtures/direct-esm/package-lock.json", () => {
    const lock = loadPackageLockFile(
      fixturePath("direct-esm", "package-lock.json"),
    );

    expect(lock.lockfileVersion).toBe(3);
    expect(lock.name).toBe("fixture-direct-esm");

    const root = lock.packages[""];
    expect(root?.name).toBe("fixture-direct-esm");
    expect(root?.dependencies).toEqual({ "fixture-lib": "1.0.0" });

    const dependency = lock.packages["node_modules/fixture-lib"];
    expect(dependency?.version).toBe("1.0.0");
    // The real fixture omits `name` on this entry (npm elides it when
    // inferable from the path), so this exercises derivePackageName against
    // real npm output rather than only synthetic test data.
    expect(dependency?.name).toBeUndefined();
    expect(derivePackageName("node_modules/fixture-lib")).toBe("fixture-lib");
  });
});
