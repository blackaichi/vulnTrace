const minimist = require("minimist");

// App-authored wrapper forwarding CLI args into minimist's default export
// (GHSA-xvch-5gv4-984h / CVE-2021-44906, prototype pollution via
// constructor.prototype keys).
function parseArgs(argv) {
  return minimist(argv);
}

function main() {
  return parseArgs(process.argv.slice(2));
}

module.exports = { main };
