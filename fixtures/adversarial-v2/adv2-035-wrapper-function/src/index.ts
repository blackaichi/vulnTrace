import { dangerousOp } from "vt2-vuln-lib";

function riskyWrapper() {
  return dangerousOp();
}

export function main() {
  return riskyWrapper();
}
