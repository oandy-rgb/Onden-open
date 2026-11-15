// R2 可點的東西互不重疊：兩個互不包含的可點元素，可見外框重疊面積 > 0（兩邊各 > 0.5px，免得吃進小數誤差）。
export default {
  id: "R2", name: "可點的東西互相重疊", severity: 2,
  async run(page) {
    return page.evaluate(() => {
      const A = window.__audit, out = [];
      const list = A.clickables().map((el) => ({ el, r: A.visibleRect(el) }));
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w <= 0.5 || h <= 0.5) continue;
        // A checkbox/radio and its own label overlap on purpose.
        if (A.hits(a.el, b.el) || A.hits(b.el, a.el)) continue;
        // Under a fixed bar only because the page is scrolled there: not an overlap in the layout.
        if (A.scrollsUnder(a.el, b.el) || A.scrollsUnder(b.el, a.el)) continue;
        // A text field with its own clear/reveal button drawn inside it overlaps by design.
        const field = (e) => e.matches('input, textarea, select');
        if ((field(a.el) && b.el.tagName === 'BUTTON' && a.el.parentElement === b.el.parentElement) || (field(b.el) && a.el.tagName === 'BUTTON' && a.el.parentElement === b.el.parentElement)) continue;
        // Both are the same control drawn twice (label+input pair, sr-only duplicate): skip when one is nearly invisible.
        if (A.style(a.el).opacity === '0' || A.style(b.el).opacity === '0') continue;
        out.push({ ...A.describe(a.el), box: A.box(a.r), detail: { overlapsWith: A.selector(b.el) + ' "' + A.label(b.el) + '"', overlapPx: A.num(w) + '×' + A.num(h) } });
      }
      return out;
    });
  },
};
