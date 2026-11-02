/**
 * The FINDINGS register's status classification — the reading that decides
 * what `docs/SCORECARD.md` § 8 reports as open, open in part and fixed.
 *
 * Reporting an open finding as fixed is this document's equivalent of a
 * false `NOT_AFFECTED`, and it has already happened: RWF-047's status cell
 * was first written `**OPEN — classified, not fixed**`, and a classifier
 * that matched prose (`/^Open\b/` defeated by the `**`, `/\bfixed\b/`
 * satisfied by "not fixed") filed it as FIXED. The cases below are the
 * wordings that must never do that again, plus the refusal an unknown
 * wording must produce.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  classifyFindingsRegister,
  readFindingsRegister,
  TRUST_BOUNDARY_SECTIONS,
} from "../../scripts/scorecard-sources.mjs";

/** A minimal FINDINGS.md: its `## Status` table, then a finding section. */
function findingsText(
  rows: readonly (readonly [id: string, status: string])[],
): string {
  return [
    "# Real-world findings",
    "",
    "## Status",
    "",
    "| ID | Package | Root cause | Impact | Status |",
    "|---|---|---|---|---|",
    ...rows.map(
      ([id, status]) =>
        `| ${id} | \`pkg\` | a root cause | an impact | ${status} |`,
    ),
    "",
    ...rows.flatMap(([id]) => ["---", "", `## ${id} — a finding`, ""]),
  ].join("\n");
}

/** A status table given verbatim, followed by one section per listed id. */
function tableText(tableLines: readonly string[], ids: readonly string[]) {
  return [
    "# Real-world findings",
    "",
    "## Status",
    "",
    ...tableLines,
    "",
    ...ids.flatMap((id) => [`## ${id} — a finding`, ""]),
  ].join("\n");
}

type Outcome = "open" | "partlyOpen" | "fixed" | "limitation" | "refused";

/** Where one status cell lands, or `"refused"` when classification throws. */
function classify(status: string, id = "RWF-900"): Outcome {
  let register;
  try {
    register = classifyFindingsRegister(findingsText([[id, status]]));
  } catch {
    return "refused";
  }
  if (register.fixed.some((row) => row.id === id)) return "fixed";
  if (register.partlyOpen.some((row) => row.id === id)) return "partlyOpen";
  if (register.open.some((row) => row.id === id)) return "open";
  if (register.limitation.some((row) => row.id === id)) return "limitation";
  throw new Error(`${id} was parsed into no bucket at all`);
}

describe("FINDINGS status classification", () => {
  describe("wholly open wordings classify as open", () => {
    it.each([
      "Open",
      "**Open**",
      "Open — classified, not fixed",
      // RWF-047's first wording, which the prose classifier filed as FIXED.
      "**OPEN — classified, not fixed**",
      "Open, not yet scoped as a task",
    ])("%j → open", (status) => {
      expect(classify(status)).toBe("open");
    });
  });

  describe('"not fixed" anywhere in the cell never classifies as fixed', () => {
    it.each([
      "Not fixed",
      "**not fixed**",
      "Fixed — not fixed for the ESM form",
      "**Fixed (RWF-046)**; the declaration form is not yet fixed",
    ])("%j → never fixed", (status) => {
      expect(classify(status)).not.toBe("fixed");
    });
  });

  describe("wholly fixed wordings classify as fixed", () => {
    it.each([
      "Fixed",
      "**Fixed**",
      "Fixed (RWF-046)",
      "**Fixed (RWF-046)** — see below",
    ])("%j → fixed", (status) => {
      expect(classify(status)).toBe("fixed");
    });
  });

  describe("a finding only partly fixed is still open", () => {
    it.each([
      "Fixed in part",
      "**Fixed in part** — the CommonJS half; the ESM half remains",
      "partially fixed",
      "**Partially fixed (RWF-046)**",
      "open-in-part",
      "Open in part",
    ])("%j → open (in part), never fixed", (status) => {
      const outcome = classify(status);
      expect(outcome).not.toBe("fixed");
      expect(outcome).not.toBe("refused");
      expect(["open", "partlyOpen"]).toContain(outcome);
    });
  });

  describe("a documented limitation (task BL-113) is its own category", () => {
    it.each([
      "Documented limitation (the trust boundary over the runtime's built-in prototypes, SOUNDNESS-CONTRACT § 1; task `BL-113`)",
      "  Documented limitation (the trust boundary over the runtime's built-in prototypes, SOUNDNESS-CONTRACT § 1; task `BL-999`)  ",
    ])("%j → limitation, never fixed and never open", (status) => {
      expect(classify(status)).toBe("limitation");
    });

    it.each([
      "Documented limitation",
      "Documented limitation (trust boundary; BL-113)",
      "Documented limitation — see ADR 0010",
      // A section that states no boundary (BL-113's audit, round 1, F1).
      "Documented limitation (SOUNDNESS-CONTRACT § 99)",
      "Documented limitation (SOUNDNESS-CONTRACT § 1, SOUNDNESS-CONTRACT § 3)",
      "Documented limitation (the trust boundary over the runtime's built-in prototypes, SOUNDNESS-CONTRACT § 1; task `BL-113`; see SOUNDNESS-CONTRACT.md § 3)",
    ])(
      "%j → refused: a limitation must cite the contract section that states it",
      (status) => {
        const text = findingsText([["RWF-977", status]]);
        expect(() => classifyFindingsRegister(text)).toThrow(
          /RWF-977: status value "documented limitation" must cite/,
        );
      },
    );

    it.each([
      // BL-113's audit, round 1, F1: a limitation whose own cell says part
      // of it is still open would leave the open count.
      "Documented limitation (SOUNDNESS-CONTRACT § 1) for the prototype forms; the constructor route remains open and live",
      "Documented limitation: not covered by SOUNDNESS-CONTRACT § 1, still open",
      "Documented limitation (SOUNDNESS-CONTRACT § 1), fixed in part",
      // BL-113's audit, round 2, R2-2: no shape but the closed one.
      "Documented limitation (SOUNDNESS-CONTRACT § 1); the Array[Symbol.species] route is still live and unresolved",
      "Documented limitation (SOUNDNESS-CONTRACT § 1) except the URL.prototype route, a live false NOT_AFFECTED",
      "**Documented limitation** — SOUNDNESS-CONTRACT § 1",
      "Documented limitation (the trust boundary over prototypes except URL, SOUNDNESS-CONTRACT § 1; task `BL-113`)",
      "Documented limitation (the trust boundary over the live prototypes, SOUNDNESS-CONTRACT § 1; task `BL-113`)",
    ])(
      "%j → refused: a limitation whose own cell says part is still open",
      (status) => {
        const text = findingsText([["RWF-977", status]]);
        expect(() => classifyFindingsRegister(text)).toThrow(
          /RWF-977: status value "documented limitation" must take exactly the shape/,
        );
      },
    );

    it("every boundary section a limitation may cite states its boundary in the contract", () => {
      const contract = readFileSync(
        path.join(
          path.resolve(fileURLToPath(new URL("../../", import.meta.url))),
          "docs",
          "SOUNDNESS-CONTRACT.md",
        ),
        "utf-8",
      );
      expect(TRUST_BOUNDARY_SECTIONS.size).toBeGreaterThan(0);
      for (const [section, heading] of TRUST_BOUNDARY_SECTIONS) {
        const start = contract.indexOf(`\n## ${section}. `);
        expect(start, `the contract has a § ${section}`).toBeGreaterThanOrEqual(
          0,
        );
        const next = contract.indexOf("\n## ", start + 1);
        const body = contract.slice(start, next < 0 ? undefined : next);
        expect(body, `§ ${section} holds "${heading}"`).toContain(
          `\n${heading}\n`,
        );
      }
    });
  });

  describe("a status value outside the vocabulary fails, naming row and value", () => {
    it.each(["Resolved", "Done", "Mitigated", "Closed", "Wontfix", "TBD"])(
      "%j → refused",
      (status) => {
        const text = findingsText([
          ["RWF-001", "Open"],
          ["RWF-977", status],
        ]);
        expect(() => classifyFindingsRegister(text)).toThrow(/RWF-977/);
        expect(() => classifyFindingsRegister(text)).toThrow(
          new RegExp(status),
        );
      },
    );

    it("an empty status cell is refused, never defaulted", () => {
      expect(classify("")).toBe("refused");
    });
  });

  describe("status is read from the Status column only", () => {
    it("the word Fixed in another column does not make an open row fixed", () => {
      const text = tableText(
        [
          "| ID | Package | Root cause | Impact | Status |",
          "|---|---|---|---|---|",
          "| RWF-901 | Fixed | Fixed | Fixed | Open |",
        ],
        ["RWF-901"],
      );
      const register = classifyFindingsRegister(text);
      expect(register.open.map((row) => row.id)).toEqual(["RWF-901"]);
      expect(register.fixed).toEqual([]);
    });

    it("a row whose cell count does not match the header is refused", () => {
      const text = [
        "# Real-world findings",
        "",
        "## Status",
        "",
        "| ID | Package | Root cause | Impact | Status |",
        "|---|---|---|---|---|",
        "| RWF-902 | pkg | cause | impact | Open | Fixed |",
        "",
      ].join("\n");
      expect(() => classifyFindingsRegister(text)).toThrow(/RWF-902/);
    });

    it("a status table whose header is not the designated shape is refused", () => {
      const text = [
        "# Real-world findings",
        "",
        "## Status",
        "",
        "| ID | Package | Status | Root cause | Impact |",
        "|---|---|---|---|---|",
        "| RWF-903 | pkg | Open | cause | impact |",
        "",
      ].join("\n");
      expect(() => classifyFindingsRegister(text)).toThrow(/header/i);
    });
  });

  describe("rows from another register series use the same field and vocabulary", () => {
    it("an AUD row is parsed and classified like any RWF row", () => {
      const register = classifyFindingsRegister(
        findingsText([
          ["RWF-001", "Open"],
          ["AUD-01", "**Open**"],
          ["AUD-02", "Fixed (AUD-02)"],
        ]),
      );
      expect(register.rows.map((row) => row.id)).toEqual([
        "RWF-001",
        "AUD-01",
        "AUD-02",
      ]);
      expect(register.open.map((row) => row.id)).toEqual(["RWF-001", "AUD-01"]);
      expect(register.fixed.map((row) => row.id)).toEqual(["AUD-02"]);
    });

    it("an AUD row with an unknown status is refused, naming it", () => {
      expect(() =>
        classifyFindingsRegister(findingsText([["AUD-16", "Triaged"]])),
      ).toThrow(/AUD-16.*Triaged/s);
    });
  });

  describe("every finding section has a status row, and every row a section", () => {
    const header = [
      "| ID | Package | Root cause | Impact | Status |",
      "|---|---|---|---|---|",
    ];

    it("a finding section with no status row fails, naming the id", () => {
      const text = tableText(
        [...header, "| RWF-001 | pkg | cause | impact | Fixed |"],
        ["RWF-001", "RWF-049"],
      );
      expect(() => classifyFindingsRegister(text)).toThrow(
        /RWF-049: has a "## RWF-049" section but no status-table row/,
      );
    });

    it("a status row with no finding section fails, naming the id", () => {
      const text = tableText(
        [
          ...header,
          "| RWF-001 | pkg | cause | impact | Fixed |",
          "| RWF-046b | pkg | cause | impact | Fixed |",
        ],
        ["RWF-001"],
      );
      expect(() => classifyFindingsRegister(text)).toThrow(
        /RWF-046b: has a status-table row but no "## RWF-046b" section/,
      );
    });

    it("sections of the AUD- and PRM- series are held to the same rule", () => {
      const missingRows = tableText(
        [...header, "| RWF-001 | pkg | cause | impact | Open |"],
        ["RWF-001", "AUD-07", "PRM-02"],
      );
      expect(() => classifyFindingsRegister(missingRows)).toThrow(/AUD-07/);
      expect(() => classifyFindingsRegister(missingRows)).toThrow(/PRM-02/);

      const complete = tableText(
        [
          ...header,
          "| AUD-07 | pkg | cause | impact | **Open** |",
          "| PRM-02 | pkg | cause | impact | Fixed (PRM-02) |",
        ],
        ["AUD-07", "PRM-02"],
      );
      const register = classifyFindingsRegister(complete);
      expect(register.open.map((row) => row.id)).toEqual(["AUD-07"]);
      expect(register.fixed.map((row) => row.id)).toEqual(["PRM-02"]);
    });

    it("several sections for one id (a CORRECTION) need one row, not several", () => {
      const text = [
        tableText(
          [...header, "| RWF-032 | pkg | cause | impact | Fixed |"],
          ["RWF-032"],
        ),
        "## RWF-032 CORRECTION — the record above was wrong",
        "",
      ].join("\n");
      expect(classifyFindingsRegister(text).fixed.map((row) => row.id)).toEqual(
        ["RWF-032"],
      );
    });
  });

  describe("the committed register", () => {
    it("classifies every row, and RWF-047 as open", () => {
      const register = readFindingsRegister();
      expect(
        register.open.length +
          register.partlyOpen.length +
          register.fixed.length +
          register.limitation.length,
      ).toBe(register.rows.length);
      expect(register.open.map((row) => row.id)).toContain("RWF-047");
      expect(register.fixed.map((row) => row.id)).not.toContain("RWF-047");
    });
  });
});
