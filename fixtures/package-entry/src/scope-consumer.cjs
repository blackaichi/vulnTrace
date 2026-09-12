// Loads both scoped packages, but calls only @scope/pkg's root export.
const scoped = require("@scope/pkg");
require("@other/pkg");

module.exports = function main(input) {
  return scoped.vulnerable(input);
};
