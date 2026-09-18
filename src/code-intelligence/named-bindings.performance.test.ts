import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  namedBindingScopeIndexBuilds,
  resolveNamedBinding,
} from "./named-bindings.js";

/**
 * P1-B3 REMEDIATION — the STRUCTURAL guarantee behind named-binding
 * resolution's cost, asserted as a structure rather than as a stopwatch.
 *
 * The first P1-B3 implementation answered each of its three questions
 * about a scope by walking that scope's subtree once PER QUERY. On a real
 * file that is quadratic in exactly the wrong shape: `lodash.js` has on the
 * order of 1,700 unresolved call sites inside ONE ~16,000-line function
 * expression, so one subtree was walked ~1,700 times. An independent audit
 * measured the cost at about +45% of scan wall time and found the record
 * claiming there was no regression.
 *
 * The fix is a per-scope index. The property that makes it a fix, and the
 * only thing worth pinning, is:
 *
 *   THE NUMBER OF SUBTREE WALKS DEPENDS ON HOW MANY SCOPES WERE ASKED
 *   ABOUT, NEVER ON HOW MANY QUERIES WERE ASKED.
 *
 * A wall-clock test could not state that, would drift with hardware, and
 * would have to be given a threshold somebody could quietly relax. A walk
 * count is exact: after the first reference in a scope has been resolved,
 * every later reference in that same scope must cost ZERO additional
 * walks, whatever it asks about. Deleting the caches makes this fail
 * immediately and unambiguously.
 */

/**
 * One module-scope function holding `count` distinct bindings and one
 * inner function calling every one of them -- the shape whose cost blew
 * up, in miniature. Every call site sits in the SAME scope chain, so the
 * indexes they need are the same indexes.
 */
function buildSourceFile(count: number): ts.SourceFile {
  const lines: string[] = ["function danger() {}"];
  for (let i = 0; i < count; i++) {
    lines.push(`const fn${i} = danger;`);
  }
  lines.push("function main() {");
  for (let i = 0; i < count; i++) {
    lines.push(`  fn${i}();`);
  }
  lines.push("}");
  return ts.createSourceFile(
    "perf.js",
    lines.join("\n"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
}

/** Every `fnN` identifier in callee position inside `main`, in source order. */
function calleeReferences(sourceFile: ts.SourceFile): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      found.push(node.expression);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

describe("P1-B3: named-binding scope analysis is indexed, not rescanned", () => {
  it("costs zero additional scope walks after the first reference in a scope", () => {
    const references = calleeReferences(buildSourceFile(200));
    expect(references).toHaveLength(200);

    const before = namedBindingScopeIndexBuilds();

    // The first reference pays for the indexes of every scope on its own
    // chain. That cost is real and expected.
    const first = references[0];
    expect(first).toBeDefined();
    if (first) {
      expect(resolveNamedBinding(first).kind).toBe("function");
    }
    const afterFirst = namedBindingScopeIndexBuilds();
    expect(afterFirst).toBeGreaterThan(before);

    // Every other reference asks about a DIFFERENT name in the SAME
    // scopes. Not one of them may walk anything again.
    for (const reference of references.slice(1)) {
      expect(resolveNamedBinding(reference).kind).toBe("function");
    }

    expect(namedBindingScopeIndexBuilds()).toBe(afterFirst);
  });

  it("builds a bounded number of indexes for one scope chain", () => {
    // Three questions (declarations, assigned names, assigned members) over
    // a chain of at most a handful of scopes. The exact number is not the
    // contract -- that it does not grow with the file is.
    const smallReferences = calleeReferences(buildSourceFile(5));
    const largeReferences = calleeReferences(buildSourceFile(500));

    const beforeSmall = namedBindingScopeIndexBuilds();
    for (const reference of smallReferences) resolveNamedBinding(reference);
    const smallCost = namedBindingScopeIndexBuilds() - beforeSmall;

    const beforeLarge = namedBindingScopeIndexBuilds();
    for (const reference of largeReferences) resolveNamedBinding(reference);
    const largeCost = namedBindingScopeIndexBuilds() - beforeLarge;

    // 100x the call sites, the same number of scopes, so the same cost.
    expect(largeCost).toBe(smallCost);
  });
});

/**
 * P1-B3b — the same guarantee for the two authorities this block added.
 *
 * The matcher they replace was an `Array#find` over every function-like
 * node in the file, run once per call site: linear per query, quadratic
 * over a file. The replacement must not reintroduce that shape through a
 * side door, so the class and named-function-expression paths are held to
 * the same structural contract as every other binding — they read the
 * SAME per-scope indexes, and asking about them repeatedly must cost
 * nothing.
 */
describe("P1-B3b: class and self-name authority reuse the same indexes", () => {
  function constructionSites(count: number): ts.Identifier[] {
    const lines = [
      "class Thing {",
      "  constructor() {}",
      "}",
      "function main() {",
    ];
    for (let i = 0; i < count; i++) {
      lines.push("  new Thing();");
    }
    lines.push("}");
    const sourceFile = ts.createSourceFile(
      "ctor.js",
      lines.join("\n"),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
    );
    const found: ts.Identifier[] = [];
    function visit(node: ts.Node): void {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        found.push(node.expression);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return found;
  }

  it("costs zero additional scope walks per construction site", () => {
    const references = constructionSites(200);
    expect(references).toHaveLength(200);

    const first = references[0];
    expect(first).toBeDefined();
    if (first) {
      expect(resolveNamedBinding(first).kind).toBe("class");
    }
    const afterFirst = namedBindingScopeIndexBuilds();

    for (const reference of references.slice(1)) {
      expect(resolveNamedBinding(reference).kind).toBe("class");
    }

    expect(namedBindingScopeIndexBuilds()).toBe(afterFirst);
  });

  it("costs zero additional scope walks per self-recursive call", () => {
    const lines = ["const outer = function inner(n) {"];
    for (let i = 0; i < 200; i++) {
      lines.push(`  inner(n - ${i});`);
    }
    lines.push("};");
    const sourceFile = ts.createSourceFile(
      "self.js",
      lines.join("\n"),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
    );
    const references = calleeReferences(sourceFile);
    expect(references).toHaveLength(200);

    const first = references[0];
    expect(first).toBeDefined();
    if (first) {
      expect(resolveNamedBinding(first).kind).toBe("function-expression");
    }
    const afterFirst = namedBindingScopeIndexBuilds();

    for (const reference of references.slice(1)) {
      expect(resolveNamedBinding(reference).kind).toBe("function-expression");
    }

    expect(namedBindingScopeIndexBuilds()).toBe(afterFirst);
  });
});
