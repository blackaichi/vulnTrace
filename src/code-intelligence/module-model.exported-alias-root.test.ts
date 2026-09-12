import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildModuleModel, entrypointRootCandidates } from "./module-model.js";
import { indexSourceFileFromDisk } from "./source-index.js";

/**
 * P0-Z round 3: an exported local ALIAS must resolve to the callable a root
 * can actually be looked up by.
 *
 * `entrypointRootCandidates` contributed `exp.localName ?? exp.exportedName`
 * and called the derivation complete. For `const alias = bad;
 * module.exports.run = alias` that name is `alias` -- a variable -- while
 * the only callable node is `bad`. The candidate matched nothing, the
 * entrypoint was rooted at `<module>` alone, and family C certified
 * `reachableSubgraphComplete: true` over a sink Node executes.
 *
 * Two halves are tested here: the chain RESOLUTION (this file's concern)
 * and the REQUIREMENTS it emits, which `entrypointSourceNodes` checks
 * against the graph -- a candidate name is not a root, a node is.
 */

let dir: string | undefined;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

const DEP =
  "const dep = require('vlib');\n" +
  "function bad(u){ return dep.vulnerable(u); }\n" +
  "function safe(u){ return dep.safe(u); }\n";

function candidatesFor(source: string) {
  dir = mkdtempSync(path.join(tmpdir(), "p0z-alias-"));
  const file = path.join(dir, "m.js");
  writeFileSync(file, source);
  const index = indexSourceFileFromDisk(file);
  return entrypointRootCandidates(index, buildModuleModel(index));
}

describe("P0-Z: exact alias chains resolve to the callable", () => {
  const RESOLVES: ReadonlyArray<readonly [string, string, string]> = [
    ["direct callable", "module.exports.run = bad;\n", "bad"],
    [
      "one-hop const alias",
      "const alias = bad;\nmodule.exports.run = alias;\n",
      "bad",
    ],
    [
      "two-hop const alias",
      "const a = bad;\nconst b = a;\nmodule.exports.run = b;\n",
      "bad",
    ],
    ["dot export", "const alias = bad;\nmodule.exports.run = alias;\n", "bad"],
    [
      "bracket export",
      'const alias = bad;\nmodule.exports["run"] = alias;\n',
      "bad",
    ],
    [
      "exports alias export",
      "const alias = bad;\nexports.run = alias;\n",
      "bad",
    ],
    [
      "object-literal export",
      "const alias = bad;\nmodule.exports = { run: alias };\n",
      "bad",
    ],
    [
      "safe alias resolves to the SAFE callable",
      "const alias = safe;\nmodule.exports.run = alias;\n",
      "safe",
    ],
  ];

  for (const [label, source, expected] of RESOLVES) {
    it(`${label} -> root names include "${expected}"`, () => {
      expect([...candidatesFor(DEP + source).names]).toContain(expected);
    });
  }

  it("does not lose the ORIGINAL name -- resolution only widens", () => {
    // RWF-021's monotonicity: root selection must never shrink.
    const names = [
      ...candidatesFor(
        DEP + "const alias = bad;\nmodule.exports.run = alias;\n",
      ).names,
    ];
    expect(names).toContain("alias");
    expect(names).toContain("bad");
  });

  it("deduplicates when the alias resolves to an already-exported callable", () => {
    const names = [
      ...candidatesFor(
        DEP + "const alias = bad;\nmodule.exports = { bad, alias };\n",
      ).names,
    ];
    expect(names.filter((n) => n === "bad")).toHaveLength(1);
  });

  it("root NAME follows identity, not textual coincidence", () => {
    // Exported name `run`, local name `alias`, callable `bad`: three
    // different strings, and only one of them is the root.
    const c = candidatesFor(
      DEP + "const alias = bad;\nmodule.exports.run = alias;\n",
    );
    expect([...c.names]).toContain("bad");
  });
});

describe("P0-Z: uncertain alias forms emit a root REQUIREMENT", () => {
  // These cannot be materialized in-file, so they must leave a requirement
  // for `entrypointSourceNodes` to fail on -- never a silent complete.
  const UNCERTAIN: ReadonlyArray<readonly [string, string]> = [
    [
      "reassigned alias",
      "let alias = safe;\nalias = bad;\nmodule.exports.run = alias;\n",
    ],
    [
      "conditional alias",
      "const alias = process.env.F ? bad : safe;\nmodule.exports.run = alias;\n",
    ],
    ["member alias", "const obj = { bad };\nmodule.exports.run = obj.bad;\n"],
    [
      "property-access initializer",
      "const obj = { bad };\nconst alias = obj.bad;\nmodule.exports.run = alias;\n",
    ],
    [
      "destructured alias",
      "const obj = { bad };\nconst { bad: alias } = obj;\nmodule.exports.run = alias;\n",
    ],
    [
      "call-expression initializer",
      "const alias = factory();\nmodule.exports.run = alias;\n",
    ],
  ];

  for (const [label, source] of UNCERTAIN) {
    it(`${label} -> emits a requirement`, () => {
      expect(
        candidatesFor(DEP + source).rootRequirements.length,
      ).toBeGreaterThan(0);
    });
  }

  it("a provably NON-CALLABLE export emits NO requirement", () => {
    // "There is no root here" must stay a complete answer, or every valid
    // Family C proof dies with it.
    expect(
      candidatesFor(DEP + "const alias = 42;\nmodule.exports.run = alias;\n")
        .rootRequirements,
    ).toEqual([]);
  });

  it("a file with no exported callable emits NO requirement", () => {
    expect(
      candidatesFor(DEP + "module.exports = 42;\n").rootRequirements,
    ).toEqual([]);
  });

  it("a resolved alias's requirement names the callable it must materialize to", () => {
    const c = candidatesFor(
      DEP + "const alias = bad;\nmodule.exports.run = alias;\n",
    );
    expect(c.rootRequirements.some((r) => r.names.includes("bad"))).toBe(true);
  });

  it("MIXED resolved + unresolved candidates still leave the unresolved one", () => {
    const c = candidatesFor(
      DEP +
        "const good = bad;\n" +
        "const murky = process.env.F ? bad : safe;\n" +
        "module.exports = { a: good, b: murky };\n",
    );
    // The resolvable sibling must not mask the unresolvable one.
    expect(c.rootRequirements.length).toBeGreaterThan(0);
  });
});
