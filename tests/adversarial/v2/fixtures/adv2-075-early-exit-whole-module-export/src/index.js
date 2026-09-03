const exitLib = require("vt2-exit-lib");

// The application calls the package's WHOLE EXPORTED VALUE. It has no
// reference to vt2-vuln-lib anywhere -- whether this call reaches it is
// decided entirely by whether vt2-exit-lib/index.js left module evaluation
// early at load time.
function main(userInput) {
  return exitLib(userInput);
}

module.exports = { main };
