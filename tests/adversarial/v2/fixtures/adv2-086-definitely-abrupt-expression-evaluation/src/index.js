const initLib = require("vt2-init-lib");

// The application calls the package's WHOLE EXPORTED VALUE. It has no
// reference to vt2-vuln-lib anywhere -- whether this call reaches it is
// decided entirely by whether vt2-init-lib/index.js's throwing call ran
// before the module published its final export at load time. That call
// sits in no privileged syntactic slot at all: it is an ordinary call
// ARGUMENT, one operand of an expression that has to evaluate it before
// it can complete.
function main(userInput) {
  return initLib(userInput);
}

module.exports = { main };
