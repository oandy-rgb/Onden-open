// Onden custom rule: modals-through-ui-modal (depth audit D99)
//
// Every modal is a ui/Modal (components/ui/Modal.tsx): a native <dialog>
// opened with showModal(), so the page behind is inert, Esc closes only the top
// modal, a modal opened from a modal stacks above it, and the page's keyboard
// shortcuts wait while one is open. A modal built by hand (a fixed overlay
// with its own focus trap, Esc handler and z-index) gets each of those wrong in
// its own way: ⌘K in Version history opened the palette UNDER it.
//
// Flags, outside components/ui (exempt in eslint.config.js):
//   aria-modal={...}                       a hand-made modal says it is one
//   <dialog>  /  x.showModal()             a second native-modal implementation
//   <div role="dialog"> / role="alertdialog" on an HTML element: a hand-made
//                                          dialog overlay (<Modal role=…> is fine)
// A non-modal dialog (a popover anchored to a control) may keep its role with
// an eslint-disable comment that says why it is not a modal.

const MESSAGE =
  "Modals go through ui/Modal (components/ui/Modal.tsx): it owns the top layer, Esc, focus, stacking and the page's shortcuts. " +
  "Wrap the card in <Modal label=… className=… onClose=…>. A non-modal popover dialog: disable this line and say why.";

function attrName(node) {
  return node.name && node.name.type === "JSXIdentifier" ? node.name.name : null;
}

// <div role=…> is a hand-made dialog; <Modal role="alertdialog"> asks ui/Modal for one.
function onHtmlElement(attr) {
  const el = attr.parent;
  return el && el.type === "JSXOpeningElement" && el.name.type === "JSXIdentifier" && /^[a-z]/.test(el.name.name);
}

function literalValue(value) {
  if (!value) return null;
  if (value.type === "Literal") return value.value;
  if (value.type === "JSXExpressionContainer" && value.expression.type === "Literal") return value.expression.value;
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Build every modal on ui/Modal" },
    schema: [],
    messages: { handMade: "{{what}}: " + MESSAGE },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        const name = attrName(node);
        if (name === "aria-modal") {
          context.report({ node, messageId: "handMade", data: { what: "aria-modal" } });
          return;
        }
        if (name === "role" && onHtmlElement(node)) {
          const role = literalValue(node.value);
          if (role === "dialog" || role === "alertdialog") {
            context.report({ node, messageId: "handMade", data: { what: `role="${role}"` } });
          }
        }
      },
      JSXOpeningElement(node) {
        if (node.name.type === "JSXIdentifier" && node.name.name === "dialog") {
          context.report({ node, messageId: "handMade", data: { what: "<dialog>" } });
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === "MemberExpression" && !callee.computed
          && callee.property.type === "Identifier" && callee.property.name === "showModal") {
          context.report({ node, messageId: "handMade", data: { what: "showModal()" } });
        }
      },
    };
  },
};
