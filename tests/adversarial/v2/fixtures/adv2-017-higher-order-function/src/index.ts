import { dangerousOp } from "vt2-vuln-lib";

function invoke(fn: () => unknown) {
  return fn();
}

export function main() {
  return invoke(dangerousOp);
}
