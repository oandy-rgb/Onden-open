import { Suspense, useState } from "react";
import type { ModuleScreenProps } from "../types";
import { useAppSelector } from "../../lib/appStore";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useHomeStudio } from "./studio/useHomeStudio";

// The website page (`?view=website`): the site drawn from your own notes with the choices above it
// (setup/SiteSetupScreen), on every screen width. Under 進階, 「舊的首頁畫布」 opens the old free-form
// home page editor: the Puck studio on a desktop (studio/HomeStudio), the block list on a phone
// (PhoneWebsiteScreen). Each loads only when it is shown.
const SiteSetup = lazyWithReload(() => import("./setup/SiteSetupHost"));
const HomeStudio = lazyWithReload(() => import("./studio/HomeStudio"), { warm: false });
const PhoneStudio = lazyWithReload(() => import("./PhoneWebsiteScreen"));

export default function WebsiteScreen(props: ModuleScreenProps) {
  const [legacy, setLegacy] = useState(false);
  if (!legacy) return <Suspense fallback={null}><SiteSetup {...props} onOpenLegacy={() => setLegacy(true)} /></Suspense>;
  const back = () => setLegacy(false);
  return <LegacyScreen {...props} onBack={back} />;
}

// The old home canvas has no pages: a canvas card's 「Web Render」 (target.rootId) opens the studio itself.
function LegacyScreen({ online, onOpenNode, onRefresh, onBack, ...rest }: ModuleScreenProps & { onBack: () => void }) {
  const mobile = useIsMobile();
  if (mobile) return <Suspense fallback={null}><PhoneStudio online={online} onOpenNode={onOpenNode} onRefresh={onRefresh} onBack={onBack} {...rest} /></Suspense>;
  return <DesktopLegacy online={online} onOpenNode={onOpenNode} onRefresh={onRefresh} onBack={onBack} />;
}

function DesktopLegacy({ online, onOpenNode, onRefresh, onBack }: Pick<ModuleScreenProps, "online" | "onOpenNode" | "onRefresh"> & { onBack: () => void }) {
  const data = useAppSelector((s) => s.data);
  const site = useHomeStudio({ data, online, refresh: async () => { await onRefresh(); } });
  return (
    <Suspense fallback={null}>
      <HomeStudio site={site} onOpenNode={onOpenNode} onBack={onBack} />
    </Suspense>
  );
}
