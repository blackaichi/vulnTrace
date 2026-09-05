const initLib = require("vt2-init-lib");

// The application calls the package's WHOLE EXPORTED VALUE. It has no
// reference to vt2-vuln-lib anywhere -- whether this call reaches it is
// decided entirely by whether vt2-init-lib/index.js's throwing call, which
// sits in a NON-STATIC class element's COMPUTED KEY, ran before the module
// published its final export at load time.
function main(userInput) {
  return initLib(userInput);
}

module.exports = { main };
