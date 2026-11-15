// The page the focus model test (properties/uiFocus.property.test.ts) drives: a menu, a popover, a modal
// that can open a second modal, and a tab list with one disabled tab.
import { useState } from "react";
import { Menu, MenuItem, Modal, Popover, Tab, TabList, TabPanel, usePopover } from "../../components/ui";
import { PlacePicker } from "../../components/PlacePicker";

export type Cfg = {
  /** Modal content has a field that takes focus when it mounts. */
  modalField: boolean;
  /** The popover's content has an autoFocus field. */
  popField: boolean;
  /** Modal 1 holds a PlacePicker (the Move-to screen) instead of plain buttons. */
  picker: boolean;
};
export type Setters = { setShowMenuTrigger: (v: boolean) => void; setShowPopTrigger: (v: boolean) => void; setShowModalTrigger: (v: boolean) => void };

const PLACES = [{ space: null, entries: [
  { parentId: "n1", title: "Alpha", depth: 0 }, { parentId: "n2", title: "Beta", depth: 1 }, { parentId: "n3", title: "Gamma", depth: 0 },
] }];
export const TAB_NAMES = ["one", "two", "three", "four"] as const;
export const DISABLED_TAB = 2;

export function Harness({ cfg, setters }: { cfg: Cfg; setters: { current: Setters | null } }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  const [m1, setM1] = useState(false);
  const [m2, setM2] = useState(false);
  const [showMenuTrigger, setShowMenuTrigger] = useState(true);
  const [showPopTrigger, setShowPopTrigger] = useState(true);
  const [showModalTrigger, setShowModalTrigger] = useState(true);
  const [tab, setTab] = useState(0);
  setters.current = { setShowMenuTrigger, setShowPopTrigger, setShowModalTrigger };

  const menu = usePopover<HTMLButtonElement>({ open: menuOpen, onClose: () => setMenuOpen(false) });
  const pop = usePopover<HTMLButtonElement>({ open: popOpen, onClose: () => setPopOpen(false) });
  const closeM1 = () => { setM2(false); setM1(false); };

  return (
    <div>
      <button type="button" data-id="elsewhere">elsewhere</button>
      {showMenuTrigger && <button type="button" ref={menu.anchor} data-id="menu-trigger" aria-haspopup="menu" aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}>menu</button>}
      {showPopTrigger && <button type="button" ref={pop.anchor} data-id="pop-trigger" aria-haspopup="dialog" aria-expanded={popOpen}
        onClick={() => setPopOpen((v) => !v)}>pop</button>}
      {showModalTrigger && <button type="button" data-id="modal-trigger" onClick={() => setM1(true)}>modal</button>}
      <button type="button" data-id="after">after</button>

      <TabList label="Sections" data-id="tablist">
        {TAB_NAMES.map((name, i) => (
          <Tab key={name} id={`tab-${i}`} data-id={`tab-${i}`} selected={tab === i} controls={`panel-${i}`} disabled={i === DISABLED_TAB}
            onClick={() => setTab(i)}>{name}</Tab>
        ))}
      </TabList>
      {TAB_NAMES.map((name, i) => (
        <TabPanel key={name} id={`panel-${i}`} labelledBy={`tab-${i}`} hidden={tab !== i}>{name} body</TabPanel>
      ))}

      {menuOpen && (
        <Menu popover={menu} label="Things">
          <MenuItem onSelect={() => {}}>First</MenuItem>
          <MenuItem onSelect={() => {}}>Second</MenuItem>
          <MenuItem disabled onSelect={() => {}}>Off</MenuItem>
          <MenuItem keepOpen onSelect={() => {}}>Third</MenuItem>
        </Menu>
      )}
      {popOpen && (
        <Popover popover={pop} label="Pop">
          {cfg.popField && <input aria-label="Pop field" autoFocus />}
          <button type="button">pop-a</button>
          <button type="button">pop-b</button>
        </Popover>
      )}

      {m1 && (
        <Modal label="M1" onClose={closeM1}>
          <div>
            {cfg.picker
              ? <PlacePicker groups={PLACES} current={null} currentMark="chosen" searchLabel="Where" onPick={closeM1} onClose={closeM1} />
              : <>{cfg.modalField && <input aria-label="M1 field" autoFocus />}<button type="button">m1-a</button></>}
            <button type="button" data-id="open-m2" onClick={() => setM2(true)}>open m2</button>
            <button type="button" data-id="close-m1" onClick={closeM1}>close m1</button>
          </div>
          {m2 && (
            <Modal label="M2" onClose={() => setM2(false)}>
              <div>
                {cfg.modalField && <input aria-label="M2 field" autoFocus />}
                <button type="button">m2-a</button>
                <button type="button" data-id="close-m2" onClick={() => setM2(false)}>close m2</button>
              </div>
            </Modal>
          )}
        </Modal>
      )}
    </div>
  );
}

