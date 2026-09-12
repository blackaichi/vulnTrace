"use strict";

// A `link:` dependency. Same story as filelib: the protocol word carries
// no authority here, the materialized symlink does.
function vulnerable(input) {
  return "linklib/index.js:vulnerable:" + String(input);
}

module.exports = { vulnerable };
