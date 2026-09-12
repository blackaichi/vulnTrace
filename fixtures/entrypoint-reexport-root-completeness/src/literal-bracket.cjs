// THE LITERAL-BRACKET BLOCKER, found by the focused re-audit.
//
// Not a re-export at all: the callable is LOCAL and the published name is
// statically exact. It was invisible anyway, because
// `describeCommonJsExportTarget` only ever recognised the dot spelling, so
// no export binding existed, no root was derived, and root derivation
// reported COMPLETE with zero roots -- a false NOT_AFFECTED carrying a
// complete Family C proof over a sink Node really executes.
//
// After the fix this is modeled exactly like `module.exports.run = run`.
const dep = require("fixture-lib");

function run(userInput) {
  return dep.dangerousOp(userInput);
}

module.exports["run"] = run;
