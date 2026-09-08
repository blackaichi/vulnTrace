"use strict";
// Every heritage-VALUE category RWF-022 reasons about, measured rather than
// asserted from the spec. `probe` returns "threw:<Ctor>" or "completed", so
// the table below is a direct record of what this Node build does.

function probe(defineClass) {
  try {
    defineClass();
    return "completed";
  } catch (err) {
    return "threw:" + err.constructor.name;
  }
}

/**
 * Each row: [label, expected, defineClass]. `expected` is what RWF-022's
 * classifier must be consistent with -- "threw:TypeError" for a value it
 * may call definitely-non-constructable, "completed" for one it must NOT.
 */
const ROWS = [
  // --- definitely non-constructable: the values RWF-022 classifies -------
  ["return 1", "threw:TypeError", () => { function f() { return 1; } return class extends f() {}; }],
  ["return 0", "threw:TypeError", () => { function f() { return 0; } return class extends f() {}; }],
  ["return 1n", "threw:TypeError", () => { function f() { return 1n; } return class extends f() {}; }],
  ['return "x"', "threw:TypeError", () => { function f() { return "x"; } return class extends f() {}; }],
  ["return `x`", "threw:TypeError", () => { function f() { return `x`; } return class extends f() {}; }],
  ["return `a${1}b`", "threw:TypeError", () => { function f() { return `a${1}b`; } return class extends f() {}; }],
  ["return true", "threw:TypeError", () => { function f() { return true; } return class extends f() {}; }],
  ["return false", "threw:TypeError", () => { function f() { return false; } return class extends f() {}; }],
  ["return {}", "threw:TypeError", () => { function f() { return {}; } return class extends f() {}; }],
  ["return { __proto__: Function.prototype }", "threw:TypeError", () => { function f() { return { __proto__: Function.prototype }; } return class extends f() {}; }],
  ["return { constructor: function () {} }", "threw:TypeError", () => { function f() { return { constructor: function () {} }; } return class extends f() {}; }],
  ["return []", "threw:TypeError", () => { function f() { return []; } return class extends f() {}; }],
  ["return () => {}", "threw:TypeError", () => { function f() { return () => {}; } return class extends f() {}; }],
  ["return async function B() {}", "threw:TypeError", () => { function f() { return async function B() {}; } return class extends f() {}; }],
  ["return function* B() {}", "threw:TypeError", () => { function f() { return function* B() {}; } return class extends f() {}; }],
  ["return async function* B() {}", "threw:TypeError", () => { function f() { return async function* B() {}; } return class extends f() {}; }],
  ["return; (bare)", "threw:TypeError", () => { function f() { return; } return class extends f() {}; }],
  ["empty body (implicit undefined)", "threw:TypeError", () => { function f() {} return class extends f() {}; }],
  ["concise arrow body `() => 1`", "threw:TypeError", () => { const f = () => 1; return class extends f() {}; }],

  // --- non-constructable by CALLEE identity, no body analysis -----------
  ["async callee -> Promise", "threw:TypeError", () => { async function f() { return 1; } const c = class extends f() {}; return c; }],
  ["generator callee -> Generator", "threw:TypeError", () => { function* f() { yield 1; } return class extends f() {}; }],
  ["async generator callee -> AsyncGenerator", "threw:TypeError", () => { async function* f() { yield 1; } return class extends f() {}; }],

  // --- VALID: must never be classified non-constructable ----------------
  ["return null", "completed", () => { function f() { return null; } return class extends f() {}; }],
  ["return class B {}", "completed", () => { function f() { return class B {}; } return class extends f() {}; }],
  ["return function B() {}", "completed", () => { function f() { return function B() {}; } return class extends f() {}; }],
  ["direct `extends null`", "completed", () => class extends null {}],

  // --- direct (non-call) heritage values --------------------------------
  ["direct `extends 1`", "threw:TypeError", () => class extends 1 {}],
  ["direct `extends (() => {})`", "threw:TypeError", () => class extends (() => {}) {}],
  ["direct `extends (class B {})`", "completed", () => class extends (class B {}) {}],

  // --- boundaries RWF-022 deliberately does NOT classify ----------------
  // Recorded so the fixture shows what the analyzer is leaving on the table
  // rather than hiding it. Both throw at runtime; neither is modeled.
  ["return Base.bind(null) [UNMODELED]", "threw:TypeError", () => { class B {} function f() { return B.bind(null); } return class extends f() {}; }],
  ["return new Proxy({}, {}) [UNMODELED]", "threw:TypeError", () => { function f() { return new Proxy({}, {}); } return class extends f() {}; }],
];

function report() {
  let mismatches = 0;
  for (const [label, expected, defineClass] of ROWS) {
    const actual = probe(defineClass);
    const mark = actual === expected ? "ok  " : "DIFF";
    if (actual !== expected) {
      mismatches += 1;
    }
    console.log(`  [${mark}] ${label.padEnd(42)} -> ${actual}`);
  }
  return mismatches;
}

/**
 * Proves the ORDER RWF-022 depends on: heritage validation happens before
 * ANY class element is evaluated, so a class whose heritage value is
 * invalid evaluates no computed key and no field initializer.
 */
function reportOrder() {
  const evaluated = [];
  function notAConstructor() {
    evaluated.push("heritage call ran");
    return 1;
  }
  function tag(name) {
    evaluated.push(name);
    return name;
  }
  let threw;
  try {
    class C extends notAConstructor() {
      [tag("computed key")] = 1;
      static s = tag("static field");
    }
    evaluated.push("class definition completed");
    return { evaluated, threw: undefined, klass: C };
  } catch (err) {
    threw = err;
  }
  return { evaluated, threw };
}

module.exports = { report, reportOrder, ROWS: ROWS.map(([l, e]) => [l, e]) };
