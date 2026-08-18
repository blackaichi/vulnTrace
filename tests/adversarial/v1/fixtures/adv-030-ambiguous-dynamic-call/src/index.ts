import * as lib from "adv-vuln-lib";

export function main(key: string) {
  const fn = (lib as unknown as Record<string, () => unknown>)[key];
  return fn();
}
