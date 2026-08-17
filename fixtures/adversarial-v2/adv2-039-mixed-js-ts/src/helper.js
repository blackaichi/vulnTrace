import { dangerousOp } from "vt2-vuln-lib";

export function helperCall() {
  return dangerousOp();
}
