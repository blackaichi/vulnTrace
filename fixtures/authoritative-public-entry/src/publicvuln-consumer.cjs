// Calls the authoritative public `vulnerable`, which really is the
// dangerous implementation -- and also the harmless same-named sibling,
// under its own public name, so both files are in the graph.
const pkg = require("publicvuln-lib");

module.exports = function main(input) {
  return pkg.vulnerable(input) + "|" + pkg.runSafeSibling(input);
};
