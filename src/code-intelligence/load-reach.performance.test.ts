import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LoadReachGraph,
  loadReachClosureVisitCount,
  loadReachMemberScanCount,
} from "./load-reach.js";
import type {
  ModuleResolutionResult,
  ModuleResolver,
} from "./module-resolver.js";
import { indexSourceFileFromDisk } from "./source-index.js";

/**
 * Task BL-074: the module graph's work is structural, never wall clock
 * (ARCHITECTURE § 10): every closure member is read and scanned at most
 * once per graph, a closure is walked once per root, and preparing a file
 * again is free.
 */

function resolverFor(): ModuleResolver {
  return {
    resolve: async (specifier, importer): Promise<ModuleResolutionResult> => {
      const file = path.resolve(path.dirname(importer), `${specifier}.js`);
      return existsSync(file)
        ? {
            kind: "resolved",
            resolvedFileName: file,
            isExternalLibraryImport: false,
          }
        : { kind: "unresolved", specifier, importer, reason: "test" };
    },
  };
}

describe("BL-074: the reach graph's cost", () => {
  it("scans each member once and walks each closure once, however many files ask", async () => {
    const N = 40;
    const root = mkdtempSync(path.join(tmpdir(), "vt-load-reach-perf-"));
    mkdirSync(root, { recursive: true });
    // A chain c0 -> c1 -> … -> c(N-1), and N files each handing every link on.
    for (let i = 0; i < N; i += 1) {
      writeFileSync(
        path.join(root, `c${i}.js`),
        i + 1 < N ? `require("./c${i + 1}");\n` : `exports.v = 1;\n`,
      );
      const loads = Array.from(
        { length: N },
        (_, j) => `set(require("./c${j}"));`,
      ).join("\n");
      writeFileSync(
        path.join(root, `f${i}.js`),
        `function set(m) { void m; }\n${loads}\nexports.run = set;\n`,
      );
    }
    const graph = new LoadReachGraph(resolverFor());
    const scansBefore = loadReachMemberScanCount();
    const visitsBefore = loadReachClosureVisitCount();
    for (let i = 0; i < N; i += 1) {
      const reach = await graph.prepare(
        indexSourceFileFromDisk(path.join(root, `f${i}.js`)),
      );
      expect(reach.mayReachBack("./c0")).toBe(false);
    }
    const scans = loadReachMemberScanCount() - scansBefore;
    const visits = loadReachClosureVisitCount() - visitsBefore;
    // Each chain member is scanned once (N), not once per asking file (N²).
    expect(scans).toBe(N);
    // Each root's closure is walked once: c_j's has N - j members.
    expect(visits).toBe((N * (N + 1)) / 2);

    // Preparing again does no work at all.
    await graph.prepare(indexSourceFileFromDisk(path.join(root, "f0.js")));
    expect(loadReachMemberScanCount() - scansBefore).toBe(scans);
    expect(loadReachClosureVisitCount() - visitsBefore).toBe(visits);
  });
});
