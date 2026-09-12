"use strict";

// There is no `exports` "." entry, so real Node refuses `require(
// "subpathonlylib")` with ERR_PACKAGE_PATH_NOT_EXPORTED. This file exists
// precisely so that a root-surface request has an index.js to be WRONGLY
// tempted by; it is not published and must never be invented as a root
// entry (P1-A4 § WORKSPACE SUBPATH-ONLY).
function vulnerable(input) {
  return "subpathonlylib/index.js:vulnerable:" + String(input);
}

module.exports = { vulnerable };
