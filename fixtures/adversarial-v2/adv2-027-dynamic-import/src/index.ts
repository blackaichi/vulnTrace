export async function main(moduleName: string) {
  const lib = (await import(moduleName)) as { dangerousOp: () => unknown };
  return lib.dangerousOp();
}
