import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NAME_LOOKUP_CENSUS,
  findNameLookups,
  type FoundNameLookup,
} from "./name-lookup-census.js";

/**
 * ADR 0011 § 2's name-keyed-lookup census, the structural gate of task V-3
 * (Foundation invariant `VT-INV-V-corroboration`). See
 * `name-lookup-census.ts` for what counts and why each listed lookup is
 * allowed to exist.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function key(entry: FoundNameLookup): string {
  return `${entry.file} # ${entry.enclosing} # ${entry.expression}`;
}

describe("the name-keyed-lookup census (ADR 0011 § 2, task V-3)", () => {
  const found = findNameLookups(REPO_ROOT);

  it("lists every name-keyed lookup in src/analysis and src/code-intelligence, and nothing that is gone", () => {
    const listed = new Set(NAME_LOOKUP_CENSUS.map(key));
    const present = new Set(found.map(key));
    expect(
      [...present].filter((k) => !listed.has(k)),
      "a name-keyed lookup the census does not list: state its direction in name-lookup-census.ts, or bind by identity instead",
    ).toEqual([]);
    expect(
      [...listed].filter((k) => !present.has(k)),
      "a census entry for a lookup that no longer exists: delete it",
    ).toEqual([]);
  });

  it("lists each lookup once", () => {
    expect(NAME_LOOKUP_CENSUS.length).toBe(
      new Set(NAME_LOOKUP_CENSUS.map(key)).size,
    );
  });

  it("names the open finding and its task for every `open` entry, and only for those", () => {
    for (const entry of NAME_LOOKUP_CENSUS) {
      expect(
        entry.openFinding !== undefined,
        `${key(entry)}: openFinding iff direction is open`,
      ).toBe(entry.direction === "open");
      expect(entry.why.length, key(entry)).toBeGreaterThan(0);
    }
  });

  it("roots no entrypoint by name: entrypointSourceNodes performs no name-keyed lookup (ADR 0011 predicate 4; PRM-25, PRM-31)", () => {
    expect(
      found.filter(
        (entry) =>
          entry.file === "src/analysis/verdict.ts" &&
          (entry.enclosing === "entrypointSourceNodes" ||
            entry.enclosing === "entrypointRootIncompleteness"),
      ),
    ).toEqual([]);
  });
});

describe("the census scanner itself", () => {
  it("finds every lookup form it claims, at any depth, and ignores a label, an `undefined` check and an AST node's name", () => {
    const root = mkdtempSync(path.join(tmpdir(), "vulntrace-name-census-"));
    try {
      const write = (relative: string, content: string): void => {
        const full = path.join(root, relative);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, content);
      };
      write(
        "src/analysis/types.ts",
        "export interface GraphNode { readonly id: string; readonly name?: string }\n" +
          "export function graphPackageInstancesByName(name: string): string[] { return [name]; }\n",
      );
      write(
        "src/analysis/uses.ts",
        'import { type GraphNode, graphPackageInstancesByName } from "./types.js";\n' +
          "function named(n: GraphNode, s: string): boolean { return n.name === s; }\n" +
          "const arrowNamed = (n: GraphNode, s: string) => n?.name !== s;\n" +
          "export function lookup(nodes: readonly GraphNode[], s: string, set: Set<string>) {\n" +
          "  const direct = nodes.find((n) => n.name === s);\n" +
          "  const viaHelper = nodes.filter((n) => named(n, s));\n" +
          "  const viaArrow = nodes.filter((n) => arrowNamed(n, s));\n" +
          '  const element = nodes.find((n) => n["name"] === s);\n' +
          "  const destructured = nodes.find(({ name }) => name === s);\n" +
          '  const keyed = nodes.filter((n) => set.has(n.name ?? ""));\n' +
          "  const map = new Map(nodes.map((n) => [n.name, n]));\n" +
          "  for (const n of nodes) { switch (n.name) { default: break; } }\n" +
          "  const absent = nodes.filter((n) => n.name !== undefined);\n" +
          "  const label = nodes.map((n) => `node ${n.name}`);\n" +
          "  const ast = { name: s };\n" +
          "  return [direct, viaHelper, viaArrow, element, destructured, keyed, map, absent, label, ast.name === s, graphPackageInstancesByName(s)];\n" +
          "}\n",
      );
      write(
        "src/code-intelligence/deep/nested.ts",
        'import type { GraphNode } from "../../analysis/types.js";\n' +
          'export const deep = (nodes: readonly GraphNode[]) => nodes.some((n) => n.name === "x");\n',
      );
      expect(findNameLookups(root).map(key)).toEqual([
        "src/analysis/uses.ts # arrowNamed # n?.name !== s",
        "src/analysis/uses.ts # lookup # [n.name, n]",
        "src/analysis/uses.ts # lookup # arrowNamed(n, s)",
        "src/analysis/uses.ts # lookup # graphPackageInstancesByName(s)",
        "src/analysis/uses.ts # lookup # n.name",
        "src/analysis/uses.ts # lookup # n.name === s",
        'src/analysis/uses.ts # lookup # n["name"] === s',
        "src/analysis/uses.ts # lookup # name",
        "src/analysis/uses.ts # lookup # named(n, s)",
        'src/analysis/uses.ts # lookup # set.has(n.name ?? "")',
        "src/analysis/uses.ts # named # n.name === s",
        'src/code-intelligence/deep/nested.ts # deep # n.name === "x"',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
