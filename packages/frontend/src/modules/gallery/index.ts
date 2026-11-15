// A view module like modules/calendar (docs/architecture/views-as-modules.md).

import { GalleryHorizontalEnd } from "lucide-react";
import type { FrontendModule } from "../types";
import { lazyWithReload } from "../../lib/lazyWithReload";

// The layout loads when a view of it is drawn (components/collections/CollectionView shows it in a Suspense).
/** One loader for the lazy layout and the offline warm-up (modules/index loadOfflineModuleScreens). */
export const loadGalleryLayout = () => import("./GalleryLayout");
const GalleryLayout = lazyWithReload(loadGalleryLayout);

export const galleryViewModule: FrontendModule = {
  id: "gallery",
  library: {
    title: "Cards",
    description: "Show a tag's notes, or a note's sub-notes, as a grid of cards with a cover image.",
    Icon: GalleryHorizontalEnd,
    manifest: {
      adds: [
        { kind: "view", text: "A Cards layout for the views of a tag, and of a note with sub-notes, with a cover image." },
      ],
      notes: "Only the notes of tags, and the sub-notes of notes, you show as cards.",
      network: null,
    },
  },
  view: { Layout: GalleryLayout, param: { key: "cover_field", label: "Cover", types: ["media"], optional: true } },
};
