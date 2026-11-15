// R3 文字被截斷：overflow 不是 visible／auto／scroll（會被切掉）、內容比框大超過 1px，且不是刻意的 ellipsis／line-clamp。
export default {
  id: "R3", name: "文字被截斷", severity: 1,
  async run(page) {
    return page.evaluate(() => {
      const A = window.__audit, out = [];
      const root = A.scopeRoot();
      for (const el of root.querySelectorAll('*')) {
        if (el.closest('svg, canvas, .cm-editor, .react-flow, [data-audit-ignore]') || ['IMG', 'VIDEO', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(el.tagName)) continue;
        const s = A.style(el);
        const clips = (v) => v === 'hidden' || v === 'clip';
        if (!clips(s.overflowX) && !clips(s.overflowY)) continue;
        if (!A.visible(el)) continue;
        const dx = el.scrollWidth - el.clientWidth, dy = el.scrollHeight - el.clientHeight;
        const cutX = clips(s.overflowX) && dx > 1, cutY = clips(s.overflowY) && dy > 1;
        if (!cutX && !cutY) continue;
        if (el.clientWidth === 0 || el.clientHeight === 0) continue; // collapsed on purpose
        const ellipsis = s.textOverflow === 'ellipsis' || s.textOverflow === 'clip' && false;
        const clamp = s.webkitLineClamp && s.webkitLineClamp !== 'none';
        if ((ellipsis && cutX && !cutY) || clamp) continue;
        if (ellipsis && cutY && s.whiteSpace === 'nowrap') continue;
        // Only text counts: a clipped decoration or a collapsed wrapper hides nothing the person reads.
        const hasText = (el.textContent || '').trim().length > 0;
        if (!hasText) continue;
        // A box that animates its height (accordion) is cut by design while it is partly open; a cut that leaves
        // none of the text visible is the closed state.
        const r = A.visibleRect(el);
        if (!r) continue;
        out.push({ ...A.describe(el), box: A.box(r), detail: { overflowX: cutX ? A.num(dx) + 'px' : '-', overflowY: cutY ? A.num(dy) + 'px' : '-', client: el.clientWidth + '×' + el.clientHeight, scroll: el.scrollWidth + '×' + el.scrollHeight } });
      }
      return out;
    });
  },
};
