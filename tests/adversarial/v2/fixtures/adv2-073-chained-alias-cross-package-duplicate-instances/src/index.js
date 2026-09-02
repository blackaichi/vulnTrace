const chain = require("vt2-chain-lib");

// The application names only the chain package. It has no reference to
// vt2-vuln-lib anywhere -- not in its source, and not as the specifier of
// any require it performs. Which of the two identically-named,
// identically-versioned installs of vt2-vuln-lib this call reaches is
// decided entirely by where the chain package's OWN require resolves, and
// the value that arrives here travels through four local aliases before it
// is published.
function main(userInput) {
  return chain.dangerousOp(userInput);
}

module.exports = { main };
