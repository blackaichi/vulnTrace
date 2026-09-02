const lib = require("vt2-vuln-lib");

// The application takes the explicit native path, unconditionally, with
// attacker-controlled input. `dangerousOpNative` and `dangerousOp` are the
// SAME function object -- both are lib/native.js's function -- so this call
// reaches exactly the symbol the advisory names.
function main(userInput) {
  return lib.dangerousOpNative(userInput);
}

module.exports = { main };
