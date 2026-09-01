const lib = require("vt2-vuln-lib");

// The application takes the explicit native path, unconditionally, with
// attacker-controlled input. Whenever the package's own native branch
// ran, this is the very function object `lib.dangerousOp` names.
function main(userInput) {
  return lib.dangerousOpNative(userInput);
}

module.exports = { main };
