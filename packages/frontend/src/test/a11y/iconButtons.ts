// Finds <button> and <Button> elements that show only an icon and carry no
// accessible name. `title` is not a name (touch screens and several screen
// readers ignore it), so only aria-label, aria-labelledby or visible text count.
// An element with a spread ({...rest}) is skipped: the caller may supply the name.
import ts from "typescript";

const NAMING_ATTRIBUTES = new Set(["aria-label", "aria-labelledby"]);

function tagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

/** The names bound by `import { A, B as C } from "lucide-react"`: what the file draws icons with. */
function lucideIcons(file: ts.SourceFile): Set<string> {
  const icons = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "lucide-react") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) icons.add(el.name.text);
  }
  return icons;
}

/** True when `node` contributes something a screen reader would read: text, a string, or a non-icon element. */
function readsAsText(node: ts.Node, icons: Set<string>): boolean {
  if (ts.isJsxText(node)) return node.text.trim() !== "";
  if (ts.isStringLiteralLike(node)) return node.text.trim() !== "";
  if (ts.isJsxSelfClosingElement(node)) return !isIcon(node, icons);
  if (ts.isJsxElement(node)) return !isIcon(node.openingElement, icons) || node.children.some((c) => readsAsText(c, icons));
  if (ts.isJsxFragment(node)) return node.children.some((c) => readsAsText(c, icons));
  if (ts.isJsxExpression(node)) return node.expression ? readsAsText(node.expression, icons) : false;
  if (ts.isParenthesizedExpression(node)) return readsAsText(node.expression, icons);
  // {open ? <ChevronDown /> : <ChevronRight />}: the condition is not content.
  if (ts.isConditionalExpression(node)) return readsAsText(node.whenTrue, icons) || readsAsText(node.whenFalse, icons);
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return readsAsText(node.right, icons);
    return readsAsText(node.left, icons) || readsAsText(node.right, icons);
  }
  // A bare identifier, call or member in {…} is text such as {count} or {label}.
  return ts.isIdentifier(node) ? node.text !== "undefined" : ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)
    || ts.isTemplateExpression(node);
}

function isIcon(opening: ts.JsxOpeningLikeElement, icons: Set<string>): boolean {
  const name = tagName(opening);
  return name === "svg" || icons.has(name);
}

function hasName(opening: ts.JsxOpeningLikeElement): boolean | "unknown" {
  let spread = false;
  for (const attribute of opening.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute)) spread = true;
    else if (NAMING_ATTRIBUTES.has(attribute.name.getText())) return true;
  }
  return spread ? "unknown" : false;
}

function iconsIn(node: ts.Node, icons: Set<string>, into: string[]): string[] {
  if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && isIcon(node, icons)) into.push(tagName(node));
  ts.forEachChild(node, (child) => { iconsIn(child, icons, into); });
  return into;
}

function classNameOf(opening: ts.JsxOpeningLikeElement): string {
  for (const attribute of opening.attributes.properties) {
    if (ts.isJsxAttribute(attribute) && attribute.name.getText() === "className" && attribute.initializer) {
      const init = attribute.initializer;
      // Only a literal class names the element; a computed one would make the id unstable.
      return ts.isStringLiteral(init) ? init.text : "";
    }
  }
  return "";
}

/**
 * One id per unnamed icon-only button: `path <button.class> [Icon]`. Ids name the
 * element, not its line, so an unrelated edit above it does not turn a known
 * violation into a new one; a second identical element gets `#2`.
 */
export function unnamedIconButtons(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const icons = lucideIcons(file);
  const seen = new Map<string, number>();
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      const tag = tagName(node.openingElement);
      if ((tag === "button" || tag === "Button")
        && !node.children.some((c) => readsAsText(c, icons))
        && node.children.some((c) => iconsIn(c, icons, []).length > 0)
        && hasName(node.openingElement) === false) {
        const cls = classNameOf(node.openingElement);
        const names = [...new Set(node.children.flatMap((c) => iconsIn(c, icons, [])))].join("|");
        const base = `${path} <${tag}${cls ? `.${cls}` : ""}> [${names}]`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        found.push(n === 1 ? base : `${base} #${n}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
