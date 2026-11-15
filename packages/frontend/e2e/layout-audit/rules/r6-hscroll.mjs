// R6 沒有橫向捲軸：document 的 scrollWidth 不大於視窗寬度。
export default {
  id: "R6", name: "頁面出現橫向捲軸", severity: 1,
  async run(page) {
    return page.evaluate(() => {
      const A = window.__audit, de = document.documentElement;
      const sw = Math.max(de.scrollWidth, document.body.scrollWidth);
      if (sw <= de.clientWidth) return [];
      const culprits = [];
      for (const el of document.body.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > de.clientWidth + 1 && A.isShown(el) && !A.visibleRect(el)?.width) continue;
        if (r.width > 0 && r.right > de.clientWidth + 1 && A.isShown(el)) {
          // Skip what is clipped away by an ancestor: it adds no scroll width.
          const vr = A.visibleRect(el);
          if (vr && r.right > de.clientWidth + 1 && vr.right >= de.clientWidth - 0.5) culprits.push(el);
        }
        if (culprits.length >= 3) break;
      }
      const first = culprits[0];
      return [{ selector: 'html', text: '', detail: { scrollWidth: sw, clientWidth: de.clientWidth, wider: sw - de.clientWidth + 'px', culprits: culprits.map((c) => A.selector(c) + ' "' + A.label(c) + '"') }, ...(first ? { box: A.box(first.getBoundingClientRect()) } : {}) }];
    });
  },
};
