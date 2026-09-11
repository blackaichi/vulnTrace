"use strict";
const { record } = require("./trace");

// Circular require: a.js is still mid-evaluation (it required us). Node
// returns a.js's module.exports AS IT CURRENTLY STANDS -- the dangerous
// branch, published just before this require() ran. This is what makes
// the bypassed export a REAL retained value rather than a thought
// experiment.
const retainedFromA = require("./a");
record("b.js: retained from circular require(a): " + retainedFromA.name);

module.exports = { retained: retainedFromA };
