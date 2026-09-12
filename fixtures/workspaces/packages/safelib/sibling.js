"use strict";

// Never published. `main` is index.js and the package declares no
// `exports`, so no importer can reach this file through the package name.
// Its same-named export must never answer for the package (RWF-030), and
// being a WORKSPACE sibling rather than an installed one changes nothing.
function vulnerable(input) {
  return "safelib/sibling.js:vulnerable:" + String(input);
}

module.exports = { vulnerable };
