/**
 * `scripts/next-id.mjs` (task BL-119): the next free id of a series is
 * never one a register holds or a record cites.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { nextId } from "../../scripts/next-id.mjs";

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A repository root holding the given files. */
function tree(files: Readonly<Record<string, string>>): string {
  root = mkdtempSync(path.join(os.tmpdir(), "vt-next-id-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return root;
}

const base = {
  "tests/validation/findings/RWF-009.md": "",
  "tests/validation/findings/RWF-010.md": "",
  "tests/validation/findings/RWF-010b.md": "",
  "tests/validation/findings/PRM-07.md": "",
  "docs/tasks/BACKLOG.md": "| BL-007 | a | TODO |\n| BL-041 | b | MERGED |\n",
  "docs/OPEN-DEBTS.md": "### D-05 — a debt\n\n### D-11 — another\n",
};

describe("next-id", () => {
  it("is one past the register's highest, padded to the series' width", () => {
    const at = tree(base);
    expect(nextId("RWF", at).id).toBe("RWF-011");
    expect(nextId("PRM", at).id).toBe("PRM-08");
    expect(nextId("BL", at).id).toBe("BL-042");
    expect(nextId("D", at).id).toBe("D-12");
  });

  it("skips past an id a record cites but the register does not hold", () => {
    const at = tree({
      ...base,
      "docs/tasks/BL-041.md": "Registers RWF-012 and reserves BL-050.\n",
    });
    const rwf = nextId("RWF", at);
    expect(rwf.id).toBe("RWF-013");
    expect(rwf.unregistered).toEqual([
      { file: path.join("docs", "tasks", "BL-041.md"), number: 12 },
    ]);
    expect(nextId("BL", at).id).toBe("BL-051");
  });

  it("reads records only: code, vendored fixtures and node_modules are not scanned", () => {
    const at = tree({
      ...base,
      "src/a.test.ts": "// RWF-900, a synthetic id\n",
      "tests/validation/fixtures/pkg/README.md": "RWF-500\n",
      "node_modules/x/README.md": "RWF-600\n",
    });
    expect(nextId("RWF", at).id).toBe("RWF-011");
  });

  it("does not read a longer series or a suffixed id as the series", () => {
    const at = tree({
      ...base,
      "docs/x.md": "XRWF-099, RWF-013b, PRM-07a, BL-0412x\n",
    });
    expect(nextId("RWF", at).id).toBe("RWF-011");
    expect(nextId("PRM", at).id).toBe("PRM-08");
    expect(nextId("BL", at).id).toBe("BL-042");
  });

  it("refuses an unknown series and an empty register", () => {
    const at = tree(base);
    expect(() => nextId("XYZ", at)).toThrow(/unknown series "XYZ"/);
    expect(() => nextId("AUD", at)).toThrow(/the AUD register holds no id/);
  });
});
