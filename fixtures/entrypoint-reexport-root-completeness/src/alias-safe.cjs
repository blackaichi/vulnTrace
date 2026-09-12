// The SAFE-ALIAS control, and the proof that alias support does not
// globally force UNKNOWN: the alias resolves exactly, the root
// materializes, and the rule's target (`neverCalled`) is genuinely
// unreachable from it -- so a real, complete Family C proof must still be
// issued.
const dep = require("fixture-lib");

function onlyDangerous(userInput) {
  return dep.dangerousOp(userInput);
}

const alias = onlyDangerous;

module.exports.run = alias;
