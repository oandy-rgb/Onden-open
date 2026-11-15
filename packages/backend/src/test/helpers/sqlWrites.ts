// Finds the SQL writes in a source file and where they sit: which function holds
// them, whether they run through pool.query (outside any transaction) and
// whether they sit lexically inside a spine call (mutate(), mutatePersonal(), withEventTransaction(),
// createNote(), runCascade()). test/spineGate.test.ts judges them. Working on the
// syntax tree makes the unit the function, not the file, and ignores comments.
import ts from "typescript";
import { sqlWriteIn } from "../../../eslint-rules/no-route-writes.js";

export type SqlWrite = {
  /** The function that holds the statement; "<module>" outside every function. */
  fn: string;
  line: number;
  /** The statement is an argument of pool.query(...): it cannot join mutate()'s transaction. */
  viaPool: boolean;
  /** The statement is lexically inside a call to the spine. */
  inSpineCall: boolean;
};

const SPINE_CALLS = new Set(["mutate", "mutatePersonal", "withEventTransaction", "createNote", "runCascade"]);

function statementText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" x ");
  return null;
}

function functionName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name?.getText() ?? "<anonymous>";
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.name.getText();
  }
  return null;
}

// queryOnSeparateConnection (db.ts) is pool.query by another name: a write that commits apart from the caller's transaction.
const isPoolQuery = (node: ts.Node) =>
  ts.isCallExpression(node) && (
    (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "query" && node.expression.expression.getText() === "pool")
    || (ts.isIdentifier(node.expression) && node.expression.text === "queryOnSeparateConnection"));

export function sqlWritesIn(file: string, source: string): SqlWrite[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: SqlWrite[] = [];
  const visit = (node: ts.Node, ancestors: ts.Node[]) => {
    const text = statementText(node);
    if (text && sqlWriteIn(text)) {
      out.push({
        // The outermost named function: a helper nested in it is part of it.
        fn: ancestors.map(functionName).find((name) => name !== null) ?? "<module>",
        line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        viaPool: ancestors.some(isPoolQuery),
        inSpineCall: ancestors.some((n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && SPINE_CALLS.has(n.expression.text)),
      });
    }
    ts.forEachChild(node, (child) => visit(child, [...ancestors, node]));
  };
  visit(tree, []);
  return out;
}
