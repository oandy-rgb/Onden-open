// 每一步回應「只留該比較的部分」。bootstrap 與議程這類回應含整個工作區（內建標籤、系統筆記），
// 只取劇本自己建立的東西，才不會把與劇本無關的內建資料當成差異。
import { unzipSync, strFromU8 } from "fflate";
import { scrubText, scrubPath } from "./areas/util.mjs";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** 劇本命名過的 id 集合（即「劇本自己建立的東西」）。 */
export const projections = (names) => {
  const mine = (id) => names.has(id);
  const slim = (n) => ({ id: n.id, title: n.title, node_type: n.node_type, parent_id: n.parent_id, markdown: n.markdown, sort_order: n.sort_order, hidden: n.hidden, deleted: n.deleted_at != null, slug: n.slug, class_tag_ids: n.class_tag_ids, label_tag_ids: n.label_tag_ids });
  return {
    projectBootstrap: (r) => {
      const b = r.body;
      const nodes = (b.nodes ?? []).filter((n) => mine(n.id)).map(slim);
      return {
        nodes,
        attributes: (b.attributes ?? []).filter((a) => mine(a.node_id)).map(({ node_id, key, value, value_type, is_inheritable }) => ({ node_id, key, value, value_type, is_inheritable })),
        edges: (b.edges ?? []).filter((e) => mine(e.source_node_id) || mine(e.target_node_id)).map(({ source_node_id, target_node_id, edge_type, status, origin }) => ({ source_node_id, target_node_id, edge_type, status, origin })),
        tasks: (b.tasks ?? []).filter((t) => mine(t.id)),
        graph_positions: b.graph_positions,
        note_anchors: (b.note_anchors ?? []).filter((a) => mine(a.note_id ?? a.node_id)),
        note_link_bindings: b.note_link_bindings,
        modules: Object.fromEntries((b.workspace?.modules ?? []).map((m) => [m, true])),
        features: b.features,
      };
    },
    // 議程：瀏覽器版有範例任務。只留劇本建立的任務；全工作區的計數（count、done_total）跟著範例變，不比。
    projectAgenda: (r) => {
      const strip = (x) => {
        if (Array.isArray(x)) return x.filter((e) => !(e && typeof e === "object" && typeof e.id === "string" && !mine(e.id))).map(strip);
        if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).filter(([k]) => k !== "count" && k !== "done_total").map(([k, v]) => [k, strip(v)]));
        return x;
      };
      return strip(r.body);
    },
    projectInk: (r) => (Array.isArray(r.body) ? r.body.map(({ ink_data, actor_name, actor_type }) => ({ ink_data, actor_name, actor_type })) : r.body),
    projectSearch: (r) => (Array.isArray(r.body) ? r.body.map((row) => ({ id: row.id, title: row.title, node_type: row.node_type, snippet: row.snippet })) : r.body),
    projectVersions: (r) => (Array.isArray(r.body) ? r.body.map(({ title, markdown, actor_type, actor_name, kind, summary }) => ({ title, markdown, actor_type, actor_name, kind, summary })) : r.body),
    // 備份 zip：只看劇本建立的筆記（瀏覽器版另有範例筆記）與標籤定義。檔案按「種類｜標題」當鍵、內容解析成物件，
    // 差異才指得到欄位；檔名裡的 id 每個宿主不同，不能當鍵。
    projectZip: (r) => {
      if (!r.bytes) return { error: "no bytes" };
      let files;
      try { files = unzipSync(new Uint8Array(r.bytes)); } catch (e) { return { notZip: String(e.message).slice(0, 80), size: r.bytes.length }; }
      const out = { contentType: r.contentType, entries: {} };
      for (const [path, data] of Object.entries(files)) {
        const isText = /\.(md|json|txt|yaml|yml)$/.test(path);
        const text = isText ? strFromU8(data) : null;
        if (text === null) { const key = scrubPath(path); out.entries[key] = { bytes: data.length > 0, copies: (out.entries[key]?.copies ?? 0) + 1 }; continue; }
        if (path.startsWith(".onden/notes/") && path.endsWith(".json")) {
          const note = JSON.parse(text);
          if (mine(note.id)) {
            // 匯入時記下的內容雜湊含媒體網址、媒體檔名各宿主不同，值不比；其餘屬性照比。
            note.attributes = (note.attributes ?? []).map((a) => (String(a.key).startsWith("_import_") ? { ...a, value: "<masked>" } : a));
            out.entries[`.onden/notes/${note.node_type}|${note.title}`] = JSON.parse(scrubText(JSON.stringify(note)));
          }
          continue;
        }
        if (path.endsWith(".json")) {
          const parsed = JSON.parse(text);
          if (path === ".onden/manifest.json") delete parsed.counts; // 全工作區的計數，含範例筆記
          // 桌面版視窗自己寫的偏好（更新紀錄看到哪一筆）不是劇本做的。
          if (path === ".onden/extras.json" && Array.isArray(parsed.prefs)) parsed.prefs = parsed.prefs.filter((p) => p.key !== "changesSeen");
          out.entries[path] = parsed;
          continue;
        }
        if (path.endsWith(".md")) {
          const id = text.match(/^id:\s*(\S+)/m)?.[1];
          if (id && !mine(id)) continue; // 範例筆記
          out.entries[scrubPath(path)] = { text: scrubText(text) };
          continue;
        }
        out.entries[scrubPath(path)] = { text: scrubText(text) };
      }
      return out;
    },
  };
};
export { UUID };
