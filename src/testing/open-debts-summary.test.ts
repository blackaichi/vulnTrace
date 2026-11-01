/**
 * OPEN-DEBTS D-17's summary (task BL-119) against the findings register.
 *
 * D-17's full record (`docs/open-debts/D-17.md`) tracked, note by note,
 * which of its findings were still open. Its summary states the result as
 * two lists of ids. A summary that kept naming a fixed finding as open, or
 * stopped naming an open one, would be the debt register's stale claim, so
 * both lists are read against the register's own classification: the
 * task that fixes a listed finding updates the summary.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readFindingsRegister } from "../../scripts/scorecard-sources.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

function d17(): string {
  const text = readFileSync(path.join(ROOT, "docs", "OPEN-DEBTS.md"), "utf-8");
  const start = text.indexOf("\n### D-17 — ");
  expect(start, "OPEN-DEBTS.md has a D-17 entry").toBeGreaterThanOrEqual(0);
  const end = text.slice(start + 1).search(/\n#{2,3} /);
  return text.slice(start + 1, end < 0 ? undefined : start + 1 + end);
}

/** The bullet beginning with `lead`, up to the next bullet or paragraph. */
function bullet(entry: string, lead: string): string {
  const start = entry.indexOf(`- ${lead}`);
  expect(start, `D-17's summary has a bullet "${lead}"`).toBeGreaterThanOrEqual(
    0,
  );
  const rest = entry.slice(start + 2);
  const end = rest.search(/\n- |\n\n/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The finding ids a text names in code spans (a task id is not one). */
const ids = (text: string) =>
  [...text.matchAll(/`((?:RWF|AUD|PRM)-\d+)`/g)].map((m) => m[1]);

describe("OPEN-DEBTS D-17's summary", () => {
  const register = readFindingsRegister();
  const category = new Map(register.rows.map((row) => [row.id, row.category]));
  const entry = d17();

  it("names exactly the audits' own findings the register holds open", () => {
    const [open = "", partly = ""] = bullet(
      entry,
      "The audits' own findings still open:",
    ).split("open in part:");
    const audits = (id: string) => /^(AUD|PRM)-/.test(id);
    expect(ids(open)).toEqual(
      register.open.map((row) => row.id).filter(audits),
    );
    expect(ids(partly)).toEqual(
      register.partlyOpen.map((row) => row.id).filter(audits),
    );
  });

  it("names only findings of the family the register still holds open", () => {
    const listed = ids(
      bullet(entry, "The remediation tasks found more of the same family."),
    );
    expect(listed.length).toBeGreaterThan(0);
    for (const id of listed) {
      expect(["open", "partlyOpen"], `${id} in D-17's summary`).toContain(
        category.get(id ?? "") ?? "absent from the register",
      );
    }
  });

  it("links its full record", () => {
    expect(entry).toContain("[`open-debts/D-17.md`](open-debts/D-17.md)");
  });
});
