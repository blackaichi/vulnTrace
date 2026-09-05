"use strict";
// Circular require: a.js is still mid-evaluation (it required us). Node
// returns a.js's module.exports AS IT CURRENTLY STANDS -- the dangerous
// branch, published just before this require() ran.
const retainedFromA = require("./a");
console.log("[b.js] retained from circular require(a):", retainedFromA.name);

module.exports = { retained: retainedFromA };
