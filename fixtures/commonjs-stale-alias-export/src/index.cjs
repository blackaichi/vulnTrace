const fixture = require("fixture-lib");

// The application calls the explicit alias. At runtime `parseSync` and
// `parse` are the SAME function object, so this call reaches exactly the
// symbol the rule names -- but it reaches it through the statically
// resolvable name, not through the stale-aliased one.
module.exports = function main(input) {
  return fixture.parseSync(input);
};
