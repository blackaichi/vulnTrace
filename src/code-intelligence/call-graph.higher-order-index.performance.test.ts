import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCallGraph,
  higherOrderCallSiteIndexBuildCount,
} from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";

/**
 * P1-B3b REMEDIATION — the STRUCTURAL cost of the higher-order call-site
 * authority, asserted as a structure rather than as a stopwatch.
 *
 * The text matcher this replaced walked the WHOLE FILE once per
 * higher-order call site, matching `node.expression.text === functionName`.
 * The replacement proves strictly more (it resolves each candidate callee
 * to a declaration, so a same-named function in another scope cannot
 * donate arguments) and must nevertheless cost LESS, by inverting the
 * work: walk once per file, bucket every call by the declaration its
 * callee denotes, and answer later queries from the map.
 *
 * The property worth pinning is therefore:
 *
 *   THE NUMBER OF FILE WALKS DEPENDS ON HOW MANY FILES WERE ASKED ABOUT,
 *   NEVER ON HOW MANY HIGHER-ORDER CALL SITES THEY CONTAIN.
 *
 * Deleting the memo makes this fail immediately; a wall-clock threshold
 * could not state it and could be quietly relaxed.
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * One file with `count` distinct higher-order functions, each called
 * twice with the same callable, so each one is a genuine VT-210 query
 * that resolves. Every query asks about the SAME file.
 */
function sourceWith(count: number): string {
  const lines = ["function target() {}"];
  for (let i = 0; i < count; i++) {
    lines.push(`function invoke${i}(fn) { return fn(); }`);
  }
  lines.push("function main() {");
  for (let i = 0; i < count; i++) {
    lines.push(`  invoke${i}(target);`);
    lines.push(`  invoke${i}(target);`);
  }
  lines.push("}");
  lines.push("module.exports = { main };");
  return lines.join("\n");
}

async function buildFor(count: number): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-b3b-hoperf-"));
  tempDirs.push(root);
  const entry = path.join(root, "src/index.js");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, sourceWith(count));
  const resolver = createModuleResolver(loadTsProject(root));
  await buildCallGraph({ entryFiles: [entry], resolver });
}

describe("P1-B3b: higher-order call sites are indexed per file, not rescanned", () => {
  it("costs the same number of file walks for 5 and for 200 call sites", async () => {
    const beforeSmall = higherOrderCallSiteIndexBuildCount();
    await buildFor(5);
    const smallCost = higherOrderCallSiteIndexBuildCount() - beforeSmall;

    const beforeLarge = higherOrderCallSiteIndexBuildCount();
    await buildFor(200);
    const largeCost = higherOrderCallSiteIndexBuildCount() - beforeLarge;

    // 40x the higher-order queries, one file either way.
    expect(smallCost).toBeGreaterThan(0);
    expect(largeCost).toBe(smallCost);
  });

  it("builds at most one index for a file however many queries it serves", async () => {
    const before = higherOrderCallSiteIndexBuildCount();
    await buildFor(50);
    expect(higherOrderCallSiteIndexBuildCount() - before).toBe(1);
  });
});
