"use strict";

// The superseded `main`. `exports` has authority over it, so no importer
// can reach this file through the package name -- being a workspace
// package changes nothing about that (P1-A4 § WORKSPACE MAIN VS EXPORTS).
function vulnerable(input) {
  return "exportslib/legacy.js:vulnerable:" + String(input);
}

module.exports = { vulnerable };
