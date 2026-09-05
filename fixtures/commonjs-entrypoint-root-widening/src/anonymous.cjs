// The ANONYMOUS-callable form (RWF-003's shape). The exported function has
// no name at all, so a name-only root lookup could never find it -- with or
// without a cutoff. RWF-021 roots it by its exact source POSITION, which is
// the same identity evidence RWF-003 already records; when authority is
// withdrawn the position is recovered from the collected `module.exports`
// writes instead of from the (now absent) attribution.
const dep = require("fixture-lib");

function bail() {
  throw new Error("boom");
}

if (process.env.FIXTURE_FLAG === "1") {
  bail();
}

module.exports = function (userInput) {
  return dep.dangerousOp(userInput);
};
