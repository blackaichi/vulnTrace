/**
 * Task BL-119 — prints the next free id of a series.
 *
 *   node scripts/next-id.mjs RWF     # a finding: RWF, PRM or AUD
 *   node scripts/next-id.mjs BL      # a backlog row
 *   node scripts/next-id.mjs D       # an OPEN-DEBTS entry
 *
 * NEVER AN ID ALREADY USED. The next id is one past the highest of two
 * sets: the ids the series' own record registers (a finding's file under
 * `tests/validation/findings/`, a row of `docs/tasks/BACKLOG.md`, a
 * `### D-NN —` entry of `docs/OPEN-DEBTS.md`), and every mention of the
 * series anywhere in the repository's records: every markdown file outside
 * `node_modules`, the build output and the vendored fixtures. A mention
 * above the register is reported: it is an id some record cites that the
 * register does not hold yet (a reservation, a record not yet written, or a
 * typo), and handing it out again would make two things share one name.
 * Code is not scanned: its tests use synthetic ids deliberately
 * (`RWF-900`, `D-99`), out of every real series' range.
 *
 * The id is zero-padded to the series' own width, as `RWF-047`, `PRM-12`,
 * `AUD-01`, `BL-001` and `D-03` are. A suffixed id (`RWF-013b`) is a sub-record of its
 * number and is never a next id.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FINDINGS_DIR } from "./findings-register.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

const SCANNED_EXTENSIONS = new Set([".md"]);
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".claude",
  "dist",
  "coverage",
  "fixtures",
]);

/** Each series, and how to read the ids its own register holds. */
export const SERIES = {
  RWF: { register: "findings", width: 3 },
  PRM: { register: "findings", width: 2 },
  AUD: { register: "findings", width: 2 },
  BL: { register: "backlog", width: 3 },
  D: { register: "openDebts", width: 2 },
};

const numbersIn = (text, series) =>
  [...text.matchAll(new RegExp(`(?<![A-Za-z0-9-])${series}-(\\d+)\\b`, "g"))].map(
    (match) => Number(match[1]),
  );

function registered(series, root) {
  const { register } = SERIES[series];
  if (register === "findings") {
    return fs
      .readdirSync(path.join(root, FINDINGS_DIR))
      .map((name) => new RegExp(`^${series}-(\\d+)\\.md$`).exec(name)?.[1])
      .filter((number) => number !== undefined)
      .map(Number);
  }
  if (register === "backlog") {
    const text = fs.readFileSync(path.join(root, "docs/tasks/BACKLOG.md"), "utf-8");
    return [...text.matchAll(/^\|\s*BL-(\d+)\s*\|/gm)].map((match) => Number(match[1]));
  }
  const text = fs.readFileSync(path.join(root, "docs/OPEN-DEBTS.md"), "utf-8");
  return [...text.matchAll(/^### D-(\d+) —/gm)].map((match) => Number(match[1]));
}

/** Every scanned file's mentions of the series: `[{ file, number }]`. */
function mentions(series, root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
        const file = path.join(dir, entry.name);
        for (const number of numbersIn(fs.readFileSync(file, "utf-8"), series)) {
          found.push({ file: path.relative(root, file), number });
        }
      }
    }
  };
  walk(root);
  return found;
}

/**
 * The next free id of `series`: `{ id, registeredMax, mentionedMax,
 * unregistered }`, where `unregistered` lists the mentions above the
 * register's highest id.
 */
export function nextId(series, root = ROOT) {
  const spec = SERIES[series];
  if (spec === undefined) {
    throw new Error(
      `next-id: unknown series ${JSON.stringify(series)}; known: ${Object.keys(SERIES).join(", ")}`,
    );
  }
  const own = registered(series, root);
  if (own.length === 0) throw new Error(`next-id: the ${series} register holds no id`);
  const registeredMax = Math.max(...own);
  const cited = mentions(series, root);
  const mentionedMax = Math.max(registeredMax, ...cited.map((m) => m.number));
  const unregistered = cited.filter((m) => m.number > registeredMax);
  const next = mentionedMax + 1;
  return {
    id: `${series}-${String(next).padStart(spec.width, "0")}`,
    registeredMax,
    mentionedMax,
    unregistered,
  };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const series = process.argv[2];
  try {
    const result = nextId(series);
    process.stdout.write(`${result.id}\n`);
    if (result.unregistered.length > 0) {
      const byNumber = new Map();
      for (const { file, number } of result.unregistered) {
        byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
      }
      process.stderr.write(
        `next-id: ${series}-${result.registeredMax} is the register's highest; ` +
          "these higher ids are cited but not registered, so they were skipped:\n" +
          [...byNumber]
            .sort(([a], [b]) => a - b)
            .map(([number, files]) => `  ${series}-${number}: ${[...new Set(files)].join(", ")}`)
            .join("\n") +
          "\n",
      );
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}
