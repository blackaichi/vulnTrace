const facade = require("vt2-facade-lib");

// The application names only the facade. It has no reference to
// vt2-vuln-lib anywhere -- not in its source, and not as the specifier of
// any require it performs. Which of the two identically-named,
// identically-versioned installs of vt2-vuln-lib this call actually reaches
// is decided entirely by where the facade's OWN require resolves.
function main(userInput) {
  return facade.dangerousOp(userInput);
}

module.exports = { main };
