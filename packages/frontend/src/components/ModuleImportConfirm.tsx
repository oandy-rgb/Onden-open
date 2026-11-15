import { useRef, useState, type ReactNode } from "react";
import { MODULES, type ModuleAddition } from "../modules";
import { useT } from "../lib/i18n";
import { useIsOwner } from "../lib/capabilities";
import { openSettings } from "../lib/settingsRequest";
import { useIsMobile } from "../hooks/useIsMobile";
import { navLayoutStore, type NavLayoutStore } from "../lib/navLayoutStore";
import { pinDestination, type NavSurface } from "../lib/navLayout";
import { moduleNavDestinationId } from "../hooks/shellNavigation";
import { Button, Checkbox, Modal, Pressable } from "./ui";
import "./ModuleImportConfirm.css";

// The one-time yes (docs/architecture/module-library.md): built-in functions
// are on by default, except three that spend money, reach outside websites or
// publish to the web (semantic search, RSS, website). The first time the owner
// starts using one — the editor's # menu, a paragraph's action, Settings ›
// Modules — this dialog says what it does in plain words and asks once; after
// yes it never asks again (the server stores it per workspace). It lists what
// the module adds and what it can reach, from the module's own declaration
// (FrontendModule.library.manifest). Settings › Modules stays the place to
// adjust modules; the dialog links there.
//
// Usage — the caller says what happens after the yes and runs it:
//   const importer = useModuleImportConfirm();
//   await importer.confirm("rss", { run: () => fns.add(tag.id, ext, "rss", { confirmed: true }) });
//   return <>{…}{importer.element}</>;
// `run` resolves whether it worked; the dialog stays open (busy) meanwhile and
// closes after. Only the workspace owner can decide (the server refuses anyone
// else, PATCH /api/workspace/modules → principal admin); for anyone else the
// dialog says so and offers nothing to press.

type Request = {
  moduleId: string;
  /** What the yes is for, shown under the title: the tag to insert where the person typed. */
  target?: { kind: "insert"; name: string };
  run: () => Promise<boolean>;
  resolve: (done: boolean) => void;
};

export type ModuleImportConfirm = {
  /** Ask, then on 「開啟並加上」 run `run`. Resolves true once `run` worked;
   *  false when cancelled or it failed (the writer reported the failure). */
  confirm: (moduleId: string, options: { target?: Request["target"]; run: () => Promise<boolean> }) => Promise<boolean>;
  /** The dialog while one is open; render it once, anywhere. */
  element: ReactNode;
};

export function useModuleImportConfirm(): ModuleImportConfirm {
  const [request, setRequest] = useState<Request | null>(null);
  const confirm: ModuleImportConfirm["confirm"] = (moduleId, options) => new Promise<boolean>((resolve) => {
    setRequest({ moduleId, ...options, resolve });
  });
  const element = request ? (
    <ModuleImportDialog key={request.moduleId} request={request}
      onDone={(done) => { request.resolve(done); setRequest(null); }} />
  ) : null;
  return { confirm, element };
}

/** After the yes, if the person asked to pin: put the module's page in their
 *  nav. Only an edited layout needs it (null, the default, shows the page once
 *  the module is in use). Pinned pages show even before that. On the phone, a
 *  full bar does not ask for a swap here: the page joins the list after the
 *  phone's cut, so the desktop shows it and the phone keeps it under 更多. */
export function pinImportedModule(destinationId: string, surface: NavSurface, store: NavLayoutStore = navLayoutStore): void {
  const { value: layout } = store.get();
  if (!layout) return;
  let result = pinDestination(layout, destinationId, surface);
  if ("full" in result) result = pinDestination(layout, destinationId, "desktop");
  if ("layout" in result && result.layout !== layout) store.save(result.layout);
}

const ADDITION_LABEL: Record<ModuleAddition["kind"], string> = {
  page: "Page", fields: "Fields", tag: "Tag", schedule: "Schedule", import: "Import", command: "Command", view: "View",
};

function ModuleImportDialog({ request, onDone }: { request: Request; onDone: (done: boolean) => void }) {
  const t = useT();
  const isOwner = useIsOwner();
  const surface: NavSurface = useIsMobile() ? "phone" : "desktop";
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const mod = MODULES.find((m) => m.id === request.moduleId);
  if (!mod) return null;
  const { title, description, confirm, moduleTag, manifest } = mod.library;
  const name = t(title);
  const destination = moduleNavDestinationId(mod.id);
  // An edited nav starts the page in 「更多」 (a page nobody uses yet stays out
  // of the default nav): offer to pin it.
  const offerPin = destination !== null && navLayoutStore.get().value !== null;
  const adds: ModuleAddition[] = [...manifest.adds];
  if (moduleTag && !mod.noteSwitch) adds.push({ kind: "tag", text: t("{name} shows as a function, never as one of your tags.", { name: t(mod.library.title) }) });

  async function go() {
    setBusy(true);
    let done = false;
    try { done = await request.run(); } catch { done = false; }
    if (done && pin && destination) pinImportedModule(destination, surface);
    setBusy(false);
    onDone(done);
  }

  return (
    <Modal label={t("Turn on “{name}”?", { name })} className="confirm-dialog-backdrop module-import-layer" busy={busy}
      onClose={() => onDone(false)} initialFocus={isOwner ? confirmRef : undefined}>
      <div className="module-import-confirm" data-module={mod.id}>
        <h2 className="module-import-title">{t("Turn on “{name}”?", { name })}</h2>
        <p className="module-import-lead">{t(confirm ?? description)}{" "}
          {request.target?.kind === "insert" && t("Then {tag} is written where you typed.", { tag: request.target.name })}
        </p>
        <h3 className="module-import-heading">{t("It adds")}</h3>
        <ul className="module-import-list" aria-label={t("It adds")}>
          {adds.map((item, i) => (
            <li key={`${item.kind}-${i}`} className="module-import-row" data-kind={item.kind}>
              <span className="module-import-kind">{t(ADDITION_LABEL[item.kind])}</span><span>{t(item.text)}</span>
            </li>
          ))}
        </ul>
        <h3 className="module-import-heading">{t("It can reach")}</h3>
        <ul className="module-import-list" aria-label={t("It can reach")}>
          <li className="module-import-row" data-kind="notes"><span className="module-import-kind">{t("Notes")}</span><span>{t(manifest.notes)}</span></li>
          <li className="module-import-row" data-kind="network"><span className="module-import-kind">{t("Network")}</span>
            <span>{manifest.network ? t(manifest.network) : t("Doesn't connect anywhere; its data stays in this Onden.")}</span></li>
        </ul>
        {isOwner && offerPin && (
          <label className="module-import-pin">
            <Checkbox checked={pin} onChange={(e) => setPin(e.target.checked)} disabled={busy} />
            <span>{t("Also pin to the navigation bar")}
              {surface === "phone" && <small className="module-import-pin-hint">{t("If the bottom bar is full, it goes after it: on the desktop bar, and under More here.")}</small>}
            </span>
          </label>
        )}
        {!isOwner && <p className="module-import-denied" role="note">{t("Only the workspace owner can turn modules on.")}</p>}
        <div className="module-import-actions">
          <Pressable type="button" className="module-import-manage" disabled={busy}
            onClick={() => { onDone(false); openSettings("modules"); }}>{t("Manage in Settings › Modules")}</Pressable>
          <span className="module-import-spacer" />
          <Button disabled={busy} onClick={() => onDone(false)}>{t("Cancel")}</Button>
          {isOwner && (
            <Button ref={confirmRef} variant="primary" disabled={busy} onClick={() => void go()}>
              {busy ? t("Turning on…") : request.target ? t("Turn on and add") : t("Turn on")}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
