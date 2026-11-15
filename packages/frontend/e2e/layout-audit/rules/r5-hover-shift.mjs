// R5 滑鼠移過去版面不位移（只在桌面寬度）：對畫面上每個可點元素 hover，比較 hover 前後所有可見元素的外框；
// 任何元素移動或大小改變 > 0.5px 就報。hover 時本身變色、出現浮出提示（新出現／絕對定位且原本不存在）不算。
const MAX_TARGETS = 30;
// Hovering is the same at every desktop width; running it at three of them keeps the audit short.
const WIDTHS = new Set(["1280", "1100", "1920"]);
export default {
  id: "R5", name: "滑鼠移過去版面位移", severity: 2,
  when: (vp) => WIDTHS.has(vp.id),
  async run(page, ctx) {
    const targets = await page.evaluate((max) => {
      const A = window.__audit;
      const items = A.clickables().filter((el) => { const r = A.visibleRect(el); return r.width >= 4 && r.height >= 4 && r.top >= 0 && r.bottom <= innerHeight; });
      // Spread the sample over the whole list instead of taking only the first ones.
      const step = Math.max(1, items.length / max);
      const picked = []; for (let i = 0; i < items.length && picked.length < max; i += step) picked.push(items[Math.floor(i)]);
      window.__auditTargets = picked;
      window.__auditBefore = new Map();
      for (const el of document.body.querySelectorAll('*')) {
        if (!A.isShown(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) window.__auditBefore.set(el, { x: r.left, y: r.top, w: r.width, h: r.height });
      }
      return picked.map((el) => { const r = A.visibleRect(el); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    }, MAX_TARGETS);
    const out = [];
    for (let i = 0; i < targets.length; i++) {
      await page.mouse.move(1, 1);
      await page.waitForTimeout(30);
      await page.mouse.move(targets[i].x, targets[i].y);
      await page.waitForTimeout(90);
      const moved = await page.evaluate((i) => {
        const A = window.__audit, hovered = window.__auditTargets[i];
        if (!hovered.isConnected) return null;
        const found = [];
        for (const [el, b] of window.__auditBefore) {
          if (!el.isConnected || hovered.contains(el) && el !== hovered) continue;
          if (el.contains(hovered) && el !== hovered) continue; // an ancestor follows its child; the child is reported
          const r = el.getBoundingClientRect();
          const d = Math.max(Math.abs(r.left - b.x), Math.abs(r.top - b.y), Math.abs(r.width - b.w), Math.abs(r.height - b.h));
          if (d > 0.5 && A.isShown(el) && (b.w > 0 || b.h > 0)) found.push({ el, d, from: b, to: { x: r.left, y: r.top, w: r.width, h: r.height } });
        }
        // Keep the outermost moved boxes only: their children moved with them.
        const roots = found.filter((f) => !found.some((g) => g.el !== f.el && g.el.contains(f.el)));
        return { hovered: A.describe(hovered), moved: roots.slice(0, 4).map((f) => ({ ...A.describe(f.el), from: f.from, to: f.to })), count: roots.length };
      }, i);
      if (moved && moved.count) {
        for (const m of moved.moved) {
          const r = (n) => Math.round(n * 10) / 10;
          out.push({ selector: m.selector, text: m.text, box: { x: m.to.x, y: m.to.y, w: m.to.w, h: m.to.h },
            detail: { whenHovering: `${moved.hovered.selector} "${moved.hovered.text}"`, before: `${r(m.from.x)},${r(m.from.y)} ${r(m.from.w)}×${r(m.from.h)}`, after: `${r(m.to.x)},${r(m.to.y)} ${r(m.to.w)}×${r(m.to.h)}` } });
        }
      }
    }
    await page.mouse.move(1, 1);
    await page.evaluate(() => { delete window.__auditTargets; delete window.__auditBefore; });
    return out;
  },
};
