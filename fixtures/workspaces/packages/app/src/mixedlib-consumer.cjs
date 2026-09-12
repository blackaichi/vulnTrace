"use strict";

const mixedlib = require("mixedlib");

module.exports.handle = function handle(input) {
  return mixedlib.vulnerable(input);
};
