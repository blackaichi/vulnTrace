export async function main(moduleName: string) {
  const lib = (await import(moduleName)) as { vulnerable: () => unknown };
  return lib.vulnerable();
}
