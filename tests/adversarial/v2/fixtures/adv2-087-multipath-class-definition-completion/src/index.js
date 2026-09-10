const bootLib = require("vt2-boot-lib");

// The application calls the package's WHOLE EXPORTED VALUE. It has no
// reference to vt2-vuln-lib anywhere -- whether this call reaches it is
// decided entirely by whether a class DEFINITION completed at load time in
// vt2-boot-lib/index.js. The heritage call there completes normally on one
// path and throws on the other, so no single-ending rule can say anything
// about it; what matters is that NO ending lets the class definition
// finish.
function main(userInput) {
  return bootLib(userInput);
}

module.exports = { main };
