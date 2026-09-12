"use strict";

const lib = require("lib");

// Loads the workspace package but never calls its vulnerable export. The
// package is module-load reachable; the target is not called.
module.exports.handle = function handle() {
  return typeof lib;
};
