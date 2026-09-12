"use strict";

// The second `"name": "dup"` workspace package. Same name, same version,
// different canonical root -- a distinct PackageInstance by construction.
function vulnerable(input) {
  return "dupb/index.js:vulnerable:" + String(input);
}

module.exports = { vulnerable };
