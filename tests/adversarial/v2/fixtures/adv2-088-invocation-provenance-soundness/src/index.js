const aliasLib = require("vt2-alias-lib");

// The application calls the package's WHOLE EXPORTED VALUE. It has no
// reference to vt2-vuln-lib anywhere -- whether this call reaches it is
// decided entirely by whether module evaluation in vt2-alias-lib/index.js
// survived past its early branch. The statement that decides it is a call
// through a one-hop const ALIAS, which is the whole case: the callee it
// names has always been provably fatal, and the only open question was
// whether an analyzer may say WHICH function the alias invokes.
function main(userInput) {
  return aliasLib(userInput);
}

module.exports = { main };
