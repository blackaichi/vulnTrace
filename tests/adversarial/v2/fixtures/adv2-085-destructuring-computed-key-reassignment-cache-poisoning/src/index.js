const initLib = require("vt2-init-lib");

// The application calls the package's WHOLE EXPORTED VALUE. It has no
// reference to vt2-vuln-lib anywhere -- whether this call reaches it is
// decided entirely by whether vt2-init-lib/index.js's throwing call ran
// before the module published its final export at load time. That call
// sits in an OBJECT LITERAL's COMPUTED KEY (ADV2-084's shape, already
// modelled); what is on trial here is whether an UNRELATED destructuring
// statement elsewhere in the same file can silently switch that model off.
function main(userInput) {
  return initLib(userInput);
}

module.exports = { main };
