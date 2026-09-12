"use strict";

const linklib = require("linklib");

module.exports.handle = function handle(input) {
  return linklib.vulnerable(input);
};
