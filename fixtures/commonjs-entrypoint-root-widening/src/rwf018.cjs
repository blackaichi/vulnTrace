// RWF-018's cutoff shape (the call in a class static field), on a CONFIGURED ENTRYPOINT.
//
// `main` is the only path to the sink, and nothing in this file calls it:
// it runs only because an outside caller invokes this module's exported
// value. `bail()` above the export write makes that write bypassable, so
// export ATTRIBUTION is (correctly) withdrawn -- and before RWF-021 the
// entrypoint ROOT went with it, hiding `main`'s body from reachability and
// producing a complete Family C proof for a genuinely reachable sink.
const dep = require("fixture-lib");

function main(userInput) {
  return dep.dangerousOp(userInput);
}

function bail() {
  throw new Error("boom");
}

if (process.env.FIXTURE_FLAG === "1") {
  class Mode {
    static ready = bail();
  }
}

module.exports = main;
