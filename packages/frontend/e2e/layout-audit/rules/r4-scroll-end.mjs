// R4 捲動容器的最後一項到得了：捲到底後最後一個子項完整在可視範圍內；子項被壓縮（內容比自己的框高）也報。
export default {
  id: "R4", name: "捲動容器的最後一項到不了／子項被壓縮", severity: 1,
  async run(page) {
    return page.evaluate(() => {
      const A = window.__audit, out = [];
      const root = A.scopeRoot();
      const all = [...root.querySelectorAll('*')].concat(root === document.body ? [] : [root]);
      // A bar fixed at the bottom (a phone's tab bar) hides what is under it, so a scroller that runs under the bar
      // must leave room for it at the end of its scroll.
      const bars = [...document.body.querySelectorAll('*')].filter((e) => A.style(e).position === 'fixed' && A.visible(e)).filter((e) => { const r = e.getBoundingClientRect(); return r.bottom >= innerHeight - 1 && r.width >= innerWidth * 0.5 && r.height < innerHeight * 0.4; });
      const containers = all.filter((el) => {
        if (el.closest('svg, canvas, .cm-editor, [data-audit-ignore]') || !A.visible(el)) return false;
        const s = A.style(el);
        const scrolls = s.overflowY === 'auto' || s.overflowY === 'scroll';
        return (scrolls && el.scrollHeight > el.clientHeight + 1) || el.matches('.ui-menu--sheet, [role=dialog], [role=menu]');
      });
      for (const c of containers) {
        const kids = [...c.children].filter((k) => A.isShown(k) && A.style(k).position !== 'fixed' && A.style(k).position !== 'absolute' && k.getBoundingClientRect().height > 0);
        if (!kids.length) continue;
        const before = c.scrollTop;
        c.scrollTop = c.scrollHeight;
        const cr = c.getBoundingClientRect();
        const last = kids[kids.length - 1], lr = last.getBoundingClientRect();
        const padBottom = parseFloat(A.style(c).paddingBottom) || 0;
        // Inside a scroller that itself ends above the bar the bar does not matter; inside one that runs under it, it does.
        // Only a bar that is really drawn over the scroller's bottom edge counts (a sheet or dialog sits above the tab bar).
        const cx = Math.min(Math.max(cr.left + cr.width / 2, 0), innerWidth - 1);
        const over = bars.filter((b) => { if (b === c || b.contains(c) || c.contains(b)) return false; const t = b.getBoundingClientRect().top; const hit = document.elementFromPoint(cx, Math.min(innerHeight - 1, Math.max(t + 2, 0))); return !!hit && b.contains(hit); });
        const barTop = Math.min(Infinity, ...over.map((b) => b.getBoundingClientRect().top));
        const limit = Math.min(cr.bottom, innerHeight, cr.bottom > barTop ? barTop : Infinity);
        if (lr.bottom > limit + 1.5) out.push({ ...A.describe(last), box: A.box(lr), detail: { problem: '捲到底後最後一項仍超出 ' + A.num(lr.bottom - limit) + 'px', container: A.selector(c), containerPaddingBottom: padBottom } });
        // Squeezed children: what the child holds in normal flow reaches below the box the layout gave it.
        // (Absolutely positioned bits such as an invisible ::after that widens a tap area do not count.)
        for (const k of kids) {
          const ks = A.style(k);
          if (k.clientHeight <= 0 || ks.overflowY === 'auto' || ks.overflowY === 'scroll' || !(k.textContent || '').trim()) continue;
          const kr = k.getBoundingClientRect(), limitY = kr.bottom - (parseFloat(ks.paddingBottom) || 0);
          let lowest = -Infinity;
          for (const n of k.childNodes) {
            if (n.nodeType === 1) { const p = A.style(n).position; if (p === 'absolute' || p === 'fixed' || !A.isShown(n)) continue; const r = n.getBoundingClientRect(); if (r.height > 0) lowest = Math.max(lowest, r.bottom); }
            else if (n.nodeType === 3 && n.textContent.trim()) { const rg = document.createRange(); rg.selectNodeContents(n); lowest = Math.max(lowest, ...[...rg.getClientRects()].map((r) => r.bottom)); }
          }
          if (lowest - limitY > 1.5) out.push({ ...A.describe(k), box: A.box(kr), detail: { problem: '子項被壓縮：內容比框多出 ' + A.num(lowest - limitY) + 'px（框高 ' + A.num(kr.height) + 'px）', container: A.selector(c) } });
        }
        c.scrollTop = before;
      }
      return out;
    });
  },
};
