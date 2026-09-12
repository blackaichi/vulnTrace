"use strict";

const lib = require("lib");

module.exports.handle = function handle(input) {
  return lib.vulnerable(input);
};
