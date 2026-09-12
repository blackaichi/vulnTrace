"use strict";

const expmainlib = require("expmainlib");

module.exports.handle = function handle(input) {
  return expmainlib.safe(input);
};
