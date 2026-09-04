const throwLib = require("vt2-throw-lib");

// The application calls the package's WHOLE EXPORTED VALUE. It has no
// reference to vt2-vuln-lib anywhere -- whether this call reaches it is
// decided entirely by whether vt2-throw-lib/index.js's resolvable local
// throwing call ran before publishing its final export at load time.
function main(userInput) {
  return throwLib(userInput);
}

module.exports = { main };
