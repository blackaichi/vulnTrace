import * as fixture from "fixture-lib";

export function main(method: string) {
  return fixture[method]();
}
