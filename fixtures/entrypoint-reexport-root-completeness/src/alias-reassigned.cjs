// The REASSIGNMENT negative control: the published value is whatever
// `alias` holds at the end, which RWF-013/013b proves this analyzer cannot
// determine. It must fail closed rather than root the stale declaration --
// and must not certify absence either, since the live value DOES reach the
// vulnerable sink.
const dep = require("fixture-lib");

function safeOne(userInput) {
  return "safe:" + userInput;
}

function dangerous(userInput) {
  return dep.dangerousOp(userInput);
}

let alias = safeOne;
alias = dangerous;

module.exports.run = alias;
