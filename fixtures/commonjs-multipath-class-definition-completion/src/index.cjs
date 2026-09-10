const fixture = require("fixture-lib");

// Required so its file and package instance are genuinely discovered by
// the call graph, and never called -- the Family C positive control.
require("fixture-lib/stable");

// B02: two returns, both invalid, and NO throwing path at all.
require("fixture-lib/two-bad");

// The implicit ending: one written `return 1` and one fallthrough
// `undefined`, both invalid.
require("fixture-lib/fallthrough");

// Required so the multi-path negative control module is discovered too. Its
// later export must REMAIN authoritative.
require("fixture-lib/valid-multipath");

module.exports = function main(input) {
  return fixture(input);
};
