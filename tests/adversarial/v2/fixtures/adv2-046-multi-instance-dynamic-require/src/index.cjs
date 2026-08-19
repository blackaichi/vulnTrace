const holder = require("vt2-holder");

// Reaches only the NESTED vt2-vuln-lib instance (node_modules/vt2-holder/
// node_modules/vt2-vuln-lib@1.0.0), via vt2-holder's own useHolder().
function main() {
  return holder.useHolder();
}

// A second, unrelated function exported by this same entrypoint file (no
// configured `symbol`, so both `main` and `loadPlugin` are entrypoint
// sources). Its require() target is a runtime value VulnTrace cannot
// statically resolve -- at runtime it could load ANY installed module,
// including the top-level vt2-vuln-lib@1.9.0 instance that `main` itself
// never touches. This is the RWF-008 reproduction: does an untraversed
// package instance's own absence from the call graph still count as
// positive evidence of non-reachability when a construct like this is
// reachable from the same entrypoint?
function loadPlugin(pluginName) {
  return require(pluginName);
}

module.exports = { main, loadPlugin };
