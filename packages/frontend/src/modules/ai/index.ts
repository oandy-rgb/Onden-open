// AI module (frontend) — the module library's card for AI, the twin of backend
// modules/ai. AI is a feature the owner agrees to once (a new workspace has it
// off; 「同意立場」, 2026-11-01), and everything about it is behind this one switch:
// the shell asks for the "ai" shell feature (useAiEnabled), never for the module by
// id. The AI code itself (info panel tab, mentions, hand-off menus, suggestions,
// role and key settings) stays where it is and loads on use; this file is only
// the registration. Off hides every entry and keeps the data (roles, keys, history,
// suggestions); skills need it (library.requires on the backend).
import { Bot } from "lucide-react";
import type { FrontendModule } from "../types";
import NoteAiButton from "../../components/NoteAiButton";

export const aiModule: FrontendModule = {
  id: "ai",
  shellFeature: "ai",
  // The phone's way to the AI conversation: a button in the note's top bar (a wide screen has the info panel's tab).
  noteHeaderAction: NoteAiButton,
  // The places an AI proposed for the open note (the 「AI」 row of the info panel's 功能 tab).
  noteFunctionRows: () => import("./noteFunctionRows"),
  library: {
    title: "AI",
    confirm: "AI is off until you say yes. Once on, you can give an AI role access to your notes through MCP, or add your own API key so the server can ask a model for suggestions. Anything an AI wants to change waits for your decision.",
    description: "Let an AI help with your notes: ask it from a note, hand it selected text, and decide on its suggestions. Roles, keys and history are kept when you turn it off. Asks once before it starts.",
    Icon: Bot,
    group: { id: "ai", order: 1 },
    blurb: "Ask AI from a note; you decide what to keep",
    ownerNote: "Connections and roles are in Settings › AI",
    blurbOff: "Off. Roles, connections and history are kept",
    settingsTab: "ai",
    manifest: {
      adds: [
        { kind: "command", text: "An AI tab in the note's info panel, @-mentions, and “Hand to AI” on selected text." },
        { kind: "page", text: "AI roles and API keys in Settings; AI suggestions wait in the inbox for your decision." },
      ],
      notes: "An AI can read the notes its role may read, only after you create the role.",
      network: "Reaches the AI service you set up with your own key, or your own AI client over MCP.",
    },
  },
};
