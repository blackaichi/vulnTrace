export {
  type RelevantCompilerOptions,
  type TsProject,
  type TsProjectDiagnostic,
  type TsProjectOptions,
  loadTsProject,
} from "./ts-project.js";
export { TsProjectRootNotFoundError } from "./ts-project-errors.js";
export {
  type ExportBindingKind,
  type ImportBindingKind,
  type IndexedExport,
  type IndexedFunction,
  type IndexedImport,
  type SourceIndex,
  indexSourceFile,
  indexSourceFileFromDisk,
  indexSourceFiles,
} from "./source-index.js";
export { SourceFileNotFoundError } from "./source-index-errors.js";
export {
  type BindingKind,
  type ExportBinding,
  type ExportKind,
  type ImportBinding,
  type ModuleModel,
  type ModuleSyntax,
  buildModuleModel,
  mapExportsToFunctions,
} from "./module-model.js";
export {
  type BuiltinModule,
  type DeclarationOnlyModule,
  type ModuleResolutionResult,
  type ModuleResolver,
  type ResolutionFailure,
  type ResolvedModule,
  type ResolvedPackageId,
  createModuleResolver,
} from "./module-resolver.js";
export {
  type CanonicalSymbolTarget,
  type SymbolBindingAmbiguous,
  type SymbolBindingBuiltin,
  type SymbolBindingDeclarationOnly,
  type SymbolBindingNotAnImport,
  type SymbolBindingResolved,
  type SymbolBindingResult,
  type SymbolBindingUnresolvedModule,
  bindCallee,
} from "./symbol-binder.js";
export { type BuildCallGraphOptions, buildCallGraph } from "./call-graph.js";
