/**
 * Task BL-120 — the comparison logic of `measure-options.mjs`, pure, so
 * `src/testing/measure-options-lib.test.ts` can drive it from synthetic
 * reports with no worktree, build or suite run.
 *
 * WHAT IS COMPARED, PER OPTION, AGAINST THE BASE (the four quantities
 * BL-094, BL-096, BL-111 and BL-114 each measured by hand):
 *
 * 1. THE ORACLE SUITE (`vitest.oracle.config.ts`, a vitest JSON report per
 *    side). Each test is keyed by its file, relative to its side's root,
 *    and its full name. A test that passes on the base and fails under the
 *    option is classified by its failure message, which
 *    `openSoundnessDefectProblems` (`src/testing/open-soundness-defect.ts`)
 *    writes in fixed words:
 *    - `flipped`: "is now ADMISSIBLE" — an open-soundness-defect record
 *      whose live result became sound; the option closes that case;
 *    - `drifted`: "the defect DRIFTED" — a record whose wrong result
 *      changed into another wrong one;
 *    - `lost`: any other failure — a control the option gives up (a
 *      proof, an edge, a precision case), or a new breakage. Read each.
 *    A message naming both is `drifted`: a drift is never counted as a
 *    fix. A test that fails on the base and passes under the option is
 *    `gained`; a test on one side only is listed, never counted as
 *    unchanged.
 * 2. THE DIFFERENTIALS (`scripts/differential.mjs --diff`'s `diff.json`):
 *    graph, proof and verdict, reported separately with
 *    `differential-lib.mjs`'s own `summarize`, and every verdict that
 *    moved, those into `NOT_AFFECTED` named first.
 * 3. THE SUITES' `NOT_AFFECTED` PROOFS, by corpus: of the cases whose
 *    expected verdict is `NOT_AFFECTED` and whose base verdict (the
 *    suite's own selector) is `NOT_AFFECTED`, those the option loses; and
 *    every case whose selected verdict moved INTO `NOT_AFFECTED`.
 * 4. THE CENSUS (optional): the files, and the packages holding them, for
 *    which a caller's predicate is true, over a set of roots.
 *
 * A side that could not be measured is reported as such, never as zero.
 */

import path from "node:path";

import { summarize } from "./differential-lib.mjs";

/** The fixed words of `openSoundnessDefectProblems`' two live-result messages. */
export const RECORD_FLIPPED = "is now ADMISSIBLE";
export const RECORD_DRIFTED = "the defect DRIFTED";

/**
 * The outcome of every test of a vitest JSON report, keyed
 * `<file relative to root> > <full name>`. A file that failed before any
 * of its tests ran is one entry, `<file> > (file)`.
 */
export function oracleOutcomes(report, root) {
  const outcomes = new Map();
  for (const file of report.testResults ?? []) {
    const rel = path.relative(root, file.name).split(path.sep).join("/");
    const tests = file.assertionResults ?? [];
    if (tests.length === 0 && file.status === "failed") {
      outcomes.set(`${rel} > (file)`, {
        status: "failed",
        messages: [file.message ?? ""],
      });
      continue;
    }
    for (const test of tests) {
      outcomes.set(`${rel} > ${test.fullName}`, {
        status: test.status,
        messages: test.failureMessages ?? [],
      });
    }
  }
  return outcomes;
}

/** How a test that passes on the base and fails under the option failed. */
export function classifyFailure(messages) {
  const text = messages.join("\n");
  if (text.includes(RECORD_DRIFTED)) return "drifted";
  if (text.includes(RECORD_FLIPPED)) return "flipped";
  return "lost";
}

/** Compares two sides' oracle outcomes. */
export function compareOracle(base, option) {
  const result = {
    run: option.size,
    passed: [...option.values()].filter((o) => o.status === "passed").length,
    flipped: [],
    drifted: [],
    lost: [],
    gained: [],
    onlyBase: [],
    onlyOption: [],
  };
  for (const [key, b] of base) {
    const o = option.get(key);
    if (o === undefined) {
      result.onlyBase.push(key);
    } else if (b.status === "passed" && o.status === "failed") {
      result[classifyFailure(o.messages)].push(key);
    } else if (b.status === "failed" && o.status === "passed") {
      result.gained.push(key);
    }
  }
  for (const key of option.keys()) {
    if (!base.has(key)) result.onlyOption.push(key);
  }
  for (const list of Object.values(result)) {
    if (Array.isArray(list)) list.sort();
  }
  return result;
}

/** Counts a side's own oracle report, for the base's column. */
export function oracleTotals(outcomes) {
  const values = [...outcomes.values()];
  return {
    run: values.length,
    passed: values.filter((o) => o.status === "passed").length,
  };
}

const corpusOf = (caseKey) => caseKey.slice(0, caseKey.indexOf("/"));

/** The differentials and the suites' proofs, from one `diff.json`. */
export function summarizeDifferential(diff) {
  const summary = summarize(diff);
  const verdictsMoved = [...diff.verdict.changed]
    .map((c) => ({ case: c.case, key: c.key, from: c.from, to: c.to }))
    .sort((a, b) =>
      a.to === "NOT_AFFECTED" && b.to !== "NOT_AFFECTED"
        ? -1
        : b.to === "NOT_AFFECTED" && a.to !== "NOT_AFFECTED"
          ? 1
          : `${a.case} ${a.key}`.localeCompare(`${b.case} ${b.key}`),
    );
  const proofs = {};
  const intoNotAffected = [];
  for (const row of diff.suite) {
    const corpus = corpusOf(row.case);
    proofs[corpus] ??= { held: 0, lost: [] };
    if (row.expected === "NOT_AFFECTED" && row.base === "NOT_AFFECTED") {
      proofs[corpus].held += 1;
      if (row.head !== "NOT_AFFECTED") {
        proofs[corpus].lost.push({ case: row.case, to: row.head });
      }
    }
    if (row.head === "NOT_AFFECTED" && row.base !== "NOT_AFFECTED") {
      intoNotAffected.push({
        case: row.case,
        expected: row.expected,
        from: row.base,
      });
    }
  }
  return {
    summary,
    verdictsMoved,
    suite: { proofs, intoNotAffected, moved: summary.suiteMoved },
    unmeasured: diff.cases.unmeasured.map((u) => u.case),
    onlyOneSide: [...diff.cases.onlyBase, ...diff.cases.onlyHead],
  };
}

/** The package directory a file belongs to: the path through `node_modules/<name>`. */
export function packageOf(file) {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length - 1) return "(no package)";
  const width = parts[at + 1].startsWith("@") ? 2 : 1;
  return parts.slice(0, at + 1 + width).join("/");
}

/** Aggregates per-file census results: `{ file, flagged }` entries. */
export function aggregateCensus(entries) {
  const packages = new Map();
  let flagged = 0;
  for (const { file, flagged: hit } of entries) {
    const pkg = packageOf(file);
    packages.set(pkg, (packages.get(pkg) ?? false) || hit);
    if (hit) flagged += 1;
  }
  return {
    files: entries.length,
    flagged,
    packages: packages.size,
    packagesFlagged: [...packages.values()].filter(Boolean).length,
  };
}

const pct = (n, of) => (of === 0 ? "—" : `${((100 * n) / of).toFixed(1)} %`);
const LIST_LIMIT = 40;

function list(items, render = (x) => `\`${x}\``) {
  if (items.length === 0) return ["  - none"];
  const lines = items.slice(0, LIST_LIMIT).map((x) => `  - ${render(x)}`);
  if (items.length > LIST_LIMIT) {
    lines.push(`  - … and ${items.length - LIST_LIMIT} more (summary.json)`);
  }
  return lines;
}

/**
 * The report. `sides` is the base first, then every option, each
 * `{ name, error?, oracle?, differential?, census? }`, where `oracle` is
 * the base's {@link oracleTotals} or an option's {@link compareOracle},
 * `differential` an option's {@link summarizeDifferential}, and `census`
 * {@link aggregateCensus} or `{ error }`. A missing part is "not measured".
 */
export function renderReport({ base, sides, notes = [] }) {
  const NM = "not measured";
  const cell = (side, pick) => {
    if (side.error !== undefined) return "error";
    try {
      const value = pick(side);
      return value === undefined ? NM : String(value);
    } catch {
      return NM;
    }
  };
  const [baseSide, ...options] = sides;
  const corpora = [
    ...new Set(
      options.flatMap((o) => Object.keys(o.differential?.suite.proofs ?? {})),
    ),
  ].sort();
  const census = (s) =>
    s.census === undefined
      ? undefined
      : s.census.error !== undefined
        ? "unavailable"
        : s.census;
  const rows = [
    [
      "oracle tests passed / run",
      (s) => s.oracle && `${s.oracle.passed} / ${s.oracle.run}`,
      true,
    ],
    ["open records flipped (now admissible)", (s) => s.oracle?.flipped.length],
    ["open records drifted", (s) => s.oracle?.drifted.length],
    ["controls lost (pass on the base, fail here)", (s) => s.oracle?.lost.length],
    ["tests gained (fail on the base, pass here)", (s) => s.oracle?.gained.length],
    [
      "oracle tests on one side only",
      (s) => s.oracle && s.oracle.onlyBase.length + s.oracle.onlyOption.length,
    ],
    [
      "census: files flagged",
      (s) => {
        const c = census(s);
        return typeof c === "object"
          ? `${c.flagged} of ${c.files} (${pct(c.flagged, c.files)})`
          : c;
      },
      true,
    ],
    [
      "census: packages with a flagged file",
      (s) => {
        const c = census(s);
        return typeof c === "object"
          ? `${c.packagesFlagged} of ${c.packages} (${pct(c.packagesFlagged, c.packages)})`
          : c;
      },
      true,
    ],
    [
      "graph differential: cases changed (sites changed)",
      (s) =>
        s.differential &&
        `${s.differential.summary.graph.casesChanged} (${s.differential.summary.graph.sitesChanged})`,
    ],
    [
      "proof differential: findings changed",
      (s) => s.differential?.summary.proof.changed,
    ],
    [
      "verdict differential: changed (into `NOT_AFFECTED`)",
      (s) =>
        s.differential &&
        `${s.differential.summary.verdict.changed} (**${s.differential.summary.verdict.intoNotAffected}**)`,
    ],
    [
      "suite verdicts moved (into `NOT_AFFECTED`)",
      (s) =>
        s.differential &&
        `${s.differential.suite.moved} (**${s.differential.suite.intoNotAffected.length}**)`,
    ],
    ...corpora.map((corpus) => [
      `\`${corpus}\` \`NOT_AFFECTED\` proofs lost`,
      (s) => {
        const p = s.differential?.suite.proofs[corpus];
        return p && `${p.lost.length} of ${p.held}`;
      },
    ]),
    [
      "corpus cases not measured / on one side",
      (s) =>
        s.differential &&
        `${s.differential.unmeasured.length} / ${s.differential.onlyOneSide.length}`,
    ],
  ];

  const lines = [
    `# Options measured against \`${base}\``,
    "",
    "Produced by `node scripts/measure-options.mjs` (task BL-120). Each",
    "option is a patch applied to the base in its own detached worktree;",
    "every column but the base's is compared with the base's.",
    "",
    `| | ${sides.map((s) => `\`${s.name}\``).join(" | ")} |`,
    `| --- | ${sides.map(() => "---:").join(" | ")} |`,
  ];
  for (const [label, pick, baseToo] of rows) {
    const baseCell = baseToo ? cell(baseSide, pick) : "—";
    lines.push(
      `| ${label} | ${[baseCell, ...options.map((o) => cell(o, pick))].join(" | ")} |`,
    );
  }
  for (const side of sides) {
    if (side.error !== undefined) {
      lines.push("", `**\`${side.name}\` was not measured:** ${side.error}`);
    }
  }
  for (const o of options) {
    if (o.error !== undefined) continue;
    lines.push("", `## \`${o.name}\``, "");
    if (o.differential) {
      const d = o.differential;
      lines.push("- Suite verdicts moved **into `NOT_AFFECTED`**:");
      lines.push(
        ...list(d.suite.intoNotAffected, (r) => `\`${r.case}\`: ${r.from} → NOT_AFFECTED (expected ${r.expected})`),
      );
      lines.push("- `NOT_AFFECTED` proofs lost:");
      lines.push(
        ...list(
          Object.values(d.suite.proofs).flatMap((p) => p.lost),
          (r) => `\`${r.case}\` → ${r.to}`,
        ),
      );
      lines.push("- Verdicts moved (every finding, `NOT_AFFECTED` first):");
      lines.push(
        ...list(d.verdictsMoved, (v) => `\`${v.case}\` \`${v.key}\`: ${v.from} → ${v.to}`),
      );
    }
    if (o.oracle) {
      lines.push("- Open records flipped:", ...list(o.oracle.flipped));
      lines.push("- Open records drifted:", ...list(o.oracle.drifted));
      lines.push("- Controls lost:", ...list(o.oracle.lost));
      lines.push("- Tests gained:", ...list(o.oracle.gained));
      const oneSide = [...o.oracle.onlyBase, ...o.oracle.onlyOption];
      if (oneSide.length > 0) lines.push("- On one side only:", ...list(oneSide));
    }
    if (o.census?.error !== undefined) {
      lines.push(`- Census unavailable: ${o.census.error}`);
    }
  }
  if (notes.length > 0) {
    lines.push("", "## Notes", "", ...notes.map((n) => `- ${n}`));
  }
  return lines.join("\n") + "\n";
}
