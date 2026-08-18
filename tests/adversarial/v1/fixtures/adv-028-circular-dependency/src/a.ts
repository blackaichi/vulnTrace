import { fromB } from "./b.js";
import { vulnerable } from "adv-vuln-lib";

export function helperFromA() {
  return "helper";
}

export function main() {
  fromB();
  return vulnerable();
}
