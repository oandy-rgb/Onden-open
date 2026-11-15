// The quick capture the shell mounts. The box (QuickCapture: voice, images, the
// place picker) loads on the first request to open it, or when a share arrives;
// after that it listens for openQuickCapture() itself.

import { Suspense, useEffect, useState } from "react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { OPEN_QUICK_CAPTURE_EVENT } from "./openQuickCapture";
import type { QuickCaptureProps } from "./QuickCapture";
import { onWindow } from "../../lib/globalEvents";

const QuickCaptureBox = lazyWithReload(() => import("./QuickCapture"));

export default function QuickCaptureHost(props: Omit<QuickCaptureProps, "startOpen">) {
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    const handler = () => setAsked(true);
    return onWindow(OPEN_QUICK_CAPTURE_EVENT, handler);
  }, []);
  const wanted = asked || props.initialDraft != null || props.share != null;
  // Once wanted the box stays: it keeps the draft and the pick for this capture.
  // `startOpen` only matters when the box mounts, which can be after the file has loaded.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { if (wanted) setMounted(true); }, [wanted]);
  if (!wanted && !mounted) return null;
  return <Suspense fallback={null}><QuickCaptureBox {...props} startOpen={asked} /></Suspense>;
}
