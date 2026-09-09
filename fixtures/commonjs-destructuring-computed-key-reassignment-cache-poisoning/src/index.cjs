const fixture = require("fixture-lib");

// The ELEMENT-ACCESS form of the same defect, discovered from the same
// entrypoint because it is expected to be exactly as ambiguous.
require("fixture-lib/element-key");

// The false-AFFECTED control: `bail` is GENUINELY rebound there, so no
// cutoff may be claimed from it.
require("fixture-lib/rebound");

// Required so its file and package instance are genuinely discovered by
// the call graph, and never called -- the Family C positive control.
require("fixture-lib/stable");

module.exports = function main(input) {
  return fixture(input);
};
