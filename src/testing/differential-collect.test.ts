import { readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADVERSARIAL_V1_ADVISORY,
  ADVERSARIAL_V2_ADVISORY,
} from "./adversarial-providers.js";
import {
  collectSnapshot,
  CORPORA,
  loadCorpusCases,
} from "./differential-collect.js";
import { diffSnapshots, summarize } from "../../scripts/differential-lib.mjs";

/**
 * BL-029 — the collector scans what the suites scan, and records it in a
 * form two checkouts can compare.
 *
 * The corpus loader is checked against the suites' own case files, read
 * independently here, so a case the collector silently skipped would show
 * as a count mismatch rather than as a quiet zero in every differential.
 * Two real cases are then collected end to end: RWB-06A (validation: a
 * temp copy and the recorded OSV snapshot) and ADV-001 (adversarial v1: in
 * place, the stub record).
 */

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);

function caseFile(...parts: string[]): Array<{ id: string; dir: string }> {
  return JSON.parse(
    readFileSync(path.join(REPO_ROOT, "tests", ...parts), "utf-8"),
  ) as Array<{ id: string; dir: string }>;
}

describe("BL-029 collector: the corpus is the suites' corpus", () => {
  const cases = loadCorpusCases(REPO_ROOT, CORPORA);
  const expected = {
    validation: caseFile("validation", "cases", "cases.json"),
    "adversarial-v1": caseFile("adversarial", "v1", "expected.json"),
    "adversarial-v2": caseFile("adversarial", "v2", "expected.json"),
  };

  it("loads every case of every suite, once, with its fixture on disk", () => {
    for (const [corpus, entries] of Object.entries(expected)) {
      const loaded = cases.filter((c) => c.corpus === corpus);
      expect(
        loaded.map((c) => c.id),
        corpus,
      ).toEqual(entries.map((e) => e.id));
      for (const c of loaded) {
        expect(existsSync(c.fixtureDir), c.fixtureDir).toBe(true);
      }
    }
    expect(cases).toHaveLength(
      Object.values(expected).reduce((n, list) => n + list.length, 0),
    );
  });

  it("scans validation cases from a temp copy and adversarial cases in place, as their suites do", () => {
    for (const c of cases) {
      expect(c.copyToTemp, c.id).toBe(c.corpus === "validation");
    }
  });

  it("answers each adversarial corpus with its own suite's stub record", async () => {
    const v1 = cases.find((c) => c.corpus === "adversarial-v1");
    const v2 = cases.find((c) => c.corpus === "adversarial-v2");
    const query = (name: string) => ({
      ecosystem: "npm",
      name,
      version: "1.0.0",
    });
    expect(await v1?.provider().queryPackage(query("adv-vuln-lib"))).toEqual([
      ADVERSARIAL_V1_ADVISORY,
    ]);
    expect(await v2?.provider().queryPackage(query("vt2-vuln-lib"))).toEqual([
      ADVERSARIAL_V2_ADVISORY,
    ]);
    expect(await v1?.provider().queryPackage(query("vt2-vuln-lib"))).toEqual(
      [],
    );
  });
});

describe("BL-029 collector: two real cases, end to end", () => {
  const options = {
    corpusRoot: REPO_ROOT,
    codeRoot: REPO_ROOT,
    corpora: CORPORA,
    label: "test",
    only: ["RWB-06A", "ADV-001"],
  };
  const leftoverTemps = () =>
    readdirSync(tmpdir()).filter((name) =>
      name.startsWith("vulntrace-differential-RWB-06A-"),
    );

  it("observes the graph, keys findings by exact instance, and leaks no absolute root", async () => {
    const before = leftoverTemps();
    const snapshot = await collectSnapshot(options);

    expect(snapshot.cases.map((c) => `${c.corpus}/${c.id}`)).toEqual([
      "validation/RWB-06A",
      "adversarial-v1/ADV-001",
    ]);
    for (const c of snapshot.cases) {
      expect(c.outputStatus, c.id).toBe("ok");
      expect(c.graph, c.id).not.toBeNull();
      expect(c.schemaIssueCount, c.id).toBe(0);
    }
    const adv = snapshot.cases.find((c) => c.id === "ADV-001");
    expect(adv?.findings.map((f) => [f.key, f.verdict])).toEqual([
      ["GHSA-adv-0001 @ node_modules/adv-vuln-lib", "AFFECTED"],
    ]);
    const rwb = snapshot.cases.find((c) => c.id === "RWB-06A");
    // The case's own advisory is NOT_AFFECTED by family A (node-forge is
    // never loaded). node-forge carries other advisories too, each its own
    // finding under its own key on the same instance.
    const selected = rwb?.findings.find(
      (f) => f.vulnerability === rwb.oracle?.selector.vulnerability,
    );
    expect([selected?.verdict, selected?.proof.family]).toEqual([
      "NOT_AFFECTED",
      "A",
    ]);
    expect(new Set(rwb?.findings.map((f) => f.packageInstance))).toEqual(
      new Set(["node_modules/node-forge"]),
    );
    expect(new Set(rwb?.findings.map((f) => f.key)).size).toBe(
      rwb?.findings.length,
    );

    const text = JSON.stringify(snapshot.cases);
    expect(text).not.toContain(REPO_ROOT);
    expect(text).not.toContain(tmpdir() + path.sep);
    // The validation case's temp copy is gone.
    expect(leftoverTemps()).toEqual(before);
  });

  it("collecting the same code twice diffs to zero in all three differentials", async () => {
    const first = await collectSnapshot(options);
    const second = await collectSnapshot(options);
    const s = summarize(diffSnapshots(first, second));
    expect(s.graph).toMatchObject({
      measured: 2,
      unavailable: 0,
      casesChanged: 0,
    });
    expect(s.proof.changed).toBe(0);
    expect(s.verdict).toMatchObject({
      measured: 2,
      changed: 0,
      added: 0,
      removed: 0,
    });
  });

  it("refuses an unknown case ID rather than collecting nothing", async () => {
    await expect(
      collectSnapshot({ ...options, only: ["NO-SUCH-CASE"] }),
    ).rejects.toThrow(/no such case in the corpora: NO-SUCH-CASE/);
  });
});
