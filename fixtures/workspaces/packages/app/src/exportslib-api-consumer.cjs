"use strict";

const api = require("exportslib/api");

module.exports.handle = function handle(input) {
  return api.vulnerable(input);
};
