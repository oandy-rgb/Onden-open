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
        if (el.closest('.cm-editor, .markdown, .prose, .obsidian-preview--md, .react-flow__viewport, [data-audit-ignore]')) continue; // .obsidian-preview--md: a note's rendered Markdown (history preview, reading view)
        if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type) && el.labels && el.labels.length) continue; // the label is the target
        const r = A.visibleRect(el);
        if (r.width < 2 || r.height < 2) continue;
        // A control cut off by the edge of a scrolling box (the list itself or any box around it, or the window) is reached
        // by scrolling; its visible slice is not its size. (2026-11-22: the phone settings list scrolls in a div around
        // the ul, so its last row's 19px slice was reported as a 19px row.)
        const own = el.getBoundingClientRect();
        if (r.height < own.height - 1 || r.width < own.width - 1) {
          let box = el.parentElement;
          while (box && box !== document.body && !/auto|scroll/.test(A.style(box).overflowY + A.style(box).overflowX)) box = box.parentElement;
          const edge = box && box !== document.body ? box.getBoundingClientRect() : { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
          if (own.top < edge.top - 0.5 || own.bottom > edge.bottom + 0.5 || own.left < edge.left - 0.5 || own.right > edge.right + 0.5) continue;
        }
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        // A row the page scrolls under a fixed or sticky bar (the phone's bottom navigation) is reached once scrolled: that
        // is R4's question, not its size.
        const atCentre = document.elementFromPoint(cx, cy);
        if (atCentre && !A.hits(el, atCentre) && A.scrollsUnder(el, atCentre)) continue;
        const extent = (dx, dy) => {
          let n = 0;
          for (const sign of [1, -1]) for (let d = 0; d <= MIN * 2; d++) {
            const x = cx + sign * d * dx, y = cy + sign * d * dy;
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) break;
            const at = document.elementFromPoint(x, y);
            if (!A.hits(el, at) && !A.scrollsUnder(el, at)) break; // a toast or a fixed bar over part of it is R1/R4's, not its size
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
