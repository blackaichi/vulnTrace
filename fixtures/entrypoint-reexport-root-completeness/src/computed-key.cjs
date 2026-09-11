// A DYNAMIC COMPUTED export name. The callable is local and reaches the
// sink; only the NAME it is published under is unknown statically. An
// importer that knows the name can call it, so the root is real.
const dep = require("fixture-lib");

function run(userInput) {
  return dep.dangerousOp(userInput);
}

module.exports[process.env.EXPORT_NAME || "run"] = run;
