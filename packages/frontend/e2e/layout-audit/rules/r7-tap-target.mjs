// R7 手機點擊目標 ≥ 44×44：量實際可點的區域（用 elementFromPoint 沿中線掃描，::after 擴大的點擊範圍也算），列出不足的。
// 文字段落裡的行內連結（編輯器、Markdown 內文）按 WCAG 的「行內」例外不算；白板畫布裡的卡片大小隨縮放變，也不算。
const MIN = 44;
export default {
  id: "R7", name: "手機點擊目標小於 44×44", severity: 2,
  when: (vp) => vp.mobile,
  async run(page) {
    return page.evaluate((MIN) => {
      const A = window.__audit, out = [];
      for (const el of A.clickables()) {
        if (el.closest('.cm-editor, .markdown, .prose, .react-flow__viewport, [data-audit-ignore]')) continue;
        if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type) && el.labels && el.labels.length) continue; // the label is the target
        const r = A.visibleRect(el);
        if (r.width < 2 || r.height < 2) continue;
        // A row cut off by the edge of its own scrolling list is reached by scrolling; its visible slice is not its size.
        const own = el.getBoundingClientRect();
        if (r.height < own.height - 1 && el.parentElement?.closest('ul, ol, [role=listbox], [role=menu]') && /auto|scroll/.test(A.style(el.parentElement.closest('ul, ol, [role=listbox], [role=menu]')).overflowY)) continue;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const extent = (dx, dy) => {
          let n = 0;
          for (const sign of [1, -1]) for (let d = 0; d <= MIN * 2; d++) {
            const x = cx + sign * d * dx, y = cy + sign * d * dy;
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) break;
            if (!A.hits(el, document.elementFromPoint(x, y))) break;
            n++;
            if (n >= MIN) return n; // big enough; no need to know how much bigger
          }
          return n;
        };
        // Inline link inside running text: exempt.
        const s = A.style(el);
        if (el.tagName === 'A' && s.display === 'inline' && el.parentElement && /^(P|LI|SPAN|DIV|TD)$/.test(el.parentElement.tagName) && [...el.parentElement.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 3)) continue;
        const w = extent(1, 0), h = extent(0, 1);
        if (w < MIN - 0.5 || h < MIN - 0.5) out.push({ ...A.describe(el), box: A.box(r), detail: { clickable: w + '×' + h, drawn: A.num(r.width) + '×' + A.num(r.height) } });
      }
      return out;
    }, MIN);
  },
};
