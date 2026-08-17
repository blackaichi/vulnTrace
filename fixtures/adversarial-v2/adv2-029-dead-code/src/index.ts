import { dangerousOp } from "vt2-vuln-lib";

function unusedWrapper() {
  return dangerousOp();
}

export function main() {
  return "ok";
}
