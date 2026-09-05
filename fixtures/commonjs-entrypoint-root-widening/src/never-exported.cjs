// FALSE-AFFECTED control A. Export authority is withdrawn exactly as in
// rwf016.cjs, so root selection widens -- but the only value any export
// write in this file can publish is `main`, which is safe. `neverExported`
// reaches the vulnerable sink and is the right-hand side of NOTHING, so no
// run of this module can hand it to an importer.
//
// RWF-021's first cut widened to every top-level callable and rooted it,
// reporting a call path that cannot execute. Widening must be bounded by
// what the export writes can actually publish.
const dep = require("fixture-lib");

function main(userInput) {
  return "safe:" + userInput;
}

function neverExported(userInput) {
  return dep.dangerousOp(userInput);
}

function bail() {
  throw new Error("boom");
}

if (process.env.FIXTURE_FLAG === "1") {
  bail();
}

module.exports = main;
