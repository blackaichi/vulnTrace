import holder = require("vt2-holder");

// TypeScript's `import x = require("pkg")` -- a first-class CommonJS
// module load, not an ordinary `import` declaration and not a `require()`
// call expression (VT-307c-fix-8's own regression case: the final VT-307d
// readiness review found this syntax indexed nowhere at all, invisible to
// both ModuleLoadClosure's traversal and the call graph's shared
// `model.imports`-based module-load-edge/symbol-binding machinery). Before
// fix-8, `holder` had no import binding whatsoever, so `holder.useHolder()`
// below could not be classified as anything but `unsupported_construct` --
// the entrypoint's own real, reachable call into vt2-holder (and, through
// it, the nested vt2-vuln-lib@1.0.0 instance) was completely invisible.
export function main() {
  return holder.useHolder();
}
