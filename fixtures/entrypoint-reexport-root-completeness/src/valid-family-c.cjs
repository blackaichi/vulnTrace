// THE FAMILY C POSITIVE CONTROL, and the reason this is a fix rather than
// a blanket disabling of negative proofs.
//
// Root derivation here is COMPLETE: nothing is forwarded, the exported
// callable is local and concretely rooted. The target the rule names
// (`neverCalled`) is genuinely never reached from it. This entrypoint must
// therefore still come back NOT_AFFECTED carrying a real, complete
// Family C proof.
const dep = require("fixture-lib");

function run(userInput) {
  return dep.dangerousOp(userInput);
}

module.exports = { run };
