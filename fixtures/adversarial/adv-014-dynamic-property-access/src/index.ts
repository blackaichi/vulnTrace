import * as lib from "adv-vuln-lib";

export function main(methodName: string) {
  return (lib as unknown as Record<string, () => unknown>)[methodName]();
}
