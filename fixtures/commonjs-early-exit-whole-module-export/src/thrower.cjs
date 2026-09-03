// The THROW half of the same defect, scanned from its own entrypoint so
// that the two abrupt-completion forms stay independently observable.
const fixture = require("fixture-lib/thrower");

module.exports = function main(input) {
  return fixture(input);
};
