const { XMLParser } = require("fast-xml-parser");

// Instance method call reaching the vulnerable numeric-entity handling
// (GHSA-37qj-frw5-hhjh / CVE-2026-25128, uncaught RangeError DoS).
// htmlEntities:true is required to trigger this specific CWE and is a
// realistic app configuration for parsing HTML-entity-flavored feed/XML
// content, not a contrived flag -- see the advisory's own PoC.
function parseFeed(xmlText) {
  const parser = new XMLParser({ processEntities: true, htmlEntities: true });
  return parser.parse(xmlText);
}

module.exports = { parseFeed };
