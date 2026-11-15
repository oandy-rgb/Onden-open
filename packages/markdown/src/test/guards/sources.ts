// Shared by the cross-package guards: every non-test source of markdown, site,
// backend and frontend, comments dropped, and the one rule shape they use —
// "only the owner may do X; anything else fails; an exception says why, and an
// exception that no longer matches fails too, so the list only shrinks".
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PACKAGES = fileURLToPath(new URL("../../../../", import.meta.url));

export type SourceFile = { path: string; text: string };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist", "test", "fixtures", "__snapshots__", "migrations"].includes(entry.name) ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec|testing)\./.test(entry.name) ? [path] : [];
  });
}

/** `text` without whole-line comments (prose that names a thing is not a use of it). */
export const code = (text: string) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

export const FILES: SourceFile[] = ["markdown", "site", "backend", "frontend"]
  .flatMap((pkg) => sourceFiles(join(PACKAGES, pkg, "src")))
  .map((file) => ({ path: relative(PACKAGES, file).split(sep).join("/"), text: code(readFileSync(file, "utf8")) }));

export type OwnerRule = {
  /** What only the owner may do, in a few words (shown when the rule fails). */
  what: string;
  /** A line (or run of lines) of code that does it. With `detect`, only a cheap prefilter: `detect` has the final say. */
  pattern: RegExp;
  /** Judge the parsed file instead of its text (new guards: docs/agents/testing.md, "Guards read the syntax tree"). */
  detect?: (file: SourceFile) => boolean;
  /** Files that may. */
  owners: string[];
  /** Other files that match for a reason that is not "doing X again": path → why. */
  exceptions?: Record<string, string>;
};

/** Does `file` do what the rule forbids? */
export const matches = (rule: OwnerRule, file: SourceFile): boolean =>
  rule.pattern.test(file.text) && (rule.detect ? rule.detect(file) : true);

/** Paths in `files` that match the rule's pattern and are neither owner nor exception. */
export function violations(files: SourceFile[], rule: OwnerRule): string[] {
  const allowed = [...rule.owners, ...Object.keys(rule.exceptions ?? {})];
  return files.filter((f) => matches(rule, f) && !allowed.includes(f.path)).map((f) => f.path);
}

/** Owners and exceptions that do not match the pattern any more: delete them from the rule. */
export function staleAllowances(files: SourceFile[], rule: OwnerRule): string[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  return [...rule.owners, ...Object.keys(rule.exceptions ?? {})].filter((path) => {
    const file = byPath.get(path);
    return !file || !matches(rule, file);
  });
}

const NAME_OR_TITLE = /name|title/i;

/**
 * Does a JSX attribute talk about a name or title: its own name (not className), a string in it, or a value it reads
 * (`value={tagName}`)? Event handlers and the function being called are not looked at: `classNames(...)` and an
 * `onKeyDown` that happens to read `.name` say nothing about what the field holds.
 */
function mentionsNameOrTitle(attribute: ts.JsxAttributeLike, file: ts.SourceFile): boolean {
  if (ts.isJsxSpreadAttribute(attribute)) return false;
  const key = attribute.name.getText(file);
  if (key !== "className" && NAME_OR_TITLE.test(key)) return true;
  const found = (node: ts.Node): boolean => {
    if (ts.isFunctionLike(node)) return false;
    if (ts.isStringLiteralLike(node) || ts.isIdentifier(node)) return NAME_OR_TITLE.test(node.text);
    if (ts.isCallExpression(node)) return node.arguments.some(found);
    if (ts.isPropertyAccessExpression(node)) return found(node.expression) || found(node.name);
    return ts.forEachChild(node, found) ?? false;
  };
  return !!attribute.initializer && found(attribute.initializer);
}

/**
 * Where a file types a length limit on a name or title: a zod property (or variable) whose key mentions name/title
 * and whose schema calls `.max(<number literal>)`, or a JSX element with `maxLength={<number literal>}` next to an
 * attribute that mentions name/title. A limit that comes from a constant (`.max(TAG_NAME_MAX)`) is the fix, not the
 * problem, and an unrelated `.max(500)` on the same line or object is not a name's limit.
 */
export function nameLengthLimitSites(path: string, text: string): number[] {
  const file = parseSource(path, text);
  const lines: number[] = [];
  const at = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const keyText = (name: ts.Node): string => (ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : "");
  const isNumber = (e: ts.Expression | undefined): boolean => !!e && ts.isNumericLiteral(e);
  const isMathObject = (e: ts.Expression): boolean => ts.isIdentifier(e) && e.text === "Math";
  /** `.max(<number>)` (one argument, not `Math.max`) anywhere in this schema, not crossing into a nested object (its own keys are judged on their own) or a function. */
  const hasNumberMax = (node: ts.Node): boolean => {
    if (ts.isObjectLiteralExpression(node) || ts.isFunctionLike(node)) return false;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "max" && !isMathObject(node.expression.expression) && node.arguments.length === 1 && isNumber(node.arguments[0])) return true;
    return ts.forEachChild(node, hasNumberMax) ?? false;
  };
  const visit = (node: ts.Node) => {
    if ((ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) && node.initializer && NAME_OR_TITLE.test(keyText(node.name)) && hasNumberMax(node.initializer)) lines.push(at(node));
    if (ts.isJsxAttribute(node) && node.name.getText(file) === "maxLength" && node.initializer && ts.isJsxExpression(node.initializer) && isNumber(node.initializer.expression)) {
      const others = node.parent.properties.filter((a) => a !== node);
      if (others.some((a) => mentionsNameOrTitle(a, file))) lines.push(at(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

function parseSource(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Every declaration of `name` (function, variable, class, method, property): however it is spelled or exported. A shorthand `{ name }` and a destructured `const { name } = …` are uses, not definitions. */
export function declaresName(path: string, text: string, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    const named = node as ts.Node & { name?: ts.Node };
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node))
      && named.name && (ts.isIdentifier(named.name) || ts.isStringLiteralLike(named.name)) && named.name.text === name) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(parseSource(path, text));
  return found;
}

/**
 * Does the file build a regular expression (literal, `new RegExp("...")` or `RegExp("...")` with a string) that
 * accepts `#a1b2c3` but not `#a1b2cz`, `#ggg` or `a1b2c3`? That is a `#rrggbb` check however it is spelled
 * (`[0-9a-f]`, `[\da-fA-F]`, `[a-f0-9]`, split strings), which a text pattern can only guess at.
 */
export function buildsHexColourRegExp(path: string, text: string): boolean {
  const isHexColour = (re: RegExp): boolean => {
    try {
      // Any of the stored forms (either case, 6 or 8 digits); anchored or not. Never a non-colour or a missing `#`.
      return ["#a1b2c3", "#A1B2C3", "#a1b2c3d4", "#A1B2C3D4"].some((colour) => re.test(colour)) && !re.test("#ggg") && !re.test("a1b2c3");
    } catch { return false; }
  };
  const asRegExp = (source: string, flags: string): RegExp | null => { try { return new RegExp(source, flags); } catch { return null; } };
  const stringValue = (e: ts.Expression | undefined): string | null => {
    if (!e) return null;
    if (ts.isStringLiteralLike(e)) return e.text;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = stringValue(e.left), r = stringValue(e.right);
      return l !== null && r !== null ? l + r : null;
    }
    return null;
  };
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isRegularExpressionLiteral(node)) {
      const m = /^\/(.*)\/([a-z]*)$/s.exec(node.text);
      const re = m && asRegExp(m[1], m[2].replace(/[gy]/g, ""));
      if (re && isHexColour(re)) found = true;
    } else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === "RegExp") {
      const source = stringValue(node.arguments?.[0]);
      const flags = stringValue(node.arguments?.[1]) ?? "";
      const re = source !== null && asRegExp(source, flags.replace(/[gy]/g, ""));
      if (re && isHexColour(re)) found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(parseSource(path, text));
  return found;
}
