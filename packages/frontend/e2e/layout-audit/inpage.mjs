// Helpers that run INSIDE the page (installed once as window.__audit); every rule's page-side code uses them,
// so "visible", "clickable" and "which element is this" mean the same thing in all rules.
export const INPAGE_SOURCE = String.raw`
(() => {
  if (window.__audit) return;
  const CLICKABLE = 'button, a[href], [role=button], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=option], [role=treeitem], [role=switch], [role=checkbox], [role=radio], [role=link], input:not([type=hidden]), select, textarea, summary';
  const OVERLAYS = '[role=dialog], [aria-modal=true], .ui-menu--sheet, [role=menu], [role=listbox]';
  const num = (n) => Math.round(n * 10) / 10;
  const style = (el) => getComputedStyle(el);

  // The part of an element that can actually be seen: its box cut by every clipping ancestor and the window.
  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    let { left, top, right, bottom } = r;
    right = Math.min(right, innerWidth); bottom = Math.min(bottom, innerHeight); left = Math.max(left, 0); top = Math.max(top, 0);
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = style(p);
      if (s.display === 'contents') continue;
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        const pr = p.getBoundingClientRect();
        if (s.overflowX !== 'visible') { left = Math.max(left, pr.left); right = Math.min(right, pr.right); }
        if (s.overflowY !== 'visible') { top = Math.max(top, pr.top); bottom = Math.min(bottom, pr.bottom); }
      }
    }
    if (right - left <= 0 || bottom - top <= 0) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }
  function isShown(el) {
    for (let p = el; p; p = p.parentElement) {
      const s = style(p);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || Number(s.opacity) === 0) return false;
      if (p.hasAttribute('inert') || p.getAttribute('aria-hidden') === 'true') return false;
    }
    return true;
  }
  const visible = (el) => isShown(el) && visibleRect(el) !== null;

  // Where the audit looks: the topmost open dialog / menu / sheet if there is one (what is behind it cannot be
  // clicked, so it is not judged), otherwise the whole page.
  function scopeRoot() {
    const open = [...document.querySelectorAll(OVERLAYS)].filter(visible);
    return open.length ? open[open.length - 1] : document.body;
  }
  function inScope(el, root) { return root === document.body || root.contains(el); }

  function clickables(root = scopeRoot()) {
    return [...root.querySelectorAll(CLICKABLE)].concat(root.matches && root.matches(CLICKABLE) ? [root] : [])
      .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !(el.tagName === 'INPUT' && el.type === 'hidden'))
      .filter((el) => !el.closest('[data-audit-ignore]'))
      // pointer-events: none on purpose (a touch card's title until it is focused): the press is meant to reach what is under it.
      .filter((el) => style(el).pointerEvents !== 'none')
      .filter(visible);
  }

  const HASHY = /^(css-|_)|[0-9]{3,}|^[a-z]{1,6}-[A-Za-z0-9]{6,}$|^[A-Za-z]{1,3}[0-9]/;
  const TIDY_ATTR = /[0-9a-f]{8}-[0-9a-f]{4}-|\d{4}-\d{2}-\d{2}/;
  function part(el) {
    let s = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (role) s += '[role=' + role + ']';
    const cls = [...el.classList].filter((c) => !HASHY.test(c) && !/^(is-|has-)/.test(c)).slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    const aria = el.getAttribute('aria-label');
    if (aria && !TIDY_ATTR.test(aria)) s += '[aria-label="' + aria.slice(0, 24) + '"]';
    return s;
  }
  // A readable, stable name: the element and up to three ancestors that have a class or role of their own.
  function selector(el) {
    const parts = [part(el)];
    let hops = 0;
    for (let p = el.parentElement; p && p !== document.body && hops < 3; p = p.parentElement) {
      const t = part(p);
      if (t.includes('.') || t.includes('[role')) { parts.unshift(t); hops++; }
    }
    return parts.join(' > ');
  }
  function label(el) {
    const t = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 28);
  }
  function describe(el) { return { selector: selector(el), text: label(el) }; }
  function box(r) { return { x: num(r.left), y: num(r.top), w: num(r.width), h: num(r.height) }; }

  function labelOf(el) { return el.labels && el.labels.length ? [...el.labels] : []; }
  // Does a hit on "hit" count as a hit on el? (itself, a descendant, its label, or the control inside a label)
  function hits(el, hit) {
    if (!hit) return false;
    if (el === hit || el.contains(hit)) return true;
    for (const l of labelOf(el)) if (l === hit || l.contains(hit)) return true;
    if (hit.closest && hit.closest('label') && hit.closest('label').control === el) return true;
    return false;
  }

  // The nearest ancestor (or the element itself) that stays put while the page scrolls.
  function pinned(el) {
    for (let p = el; p && p !== document.body; p = p.parentElement) { const pos = style(p).position; if (pos === 'fixed' || pos === 'sticky') return p; }
    return null;
  }
  // A page can legitimately scroll its content under a fixed bar; "reachable once scrolled" is what R4 checks.
  const scrollsUnder = (el, cover) => !!pinned(cover) && !pinned(el);

  window.__audit = { pinned, scrollsUnder, CLICKABLE, OVERLAYS, num, style, visibleRect, isShown, visible, scopeRoot, inScope, clickables, selector, label, describe, box, hits };
})();
`;
