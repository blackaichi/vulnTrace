// The PROPERTY-export form of the same defect. `exports.run = main` loses
// its provenance to the identical cutoff gate
// (`isDefinitelyReachedExportAssignment`), so before RWF-021 the binding
// kept only its public name `run` -- which matches no function in the file
// -- and the root was lost just as completely as for the whole-module form.
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

exports.run = main;
