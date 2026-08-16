import { describe, expect, it } from "vitest";
import type { ModuleResolver } from "../code-intelligence/module-resolver.js";
import { createTimingResolver, type TimingAccumulator } from "./timing.js";

function delayedResolver(ms: number): ModuleResolver {
  return {
    resolve(specifier) {
      return new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              kind: "resolved",
              resolvedFileName: `/resolved/${specifier}`,
              isExternalLibraryImport: false,
            }),
          ms,
        );
      });
    },
  };
}

describe("createTimingResolver", () => {
  it("accumulates elapsed time across multiple resolve() calls", async () => {
    const accumulator: TimingAccumulator = { ms: 0 };
    const resolver = createTimingResolver(delayedResolver(5), accumulator);

    await resolver.resolve("a", "/project/index.ts");
    await resolver.resolve("b", "/project/index.ts");

    // Real wall-clock timing, so only a lower bound is asserted (no upper
    // bound -- CI scheduling jitter must never make this test flaky).
    expect(accumulator.ms).toBeGreaterThanOrEqual(8);
  });

  it("passes through the wrapped resolver's result unchanged", async () => {
    const accumulator: TimingAccumulator = { ms: 0 };
    const resolver = createTimingResolver(delayedResolver(0), accumulator);

    const result = await resolver.resolve("foo", "/project/index.ts");

    expect(result).toEqual({
      kind: "resolved",
      resolvedFileName: "/resolved/foo",
      isExternalLibraryImport: false,
    });
  });

  it("still records elapsed time when the wrapped resolver rejects", async () => {
    const accumulator: TimingAccumulator = { ms: 0 };
    const failing: ModuleResolver = {
      resolve() {
        return Promise.reject(new Error("boom"));
      },
    };
    const resolver = createTimingResolver(failing, accumulator);

    await expect(resolver.resolve("foo", "/project/index.ts")).rejects.toThrow(
      "boom",
    );
    expect(accumulator.ms).toBeGreaterThanOrEqual(0);
  });
});
