"use strict";

// Which local bindings does an assignment TARGET actually rebind?
//
// Every row below is asserted, not printed. `evaluated` records whether the
// language ran the expression at all; `rebound` records whether the local
// binding named by that expression's identifier holds something different
// afterwards. The two are independent, and conflating them is exactly the
// defect RWF-025 fixes.
const assert = require("node:assert");

const rows = [];

/** Runs one probe and records the observed (evaluated, rebound) pair. */
function probe(label, run) {
  const observed = run();
  rows.push({ label, ...observed });
  return observed;
}

// ---------------------------------------------------------------------------
// 1. A computed KEY in a destructuring assignment: EVALUATED, not REBOUND.
// ---------------------------------------------------------------------------
probe("({ [key()]: target } = source)", () => {
  let calls = 0;
  let target;
  function key() {
    calls++;
    return "k";
  }
  const before = key;
  ({ [key()]: target } = { k: "read" });
  return {
    keyEvaluated: calls === 1,
    keyRebound: before !== key,
    targetRebound: target === "read",
  };
});

// ---------------------------------------------------------------------------
// 2. The same shape where the key callee THROWS: proof the key really runs.
// ---------------------------------------------------------------------------
probe("({ [bail()]: target } = source) throws", () => {
  let target;
  function bail() {
    throw new Error("key evaluated");
  }
  let message = null;
  try {
    ({ [bail()]: target } = { k: 1 });
  } catch (e) {
    message = e.message;
  }
  return { keyEvaluated: message === "key evaluated", targetRebound: false };
});

// ---------------------------------------------------------------------------
// 3. Key AND target are the SAME name: the key is evaluated with the OLD
//    value, and the target rebinds it. Both roles are real.
// ---------------------------------------------------------------------------
probe("({ [bail()]: bail } = source)", () => {
  let calls = 0;
  let bail = function () {
    calls++;
    return "k";
  };
  ({ [bail()]: bail } = { k: "replacement" });
  return { keyEvaluated: calls === 1, targetRebound: bail === "replacement" };
});

// ---------------------------------------------------------------------------
// 4. A DEFAULT initializer: evaluated when the source property is absent,
//    and it rebinds the TARGET, never the default's own callee.
// ---------------------------------------------------------------------------
probe("({ target = fallback() } = source)", () => {
  let calls = 0;
  let target;
  function fallback() {
    calls++;
    return "fb";
  }
  const before = fallback;
  ({ target = fallback() } = {});
  return {
    keyEvaluated: calls === 1,
    keyRebound: before !== fallback,
    targetRebound: target === "fb",
  };
});

// ---------------------------------------------------------------------------
// 5. An ELEMENT-ACCESS target inside an array pattern: the index expression
//    runs, and NOTHING local is rebound -- a property of `holder` is.
// ---------------------------------------------------------------------------
probe("[holder[key()]] = values", () => {
  let calls = 0;
  function key() {
    calls++;
    return "slot";
  }
  const before = key;
  const holder = {};
  [holder[key()]] = ["written"];
  return {
    keyEvaluated: calls === 1,
    keyRebound: before !== key,
    holderRebound: false,
    propertyWritten: holder.slot === "written",
  };
});

// ---------------------------------------------------------------------------
// 6. A plain element-access target. Same answer.
// ---------------------------------------------------------------------------
probe("holder[key()] = value", () => {
  let calls = 0;
  function key() {
    calls++;
    return "slot";
  }
  const before = key;
  const holder = {};
  holder[key()] = "written";
  return {
    keyEvaluated: calls === 1,
    keyRebound: before !== key,
    holderRebound: false,
    propertyWritten: holder.slot === "written",
  };
});

// ---------------------------------------------------------------------------
// 7. GENUINE destructuring rebinds, in every form the language offers.
// ---------------------------------------------------------------------------
probe("genuine rebinds", () => {
  let shorthand = "old";
  let aliased = "old";
  let nested = "old";
  let rest;
  let arrayed = "old";
  let arrayRest;
  let defaulted = "old";
  ({ shorthand } = { shorthand: "new" });
  ({ k: aliased } = { k: "new" });
  ({ outer: { nested } } = { outer: { nested: "new" } });
  ({ ...rest } = { a: 1 });
  [arrayed] = ["new"];
  [...arrayRest] = ["new"];
  ({ defaulted = "new" } = {});
  return {
    shorthand: shorthand === "new",
    aliased: aliased === "new",
    nested: nested === "new",
    rest: rest.a === 1,
    arrayed: arrayed === "new",
    arrayRest: arrayRest[0] === "new",
    defaulted: defaulted === "new",
  };
});

module.exports = { rows, probe };

// The assertions. Each mirrors one line of RWF-025's semantic rule.
assert.deepStrictEqual(rows[0], {
  label: "({ [key()]: target } = source)",
  keyEvaluated: true,
  keyRebound: false,
  targetRebound: true,
});
assert.deepStrictEqual(rows[1], {
  label: "({ [bail()]: target } = source) throws",
  keyEvaluated: true,
  targetRebound: false,
});
assert.deepStrictEqual(rows[2], {
  label: "({ [bail()]: bail } = source)",
  keyEvaluated: true,
  targetRebound: true,
});
assert.deepStrictEqual(rows[3], {
  label: "({ target = fallback() } = source)",
  keyEvaluated: true,
  keyRebound: false,
  targetRebound: true,
});
assert.deepStrictEqual(rows[4], {
  label: "[holder[key()]] = values",
  keyEvaluated: true,
  keyRebound: false,
  holderRebound: false,
  propertyWritten: true,
});
assert.deepStrictEqual(rows[5], {
  label: "holder[key()] = value",
  keyEvaluated: true,
  keyRebound: false,
  holderRebound: false,
  propertyWritten: true,
});
assert.deepStrictEqual(rows[6], {
  label: "genuine rebinds",
  shorthand: true,
  aliased: true,
  nested: true,
  rest: true,
  arrayed: true,
  arrayRest: true,
  defaulted: true,
});
