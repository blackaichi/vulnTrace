// RWF-022's cutoff shape (a heritage call that RETURNS a value that is not a
// constructor), on a CONFIGURED ENTRYPOINT.
//
// Held identical to `rwf019.cjs` in every other respect.
// `main` is the only path to the sink, and nothing in this file calls it: it
// runs only because an outside caller invokes this module's exported value.
// The class above the export write makes that write bypassable, so export
// ATTRIBUTION is (correctly) withdrawn -- and RWF-021's invariant is that the
// entrypoint ROOT must NOT go with it, or `main`'s body would be hidden from
// reachability and a complete Family C proof would be issued for a genuinely
// reachable sink.
//
// When FIXTURE_FLAG is not "1" the class is never evaluated, this module
// exports `main`, and calling it reaches `dep.dangerousOp`. So NOT_AFFECTED
// is never a correct answer here, whatever RWF-022 does to attribution.
const dep = require("fixture-lib");

function main(userInput) {
  return dep.dangerousOp(userInput);
}

// Returns normally, every time. Not RWF-020's shape.
function notAConstructor() {
  return 1;
}

if (process.env.FIXTURE_FLAG === "1") {
  class Mode extends notAConstructor() {}
  void Mode;
}

module.exports = main;
