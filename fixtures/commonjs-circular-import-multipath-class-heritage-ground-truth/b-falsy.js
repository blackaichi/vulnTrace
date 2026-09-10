"use strict";
const { record } = require("./trace");

// Circular require: a-falsy.js is still mid-evaluation (it required us).
// Node returns its module.exports AS IT CURRENTLY STANDS -- the dangerous
// branch, published just before this require() ran.
const retainedFromA = require("./a-falsy");
record("b-falsy.js: retained from circular require: " + retainedFromA.name);

module.exports = { retained: retainedFromA };
