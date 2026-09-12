"use strict";

// `dup` is declared by TWO workspace packages. Neither is installed under
// the name `dup`, so this request resolves to nothing at all under real
// Node -- the honest answer is UNKNOWN, never a winner picked by order.
const dup = require("dup");

module.exports.handle = function handle(input) {
  return dup.vulnerable(input);
};
