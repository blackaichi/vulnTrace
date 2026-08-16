import { describe, expect, it } from "vitest";
import type { Evidence } from "./evidence.js";

describe("Evidence", () => {
  it("carries a source-location path and human-readable reasons", () => {
    const evidence: Evidence = {
      path: [
        "src/routes/import.ts:18",
        "src/import.ts:42",
        "node_modules/foo/parser.js:87",
      ],
      reasons: [
        "vulnerable symbol resolved",
        "symbol reachable from application entrypoint",
      ],
    };

    expect(evidence.path).toHaveLength(3);
    expect(evidence.reasons).toContain("vulnerable symbol resolved");
  });

  it("allows reasons to be omitted", () => {
    const evidence: Evidence = { path: [] };
    expect(evidence.reasons).toBeUndefined();
  });
});
