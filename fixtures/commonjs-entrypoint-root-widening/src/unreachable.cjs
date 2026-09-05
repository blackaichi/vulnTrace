// The FAMILY C positive control. Export authority is withdrawn exactly as
// in rwf016.cjs, so root selection widens to every top-level callable --
// and NONE of them reaches `neverCalled`. Widening therefore must NOT
// destroy a genuine negative proof: this entrypoint must still come back
// NOT_AFFECTED with a complete subgraph.
//
// Without this control, RWF-021 could have "fixed" the false NOT_AFFECTED
// by making every negative proof unavailable, which is not a fix.
const dep = require("fixture-lib");

function main(userInput) {
  return dep.dangerousOp(userInput);
}

function bail() {
  throw new Error("boom");
}

if (process.env.FIXTURE_FLAG === "1") {
  bail();
}

module.exports = main;
