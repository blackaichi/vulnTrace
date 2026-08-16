import { describe, expect, it } from "vitest";
import type { Coverage } from "./coverage.js";

describe("Coverage", () => {
  it("matches the example shape from docs/SDD.md § 8", () => {
    const coverage: Coverage = {
      files: 183,
      modulesResolved: 176,
      modulesUnresolved: 7,
      functions: 4210,
      callsResolved: 3850,
      callsDynamic: 360,
    };

    // modulesResolved + modulesUnresolved summing to files is specific to
    // this example's numbers, not a general invariant of the type.
    expect(coverage.modulesResolved + coverage.modulesUnresolved).toBe(
      coverage.files,
    );
    expect(coverage.functions).toBe(4210);
    expect(coverage.callsResolved).toBe(3850);
    expect(coverage.callsDynamic).toBe(360);
  });
});
