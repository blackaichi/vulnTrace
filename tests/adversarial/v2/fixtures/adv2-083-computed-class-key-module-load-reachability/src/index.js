"use strict";

// The application names only vt2-init-lib. It never requires vt2-vuln-lib
// itself, and the call below never reaches the sink -- `initLib` is the
// safe branch.
//
// The sink is reached anyway, by the `require` on the line above the call:
// loading vt2-init-lib evaluates its class definition, which evaluates the
// computed key, which calls the nested vt2-vuln-lib install's dangerousOp.
const initLib = require("vt2-init-lib");

function main(userInput) {
  return initLib(userInput);
}

module.exports = { main };
