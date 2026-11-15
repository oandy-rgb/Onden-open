// R10 打開的清單不跟頁面文字疊在一起：每個可見的 listbox（連同包著它的浮層）與筆記的標題、灰字那一行、內文第一行比較外框；
// 重疊時，重疊處最上面的必須是浮層本身，且浮層有不透明的底色（蓋住就看不到底下的字）。
// 清單直接畫在頁面裡（不是浮層）卻與這些文字重疊，兩邊的字都看得到、都讀不清楚：那是「設定上層」清單印在標題上的那種錯誤。
export default {
  id: "R10", name: "打開的清單與頁面文字疊在一起", severity: 1,
  async run(page) {
    return page.evaluate(() => {
      const A = window.__audit, out = [];
      const TEXT = ['.note-document .obsidian-title-input', '.note-document .note-meta-line',
        '.note-document .cm-line', '.note-document .obsidian-preview p'];
      const blocks = TEXT.map((s) => document.querySelector(s)).filter((e) => e && A.visible(e));
      for (const list of document.querySelectorAll('[role="listbox"]')) {
        if (!A.visible(list)) continue;
        const holder = list.closest('.ui-popover') ?? list;
        const box = holder.getBoundingClientRect();
        const bg = getComputedStyle(holder).backgroundColor;
        const alpha = bg.startsWith('rgba') ? Number(bg.split(',')[3]) : bg === 'transparent' ? 0 : 1;
        const floating = holder.classList.contains('ui-popover') && alpha >= 0.99;
        for (const el of blocks) {
          if (holder.contains(el) || el.contains(holder)) continue;
          const r = A.visibleRect(el);
          const w = Math.min(r.right, box.right) - Math.max(r.left, box.left);
          const h = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
          if (w <= 2 || h <= 2) continue;
          const x = Math.max(r.left, box.left) + w / 2, y = Math.max(r.top, box.top) + h / 2;
          const top = document.elementFromPoint(x, y);
          if (floating && top && holder.contains(top)) continue;
          out.push({ ...A.describe(el), box: A.box(box), detail: { listOver: A.selector(list), overlapPx: A.num(w) + '×' + A.num(h), floatingAndOpaque: floating } });
        }
      }
      return out;
    });
  },
};
