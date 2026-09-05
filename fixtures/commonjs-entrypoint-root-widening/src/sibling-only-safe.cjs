// FALSE-AFFECTED control B. Two top-level callables exist and only the
// safe one is ever written to `module.exports`. `dangerous` is a sibling
// helper, not a plausible exported value, so it must not be rooted.
//
// Contrast with `both-writes.cjs`, where `dangerous` IS the value of a
// real export write and rooting it is legitimate. The difference between
// those two files is the whole of RWF-021's second invariant.
const dep = require("fixture-lib");

function safe(userInput) {
  return "safe:" + userInput;
}

function dangerous(userInput) {
  return dep.dangerousOp(userInput);
}

function bail() {
  throw new Error("boom");
}

if (process.env.FIXTURE_FLAG === "1") {
  bail();
}

module.exports = safe;
