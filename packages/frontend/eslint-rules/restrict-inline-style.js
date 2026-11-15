// Onden custom rule: restrict-inline-style
//
// Allows `style={{...}}` only when every property key starts with `--`
// (CSS custom properties — the documented escape hatch for genuinely
// dynamic per-instance values).
//
// Flags every other shape:
//   - style={{ width: x }}                  // raw static prop
//   - style={cond ? { color: y } : ...}     // conditional raw
//   - style={fn()}                          // helper-returned style object
//   - style={{ "--a": x, color: y }}        // mixed raw+custom-prop
//
// See feedback_eventlogpanel_migration_pattern memory + joplin styling discipline.

const MESSAGE =
  "No inline style for static values. Move to a per-component CSS file. " +
  "For genuinely dynamic per-instance values, use CSS custom properties: " +
  "style={{ '--my-var': computed } as React.CSSProperties} + CSS rule consuming var(--my-var).";

function keyIsCustomProp(prop) {
  if (prop.type !== "Property") return false;
  const key = prop.key;
  if (key.type === "Literal" && typeof key.value === "string") {
    return key.value.startsWith("--");
  }
  if (key.type === "Identifier") {
    return key.name.startsWith("--");
  }
  return false;
}

function objectIsAllCustomProps(node) {
  if (node.type !== "ObjectExpression") return false;
  if (node.properties.length === 0) return false;
  return node.properties.every(keyIsCustomProp);
}

function expressionIsCompliant(expr) {
  if (!expr) return true;
  // Plain object literal: must be all-custom-props.
  if (expr.type === "ObjectExpression") return objectIsAllCustomProps(expr);
  // Conditional/logical with object on either side: each branch must be either
  // undefined/null or a compliant object.
  if (expr.type === "ConditionalExpression") {
    return expressionIsCompliant(expr.consequent) && expressionIsCompliant(expr.alternate);
  }
  if (expr.type === "LogicalExpression") {
    return expressionIsCompliant(expr.left) && expressionIsCompliant(expr.right);
  }
  // TSAsExpression / TypeCastExpression / ParenthesizedExpression — unwrap.
  if (expr.type === "TSAsExpression" || expr.type === "TypeCastExpression") {
    return expressionIsCompliant(expr.expression);
  }
  if (expr.type === "Identifier" && (expr.name === "undefined")) return true;
  if (expr.type === "Literal" && expr.value === null) return true;
  // Anything else (function call, identifier reference, member access, etc.) is
  // a hidden-style violation — we can't verify what it produces.
  return false;
}

export default {
  meta: {
    type: "problem",
    docs: { description: MESSAGE },
    schema: [],
    messages: { restrict: MESSAGE },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (!node.name || node.name.name !== "style") return;
        const valueNode = node.value;
        if (!valueNode || valueNode.type !== "JSXExpressionContainer") return;
        if (!expressionIsCompliant(valueNode.expression)) {
          context.report({ node: valueNode, messageId: "restrict" });
        }
      },
    };
  },
};
