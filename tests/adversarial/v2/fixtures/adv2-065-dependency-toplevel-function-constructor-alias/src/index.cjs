const holder = require("vt2-holder");

// Reaches only the NESTED vt2-vuln-lib instance (node_modules/vt2-holder/
// node_modules/vt2-vuln-lib@1.0.0), via vt2-holder's own useHolder().
// This entrypoint file itself contains no dynamic construct at all -- the
// widening blocker under test is an ALIASED `Function` constructor
// (`const F = Function;` then `F(src)()`), sitting entirely inside
// vt2-holder's own module (see node_modules/vt2-holder/index.js).
function main() {
  return holder.useHolder();
}

module.exports = { main };
