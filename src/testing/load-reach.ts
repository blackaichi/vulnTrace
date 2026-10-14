import { LoadReachGraph } from "../code-intelligence/load-reach.js";
import type { LoadReach } from "../code-intelligence/module-model.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import type { SourceIndex } from "../code-intelligence/source-index.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";

/**
 * Task BL-074: the module-graph context a model test states as its
 * PREMISE -- no load of the file under test can return one of its export
 * objects (each module it requires is another module's, loading nothing
 * back). The tests that pass it are about the export model's own rules
 * (E-1's census, RWF-004a's origins, the forwarding hop), written before
 * the census asked the module graph; the graph's own answers are tested in
 * `load-reach.test.ts` and against real Node in
 * `tests/oracle/bl074-load-result-dataflow`.
 *
 * Without a context the census applies its per-file rule, so these tests
 * would otherwise measure that rule instead of what they were written for.
 * Production never passes this: the call graph and the verdict pass the
 * scan's {@link LoadReachGraph}.
 */
export const NO_LOAD_REACHES_BACK: LoadReach = {
  mayReachBack: () => false,
};

/**
 * The real module-graph context of `index`'s file inside the fixture
 * project at `root`, computed with that project's own resolver -- for a
 * test that builds a model of an on-disk fixture directly.
 */
export async function fixtureLoadReach(
  root: string,
  index: SourceIndex,
): Promise<LoadReach> {
  return new LoadReachGraph(createModuleResolver(loadTsProject(root))).prepare(
    index,
  );
}
