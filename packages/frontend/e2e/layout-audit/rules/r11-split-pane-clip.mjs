// R11 並排的窗格沒有橫向溢出：窗格（.split-left／.split-pane）裡的文字行不超出窗格右緣，窗格本身不橫向捲動。
// 程式碼區塊、表格、長連結在自己的區塊裡捲，不算。
export default {
  id: "R11", name: "並排窗格的文字被切掉或要橫向捲動", severity: 1,
  when: (vp) => !vp.mobile,
  async run(page) {
    return page.evaluate(() => {
      const out = [];
      for (const side of document.querySelectorAll(".split-root--on > .split-left, .split-root--on > .split-pane")) {
        const box = side.getBoundingClientRect();
        if (box.width <= 0) continue;
        const clipped = [];
        const walker = document.createTreeWalker(side.querySelector(".note-document") ?? side, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent.trim() || n.parentElement.closest("pre, table, .cm-gutters, a[href^='http'], .cm-url")) continue;
          const range = document.createRange(); range.selectNodeContents(n);
          for (const r of range.getClientRects()) if (r.width > 0 && r.right > box.right + 1) clipped.push(Math.round(r.right - box.right));
        }
        const sideways = side.scrollWidth > side.clientWidth + 1;
        if (clipped.length || sideways) out.push({ selector: side.className.split(" ")[0], text: "", detail: { paneWidth: Math.round(box.width), clippedLines: clipped.length, widestOverflow: Math.max(0, ...clipped) + "px", sideways }, box: { x: box.x, y: box.y, w: box.width, h: box.height } });
      }
      return out;
    });
  },
};
