"use strict";
// The instance-field NEGATIVE control, deliberately identical to a.js
// except for the one token that decides the whole question: `x = bail()`
// is an INSTANCE field, not a `static` one.
//
// Evaluating this class definition installs the initializer and runs
// nothing. `bail()` executes only inside a constructor call, which is a
// caller's decision made long after this module finished loading -- so
// module evaluation continues, and the LATER (safe) export really is
// authoritative. Withdrawing authority here would be a false refusal.

function dangerousOp(input) {
  return "EXPLODED:" + input;
}

function bail() {
  throw new Error("c.js: bail() always throws (instance field, on construction)");
}

module.exports = dangerousOp;

class C {
  x = bail();
}

function safeOp(input) {
  return "safe:" + input;
}

console.log("[c.js] class C evaluated WITHOUT calling bail(); publishing safeOp");
safeOp.construct = () => new C();
module.exports = safeOp;
