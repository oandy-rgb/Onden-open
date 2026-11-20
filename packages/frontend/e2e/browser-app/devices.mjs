// The windows the browser-app scripts drive. "Pixel 5" is Playwright's phone; TAB_S9 is the owner's tablet
// (Samsung Galaxy Tab S9, landscape, Samsung Internet installed web app, 2026-11-20: about 1204x714 CSS px, DPR 2.1, touch).
// An emulation, not the tablet: no real Samsung Keyboard, no browser-made pan of the page.
export const TAB_S9 = {
  viewport: { width: 1204, height: 714 },
  screen: { width: 1204, height: 714 },
  deviceScaleFactor: 2.1,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};
