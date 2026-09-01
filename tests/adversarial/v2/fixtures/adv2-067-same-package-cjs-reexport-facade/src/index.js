const lib = require("vt2-vuln-lib");

// Only dangerousOp is called. safeOp is re-exported through the identical
// mechanism and must not be confused with it.
function main(userInput) {
  return lib.dangerousOp(userInput);
}

module.exports = { main };
