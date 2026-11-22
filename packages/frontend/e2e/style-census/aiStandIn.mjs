// The browser app has no AI role, so the AI panel would show its empty state. This installs (before the page loads) a stand-in
// for /api/ai/panel-chat*: one finished question with an answer, a source and a pending suggestion. Nothing else is faked.
// Same technique as e2e/browser-app/phoneAiPanel.mjs.
export const AI_STAND_IN = () => {
  const roles = { roles: [{ actor_id: "r1", handle: "ai", name: "小助手", default_runtime: "mcp", reason: null, model_name: null, runtimes: [{ kind: "mcp", available: true, unavailable_reason: null }] }] };
  const turns = [{ session_id: "s1", text: "幫我摘要這則筆記", status: "completed", fail_code: null, runtime: "mcp", agent_name: "小助手", created_at: new Date().toISOString(),
    reply: "## 摘要\n\n這則筆記說明了**版面檢查**的目的，並列出三個重點：\n\n- 標題與內文的排版\n- 清單與引用\n- 程式碼與表格\n\n建議把任務拆成更小的項目。",
    scope: { notes: [], tags: [] }, sources: [{ node_id: "00000000-0000-4000-8000-000000000101", title: "版面檢查用的長筆記", block_id: null }],
    suggestions: { pending: 0, accepted: 0, rejected: 0 }, pending: [] },
  { session_id: "s2", text: "這裡的結論可以再短一點嗎？", status: "completed", fail_code: null, runtime: "mcp", agent_name: "小助手", created_at: new Date().toISOString(),
    reply: "可以，我整理成兩句話。", scope: { notes: [], tags: [] }, sources: [], suggestions: { pending: 0, accepted: 0, rejected: 0 }, pending: [] }];
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  let real = window.fetch;
  Object.defineProperty(window, "fetch", {
    configurable: true,
    set(next) { real = next; },
    get() {
      return (input, init) => {
        const url = new URL(new Request(input, init).url, location.href);
        if (url.pathname.startsWith("/api/ai/panel-chat")) return Promise.resolve(json(url.pathname.endsWith("/roles") ? roles : { turns }));
        return real(input, init);
      };
    },
  });
};
