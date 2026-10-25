import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  protocolDefinitionOf,
  prototypeScanCount,
} from "./protocol-members.js";

/**
 * Task BL-109, its independent audit's round 2: whether a literal sets
 * `__proto__` is asked once per member, so it is cached per literal --
 * measured structurally, by scans, never by wall clock (ARCHITECTURE
 * § 10). Uncached, a literal of 2,000 members took 4.4 s.
 */
describe("a literal's `__proto__` is found once per literal, not once per member (task BL-109's audit, round 2)", () => {
  it.each([1_000, 4_000])(
    "a literal of %i members is scanned once",
    (members) => {
      const properties = Array.from(
        { length: members },
        (_, i) => `p${String(i)}: function () {}`,
      ).join(", ");
      const file = ts.createSourceFile(
        "big.js",
        `const big = { ${properties}, __proto__: p };\n`,
        ts.ScriptTarget.Latest,
        true,
      );
      const before = prototypeScanCount();
      let definitions = 0;
      const visit = (node: ts.Node): void => {
        if (protocolDefinitionOf(node)) {
          definitions += 1;
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      expect(definitions).toBe(members);
      expect(prototypeScanCount() - before).toBe(1);
    },
  );
});
