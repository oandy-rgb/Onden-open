import { useCallback, useEffect, useRef, useState } from "react";
import { useDismiss } from "./useEscapeKey";

/** Temporary writing mode. Browser fullscreen is optional; Escape, browser
 * exit and unmount restore the shell. Never exits another surface's fullscreen. */
export function useZenMode(): [boolean, () => void] {
  const [zen, setZen] = useState(false);
  const active = useRef(false);
  const ownsFullscreen = useRef(false);
  const requesting = useRef(false);

  const releaseFullscreen = useCallback(() => {
    if (!ownsFullscreen.current || document.fullscreenElement !== document.documentElement) return;
    void document.exitFullscreen?.().catch(() => {});
  }, []);

  const exit = useCallback(() => {
    active.current = false;
    setZen(false);
    releaseFullscreen();
  }, [releaseFullscreen]);

  useEffect(() => {
    const onFullscreen = () => {
      if (ownsFullscreen.current && document.fullscreenElement !== document.documentElement) {
        ownsFullscreen.current = false;
        active.current = false;
        setZen(false);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      active.current = false;
      document.body.classList.remove("onden-zen");
      document.removeEventListener("fullscreenchange", onFullscreen);
      releaseFullscreen();
    };
  }, [exit, releaseFullscreen]);

  useDismiss(() => { exit(); }, zen);

  useEffect(() => { document.body.classList.toggle("onden-zen", zen); }, [zen]);

  const toggle = useCallback(() => {
    if (active.current) { exit(); return; }
    active.current = true;
    setZen(true);
    if (requesting.current || document.fullscreenElement || !document.documentElement.requestFullscreen) return;
    requesting.current = true;
    ownsFullscreen.current = true;
    try {
      void document.documentElement.requestFullscreen().then(() => {
        // The user can leave writing mode before fullscreen finishes opening.
        if (!active.current) releaseFullscreen();
      }).catch(() => { ownsFullscreen.current = false; }).finally(() => { requesting.current = false; });
    } catch { ownsFullscreen.current = false; requesting.current = false; }
  }, [exit, releaseFullscreen]);

  return [zen, toggle];
}
