const holder = require("vt2-holder");

// Reaches only the NESTED vt2-vuln-lib instance (node_modules/vt2-holder/
// node_modules/vt2-vuln-lib@1.0.0), via vt2-holder's own useHolder().
// Deliberately identical to adv2-046's fixture MINUS the extra
// require(variable)-containing export: this is the control for RWF-008 --
// same two-instance layout, same reached/unreached split, zero
// closure-widening constructs anywhere in the entrypoint's reachable
// subgraph. The top-level, never-imported vt2-vuln-lib@1.9.0 instance
// must still resolve to a confident NOT_AFFECTED here.
function main() {
  return holder.useHolder();
}

module.exports = { main };
