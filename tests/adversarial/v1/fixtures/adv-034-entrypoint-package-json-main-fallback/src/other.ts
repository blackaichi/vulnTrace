import { vulnerable } from "adv-vuln-lib";

export function unused() {
  return vulnerable();
}
