import { fromB } from "./b.js";
import { dangerousOp } from "vt2-vuln-lib";

export function helperFromA() {
  return "a-helper";
}

export function runA() {
  fromB();
  return dangerousOp();
}
