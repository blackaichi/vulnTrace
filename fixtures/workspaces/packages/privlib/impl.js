"use strict";

exports.internal = function privlibDanger(input) {
  return "privlib/impl.js:internal:" + String(input);
};
