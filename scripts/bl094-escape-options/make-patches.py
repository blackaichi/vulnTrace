"""Generate the BL-094 option patches against escape-row.ts.

Each option is a list of (old, new) replacements; each `old` must occur
exactly once in the file as the previous replacements leave it. The file
is restored afterwards. The patches are prototypes for measurement only
(task BL-094, ADR 0008's "Proposed decision -- BL-094"); none is meant to
be merged. Each cut is guarded by an opaque `bl094Option()` so that the
code after it still type-checks.

Usage (from the repository root, on the base commit's escape-row.ts):
    python3 scripts/bl094-escape-options/make-patches.py .
"""
import pathlib
import subprocess
import sys

REPO = pathlib.Path(sys.argv[1])
OUT = REPO / "scripts" / "bl094-escape-options"
FILE = REPO / "src" / "code-intelligence" / "escape-row.ts"
ORIGINAL = FILE.read_text()

NO_CLASS = [
    # A class expression is never proven fresh.
    (
        """    ts.isArrowFunction(expr) ||
    (ts.isClassExpression(expr) &&
      !isDecorated(expr) &&
      hasOwnStaticChain(expr, hops)) ||
    ts.isRegularExpressionLiteral(expr)""",
        """    ts.isArrowFunction(expr) ||
    ts.isRegularExpressionLiteral(expr)""",
    ),
    # A class's `prototype` is never proven fresh.
    (
        """    if (cls !== undefined && ts.isClassLike(cls)) {
      // A class's `prototype` is non-writable""",
        """    if (cls !== undefined && ts.isClassLike(cls)) {
      if (bl094Option()) return false;
      // A class's `prototype` is non-writable""",
    ),
    # `this` in a static block, a field initializer or a constructor.
    (
        """    if (ts.isClassStaticBlockDeclaration(current)) {
      // The class itself""",
        """    if (ts.isClassStaticBlockDeclaration(current)) {
      if (bl094Option()) return false;
      // The class itself""",
    ),
    (
        """    if (ts.isPropertyDeclaration(current) && ts.isClassLike(current.parent)) {
      // A field initializer""",
        """    if (ts.isPropertyDeclaration(current) && ts.isClassLike(current.parent)) {
      if (bl094Option()) return false;
      // A field initializer""",
    ),
    (
        """    if (ts.isConstructorDeclaration(current)) {
      return (""",
        """    if (ts.isConstructorDeclaration(current)) {
      if (bl094Option()) return false;
      return (""",
    ),
    # A name bound to a class declaration.
    (
        """    case "function":
    case "function-expression":
    case "class": {""",
        """    case "function":
    case "function-expression":
    case "class": {
      if (binding.kind === "class" && bl094Option()) return false;""",
    ),
    # A namespace merged with a class.
    (
        """    if (ts.isClassDeclaration(statement)) {
      return !isDecorated(statement) && hasOwnStaticChain(statement, 0);
    }""",
        """    if (ts.isClassDeclaration(statement)) {
      return false;
    }""",
    ),
    # A TypeScript field's legacy-emit target (the class or the instance).
    (
        """  if (prototypeMayBeChanged(undefined, cls.getSourceFile())) {
    return false;
  }
  // A static field of a decorated class""",
        """  if (cls !== undefined) {
    return false;
  }
  // A static field of a decorated class""",
    ),
]

NO_EMIT_OBJECT = [
    # A namespace's object (one that is emitted) is never proven the program's own.
    (
        """  const parent = ns.parent;
  if (!ts.isSourceFile(parent)) {
    // Nested in another namespace (or a `declare module`).
    return false;
  }""",
        """  const parent = ns.parent;
  if (parent !== undefined) {
    return false;
  }""",
    ),
    # An enum's object is never proven the program's own.
    (
        """  const sourceFile = declaration.getSourceFile();
  const name = declaration.name.text;
  return (
    ts.isSourceFile(declaration.parent) &&""",
        """  const sourceFile = declaration.getSourceFile();
  const name = declaration.name.text;
  return (
    false &&
    ts.isSourceFile(declaration.parent) &&""",
    ),
]

LITERAL_CORE = [
    # No `this` is proven fresh.
    (
        """  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    return isFreshThis(expr);
  }""",
        """  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    return !bl094Option() && isFreshThis(expr);
  }""",
    ),
    # No `prototype` is proven fresh.
    (
        """  if (member.key === "prototype" && isFreshBinding(member.object, hops)) {""",
        """  if (member.key === "prototype") {
    return false;
  }
  if (member.key === "prototype" && isFreshBinding(member.object, hops)) {""",
    ),
]

NO_PROOF = [
    (
        """export function isProvenFreshObject(raw: ts.Expression): boolean {
  return isFresh(raw, 0);
}""",
        """export function isProvenFreshObject(raw: ts.Expression): boolean {
  if (bl094Option()) return false;
  return isFresh(raw, 0);
}""",
    ),
    # The declaration stores (fields, namespace and enum members) are judged
    # by the same proofs: none is proven.
    *NO_EMIT_OBJECT,
    NO_CLASS[-1],
]

NO_DERIVED_CLASS = [
    # A class with an `extends` clause is never proven: its static chain is
    # not the program's own, so neither is the class, its static `this`,
    # nor (already, isDerived) its `prototype` or its instances.
    (
        """  if (clause === undefined) {
    return true;
  }
  const base = clause.types[0]?.expression;""",
        """  if (clause === undefined) {
    return true;
  }
  if (bl094Option()) return false;
  const base = clause.types[0]?.expression;""",
    ),
]

def typescript_only(edits):
    """The same cuts, taken only in a TypeScript source."""
    out = []
    for old, new in edits:
        new = new.replace(
            'if (binding.kind === "class" && bl094Option()) return false;',
            'if (binding.kind === "class" && bl094Ts(id)) return false;',
        )
        new = new.replace(
            "      if (bl094Option()) return false;\n      // A class's",
            "      if (bl094Ts(expr)) return false;\n      // A class's",
        )
        new = new.replace("if (bl094Option()) return false;", "if (bl094Ts(current)) return false;")
        out.append((old, new))
    return out


HYBRID_CLASS = [
    # A class expression is proven only in a JavaScript source.
    (
        """    (ts.isClassExpression(expr) &&
      !isDecorated(expr) &&""",
        """    (ts.isClassExpression(expr) &&
      !bl094Ts(expr) &&
      !isDecorated(expr) &&""",
    ),
    *[edit for edit in typescript_only(NO_CLASS[1:]) if "bl094Ts" in edit[1]],
    # The namespace and legacy-field cuts are TypeScript-only already.
    NO_CLASS[6],
    NO_CLASS[7],
]

OPTIONS = {
    "o2e-hybrid": NO_DERIVED_CLASS + HYBRID_CLASS + NO_EMIT_OBJECT,
    "o2a0-no-derived-class": NO_DERIVED_CLASS,
    "o2a-no-class": NO_CLASS,
    "o2b-no-class-no-emit-object": NO_CLASS + NO_EMIT_OBJECT,
    "o2c-literal-core": NO_CLASS + NO_EMIT_OBJECT + LITERAL_CORE,
    "o2d-no-proof": NO_PROOF,
}

OUT.mkdir(parents=True, exist_ok=True)
try:
    for name, edits in OPTIONS.items():
        text = ORIGINAL.replace(
            "export const MODULE_SCOPE_ROOTS",
            "/** BL-094 prototype switch: opaque to control-flow narrowing. */\n"
            "function bl094Option(): boolean {\n  return true;\n}\n\n"
            + (
                "/** BL-094 prototype switch: the cut is taken in a TypeScript source only. */\n"
                "function bl094Ts(node: ts.Node): boolean {\n"
                "  return bl094Option() && /\\.[cm]?tsx?$/.test(node.getSourceFile().fileName);\n"
                "}\n\n"
                if name == "o2e-hybrid"
                else ""
            )
            + "export const MODULE_SCOPE_ROOTS",
            1,
        )
        for old, new in edits:
            count = text.count(old)
            if count != 1:
                raise SystemExit(f"{name}: {count} matches for:\n{old}")
            text = text.replace(old, new)
        FILE.write_text(text)
        diff = subprocess.run(
            ["git", "diff", "--", str(FILE.relative_to(REPO))],
            cwd=REPO,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        (OUT / f"{name}.patch").write_text(diff)
        print(name, len(diff.splitlines()), "lines")
finally:
    FILE.write_text(ORIGINAL)
