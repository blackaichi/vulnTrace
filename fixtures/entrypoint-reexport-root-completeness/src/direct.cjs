// THE DIRECT-EXPORT CONTROL. Nothing is forwarded: the callable that
// reaches the sink is defined here and exported here, so its root is
// derived concretely exactly as before P0-Z. This must stay AFFECTED --
// the fix must not degrade entrypoints whose roots ARE derivable.
const dep = require("fixture-lib");

function run(userInput) {
  return dep.dangerousOp(userInput);
}

module.exports = { run };
