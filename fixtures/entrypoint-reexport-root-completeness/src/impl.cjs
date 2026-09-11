// The shared implementation every re-exporting entrypoint forwards. The
// callable that reaches the sink lives HERE, never in the entrypoint --
// which is precisely why an entrypoint that re-exports it has no local
// node to serve as a reachability root.
const dep = require("fixture-lib");

function run(userInput) {
  return dep.dangerousOp(userInput);
}

function safe(userInput) {
  return "safe:" + userInput;
}

module.exports = { run, safe };
