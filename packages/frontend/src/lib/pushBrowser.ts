// What lock-screen reminders need to ask the browser about itself (lib/webPush.ts has the flow).
// Kept apart because `navigator` is read here only.

type BraveNavigator = Navigator & { brave?: { isBrave?: () => Promise<boolean> } };

/** Brave answers `navigator.brave`; its push needs a setting most people never turned on. */
export async function isBrave(): Promise<boolean> {
  const brave = (navigator as BraveNavigator).brave;
  if (!brave) return false;
  try { return (await brave.isBrave?.()) ?? true; } catch { return true; }
}

/** iPhone / iPad: push exists only for an app added to the Home Screen. */
export const isIos = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent);
