const cond = require("vt2-cond-lib");

// The application calls the package's WHOLE EXPORTED VALUE. It has no
// reference to vt2-vuln-lib anywhere -- whether this call reaches it is
// decided entirely by which of the two branches in vt2-cond-lib/index.js
// won the `module.exports` assignment at load time.
function main(userInput) {
  return cond(userInput);
}

module.exports = { main };
