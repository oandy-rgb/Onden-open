// jsdom has no matchMedia: tests that depend on the phone layout (≤900px, the
// hooks/useIsMobile boundary) install one that answers for it.
export function setPhoneLayout(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: phone && query === "(max-width: 900px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

export function clearPhoneLayout() {
  delete (window as { matchMedia?: unknown }).matchMedia;
}
