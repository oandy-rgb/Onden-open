// Runs INSIDE the page (after layout-audit's inpage.mjs, whose `window.__audit` it reuses for "what is shown" and
// "what is this element called"). Walks the rendered DOM of the current screen and returns, per kind of value in
// docs/agents/appearance-rules.md, every COMPUTED value with its count and up to three example elements.
// Classification (on / off the scale) is NOT done here: scale.mjs does it in Node, so the scale lives in one place.
export const CENSUS_SOURCE = String.raw`
(() => {
  if (window.__census) return;
  const A = window.__audit;
  const HASHY = /^(css-|_)|[0-9]{3,}|^[a-z]{1,6}-[A-Za-z0-9]{6,}$|^[A-Za-z]{1,3}[0-9]/;
  const r1 = (n) => Math.round(n * 10) / 10;
  const r2 = (n) => Math.round(n * 100) / 100;
  const pxv = (s) => Number.parseFloat(s);

  // "Which kind of element" without its position: tag, role and the first two readable classes.
  function keyOf(el) {
    let s = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (role) s += '[' + role + ']';
    const cls = [...el.classList].filter((c) => !HASHY.test(c) && !/^(is-|has-)/.test(c)).slice(0, 2);
    return cls.length ? s + '.' + cls.join('.') : s;
  }

  // ── token reverse maps: a computed value → the name of the token that has it in the current theme ──
  function reverseMaps(priority) {
    const names = new Set();
    const scan = (rules) => { for (const r of rules) {
      if (r.style) for (const p of r.style) if (p.startsWith('--')) names.add(p);
      if (r.cssRules) scan(r.cssRules);
    } };
    for (const sheet of document.styleSheets) { try { scan(sheet.cssRules); } catch {} }
    const host = document.createElement('div'); host.style.cssText = 'position:absolute;visibility:hidden;color:rgb(1,2,3)';
    const probe = document.createElement('div'); host.appendChild(probe); document.body.appendChild(host);
    const colour = new Map(), shadow = new Map(), z = new Map(), family = {};
    const order = (a, b) => { const ia = priority.indexOf(a), ib = priority.indexOf(b); return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib) || a.localeCompare(b); };
    for (const n of [...names].sort(order)) {
      if (/^--(ac|onden)-/.test(n) && !/shadow|ring|bar-|inset|edge|font|fs-|fw-|lh-|space|radius|row|control|tap|topbar|tree|panel|prose|page|list|phone|focus-(offset|inset|outline)|motion|ease|ui-|note-|hint|leading|tracking|weight|text-(xs|sm|base)/.test(n)) {
        probe.style.color = ''; probe.style.color = 'var(' + n + ')';
        const c = getComputedStyle(probe).color;
        if (c !== 'rgb(1, 2, 3)' && !colour.has(c)) colour.set(c, n);
      }
      if (/shadow|ring|bar-|inset-ring|edge|^--shadow$|focus-ring/.test(n)) {
        probe.style.boxShadow = ''; probe.style.boxShadow = 'var(' + n + ')';
        const s = getComputedStyle(probe).boxShadow;
        if (s && s !== 'none' && !shadow.has(s)) shadow.set(s, n);
      }
      if (/^--z-/.test(n)) {
        probe.style.zIndex = ''; probe.style.zIndex = 'var(' + n + ')';
        const v = getComputedStyle(probe).zIndex;
        if (v !== 'auto' && !z.has(v)) z.set(v, n);
      }
      if (/^--ac-font-(ui|serif|mono|kai|display|prose)$/.test(n)) {
        probe.style.fontFamily = 'var(' + n + ')';
        family[n.slice(10)] = getComputedStyle(probe).fontFamily.split(',')[0].trim().replace(/["']/g, '');
      }
    }
    host.remove();
    return { colour, shadow, z, family };
  }

  // ── which stylesheet rule declares a property (the last matching rule wins: an approximation of the cascade) ──
  const PROP_ALIASES = { height: ['height', 'min-height', 'padding-top', 'padding-block', 'line-height'], 'background-color': ['background-color', 'background'],
    'border-top-color': ['border-top-color', 'border-color', 'border-top', 'border'], 'border-right-color': ['border-right-color', 'border-color', 'border-right', 'border'],
    'border-bottom-color': ['border-bottom-color', 'border-color', 'border-bottom', 'border'], 'border-left-color': ['border-left-color', 'border-color', 'border-left', 'border'],
    'border-top-width': ['border-top-width', 'border-width', 'border-top', 'border'], 'border-right-width': ['border-right-width', 'border-width', 'border-right', 'border'],
    'border-bottom-width': ['border-bottom-width', 'border-width', 'border-bottom', 'border'], 'border-left-width': ['border-left-width', 'border-width', 'border-left', 'border'],
    'transition-duration': ['transition-duration', 'transition'], 'animation-duration': ['animation-duration', 'animation'] };
  const ruleIndex = new Map(); // property → [rule]
  let allRules = null;
  function flatRules() {
    if (allRules) return allRules;
    allRules = [];
    const walk = (rules, sheet) => { for (const r of rules) {
      if (r.selectorText) allRules.push({ sel: r.selectorText, style: r.style, sheet: sheet.href ? sheet.href.split('/').pop() : 'inline <style>' });
      if (r.cssRules) walk(r.cssRules, sheet);
    } };
    for (const sheet of document.styleSheets) { try { walk(sheet.cssRules, sheet); } catch {} }
    return allRules;
  }
  function declaring(prop) {
    if (!ruleIndex.has(prop)) {
      const names = PROP_ALIASES[prop] || [prop];
      ruleIndex.set(prop, flatRules().filter((r) => names.some((n) => r.style.getPropertyValue(n) !== '')));
    }
    return ruleIndex.get(prop);
  }
  function sourceOf(el, prop) {
    if (el.style && (PROP_ALIASES[prop] || [prop]).some((n) => el.style.getPropertyValue(n) !== '')) return { inline: true };
    const rules = declaring(prop);
    for (let i = rules.length - 1; i >= 0; i--) { try { if (el.matches(rules[i].sel)) return { sel: rules[i].sel, sheet: rules[i].sheet }; } catch {} }
    return null;
  }

  function collect(opts) {
    const maps = reverseMaps(opts.colourPriority || []);
    const root = A.scopeRoot();
    const coarse = matchMedia('(pointer: coarse)').matches;
    const values = {};   // kind → value → { n, ex: [{ sel, prop, key }] }
    const keys = {};     // key → { n, sel, kinds: { kind: { value: n } } }
    const reps = (window.__census_reps = new Map());
    let elements = 0;
    let taps = null;

    function add(kind, value, el, prop, key) {
      const k = (values[kind] ||= {});
      const e = (k[value] ||= { n: 0, ex: [] });
      e.n++;
      if (e.ex.length < 3 && !e.ex.some((x) => x.key === key)) e.ex.push({ sel: A.selector(el), prop, key });
      const kk = (keys[key] ||= { n: 0, sel: A.selector(el), kinds: {}, props: {} });
      const kv = (kk.kinds[kind] ||= {});
      kv[value] = (kv[value] || 0) + 1;
      (kk.props[kind + '|' + value] ||= new Set()).add(prop);
    }

    const shown = new WeakMap();
    function isShown(el) {
      if (shown.has(el)) return shown.get(el);
      const p = el.parentElement;
      let ok = !p || p === document.documentElement || isShown(p);
      if (ok) {
        const s = getComputedStyle(el);
        ok = s.display !== 'none' && s.visibility !== 'hidden' && s.visibility !== 'collapse' && Number(s.opacity) !== 0;
      }
      shown.set(el, ok);
      return ok;
    }
    const hasOwnText = (el) => { for (const c of el.childNodes) if (c.nodeType === 3 && c.nodeValue.trim()) return true; return false; };
    const alpha = (c) => { const m = c.match(/\/\s*([\d.]+)\s*\)$/) || c.match(/^rgba\([^)]*,\s*([\d.]+)\)$/); return m ? Number(m[1]) : 1; };
    // A colour without its transparency: "the same ink at 55%" is a token with an overlay, not a new colour.
    const rgbKey = (c) => { const m = c.match(/^rgba?\(([^)]*)\)$/); if (m) return m[1].split(',').slice(0, 3).map((x) => Math.round(Number(x))).join(','); const n = c.match(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/); return n ? [n[1], n[2], n[3]].map((x) => Math.round(Number(x) * 255)).join(',') : null; };
    const solid = new Map(); for (const [c, n] of maps.colour) { if (alpha(c) === 1 && !solid.has(rgbKey(c))) solid.set(rgbKey(c), n); }
    const colourName = (c) => {
      if (alpha(c) === 0) return null;
      if (maps.colour.has(c)) return 'token:' + maps.colour.get(c);
      const k = rgbKey(c);
      if (k && solid.has(k)) return 'alpha:' + solid.get(k) + '@' + r2(alpha(c));
      return 'raw:' + c;
    };
    const addColour = (c, el, prop, key) => { const v = colourName(c); if (v) add('colour', v, el, prop, key); };
    const BUTTONY = 'button, [role=button], [role=tab], [role=menuitem], [role=option], summary';
    const FIELD = 'input, textarea, select, [contenteditable=true], [role=textbox], [role=combobox], [role=searchbox]';
    const SIDES = ['top', 'right', 'bottom', 'left'];
    const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];

    const all = [root, ...root.querySelectorAll('*')];
    for (const el of all) {
      const tag = el.tagName;
      if (/^(SCRIPT|STYLE|LINK|META|HEAD|TITLE|NOSCRIPT|TEMPLATE|PATH|G|CIRCLE|RECT|LINE|POLYLINE|POLYGON|ELLIPSE|DEFS|USE|TEXT|TSPAN|CLIPPATH|MASK|LINEARGRADIENT|STOP|SYMBOL)$/i.test(tag)) continue;
      if (el.closest('svg') && tag.toLowerCase() !== 'svg') continue;
      if (el.closest('canvas, [data-census-ignore]')) continue;
      if (!isShown(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'contents') continue;
      elements++;
      const key = keyOf(el);
      if (!reps.has(key)) reps.set(key, el);
      (keys[key] ||= { n: 0, sel: A.selector(el), kinds: {}, props: {} }).n++;

      // text
      const textual = hasOwnText(el) || /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
      if (textual) {
        const fs = pxv(cs.fontSize);
        add('font-size', r2(fs) + 'px', el, 'font-size', key);
        add('font-weight', String(cs.fontWeight), el, 'font-weight', key);
        const lh = cs.lineHeight === 'normal' ? 'normal' : String(r2(pxv(cs.lineHeight) / fs));
        add('line-height', lh, el, 'line-height', key);
        add('letter-spacing', cs.letterSpacing === 'normal' ? '0' : String(r2(pxv(cs.letterSpacing) / fs)), el, 'letter-spacing', key);
        const first = cs.fontFamily.split(',')[0].trim().replace(/["']/g, '');
        const fam = Object.entries(maps.family).find(([, v]) => v === first);
        const named = fam ? ({ ui: 'sans', serif: 'serif', display: 'serif', prose: 'serif', mono: 'mono', kai: 'kai' })[fam[0]] : null;
        const generic = /mono/i.test(first) || /^(ui-monospace|monospace)$/i.test(first) ? 'mono' : null;
        add('font-family', named || generic || 'raw:' + first, el, 'font-family', key);
        addColour(cs.color, el, 'color', key);
      }
      // colours of boxes
      const bg = cs.backgroundColor;
      addColour(bg, el, 'background-color', key);

      // spacing
      for (const s of SIDES) {
        const p = pxv(cs['padding' + s[0].toUpperCase() + s.slice(1)]);
        if (p > 0) add('spacing', r1(p) + 'px', el, 'padding-' + s, key);
        const m = pxv(cs['margin' + s[0].toUpperCase() + s.slice(1)]);
        if (m > 0) {
          let auto = false;
          if ((s === 'left' || s === 'right') && el.parentElement) {
            const ml = pxv(cs.marginLeft), mr = pxv(cs.marginRight);
            const free = el.parentElement.clientWidth - el.offsetWidth;
            if (m > 64 || (ml === mr && Math.abs(free - 2 * m) <= 1.5) || (Math.abs(free - m) <= 1.5 && (ml === 0 || mr === 0))) auto = true;
          }
          if (!auto) add('spacing', r1(m) + 'px', el, 'margin-' + s, key);
        }
      }
      if (/flex|grid/.test(cs.display)) {
        for (const g of ['rowGap', 'columnGap']) { if (cs[g] !== 'normal') { const v = pxv(cs[g]); if (v > 0) add('spacing', r1(v) + 'px', el, g === 'rowGap' ? 'row-gap' : 'column-gap', key); } }
      }

      // radius
      for (const c of CORNERS) {
        const camel = 'border' + c.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('') + 'Radius';
        const raw = cs[camel].split(' ')[0];
        if (raw === '0px' || raw === '0%') continue;
        add('radius', raw === '50%' || pxv(raw) >= 99 ? 'pill' : r2(pxv(raw)) + 'px', el, 'border-' + c + '-radius', key);
      }

      // borders
      const sides = SIDES.filter((s) => {
        const U = s[0].toUpperCase() + s.slice(1);
        return cs['border' + U + 'Style'] !== 'none' && cs['border' + U + 'Style'] !== 'hidden' && pxv(cs['border' + U + 'Width']) > 0;
      });
      if (sides.length) {
        const styles = new Set();
        for (const s of sides) {
          const U = s[0].toUpperCase() + s.slice(1);
          add('border-width', r2(pxv(cs['border' + U + 'Width'])) + 'px', el, 'border-' + s + '-width', key);
          styles.add(cs['border' + U + 'Style']);
          addColour(cs['border' + U + 'Color'], el, 'border-' + s + '-color', key);
        }
        for (const st of styles) add('border-style', st, el, 'border-style', key);
        const w = pxv(cs['border' + sides[0][0].toUpperCase() + sides[0].slice(1) + 'Width']);
        const dashed = styles.has('dashed') || styles.has('dotted');
        const buttony = el.matches(BUTTONY);
        let where;
        if (sides.length >= 3) {
          where = el.matches(FIELD) ? 'ok:field-frame' : /^(TD|TH|TABLE)$/.test(tag) ? 'ok:table-grid' : dashed ? 'ok:dashed-drop-area'
            : buttony ? 'off:按鈕外面一圈框' : 'off:' + (sides.length === 4 ? '四邊' : '三邊') + '都有框（非欄位、非表格）';
        } else if (sides.length === 2) where = 'off:兩邊有框';
        else {
          const s = sides[0];
          where = (s === 'left' || s === 'right') && w >= 2 && !buttony ? 'ok:accent-rule' : s === 'bottom' && w >= 2 && el.matches('[role=tab], button') ? 'ok:tab-underline'
            : buttony && s === 'bottom' && w < 2 ? 'off:按鈕下緣一條線' : 'ok:separator';
        }
        add('border-where', where, el, 'border', key);
      }

      // shadow
      if (cs.boxShadow !== 'none') add('shadow', maps.shadow.has(cs.boxShadow) ? 'token:' + maps.shadow.get(cs.boxShadow) : 'raw:' + cs.boxShadow.slice(0, 90), el, 'box-shadow', key);

      // z-index
      if (cs.zIndex !== 'auto' && cs.position !== 'static') add('z-index', maps.z.has(cs.zIndex) ? 'token:' + maps.z.get(cs.zIndex) : 'raw:' + cs.zIndex, el, 'z-index', key);

      // opacity, max-width
      const op = Number(cs.opacity);
      if (op !== 1 && op !== 0) add('opacity', String(r2(op)), el, 'opacity', key);
      if (cs.maxWidth !== 'none' && cs.maxWidth.endsWith('px') && pxv(cs.maxWidth) <= 1400) add('max-width', r1(pxv(cs.maxWidth)) + 'px', el, 'max-width', key);

      // motion (computed; the context runs with motion allowed)
      for (const prop of ['transitionDuration', 'animationDuration']) {
        if (prop === 'animationDuration' && cs.animationIterationCount.includes('infinite')) continue; // a loading loop, not a transition
        const parts = cs[prop].split(',').map((x) => x.trim());
        const props = prop === 'transitionDuration' ? cs.transitionProperty.split(',').map((x) => x.trim()) : [];
        parts.forEach((d, i) => {
          const ms = d.endsWith('ms') ? pxv(d) : pxv(d) * 1000;
          if (ms > 0 && !(prop === 'transitionDuration' && props[i % props.length] === 'none')) add('transition-ms', String(r1(ms)) + 'ms', el, prop === 'transitionDuration' ? 'transition-duration' : 'animation-duration', key);
        });
      }

      // icons
      if (tag.toLowerCase() === 'svg') {
        const n = Math.max(rect.width, rect.height);
        if (n <= 600) {
          add('icon-size', r1(n) + 'px', el, 'width', key);
          if (cs.stroke !== 'none' && cs.stroke !== '') add('icon-stroke', String(r2(pxv(cs.strokeWidth))), el, 'stroke-width', key);
        }
      }

      // control height
      if (el.matches(A.CLICKABLE) && !(tag === 'A' && cs.display === 'inline') && !(tag === 'INPUT' && /^(checkbox|radio|range|file|color)$/.test(el.type)) && rect.height <= 80) {
        add('control-height', r1(rect.height) + 'px', el, 'height', key);
      }

      // touch target: the size that can actually be pressed (the drawn box plus any invisible extension), judged on a touch screen only.
      // Measured with elementFromPoint walking outwards from each edge, so an enlarged hit area (a ::before, padding on a wrapper) counts.
      if (coarse && el.matches(A.CLICKABLE) && !(tag === 'A' && cs.display === 'inline') && !(tag === 'INPUT' && /^(checkbox|radio|range|file|color)$/.test(el.type)) && rect.height <= 80
          && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight) {
        const hit = (x, y) => { const t = document.elementFromPoint(x, y); return !!t && (t === el || el.contains(t) || (el.labels && [...el.labels].some((l) => l === t || l.contains(t)))); };
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        const walk = (x0, y0, dx, dy) => { let n = 0; for (let d = 0; d < 24; d++) { if (!hit(x0 + dx * (d + 1), y0 + dy * (d + 1))) break; n++; } return n; };
        const hitW = rect.width + walk(rect.left, cy, -1, 0) + walk(rect.right, cy, 1, 0);
        const hitH = rect.height + walk(cx, rect.top, 0, -1) + walk(cx, rect.bottom, 0, 1);
        const smallest = r1(Math.min(hitW, hitH));
        add('tap-target', smallest + 'px', el, 'hit-size', key);
        (taps ||= []).push({ sel: A.selector(el), drawn: r1(rect.width) + '×' + r1(rect.height), hit: r1(hitW) + '×' + r1(hitH), min: smallest });
      }
    }
    return { elements, coarse, taps: taps ? taps.slice(0, 400) : [], viewport: [innerWidth, innerHeight], values, keys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, { n: v.n, sel: v.sel, kinds: v.kinds, props: Object.fromEntries(Object.entries(v.props).map(([a, b]) => [a, [...b]])) }])) };
  }

  /** Phase 2, only for what is off the scale: which rule declares each (key, property). Cached per page. */
  const resolved = new Map();
  function resolve(requests) {
    const out = {};
    for (const { key, props } of requests) {
      const el = (window.__census_reps || new Map()).get(key);
      if (!el || !el.isConnected) continue;
      for (const prop of props) {
        const id = key + '|' + prop;
        if (!resolved.has(id)) resolved.set(id, sourceOf(el, prop));
        (out[key] ||= {})[prop] = resolved.get(id);
      }
    }
    return out;
  }

  /** The focus ring of whatever holds focus now (after a Tab). */
  async function focusRing() {
    // A ring that fades in is read once it has finished (CSS transitions are animations of the document).
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
    const el = document.activeElement;
    if (!el || el === document.body || !el.matches(':focus-visible')) return null;
    const cs = getComputedStyle(el);
    const maps = reverseMaps([]);
    const outline = cs.outlineStyle !== 'none' && pxv(cs.outlineWidth) > 0;
    const focusColour = [...maps.colour].find(([, n]) => n === '--ac-focus')?.[0];
    const ringShadow = cs.boxShadow !== 'none' && (/focus|ring/.test(maps.shadow.get(cs.boxShadow) || '') || (focusColour && cs.boxShadow.includes(focusColour)));
    let value;
    if (outline && cs.outlineStyle === 'solid' && pxv(cs.outlineWidth) === 2 && [2, -2].includes(pxv(cs.outlineOffset))) value = 'ok:outline 2px solid、外距 ' + cs.outlineOffset;
    else if (ringShadow) value = 'off:陰影形的光圈（A 只留 outline）';
    else if (outline) value = 'off:outline ' + cs.outlineWidth + ' ' + cs.outlineStyle + '、外距 ' + cs.outlineOffset;
    else if (cs.boxShadow !== 'none' && /(^|\s)0px 0px 0px (0|[\d.]+)px/.test(cs.boxShadow)) value = 'off:焦點樣式是別的陰影';
    else value = 'off:沒有可見的焦點框';
    return { value, sel: A.selector(el), key: keyOf(el) };
  }

  window.__census = { collect, resolve, focusRing };
})();
`;
