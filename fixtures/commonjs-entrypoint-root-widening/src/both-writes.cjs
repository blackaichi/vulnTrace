// The LEGITIMATE multi-candidate control, and the counterpart to
// `sibling-only-safe.cjs`. Here `dangerous` really is the value of a real
// `module.exports` write, so it is a value this module can publish and
// rooting it is correct rather than over-approximation.
//
// Neither write is authoritative -- that is exactly why attribution is
// withdrawn -- so root selection takes both and picks neither.
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
  module.exports = dangerous;
  bail();
}

module.exports = safe;
