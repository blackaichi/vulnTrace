"use strict";
// The RWF-027 outcome matrix, measured rather than asserted from memory.
//
// Each row is a heritage factory with MORE THAN ONE ending. For every row
// the driver runs EVERY relevant flag combination, performs the real class
// definition with the value that ending produced, and records whether the
// class definition completed -- i.e. whether a later `module.exports = safeOp`
// would have run.
//
// `expected` is what VulnTrace's model claims: `true` means "no combination
// completes the class definition", so the later export's authority may be
// withdrawn. A single completing combination makes the row `false`, and the
// model MUST refuse it.

class Base {}
function Ctor() {}

const ROWS = [
  // ---- every ending is class-definition-fatal: withdrawal is correct ----
  {
    name: "throw + invalid (B01)",
    arity: 1,
    fn: (flag) => {
      if (flag) {
        throw new Error("boom");
      }
      return 1;
    },
    expected: true,
  },
  {
    name: "invalid + invalid (B02)",
    arity: 1,
    fn: (flag) => {
      if (flag) {
        return 1;
      }
      return 2;
    },
    expected: true,
  },
  {
    name: "invalid number + invalid string",
    arity: 1,
    fn: (flag) => (flag ? 1 : "x"),
    expected: true,
  },
  {
    name: "invalid object + invalid boolean",
    arity: 1,
    fn: (flag) => (flag ? {} : true),
    expected: true,
  },
  {
    name: "throw + throw (RWF-020 already had this)",
    arity: 1,
    fn: (flag) => {
      if (flag) {
        throw new Error("a");
      }
      throw new Error("b");
    },
    expected: true,
  },
  {
    name: "invalid + implicit undefined (fallthrough)",
    arity: 1,
    fn: (flag) => {
      if (flag) return 1;
    },
    expected: true,
  },
  {
    name: "bare return (undefined) + invalid",
    arity: 1,
    fn: (flag) => {
      if (flag) return;
      return 1;
    },
    expected: true,
  },
  {
    name: "empty body (undefined on every path)",
    arity: 1,
    fn: () => {},
    expected: true,
  },
  {
    name: "early return invalid, then throw",
    arity: 1,
    fn: (flag) => {
      if (flag) {
        return 1;
      }
      throw new Error("boom");
    },
    expected: true,
  },
  {
    name: "nested if, every leaf fatal",
    arity: 2,
    fn: (a, b) => {
      if (a) {
        if (b) return 1;
        throw new Error("boom");
      }
      return 2;
    },
    expected: true,
  },

  // ---- one surviving good ending: withdrawal would be an OVERREACH ----
  {
    name: "throw + constructable (B04)",
    arity: 1,
    fn: (flag) => {
      if (flag) {
        throw new Error("boom");
      }
      return Base;
    },
    expected: false,
  },
  {
    name: "invalid + constructable (B05)",
    arity: 1,
    fn: (flag) => {
      if (flag) {
        return 1;
      }
      return Base;
    },
    expected: false,
  },
  {
    name: "invalid + valid NULL",
    arity: 1,
    fn: (flag) => {
      if (flag) {
        return 1;
      }
      return null;
    },
    expected: false,
  },
  {
    name: "throw + valid NULL",
    arity: 1,
    fn: (flag) => {
      if (flag) {
        throw new Error("boom");
      }
      return null;
    },
    expected: false,
  },
  {
    name: "invalid + ordinary function (constructable)",
    arity: 1,
    fn: (flag) => (flag ? 1 : Ctor),
    expected: false,
  },
  {
    name: "nested if with a constructable leaf",
    arity: 2,
    fn: (a, b) => {
      if (a) {
        if (b) return Base;
        throw new Error("boom");
      }
      return 2;
    },
    expected: false,
  },
];

function flagSets(arity) {
  return arity === 1
    ? [[true], [false]]
    : [
        [true, true],
        [true, false],
        [false, true],
        [false, false],
      ];
}

/** Runs every row against every flag combination. Returns the mismatch count. */
function report() {
  let mismatches = 0;
  for (const row of ROWS) {
    const outcomes = [];
    let anyCompleted = false;
    for (const flags of flagSets(row.arity)) {
      let outcome;
      try {
        const value = row.fn(...flags);
        class C extends value {} // eslint-disable-line no-unused-vars
        void C;
        outcome = "class definition COMPLETED";
        anyCompleted = true;
      } catch (err) {
        outcome = "ABORTED " + err.constructor.name + ": " + err.message;
      }
      outcomes.push(`  flags=[${flags.join(", ")}] -> ${outcome}`);
    }
    const measured = !anyCompleted;
    const ok = measured === row.expected;
    if (!ok) mismatches += 1;
    console.log(
      `${ok ? "ok  " : "MISMATCH"} ${row.name}: every-path-fatal=${measured} (expected ${row.expected})`,
    );
    for (const line of outcomes) console.log(line);
  }
  return mismatches;
}

module.exports = { report };
