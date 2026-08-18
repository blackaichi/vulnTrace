import { dangerousOp } from "vt2-vuln-lib";

export function main() {
  if (false) {
    return dangerousOp();
  }
  return "safe";
}
