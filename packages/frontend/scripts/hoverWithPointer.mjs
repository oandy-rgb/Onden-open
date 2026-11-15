// :hover only where a pointer can hover. On a touch screen the browser keeps :hover on
// the last thing tapped, so a hover tint stays on a row or a ▸ after the finger lifts
// (the sidebar's selected row grew a dark block, 2026-11-01). Every stylesheet of the
// build goes through this postcss plugin (astro.config.mjs): a rule whose selector
// hovers is moved into @media (hover: hover). Write plain `:hover`; nobody writes that
// wrapper by hand. scripts/check-app-css.mjs fails the build if a built sheet still
// has a hover tint outside it.
//
// Left as written:
//  - rules already inside a @media that asks about hover;
//  - :hover only inside :not(…), which is true on a touch screen;
//  - rules that show or hide something (opacity, display, …): on a touch screen a tap
//    is how those get revealed, so the sticky :hover is the feature there.

const HOVER_MEDIA = "(hover: hover)";
const REVEAL = /^(opacity|visibility|display|pointer-events|width|height|max-width|max-height|clip|clip-path)$/;

/** The selector without its :not(…) parts (balanced parentheses). */
function withoutNot(selector) {
  let out = "";
  for (let i = 0; i < selector.length; i++) {
    if (selector.startsWith(":not(", i)) {
      let depth = 0;
      for (i += 4; i < selector.length; i++) {
        if (selector[i] === "(") depth++;
        else if (selector[i] === ")" && --depth === 0) break;
      }
      continue;
    }
    out += selector[i];
  }
  return out;
}

export const hovers = (selector) => /:hover\b/.test(withoutNot(selector));

function insideHoverMedia(node) {
  for (let p = node.parent; p; p = p.parent) if (p.type === "atrule" && p.name === "media" && /\bhover\b/.test(p.params)) return true;
  return false;
}

function reveals(rule) {
  let found = false;
  rule.walkDecls((decl) => { if (REVEAL.test(decl.prop)) found = true; });
  return found;
}

/** Rules whose hover this plugin would move: they tint on hover, outside a hover media. */
export function bareHoverRules(root) {
  const out = [];
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes$/.test(rule.parent.name)) return;
    if (!rule.selectors.some(hovers) || insideHoverMedia(rule) || reveals(rule)) return;
    out.push(rule);
  });
  return out;
}

export default function hoverWithPointer() {
  return {
    postcssPlugin: "onden-hover-with-pointer",
    OnceExit(root, { AtRule }) {
      for (const rule of bareHoverRules(root)) {
        const hovering = rule.selectors.filter(hovers);
        const rest = rule.selectors.filter((s) => !hovers(s));
        const media = new AtRule({ name: "media", params: HOVER_MEDIA });
        if (rest.length === 0) {
          rule.replaceWith(media);
          media.append(rule);
        } else {
          media.append(rule.clone({ selectors: hovering }));
          rule.selectors = rest;
          rule.after(media);
        }
      }
    },
  };
}
hoverWithPointer.postcss = true;
