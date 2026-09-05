// FALSE-AFFECTED control C. The declaration `main` reaches the vulnerable
// sink, but the module reassigns `main` to a safe function before the
// export write, so what is actually published is the safe one.
//
// RWF-013/013b already established that a name this file writes to is not
// a stable alias for what it was declared as, and root selection honours
// that same refusal: the STALE declaration is not a plausible published
// value and is not rooted.
const dep = require("fixture-lib");

function main(userInput) {
  return dep.dangerousOp(userInput);
}

function safe(userInput) {
  return "safe:" + userInput;
}

function bail() {
  throw new Error("boom");
}

main = safe;

if (process.env.FIXTURE_FLAG === "1") {
  bail();
}

module.exports = main;
