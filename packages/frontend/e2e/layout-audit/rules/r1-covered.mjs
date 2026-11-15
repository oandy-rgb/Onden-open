// R1 可點的東西不被蓋住：中心與四角內縮 2px 的點，elementFromPoint 回傳的必須是它自己、子孫或它的 label。
// 圓角按鈕的角落本來就可能點到它的父層；所以「中心被蓋」或「至少兩個點被同一個非祖先元素蓋」才算。
// 中心被蓋＝點不到（嚴重度 1）；只有角落被鄰居的點擊範圍吃掉＝嚴重度 2。
export default {
  id: "R1", name: "可點的東西被蓋住", severity: 1,
  async run(page) {
    return page.evaluate(() => {
      const A = window.__audit, out = [];
      for (const el of A.clickables()) {
        let r = A.visibleRect(el);
        if (r.width < 6 || r.height < 6) continue;
        // A link wrapped over several text lines: its bounding box has corners on other lines; judge its first line.
        if (A.style(el).display === 'inline' && el.getClientRects().length > 1) { const f = el.getClientRects()[0]; r = { left: f.left, top: f.top, right: f.right, bottom: f.bottom, width: f.width, height: f.height }; }
        const centre = [r.left + r.width / 2, r.top + r.height / 2];
        // A round or pill shape has no corners: test points well inside it instead.
        const radius = parseFloat(A.style(el).borderTopLeftRadius) || 0, rounded = radius >= Math.min(r.width, r.height) * 0.4;
        const ix = rounded ? r.width * 0.3 : 2, iy = rounded ? r.height * 0.3 : 2;
        const pts = [centre, [r.left + ix, r.top + iy], [r.right - ix, r.top + iy], [r.left + ix, r.bottom - iy], [r.right - ix, r.bottom - iy]];
        const covers = new Map(); let centreCover = null, tested = 0;
        pts.forEach(([x, y], i) => {
          const hit = document.elementFromPoint(x, y);
          tested++;
          if (A.hits(el, hit)) return;
          if (hit && hit.contains(el) && i !== 0) return; // a corner of a rounded shape: the parent shows through
          covers.set(hit, (covers.get(hit) || 0) + 1);
          if (i === 0) centreCover = hit;
        });
        const worst = centreCover ?? [...covers.entries()].find(([, n]) => n >= 2)?.[0];
        if (!worst && !centreCover) continue;
        // A text field with its own clear button inside it; and content that is only under a fixed bar because the
        // page is scrolled there (R4 checks that the end of the scroll is reachable).
        if (worst && el.matches('input, textarea, select') && worst.tagName === 'BUTTON' && worst.parentElement === el.parentElement) continue;
        if (worst && A.scrollsUnder(el, worst)) continue;
        out.push({ ...A.describe(el), severity: centreCover ? 1 : 2, box: A.box(r), detail: { coveredPoints: [...covers.values()].reduce((a, b) => a + b, 0) + '/' + tested, coveredBy: worst ? A.selector(worst) + (A.label(worst) ? ' "' + A.label(worst) + '"' : '') : '?', centreCovered: !!centreCover } });
      }
      return out;
    });
  },
};
