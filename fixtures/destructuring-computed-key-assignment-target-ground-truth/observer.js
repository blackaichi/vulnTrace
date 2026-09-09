"use strict";

// The circular observer. `lib.js` requires this module while it is still
// evaluating, immediately AFTER publishing its dangerous export and BEFORE
// the object literal whose computed key throws. Node hands back the
// partially-initialised `module.exports` of `lib.js`, so whatever this
// module captures here is the value a real cyclic consumer holds.
const captured = require("./lib");

module.exports = { captured };
