"use strict";

const filelib = require("filelib");

module.exports.handle = function handle(input) {
  return filelib.vulnerable(input);
};
