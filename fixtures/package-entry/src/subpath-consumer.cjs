// Uses ONLY the "./parse" surface. The package root's own `vulnerable` is a
// different callable and is never called.
const parse = require("subpath-lib/parse");

module.exports = function main(input) {
  return parse.vulnerable(input);
};
