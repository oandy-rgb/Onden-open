// R8 同層對齊：role=tree／list／listbox／menu／grid 與 ul／ol 裡，同一層級的項目文字起點 x 不一致（> 1px）。
// grid 看的是同一欄的格子左緣與同一列的格子上緣（抓月曆格子歪掉）。
export default {
  id: "R8", name: "同層項目沒有對齊", severity: 3,
  async run(page) {
    return page.evaluate(() => {
      const A = window.__audit, out = [];
      const root = A.scopeRoot();
      const textLeft = (el) => {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          if (!n.textContent.trim()) continue;
          const rg = document.createRange(); rg.selectNodeContents(n);
          const rs = [...rg.getClientRects()].filter((r) => r.width > 0);
          if (rs.length) return Math.min(...rs.map((r) => r.left));
        }
        return null;
      };
      const levelOf = (el, container) => { const a = el.getAttribute('aria-level'); if (a) return 'L' + a; let d = 0; for (let p = el; p && p !== container; p = p.parentElement) d++; return 'D' + d; };
      const containers = [...root.querySelectorAll('[role=tree], [role=list], [role=listbox], [role=menu], [role=grid], [role=table], ul, ol')].filter((c) => A.visible(c) && !c.closest('.cm-editor, .markdown, .prose, [data-audit-ignore]'));
      for (const c of containers) {
        const role = c.getAttribute('role');
        if (role === 'grid' || role === 'table') {
          const rows = [...c.querySelectorAll('[role=row]')].filter(A.visible);
          const cols = new Map(), tops = [];
          rows.forEach((row, ri) => {
            const cells = [...row.querySelectorAll('[role=gridcell], [role=cell], [role=columnheader]')].filter(A.visible);
            cells.forEach((cell, ci) => { const r = cell.getBoundingClientRect(); (cols.get(ci) ?? cols.set(ci, []).get(ci)).push({ cell, left: r.left + r.width / 2, w: r.width }); });
            if (cells.length > 1) { const ts = cells.map((x) => x.getBoundingClientRect().top); const spread = Math.max(...ts) - Math.min(...ts); if (spread > 1) tops.push({ row, spread }); }
          });
          for (const [ci, arr] of cols) {
            if (arr.length < 3) continue;
            const spread = Math.max(...arr.map((a) => a.left)) - Math.min(...arr.map((a) => a.left));
            if (spread > 1) out.push({ ...A.describe(c), box: A.box(c.getBoundingClientRect()), detail: { problem: '第 ' + (ci + 1) + ' 欄的格子中心線不一致', spread: A.num(spread) + 'px', cells: arr.length } });
          }
          for (const t of tops.slice(0, 3)) out.push({ ...A.describe(t.row), box: A.box(t.row.getBoundingClientRect()), detail: { problem: '同一列的格子上緣不一致', spread: A.num(t.spread) + 'px' } });
          continue;
        }
        const items = [...c.children].filter((k) => A.visible(k));
        const treeItems = role === 'tree' ? [...c.querySelectorAll('[role=treeitem]')].filter(A.visible) : items;
        const groups = new Map();
        for (const it of treeItems) {
          const x = textLeft(it); if (x === null) continue;
          const lvl = levelOf(it, c); (groups.get(lvl) ?? groups.set(lvl, []).get(lvl)).push({ it, x });
        }
        for (const [lvl, arr] of groups) {
          if (arr.length < 3) continue;
          const counts = new Map(); for (const a of arr) { const k = Math.round(a.x); counts.set(k, (counts.get(k) || 0) + 1); }
          const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
          const off = arr.filter((a) => Math.abs(a.x - mode) > 1);
          if (!off.length || off.length > arr.length / 2) continue;
          const worst = off.sort((a, b) => Math.abs(b.x - mode) - Math.abs(a.x - mode))[0];
          out.push({ ...A.describe(worst.it), box: A.box(worst.it.getBoundingClientRect()), detail: { problem: '同層文字起點與多數項目不同', level: lvl, usualX: mode, thisX: A.num(worst.x), offBy: A.num(Math.abs(worst.x - mode)) + 'px', itemsOff: off.length + '/' + arr.length, container: A.selector(c) } });
        }
      }
      return out;
    });
  },
};
