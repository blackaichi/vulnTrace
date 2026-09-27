import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, it } from "vitest";
import type { CaseRecord } from "../../scripts/differential-lib.mjs";
import {
  collectCase,
  CORPORA,
  type CollectOptions,
  type CorpusName,
  selectCases,
  snapshotOf,
} from "../../src/testing/differential-collect.js";

/**
 * BL-029 — the collector's entry point, run by `scripts/differential.mjs`
 * through `vitest.differential.config.ts` (so the TypeScript under
 * measurement is compiled exactly as the suites compile it). Not a test
 * suite: it asserts nothing, and no other vitest config includes it.
 *
 * One `it` per case, each starting with one macrotask turn. Without the
 * turn, vitest's worker failed every full run with `Timeout calling
 * "onTaskUpdate"` after all cases had passed: a scan is an async function
 * over synchronous I/O, so a whole side (over two minutes) ran on the
 * microtask queue alone, and the RPC's reply was not read until its timer
 * had expired. Splitting the corpus into one test per case was not enough
 * on its own. A case's own failure is recorded in its record by `collectCase`
 * (never thrown), so the snapshot is written only once every selected case
 * has a record, and atomically (write, then rename): a snapshot file that
 * exists is a complete one.
 *
 * Inputs, from the environment (set by the driver):
 *
 * - `VT_DIFF_OUT` (required): where to write the snapshot JSON.
 * - `VT_DIFF_CORPUS_ROOT`: the checkout whose corpus is scanned; defaults
 *   to this checkout.
 * - `VT_DIFF_CORPORA`: comma-separated corpus names; defaults to all.
 * - `VT_DIFF_ONLY`: comma-separated case IDs; defaults to every case.
 * - `VT_DIFF_LABEL`: the side's label in the report.
 */

const CODE_ROOT = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);

function list(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

const out = process.env.VT_DIFF_OUT;
if (out === undefined || out === "") {
  throw new Error(
    "VT_DIFF_OUT is not set; run this through scripts/differential.mjs",
  );
}
const corpora = list(process.env.VT_DIFF_CORPORA) ?? [...CORPORA];
const unknown = corpora.filter(
  (name) => !(CORPORA as readonly string[]).includes(name),
);
if (unknown.length > 0) {
  throw new Error(
    `unknown corpus: ${unknown.join(", ")} (known: ${CORPORA.join(", ")})`,
  );
}
const only = list(process.env.VT_DIFF_ONLY);
const options: CollectOptions = {
  corpusRoot: path.resolve(process.env.VT_DIFF_CORPUS_ROOT ?? CODE_ROOT),
  codeRoot: CODE_ROOT,
  corpora: corpora as CorpusName[],
  label: process.env.VT_DIFF_LABEL ?? CODE_ROOT,
  ...(only === undefined ? {} : { only }),
};
const selected = selectCases(options);
const records = new Map<string, CaseRecord>();

for (const [index, c] of selected.entries()) {
  it(`${c.corpus}/${c.id}`, async () => {
    // Yield one macrotask turn first; see this file's header.
    await new Promise<void>((resolve) => setImmediate(resolve));
    process.stderr.write(
      `[${options.label}] ${index + 1}/${selected.length} ${c.corpus}/${c.id}\n`,
    );
    records.set(`${c.corpus}/${c.id}`, await collectCase(c, options));
  });
}

afterAll(() => {
  const cases = selected.map((c) => records.get(`${c.corpus}/${c.id}`));
  const missing = selected.filter((_, i) => cases[i] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `not writing a snapshot: no record for ${missing.map((c) => c.id).join(", ")}`,
    );
  }
  const partial = `${out}.partial`;
  writeFileSync(
    partial,
    JSON.stringify(snapshotOf(options, cases as CaseRecord[])) + "\n",
  );
  renameSync(partial, out);
});
