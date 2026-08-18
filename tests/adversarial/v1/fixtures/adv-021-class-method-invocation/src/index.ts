import { Lib } from "adv-vuln-lib";

export function main() {
  const instance = new Lib();
  return instance.vulnerableMethod();
}
