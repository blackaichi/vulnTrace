import { describe, expect, it } from "vitest";
import { RELEASE_ROUTES, routeLive } from "./node-release-routes.js";

/**
 * Task BL-114: the release table oracle cases read their ground truth
 * from. A wrong comparison would assert a ground truth real Node never
 * gave, so its boundaries are pinned to the measured releases.
 */
describe("routeLive", () => {
  it("answers every measured release as measured", () => {
    for (const [route, ranges] of Object.entries(RELEASE_ROUTES)) {
      for (const range of ranges) {
        for (const version of range.measured) {
          expect(
            routeLive(route as keyof typeof RELEASE_ROUTES, version),
            `${route} on v${version}`,
          ).toBe(range.live);
        }
      }
    }
  });

  it("switches at the measured edges, by number, not by text", () => {
    expect(routeLive("require-esm-source", "22.11.9")).toBe(false);
    expect(routeLive("require-esm-source", "22.12.0")).toBe(true);
    expect(routeLive("require-esm-source", "24.11.1")).toBe(true);
    expect(routeLive("require-esm-source", "24.12.0")).toBe(false);
    expect(routeLive("import-source", "24.9.0")).toBe(true);
    expect(routeLive("import-source", "24.12.0")).toBe(false);
  });

  it("keeps a line's last measured behaviour for its later releases", () => {
    expect(routeLive("require-esm-source", "26.13.0")).toBe(false);
    expect(routeLive("require-esm-source", "22.99.0")).toBe(true);
  });

  it("throws for a release no measured range covers", () => {
    for (const version of [
      "20.18.3",
      "21.0.0",
      "22.10.0",
      "25.1.0",
      "27.0.0",
    ]) {
      expect(() => routeLive("require-esm-source", version)).toThrow(
        /not measured/,
      );
    }
  });
});
