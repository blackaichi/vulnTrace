// The DYNAMIC negative control for the literal-bracket fix: the key is not
// statically known, so no binding is produced and root derivation must
// stay INCOMPLETE. Modeling literal keys must not leak into dynamic ones.
const dep = require("fixture-lib");

function run(userInput) {
  return dep.dangerousOp(userInput);
}

module.exports[process.env.EXPORT_NAME || "run"] = run;
