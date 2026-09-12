"use strict";

const exportslib = require("exportslib");

module.exports.handle = function handle(input) {
  return exportslib.vulnerable(input);
};
