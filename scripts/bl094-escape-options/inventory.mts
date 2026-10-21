// BL-094: the inventory of the escape row's class. Every oracle case of
// the tasks that built and re-audited the "unless proven" rule (BL-081,
// BL-091, BL-095, BL-099, BL-100) whose `base` verdict was `NOT_AFFECTED`
// while real Node runs the replacement (`called: true`) -- a historical
// false `NOT_AFFECTED` -- is classified by the clause of the rule it broke.
//
// Usage: npx vite-node scripts/bl094-escape-options/inventory.mts [--list]
//
// The axes (the first rule that matches a case's id wins; the order below
// is the order of the checks):
//
// - `rule-absent`: a builtin reached without its name, before BL-081 made
//   every store onto an unproven object an escape -- the rule's own reason
//   to exist, not a gap in it;
// - `store-form`: a store form the closed list missed (`with`, `for…of`,
//   a pattern, a declaration);
// - `class`: a class's semantics -- its inheritance (`extends`), its
//   `this`, its static side, its `prototype`, a class handed over with
//   its members;
// - `prototype-chain`: a non-class object whose [[Prototype]] a store or
//   a literal changes, or that inherits its `prototype`;
// - `route`: a value or key route a freshness proof of a non-class object
//   followed wrongly (aliases, `prototype` / `exports` written by a
//   builtin or another file, key spellings, the proofs' bookkeeping, a
//   function handed over with its members);
// - `typescript-emit`: a store, read or call TypeScript's emit makes that
//   the source does not show (fields at a target below ES2022, an ES5
//   class, a namespace, an enum, a decorator's helpers, a namespace
//   member's scope).
//
// Whether an O2 tier would have pre-empted a case is the measurement of
// `scripts/bl094-escape-options/*.patch` against the oracle suites, not
// this classification's.

import { BL081_CASES } from "../../tests/oracle/bl081-builtin-replaced-without-name.cases.js";
import {
  BL091_CASES,
  BL091_TYPESCRIPT_CASES,
} from "../../tests/oracle/bl091-builtin-store-reaudit.cases.js";
import { BL095_CASES } from "../../tests/oracle/bl095-typescript-emit-stores.cases.js";
import { BL099_CASES } from "../../tests/oracle/bl099-namespace-export-member-read.cases.js";
import { BL100_CASES } from "../../tests/oracle/bl100-decorator-helper-calls.cases.js";

interface Row {
  readonly suite: string;
  readonly id: string;
  readonly finding: string;
  readonly base: string;
  readonly called: boolean;
}

const SUITES: Record<string, readonly unknown[]> = {
  "BL-081": BL081_CASES,
  "BL-091": [...BL091_CASES, ...BL091_TYPESCRIPT_CASES],
  "BL-095": BL095_CASES,
  "BL-099": BL099_CASES,
  "BL-100": BL100_CASES,
};

const RULE_ABSENT = new Set([
  "rwf110.constructor-of-a-literal",
  "rwf110.sibling-constructor-of-a-literal",
  "rwf110.sibling-install-object",
  "rwf110.install-object-same-file",
  "rwf110.entry-before-loading",
  "rwf110.destructured-constructor",
  "rwf110.constructor-of-exports",
  "rwf110.opaque-value-through-a-parameter",
  "rwf063.container",
  "rwf063.returned",
  "rwf063.load-result",
  "rwf063.path-through-a-parameter",
  "rwf063.fs-through-a-parameter",
  "rwf063.global-object-through-a-parameter",
  "rwf063.sloppy-this-is-the-global-object",
]);

const AXES: readonly (readonly [string, (row: Row) => boolean])[] = [
  ["rule-absent", (row) => RULE_ABSENT.has(row.id)],
  [
    "typescript-emit",
    (row) =>
      row.suite === "BL-095" ||
      row.suite === "BL-099" ||
      row.suite === "BL-100" ||
      ["RWF-127", "RWF-128"].includes(row.finding),
  ],
  [
    "store-form",
    (row) =>
      row.finding === "RWF-120" ||
      /in-a-with-body|declared-in-a-with-body|in-a-for-of|from-a-with-body/.test(
        row.id,
      ),
  ],
  [
    "class",
    (row) =>
      ["RWF-124", "RWF-126"].includes(row.finding) ||
      /class/.test(row.id),
  ],
  [
    "prototype-chain",
    (row) =>
      /async-function-prototype-inherited|literal-with-global-prototype|prototype-changed-to-the-global|holding-proto$|replaced-with-proto/.test(
        row.id,
      ),
  ],
  ["route", () => true],
];

const rows: (Row & { axis: string })[] = [];
for (const [suite, cases] of Object.entries(SUITES)) {
  for (const raw of cases) {
    const c = raw as Row;
    if (c.base !== "NOT_AFFECTED" || c.called !== true) {
      continue;
    }
    const row = { suite, id: c.id, finding: c.finding, base: c.base, called: c.called };
    rows.push({ ...row, axis: AXES.find(([, test]) => test(row))![0] });
  }
}

const axes = AXES.map(([axis]) => axis);
const suites = Object.keys(SUITES);
console.log(`historical false NOT_AFFECTED: ${rows.length}`);
console.log(`| axis | ${suites.join(" | ")} | all |`);
console.log(`| --- | ${suites.map(() => "---:").join(" | ")} | ---: |`);
for (const axis of axes) {
  const cells = suites.map(
    (suite) => rows.filter((r) => r.axis === axis && r.suite === suite).length,
  );
  console.log(
    `| ${axis} | ${cells.join(" | ")} | ${cells.reduce((a, b) => a + b, 0)} |`,
  );
}
if (process.argv.includes("--list")) {
  for (const row of rows) {
    console.log(`${row.axis}\t${row.suite}\t${row.finding}\t${row.id}`);
  }
}
