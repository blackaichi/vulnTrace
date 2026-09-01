const lib = require("vt2-vuln-lib");

// The package's whole exported value IS the callable, exactly as with
// minimist. `lib.borrowed` -- the other package's function -- is never
// called.
function main(userInput) {
  return lib(userInput);
}

module.exports = { main };
