"use strict";

// From packages/app, Node finds packages/app/node_modules/nestedlib before
// the root-level copy of the same name and version.
const nestedlib = require("nestedlib");

module.exports.handle = function handle(input) {
  return nestedlib.vulnerable(input);
};
