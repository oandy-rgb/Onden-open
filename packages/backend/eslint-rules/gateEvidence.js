// What a backend file actually USES, read from its syntax tree, for the read gate (require-read-gate.js).
//
// The gate rule used to test the whole file's TEXT for a primitive's name, so an import, a comment, a string
// or an unused parameter satisfied it. `gateEvidence` lists only identifiers in a position that does something:
// a call (written `name(`), an argument, a property read, a shorthand property. Imports, exports, declared names,
// type positions, comments and strings are left out. Not data flow: a primitive called on a code path that is
// never reached still counts, but a gate that is only imported or mentioned does not.
import ts from "typescript";

const DECLARED_NAME_PARENTS = [
  ts.isParameter, ts.isVariableDeclaration, ts.isFunctionDeclaration, ts.isFunctionExpression, ts.isClassDeclaration,
  ts.isMethodDeclaration, ts.isPropertyDeclaration, ts.isPropertySignature, ts.isMethodSignature, ts.isBindingElement,
  ts.isTypeAliasDeclaration, ts.isInterfaceDeclaration, ts.isEnumDeclaration, ts.isEnumMember, ts.isPropertyAssignment,
  ts.isGetAccessorDeclaration, ts.isSetAccessorDeclaration, ts.isLabeledStatement, ts.isTypeParameterDeclaration,
];

/** Identifiers the file uses, in source order; a callee carries a trailing "(" (`canReadNode(`, `policy.canReadNode(`). */
export function gateEvidence(source) {
  const file = ts.createSourceFile("read.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const used = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const declaresIt = DECLARED_NAME_PARENTS.some((is) => is(parent)) && parent.name === node;
      if (!declaresIt) {
        const callee = ts.isCallExpression(parent) && parent.expression === node
          || ts.isPropertyAccessExpression(parent) && parent.name === node && ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
        used.push(node.text + (callee ? "(" : ""));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return used.join(" ");
}

/** Does the file use the primitive `claimed` (a regexp over {@link gateEvidence}) and not just name it? */
export const usesGate = (source, claimed) => claimed.test(gateEvidence(source));
