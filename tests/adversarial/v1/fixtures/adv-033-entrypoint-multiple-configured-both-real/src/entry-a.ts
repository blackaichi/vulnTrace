import { vulnerable } from "adv-vuln-lib";

export function apiHandler() {
  return vulnerable();
}
