// R9 手機點過不留 hover 色：點一個列表項，等一下、再點空白處；兩個時間點的背景色都必須和點之前一樣（除非它真的被選取）。
// 手機瀏覽器在點擊後會補送滑鼠事件，:hover 的樣式就留在被點的元素上；正確的寫法是把 hover 色包進 @media (hover: hover)。
export default {
  id: "R9", name: "手機點過之後殘留 hover 色", severity: 2,
  when: (vp) => vp.mobile,
  async run(page) {
    const picks = await page.evaluate(() => {
      const A = window.__audit;
      // Rows that only open or select something: a tap here must not delete, close or sign out anything.
      const DANGER = /刪除|移除|清除|登出|重設|重新開始|取消|關閉|封存|垃圾|還原|復原|匯入|匯出|下載|新增|建立|儲存|確認/;
      const rows = A.clickables().filter((el) => el.closest('[role=tree], [role=list], [role=listbox], ul, ol') && !el.closest('.cm-editor') && !DANGER.test((el.getAttribute('aria-label') || el.textContent || '').trim()) && el.tagName !== 'INPUT');
      const bgOf = (el) => { for (let p = el; p; p = p.parentElement) { const c = getComputedStyle(p).backgroundColor; if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; if (p === el.closest('li, [role=treeitem], [role=option], [role=menuitem]')) break; } return 'transparent'; };
      window.__auditRows = rows.slice(0, 5);
      return window.__auditRows.map((el, i) => { const r = A.visibleRect(el); return { i, x: r.left + r.width / 2, y: r.top + r.height / 2, ...A.describe(el), bg: bgOf(el) }; });
    });
    const out = [];
    for (const p of picks) {
      const still = await page.evaluate((i) => window.__auditRows[i]?.isConnected, p.i);
      if (!still) continue;
      // Tap the row, then an empty spot: elementFromPoint finds one with no clickable ancestor.
      const blank = await page.evaluate(() => {
        const A = window.__audit;
        for (let y = innerHeight - 8; y > 40; y -= 24) for (let x = innerWidth - 6; x > 4; x -= 20) {
          const hit = document.elementFromPoint(x, y);
          if (hit && !hit.closest(A.CLICKABLE) && !hit.closest('[role=tree], [role=list], [role=listbox], [role=menu], ul, ol, input, textarea, .cm-editor')) return { x, y };
        }
        return null;
      });
      if (!blank) continue;
      const measure = (i) => page.evaluate((i) => {
        const el = window.__auditRows[i]; if (!el || !el.isConnected) return null;
        const row = el.closest('li, [role=treeitem], [role=option], [role=menuitem]') || el;
        const selected = [el, row].some((n) => n.matches('[aria-selected=true], [aria-current], [aria-checked=true], [aria-pressed=true], .active, .is-active, .selected, .is-selected, .current') || n.querySelector('[aria-current], [aria-selected=true]'));
        let bg = 'transparent';
        for (let q = el; q; q = q.parentElement) { const c = getComputedStyle(q).backgroundColor; if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { bg = c; break; } if (q === row) break; }
        return { bg, selected };
      }, i);
      await page.touchscreen.tap(p.x, p.y);
      await page.waitForTimeout(450);
      const afterTap = await measure(p.i);
      if (!afterTap) { await page.keyboard.press('Escape').catch(() => {}); continue; }
      await page.touchscreen.tap(blank.x, blank.y);
      await page.waitForTimeout(500);
      const afterBlank = await measure(p.i);
      const res = [afterTap, afterBlank].filter(Boolean).find((m) => m.bg !== p.bg && !m.selected);
      if (res) out.push({ selector: p.selector, text: p.text, detail: { before: p.bg, afterTap: afterTap.bg, afterTapOnBlank: afterBlank ? afterBlank.bg : '(元素已不在)' } });
    }
    await page.evaluate(() => { delete window.__auditRows; });
    return out;
  },
};
