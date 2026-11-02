// Task BL-122 — the census module `scripts/measure-options.mjs --census`
// calls once per side: a predicate that is true for a file on which the
// side's closure-wide rule (`fileMayRedirectLoader`, added by `RA.patch` or
// `RS.patch`) fires. One such file in a closure makes it incomplete. The
// base has no such rule, so its side throws and is reported "unavailable".
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function census({ dist }) {
  const root = pathToFileURL(path.resolve(dist) + "/").href;
  const at = (module) => import(new URL(`code-intelligence/${module}`, root));
  const loader = await at("loader-constructs.js");
  const { buildModuleModel } = await at("module-model.js");
  const { indexSourceFile } = await at("source-index.js");
  if (typeof loader.fileMayRedirectLoader !== "function") {
    throw new Error(`${dist} has no closure-wide rule (fileMayRedirectLoader)`);
  }
  return (file, text) => {
    const index = indexSourceFile(file, text);
    return loader.fileMayRedirectLoader({
      index,
      model: buildModuleModel(index),
    });
  };
}
