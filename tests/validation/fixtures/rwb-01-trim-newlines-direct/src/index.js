const trimNewlines = require("trim-newlines");

// Direct call to trim-newlines's vulnerable `.end()` export
// (GHSA-7p7h-4mm5-852v / CVE-2021-33623, ReDoS) on caller-supplied input.
function normalize(userInput) {
  return trimNewlines.end(userInput);
}

module.exports = { normalize };
