"use strict";

const condlib = require("condlib");

module.exports.handle = function handle(input) {
  return condlib.vulnerable(input);
};
