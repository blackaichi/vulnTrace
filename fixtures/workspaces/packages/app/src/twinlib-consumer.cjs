"use strict";

// Resolves the INSTALLED node_modules/twinlib (the real directory wins over
// nothing -- there is no workspace symlink for this name), whose
// implementation is the dangerous one. The workspace packages/twinlib copy
// of the same name and version is a different instance entirely.
const twinlib = require("twinlib");

module.exports.handle = function handle(input) {
  return twinlib.vulnerable(input);
};
