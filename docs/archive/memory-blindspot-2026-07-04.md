# 記憶盲區普查(295 條淨化後)

> 狀態：歷史紀錄（最後確認 2026-11-01）

以下為多路掃描 findings 的最終合成。重複回報的同一事實已合併(evidence 併列),內容忠實轉述原始 evidence、未自行添加。

---

## 高優先(全列)

### A. 記憶主動錯誤(照舊記憶動工會做錯/重做)

1. **proposeTagPack 迴路已全出貨,雙記憶反向記載** — agent-extensibility-and-approval.md:26 明寫「MCP 10 工具裡沒有 proposeTagPack、tag-packs still DEFERRED」,agent-capability-surface.md 寫「Registry = 10 tools」——但完整迴路已出貨:agent 起草 pack(含 schema fields+ECA behaviour+template children)→ outbox `tag_pack` pending_approval held effect(與 publish_site 同 rail、approvalRoleFor 同列 admin 級)→ InboxReview tag_pack 卡 → installTagPackApproved 以 requesting-agent 歸因執行;RESEARCHER template 預授;registry 實數 14。北極星「AI量產插件→人審」中段迴路已接通。證據:registry.ts:16,48;inbox.ts:76-80;templates.ts:24;agentTools/proposeTagPack.ts:6-13,41;outbox.ts:39,247;InboxReview.tsx:190;commit 0fa970d。→ 收進:agent-extensibility-and-approval.md + agent-capability-surface.md

2. **ask 已出貨 web search + ASK_PROVIDER 同意閘 + 本地 provider + key 治理;onden-has-rag「still missing: web search」stale** — Anthropic server-side web_search 工具已接線(ASK_WEB_SEARCH=1 或 per-request 旗標、max_uses 3、只有實際引用頁進 sources、UI 有開關、非 Anthropic provider 優雅降級);provider 無預設=同意閘:未設 ASK_PROVIDER 時 ask 在任何 retrieval 之前就 throw(no_api_key→503),絕不默默 POST 筆記給雲端 LLM(aiEgressDefaults.test 釘死);支援 ASK_PROVIDER=openai-compatible 直打本地 chat/completions(零 SDK,wire 契約 askProvider.test 釘住);API key = DB app_settings 蓋 env、write-only 永不回讀、PUT principal_admin-only。證據:ask.ts:39,111-119,136,262-281,344-374;onden-has-rag.md:18(確認 stale);appSettings.ts:3-6,29-53;routes/ai.ts:64-69,160-191;aiEgressDefaults.test.ts:1-15;commit 983d2b7。→ 收進:onden-has-rag.md

3. **生產 dogfood 的 embedding 管線全死:@huggingface/transformers 是 opt-in 手動安裝 × docker npm ci 天生互斥** — 非 test 時 EMBEDDING_MODE 預設 local,但 transformers 刻意不宣告為依賴(免 CI 拉 native ONNX),缺套件 runtime 直接 throw(拒絕靜默降級);package-lock 零 huggingface、backend Dockerfile 沒裝、compose.yaml 沒設 EMBEDDING_MODE → 使用者天天看的 docker stack 上每筆 embed outbox job / semanticSearch / suggestLinks 反覆失敗:outbox 現有 199 筆 dead embed(最新 dead=2026-07-04 當天)、node_embeddings 110 筆全是舊向量=ask RAG 實際過期。另 onden-has-rag「default=stub」也 stale(現 default=local、test 才 stub)。證據:embedder.ts:53-91;grep package-lock 零命中;compose.yaml 無 EMBEDDING_MODE(compose.e2e.yaml:46 才有 stub);docker exec psql 實測 dead=199。→ 收進:onden-has-rag.md

4. **pages_push(GitHub Pages 發布)在 docker 部署 by-construction 壞掉** — pagesPush.ts 讀 `../frontend/dist-published` 或 PUBLISHED_BUNDLE_DIR,但 compose 沒設該 env、兩個 image 都不產出/掛載 dist-published → dogfood 部署的 pages_push 必失敗:outbox 7 筆 dead(ENOENT),自 2026-06-24 死透;而 publish_snapshots=49 筆=發布真的在用,Pages 出口斷了。發布是使用者欽定 Tier-2 軸。證據:pagesPush.ts:21-24,58;compose.yaml grep 無 PUBLISHED_BUNDLE_DIR;psql dead pages_push=7、last_error='cannot read SPA bundle…'。→ 收進:publishing-priority.md

5. **人類 per-person/per-matter ACL 已出貨,structural-gaps 反向宣稱** — mig 066 給 actors 加 scoped_tag_ids uuid[](commit 800283a):人類 session 可限縮到只讀帶特定 tag 的節點,與 bearer tokenScope 同機制、同時存在取交集(most-restrictive-wins)、[]=零可讀、null=不限;讀側經 tokenReadableNodeIds/canReadNode、寫側經 spine assertAuthority 同樣限制(debaef0)。structural-gaps.md 仍寫「無 per-person(只有 agent 有 tag-scoping)」——照它做 roadmap 會誤判 A 類 ACL 缺口仍全開。證據:066_actor_scoped_tags.sql:17;readPolicy.ts:136-177,362-386;spine/authority.ts:44,129-155;structural-gaps.md 對照確認 stale。→ 收進:onden-capability-map.md + structural-gaps.md

6. **due-soon/overdue OS 通知已完整出貨,structural-gaps「零 Notification API/SW push」反向陳述** — useDueSoonNotifications 每 5 分輪詢 agenda、localStorage de-dupe(每 (bucket,id) 每裝置一次、跨日 overdue→today 換 key 再提醒)、經 SW registration 發通知;sw.js notificationclick→postMessage {type:'open-task'}→handleOpenNote chokepoint;push handler 預接好(未來 server push 零 client 改動);「純 client-side 不做 VAPID」是明寫決策且合 D8(D8 明文拍板「Do NOT build mobile/OS push notifications」)。capability map 也全無通知條目。證據:useDueSoonNotifications.ts:1-26;public/sw.js:64-110;BuilderApp.tsx:402-430;dueSoonNotify.ts:1-15;00-decisions.md:214-216;commit 53dd7d2;structural-gaps.md:15,37,59 確認仍列缺口。→ 收進:onden-capability-map.md + structural-gaps.md

7. **restore 支援矩陣已擴至 11 型(記憶仍寫 8 型)** — 新增 TAG_UPDATED、TAG_SCHEMA_UPDATED、TAG_MERGED(merge 完整 undo=undelete source tag node+cascade 沿 triggered_by 鏈深先逆轉);但 previewRestore 對這三型仍回 422(可還原不可預覽的不對稱)。證據:eventRestore/restore.ts:271-282,463;commits 75c12a7、bd30d03;restore-state.md:14 確認仍寫 8 types。→ 收進:restore-state.md

8. **restore 的授權分層與 workspace scoping 全沒記** — restore 在 service 層過 spine authority 且按事件分層:node 事件=write_node、TAG_SCHEMA_UPDATED=permission-defining→principal_admin(拒 delegated token)、其他 tag 事件=workspace_admin、preview=read;workspaceId scoping 讓跨 workspace event id 解析成 404(原本全域 event id 可 rewind 別 workspace 歷史)。記憶只寫「route 已 assertAuthority」。證據:restore.ts:152-167,72-84,343-345;commit 27f2786。→ 收進:restore-state.md

9. **safeFetch DNS-rebinding 已重建修掉,audit-sweep 記憶仍記為 residual** — 現碼=node:http(s) 直連+connect-time lookup hook(連線當下驗解析、all:true 逐筆檢查防 Happy-Eyeballs 混 loopback、IPv6 canonical 128-bit 解析涵蓋 ::ffff:/NAT64/6to4),rebinding 窗口已關;照舊記憶寫安全報告會把已修的洞報成殘留。證據:safeFetch.ts:6-16 檔頭 vs audit-sweep-2026-06-13.md:12。→ 收進:audit-sweep-2026-06-13.md

10. **new-card 每日預算已出貨,mental-model v2 P1 仍列待辦** — new_per_day 2026-06-13 出貨(c9f1c6c,早於 roadmap):預設 20、pack 可配 clamp 0–500、UTC 日計費、?root= 聚焦刻意繞過預算、stats 露出 new_per_day/new_today/new_remaining;recall-before-reveal 也已出貨(ReviewPanel revealed gate);P1 真正剩 staging/cloze/produced-answer feedback。證據:modules/review/routes.ts:68,162-166,213-231;ReviewPanel.tsx:50-58;git show c9f1c6c。→ 收進:mental-model-corrections.md

11. **發布 table-stakes 已全出貨,site-builder-direction「STILL MISSING」清單全過期** — favicon/logo 上傳(SVG server-side sanitize)、site description+allow_indexing toggle、analytics 三家 opt-in、in-UI custom domain(每次 pages-push 重發 CNAME)、hover link preview(含 ^block)、pre-publish「N notes will go public + M stay private」確認 dialog、per-page SEO frontmatter description、OG/canonical、RSS feed+sitemap——全部存在。證據:site-builder-direction.md:47-48 仍列 missing;WebsiteStudio.tsx:77-98,133-155,551-670;SiteHead.astro:39-68;commits 117b581/7205ba4。→ 收進:site-builder-direction.md(改寫 stale 清單)

12. **App-UI i18n layer B 已出貨,site-builder-direction 仍寫「deliberately deferred」;且有零記錄的字串紀律** — 雙層架構:layer A=發布站 chrome(siteLocale.ts,Design 設定驅動)、layer B=app 殼 gettext 式(英文原文即 key,t()/useT() 查字典、miss fallback 英文;useSyncExternalStore 免 reload 切換;locale 存 localStorage onden.locale 支援 system;加語言=一字典檔+DICTIONARIES 一筆;zh-TW 字典 816 行)。紀律=每個新 user-facing 字串必須 t()-wrap+補 i18n.zh-TW.ts,無 lint 強制所以反覆回歸(5ae1251 TasksMode 整片硬編英文、058a5d7 account menu 事後補);React 元件必須 useT()(裸 t 只限非元件呼叫點);品牌/格式 token 刻意 identity(t(k)===k 有測試);已知殘留:FolderImportWidget/TagPacksWidget/RssOpmlWidget 裸英文。證據:lib/i18n.ts:1-27;site-builder-direction.md:46;test/i18n.test.tsx:55-73;commits c82877e/5ae1251/058a5d7/33f1664。→ 收進:NEW:app-i18n-two-layer(並更正 site-builder-direction.md:46)

13. **RSS 資料模型翻盤:rss_staging boundary buffer,rss-rebuild 記憶全面過期** — 2026-07-03(ba5bf2a)RSS 文章整個移出 node/event 機制,改住 rss_staging 表(mig 080,自述「outbox 的入向鏡像」):ingest 不鑄 hidden node、不冒充 pseudo-agent 事件;triage(skim/save/skip)與 governance approval 分兩條 inbox lane;POST /items/:id/save 是唯一鑄 node 時刻(spine NODE_CREATED、client-mintable id);(source,guid) 兼 tombstone+30/90 天 retention sweep(saved 豁免);read-gate lint 已納 rss_staging;舊 article node 有 carve migration。rss-rebuild.md「rss routes deliberately NOT spine-migrated」與 capability-map RSS 段已作廢。證據:commit ba5bf2a;080_rss_staging.sql 存在。→ 收進:rss-rebuild.md

14. **sync-protocol.md 出站設計已被推翻,architecture-debt 記憶仍指向被否決方向、doc 無 superseded 標記** — sync-protocol.md(仍標 draft/target)核心設計——client 鑄同型 domain event、投影=merged log pure function、退役 pending_writes——與 convergence-plan 盲測定調直接矛盾(「明確不做:客戶端從 event fold 狀態」;P1 已刪 foldClientEvents/mintEvent 腳手架 −627 行;客戶端定案=可變鏡像+pending_writes 兩軌)。architecture-debt-2026-06-14.md:36 仍寫「#7 規格已寫…client 鑄同型 event…」——照它動工會走回 10/10 盲測否決的路。sync 現行 SoT=membership-and-permission-epoch.md+convergence-plan.md;sync-protocol 只剩 provenance/tie-break/conflict-進-inbox 片段仍有效。證據:sync-protocol.md:3,35-39,61-68(grep superseded=0)vs convergence-plan.md 明確不做節;architecture-debt-2026-06-14.md:36。→ 收進:architecture-debt-2026-06-14.md(+給 doc 補 superseded 標頭)

15. **Canvas 離線鏡像已出貨,capability-map §12 反向過期 + 三處 stale 殘留** — 80bd3fd write-through `canvases` 表 + d831543 client-mint id 兼 idempotency,直接推翻 capability-map「canvas 無 localDb mirror=online-only」與 Top缺口6;殘留:handleOpenSubCanvas 仍硬 gate `if (!online||!activeCanvas) return`(離線進不了巢狀白板)、canvasViewDecision.ts 檔頭「no local mirror」過期、canvasActions.ts 兩段舊 MIRROR GAP 註解與同檔 upsertCanvas 自相矛盾。證據:commits 80bd3fd/d831543;canvasActions.ts:49,84;canvasViewDecision.ts:7-8;useCanvasActions.ts:98。→ 收進:onden-capability-map.md

16. **Astro 雙入口陷阱:main.tsx 在 prod 不執行** — prod build 由 index.astro client:only 直接 mount AppRoot、完全不經 main.tsx,只裝在 main.tsx 的全域初始化(uuid polyfill、persisted settings replay)prod 靜默失效;已兩度咬人(設定重載全丟、LAN 捕捉全掛),正解=全域 init 放 AppRoot module scope。insecure-context-crypto-trap 記的「main.tsx+worker 各裝」是不完整舊事實。證據:AppRoot.tsx:7-24(兩段註解明講 trap)+ commit 6c75010。→ 收進:insecure-context-crypto-trap.md

### B. 真 bug / 真讀洩漏(無任何記憶或 bug-tracker 覆蓋)

17. **GET /api/collections 無 read gate,與 tags.ts 半-gate 修復(2482f60)直接矛盾** — 把每個 class_tag 完整 tag_schema(含 policy/views/behaviour)裸回任何已認證 actor 含 viewer,無 visibleNodeIdsForActor 也無 token scope——同批資料在 GET /api/tags 已被 2482f60 修掉,此路=同類後門;read-gate lint 對該檔 regex 只斷言 items 路由,schema list-all 免檢過 build;bootstrap 也有同姿態且註解明寫「unfiltered on purpose…like /api/tags」=在 tags 修復後已成 stale 矛盾(待決產品判斷,別單修一面)。證據:collections.ts:78-91;eslint-rules/require-read-gate.js:44;index.ts:465-469。→ 收進:read-gate-chokepoint.md

18. **canvasMemberships lint 豁免 stale=真讀洩漏** — lint 標 INTERNAL、理由「reached via gated canvas reads」,但唯一 caller 是 bootstrap(index.ts:463),只 scope 成員 node、沒 scope canvas 本身——不可讀的 restricted canvas 只要擺一個可讀 node,canvas_id+canvas_title 就洩出;與 GET /api/canvases「restricted canvas must not even appear」姿態矛盾;整合測試無 scope case=by-construction 前向保證上的已知洞(豁免理由審核不實)。證據:require-read-gate.js:81 vs index.ts:463 + canvasMemberships.ts:16-27;測試無 restrict 斷言。→ 收進:read-gate-chokepoint.md

19. **CJK tag 的 node-slug 碰撞→500(兩套 slugify 分歧)** — tag 節點 content_nodes.slug 用 SQL ASCII-only regexp(純 CJK 名全塌成 'tag--'),tag_schema slug 用 utils.slugify(保 Unicode);(workspace,slug) partial unique index 下建第二個純中文 tag 即 23505,catch 按 (parent,title) 回查找不到 winner 就 rethrow→500;tag 建立路徑不走 retryOnSlugConflict。中文 dogfood 幾乎必踩;bug-tracker 只涵蓋 note import slug 案。證據:tagHierarchy.ts:113-137;tags.ts:290/585;grep 零 retryOnSlugConflict;schema.sql content_nodes_workspace_slug_uq。→ 收進:NEW:tag-slug-cjk-trap

20. **搜尋 snippet 契約前後端雙向漂移** — pgroonga_snippet_html 回 text[] 且用 `<span class="keyword">`,後端型別成 string|null 直接過 JSON,前端安全 renderer 只認 `<mark>`——snippet 在 palette 以逗號連接呈現、span 標籤變可見字面文字;前端註解「Backend returns snippets with <mark> tags」從 pgroonga 上線起就不成立。bug-tracker 無此條。證據:nodeSearch.ts:26,91;CommandPalette.tsx:61-85;live psql 驗證回 text[] 含 span。→ 收進:NEW:search-dsl-pgroonga-contract

21. **SettingsModal 殘留二元 theme effect 打壞三向 system 主題** — SettingsModal 掛載仍跑舊二元邏輯 localStorage.theme==='dark'?'dark':'light' 直寫 data-theme,但 registry 已是三向 applyThemeMode:OS 深色+mode=system 時一開 Settings 整個 app 翻成 light。889bc74 遺留,bug-tracker 無此條。證據:SettingsModal.tsx:28-31 vs settings/registry.tsx:484,701,717。→ 收進:bug-tracker 流程(autonomous-loops-2026-06-27.md)

22. **chrome blocks(siteConfig)serve 時永遠蓋掉 snapshot blocks(疑真 bug)** — overlaySiteConfig 的 `blocks: chrome?.blocks ?? base.blocks ?? []` 讓 workspace-config 的 chrome blocks 無條件優先於發布 snapshot;全庫唯一 chrome 寫入者=首啟 intro flow,publish 路徑從不更新/清除 → 跑過 intro 的使用者之後在 Studio 改版面再 publish,served site 永遠被舊 intro chrome 蓋住(studio preview 讀 overlay 後結果所以看不出來)。證據:publishing/collections.ts:106;BuilderApp.tsx:594 唯一 chrome PATCH。→ 收進:bug-tracker 流程

23. **Learner-access gate 只接在 /site/ 首頁,深連結與 feed/sitemap 全破(真 bug)** — access token(?access=/cookie)只有 site/index.astro 讀取轉發 x-site-access;[slug].astro、[collection]/[item].astro、feed.xml.ts、sitemap.xml.ts 打 /api/site 完全不帶 header → 受限站任何深連結(含已帶 cookie 的 learner)一律 401→'Site unavailable',feed/sitemap 503;index.astro 註解宣稱 deep links keep working 與實況不符。證據:site/[slug].astro:29-35(grep x-site-access 零命中)vs index.astro:26-43;publish.ts:166-187。→ 收進:bug-tracker 流程

### C. 承重契約/安全姿態(只活在碼註解,零記憶覆蓋)

24. **跨節點引用統一安全姿態:canReadNode + 404(絕不 403)** — 任何 client 提供的「指向另一節點」引用(create parent_id、reparent 目的地、block-ref、edge/pointer target)都必須過 canReadNode 且失敗回 404——避免 existence probe,也擋把子樹掛到受限 parent 下複製其 child:* 屬性;是新寫端點模板。read-gate-chokepoint 只覆蓋讀取 FROM/JOIN lint,寫側引用姿態無任何記憶。證據:routes/nodes.ts:154-161、308-315、108-116(「404 (not 403) so the gate doesn't even confirm…」)。→ 收進:read-gate-chokepoint.md

25. **authz 通則:write_node 不蘊含讀權(read-only-restricted 是 default-allow)** — spine `write_node` 對「只限制 READ」的節點 default-allow → 任何由使用者輸入解析寫入目標的路徑必須先 canReadNode,否則 editor 能盲目覆寫讀不到的節點、unchanged-compare 成為存在性/內容 oracle(import upsert 已裝閘:不可讀 match 落回 fresh create);配套模板:①跨節點引用=source WRITE+target canReadNode(edges.ts 檔頭)②不可讀一律 404。未來 merge/move/API upsert/embed/range-tag 全套此三則。證據:import.ts:395-402;edges.ts:5-8,48-56;canvases.ts:178-183;commit 88ca2ae。→ 收進:NEW:authz-write-read-asymmetry

26. **inbox 治理面同時是讀取面:read-policy 閘契約 + root_event 洩漏修復** — (a) node-targeted 事件以呼叫者 combined read set 過濾、非-node 事件對 tag-scoped token 全隱藏(鏡射 /api/events);(b)「no blind governance」鐵律=讀不到的 node 事件不可列出/計數/裁決,404 非 403;(c) 陷阱:group root row 按 id 無過濾撈,必須套 members 同款可見規則——2026-07 才修掉 root_event 洩受限 payload;facets/groups 都算在過濾後集合防計數洩漏。證據:inbox.ts:247-263,306-316,496-499,554-559;commits e88a1f6+78ae765。→ 收進:inbox-governance.md

27. **siteConfig 裡住著秘密,靠 overlaySiteConfig allowlist 手抄紀律不外洩** — access_tokens/access_mode/share_token 全明文存 siteConfig(#workspace-config 的 node_attributes),與 brand/nav 公開設定同袋;唯一防線=overlaySiteConfig 逐-key allowlist overlay(非 spread),檔頭鐵律「never spread the whole config into a public response」——日後在公開 payload spread cfg 或往 overlay 加 key,就把 learner/share token 洩到匿名 /api/site。正是統合主軸要獵的 by-discipline 手抄防線形狀。證據:siteAccess.ts:18-22;share.ts:10-15;publishing/collections.ts:21 起;publish.ts:128-130。→ 收進:NEW:public-surface-security

28. **Media 是第三個存儲軌:off-spine、不進 git、永無 GC、purge 反而升格可讀** — 媒體位元組=content/media/ 裸檔案,完全在兩條歷史軌之外:不進 blobs 表、上傳明文承認 off-spine 無 event 無審計、git 備份只 add .md;全 backend src 零 unlink/rmSync=媒體永不刪除(prune 只清 blobs 表)。咬人陷阱:purge 受限節點後其媒體 refs 歸零→落入 canReadMedia unattached 分支=任一認證 actor 可讀(restricted→any-authenticated)。附帶:raster 上傳一律 sharp 有損 re-encode 成 webp(max 2400px/q85),原始位元組永久不可回復——影響 export 保真;也修正 rebuild-foundation「content=hash-pointer already shipped」隱含範圍(只涵蓋 markdown body)。證據:media.ts:87-96,116-123;blobs.ts:14;git.ts:25;grep unlink/rmSync 零命中;readPolicy.ts:333-346;prune.ts:183-204。→ 收進:NEW:media-storage-posture

29. **withTransaction 重入 JOIN 語意 + 真實 pool 死鎖事故 + poisoned client 驅逐** — withTransaction 是重入的(已在 tx 內就 JOIN 外層,ALS 綁 client,不開第二條連線);起因真實事故:mutate() tx 內呼 syncBlockIds→等第二條連線,pool 飽和無 connectionTimeoutMillis→後端 wedge。附帶:tx cleanup 失敗連線標 poisoned 用 error release 驅逐;afterCommit txHooks 嚴格 COMMIT 後 flush。陷阱:collections.ts createItem 的 post-commit dispatch 註解仍寫「withTransaction does NOT nest…would deadlock」=已 stale(真承重理由是失敗隔離)。新 service 想自開交易/自 pool.connect() 必讀。證據:db.ts:53-93;collections.ts:374-380;memory 僅 membership-epoch 一句「q() 非 pool.query」。→ 收進:NEW:db-tx-discipline

30. **自助註冊 default-deny:首位=admin bootstrap、其後=viewer 地板 + advisory-lock 防雙 admin race** — better-auth 首登 auto-create actor 時只有空工作區第一位 human bootstrap 成 admin/owner,其後所有自助註冊拿無寫入權 viewer(要 admin 經 actor 管理升權);bootstrap 用 pg_advisory_xact_lock('actor-bootstrap:ws') 序列化,修掉並發首登雙 admin race。principal-authority.md 零記載 signup 姿態。證據:index.ts:277-306 + dispatcher/permissions.ts:65 signupRoleFor;commit 640eb2c。→ 收進:principal-authority.md

31. **靜態發布產物=凍結原樣,tag/read-policy 變更不觸發 republish** — GitHub Pages bundle 與 /api/export-static 把 publish_snapshots.payload 原樣發射、不重跑 serve-time redaction(snapshot 建置源頭 born clean);收斂只靠 _published 翻轉時 best-effort republishSite(吞錯);tag/read-policy 變更不觸發 republish → 已部署靜態產物會繼續公開已被限讀內容直到下次 deploy;新增 redaction 規則必須同時進 snapshot builder。證據:snapshot.ts:49-57(「emit VERBATIM」),108-129;nodes.ts:1175,1237;collections.ts:133-137。→ 收進:NEW:publish-static-freshness-contract

32. **per-node egress opt-out:local_only attribute + backup append-mostly** — 節點掛 `local_only='true'` 永不 enqueue github_backup(唯一跨部署邊界 effect;remote intent 根本不建),本地 git_commit 照跑;檢查放 enqueueBackup chokepoint 所有寫入路徑自動遵守,鏡像 _published 慣例,有測試釘住。另 backup repo 是 append-mostly——刪除不傳播(roadmap 開口),被刪/事後標 local_only 但先前已推的筆記殘留遠端;GITHUB_PAGES_TOKEN/GITHUB_BACKUP_TOKEN 各自最小權限。全記憶體系零提及。證據:outbox.ts:64-102;outbox.integration.test.ts:62-75;README.md:340-368,393;commit bf98a9e。→ 收進:onden-capability-map.md + effects-discipline.md

33. **公開面 CSP 防禦縱深批次(2026-07-02, 7e5b700):sanitizer 不再是唯一 XSS 防線** — 發布 HTML 烤 meta-CSP(GitHub Pages 設不了 header;靜態頁零 script;SPA shell 'self'+analytics sha256 hash 非 unsafe-inline,hash 對 ga4InlineScript() 輸出計算、emitter 與 hash 單一來源;frame-src 鏡射 TRUSTED_EMBED_HOSTS)、SSR /site 真 header(frame-ancestors/nosniff)、/api/media 全 nosniff+SVG 回應 `default-src 'none'; sandbox`、路徑清理統一 basename、CORS_ORIGIN="*"+credentials 在 production 從警告升級成硬 boot failure。刻意不改:canvas web-embed iframe 不上 host allowlist(會殺任意頁嵌入)——安全 sweep 別「順手修」。pin 在 publishedCsp.test.ts。記憶 grep CSP 零命中。證據:commit 7e5b700;htmlUtils.ts:122-192;seoFiles.ts:70-73;index.ts:102-113;publishedCsp.test.ts。→ 收進:NEW:public-surface-security(CSP 段)

34. **capability-tag 損壞類災難 + self-heal-on-read 修復姿態(真 production 停機)** — PATCH 預設值 bug(36069e3 修)會把 capability tag 的 node_type 翻成 content,整個子系統永久掛:site-config tag 翻型→getSiteConfig 每次 500(真 production 停機,prod DB 手工修過,5f33103)、#subscription 翻型/誤軟刪→訂閱全消失(66245fb)。確立修法模式=self-heal on read:coerce 回 live class_tag 且**回收同一個 id**(鑄新 tag 會讓掛舊 id 的 sources/config 全成孤兒)、slug-collision-guarded、只在損壞時寫。任何 name/id-based capability tag(#task/#review/config/#subscription)同屬此損壞類。證據:commits 5f33103(siteConfigSelfHeal.integration.test)、66245fb(rssModule.integration.test)、36069e3。→ 收進:tag-module-contract.md

35. **zod .partial() 不關 .default() 的 PATCH 清空陷阱** — .partial() 不停用 .default() 欄位:title-only PATCH 解析出 markdown:''/hidden:false,任何不重送全 payload 的 client(agent/MCP)靜默清空 body(web app 因總送全 payload 而遮蔽);修法=parsed input 限縮到 request 自帶 keys、SET 子句只寫請求欄位(順修並行 PATCH 互相覆寫)。會咬任何新 zod route,且已造成真實 production 損壞(見上條)。證據:commit 36069e3;nodePatchPartial.integration.test.ts:86-91;routes/nodes.ts:248-256,371-389。→ 收進:NEW:zod-partial-default-trap(或 node-route-contracts)

36. **Token permission templates 已出貨:四個嚴格巢狀角色模板** — mint token 可用 template(read-only ⊂ organizer ⊂ researcher ⊂ publisher);mint 時展開、token 存展開後固定清單(registry 之後長新工具不會靜默擴權既有 token);template+allowed_tools 同傳=400;allowed_tag_ids 刻意不進模板;expandTokenTemplate 引用已下架工具硬 throw。agent-capability-surface 完全沒有此機制。證據:agentTools/templates.ts:1-32;routes/actors.ts:181-192。→ 收進:agent-capability-surface.md

37. **Bearer token 的 /api/mcp/* 禁閉有 isPublicRead 豁免口** — 記憶說 bearer「confined to /api/mcp/*」,但 tokenScope 禁閉條件豁免 isPublicRead=bearer 也能 GET /api/media/* 與 /api/share/<token>;且 canReadMedia unattached 分支只驗 actor!==null,bearer actor 算認證→agent 可讀未附著的新上傳。是「agent 能力=工具清單」邊界的實質 carve-out。證據:index.ts:209;readPolicy.ts:346;grep agent-capability-surface.md 無 isPublicRead/media。→ 收進:agent-capability-surface.md

38. **不用 Postgres RLS 是明文取捨 + workspaceBoundary lint-test 是第二條 by-construction 閘** — workspace_id 是唯一租戶邊界;RLS 蓋不到離線 sql.js 鏡像=server-only RLS 留隱門(mig 022 拆掉唯一 no-op RLS,rationale 原指向的 schema.sql header 已不存在);強制=(1) getWorkspaceId() 單租戶釘點(永遠 'default',multi-workspace 第一步=升級此 resolver)+(2) workspaceBoundary.test lint 式閘:每條對 workspace-bearing 表的 query 必帶錨點(workspace_id/node_id/actor_id/PK),刻意跨界 query 進 ALLOWLIST 附理由。記憶只記 read-gate eslint 這一條 lint 閘。證據:022_drop_dead_node_tags_rls.sql:1-15;db.ts:229-243;workspaceBoundary.test.ts:1-28。→ 收進:NEW:workspace-tenancy-boundary

39. **module system(第一方 module seam)已出貨且有硬契約,≠ deferred plugins** — 模組=一目錄+MODULES 靜態清單一項(現有 review、rss),刻意非 plugin 系統(無動態載入/sandbox);模組可擁有 /api/<id> routes、agentTools(偏 read-only+必經 readableNodeIdSet=iron law)、dispatcherHandlers、`_<id>_*` 保留 attr(走 ATTRIBUTE_SET 免費拿 undo+inbox 治理)、tag-by-NAME 開關(rename-retires=接受取捨)、pack 行為必 server-side CLAMP;禁止:平行表(node_tasks 為戒)、繞 spine(spineGate 掃 modules/ 且 allowlist 保持空)、第三 rail;背景 timer 只由 startModuleBackground 非 test 啟動。附帶姿態(2026-07-03):by-name capability tag 可被使用者弄壞→路由 self-heal 非 500。證據:modules/README.md:1-78;modules/index.ts:1-46;前端 twin README(b17c7c3);commits 5f33103/66245fb。→ 收進:NEW:module-seam-contract

40. **備份/還原 ops 腳本已出貨但從未實跑** — scripts/backup.sh+restore.sh(1d34de7, 07-02):容器內 pg_dump --clean gzip + content volume tar、BACKUP_KEEP=14、.partial 原子改名;restore 毀滅性 DROP-all 強制 --yes。三陷阱:compose 不對 host 發布 PG 端口(必須容器內 dump);content_data named volume 只能從運行中 backend 串流(backend 停了 media 不備份);restore 前必須 stop backend。commit message 明言只 bash -n 過、從未對真 stack 實跑——第一次真用前先驗 round-trip。同 commit 另出貨零依賴分級 logger(LOG_LEVEL/LOG_FORMAT=json,已轉熱站點,新後端 log 走 logger)。證據:scripts/backup.sh:2-26,110-115;restore.sh:7-16;logger.ts:1-20;git show 1d34de7。→ 收進:NEW:ops-backup-restore

41. **client-mint id 已成全域離線 create 契約** — 2026-07-01 起所有 create 端點接受可選 client uuid(z.string().uuid().optional() / COALESCE($n::uuid, gen_random_uuid()))全覆蓋(task/day-node/quote-card/tag/canvas/canvas-node/RSS save),client-mint id 兼 idempotency key,drain+/api/sync 靠同 id 收斂=不需 temp-id remapping;server-mints-id 離線缺口清零。offline-sync-decision 的 2026-06-25 現況已過時;新 create 端點必須沿用。證據:commits 8daf66b/d10e334/d831543/80bd3fd/ba5bf2a;routes/nodes.ts:981+ COALESCE 模式。→ 收進:offline-sync-decision.md

42. **關閉路徑耐久的唯一通道=主執行緒 unload-flush relay** — persistScheduler 自帶的 pagehide/beforeunload flush 在 worker 內是 no-op(無 window 早退),tab 關閉時 2s debounce 內快照唯一落盤通道=主執行緒 installUnloadFlush() 把 pagehide+visibilitychange→hidden relay 成 flushLocalDbSync RPC(worker flushSync 後還要 await exportAndSave);拿掉這個看似冗餘的 relay=靜默資料遺失。證據:localDb.ts:198-231;localDbWorker.ts:69-74,96-109;persistScheduler.ts:81-88;commit 269d79d(P0 data-loss)。→ 收進:offline-sync-decision.md

43. **serverMerge=佇列之外的第三條寫入軌** — SettingsModal onConnect 跑 mergeLocalNodesToServer:對 pre-sync 快照的每個本地節點,server 缺就 POST 重建、title/markdown 分歧就 PATCH 且不帶 base_markdown(繞過 3-way merge、本地盲贏),快照在 sync()/membership reconcile 之前捕捉(剛被撤權/刪除的節點可能被推回 server)。是 pending_writes 與 sendOrQueue 之外的平行 rail;sync 形式化(Tier1)不知它就漏一條 rail。證據:serverMerge.ts:18-40;BuilderApp.tsx:1146-1155;grep memory 零 hit。→ 收進:offline-sync-decision.md

44. **Web Share Target 已出貨 + useUrlSync 吃參數陷阱** — manifest share_target(GET)→ /?capture=1&title&text&url 已出貨(a72f22a,Android share sheet 直入);順序契約:payload 必須在首次 render 同步消費(useState 初始化器 consumeSharedCapture)並立即 replaceState 剝參數,因 useUrlSync 首個 effect 會把 search 正規化默默吃掉 payload。附帶 quirk:manifest icon 任一 404 靜默毀 Chrome installability。mobile roadmap 仍把 OS 捕捉列 P2 未做=stale。證據:BuilderApp.tsx:98-132;manifest.webmanifest:30;pwaCapture.spec.ts:3-13;commit a72f22a。→ 收進:NEW:builderapp-boot-contracts + mobile-tablet-research-roadmap.md

45. **IME/CJK composition guard 跨元件鐵律** — 所有攔鍵盤的 popup/palette/輸入+清單表面都必須守 composition guard,否則中文使用者無法選字(組字中 Enter 是選字非提交):CM6 keymap 內讀 view.composing、DOM input 讀 e.nativeEvent.isComposing、beforeinput 在 composing 中絕不 preventDefault(會弄壞 GBoard);全 src 只有 CommandPalette 與 MarkdownEditor 兩處有 guard,新元件極易漏且 harness 不模擬 IME 抓不到,使用者 zh-TW dogfood 必咬。證據:MarkdownEditor.tsx:725-729,820-838,915-921,1316-1321;CommandPalette.tsx:193-197;grep memory 零 IME 條目。→ 收進:NEW:ime-composition-guards

46. **iframe 嵌入的真正安全邊界=render-time host 白名單,不是 sanitize schema** — rehype-sanitize protocols 表達不了 host;<iframe> 放行後唯一擋任意 https iframe 的是兩條渲染路徑都套的 isAllowedEmbedSrc(TRUSTED_EMBED_HOSTS=youtube/youtube-nocookie/vimeo/player.vimeo 及子網域,非名單即 drop)+EmbedIframe 防禦性重查;toEmbedUrl 一律正規化到 youtube-nocookie 且 id 驗證。以為 schema 有保護就會開洞。證據:mediaEmbed.ts:17,46-53;mediaSanitize.ts:10-17;MarkdownRenderer.tsx:196-214,397-401。→ 收進:NEW:markdown-render-security

47. **data: URL 政策=urlTransform 窄縫,拆掉壞發布站、放寬即 XSS** — react-markdown defaultUrlTransform 剝所有 data:,但發布站/RSS 用 data URI 內嵌媒體——覆寫 urlTransform,僅 key==='src' 且符合 ^data:image|audio|video/ 才放行,data: href 與 data:text/html 仍剝;sanitizeSchema 的 protocols.src 加 'data' 只是配套,真正牙齒在 urlTransform。刪覆寫=發布站內嵌媒體全滅,放寬=XSS。證據:MarkdownRenderer.tsx:501-507;sanitizeSchema.ts:23-33;mediaSanitize.ts:22-25。→ 收進:NEW:markdown-render-security

48. **pdf_annotations ↔ ink_data 雙軌 lockstep 契約(含 pdfAdapter 檔頭與實況座標系分歧)** — PDF 手繪/形狀雙寫兩個 attribute:渲染真相=pdf_annotations(frame-local px),ink_data 只餵 diff/治理、不可作幾何來源(實存 page-local capture-zoom px,與 pdfAdapter.ts 檔頭聲稱的 frame-local 不符;rect/circle 在 ink_data 是 [0,0]→[1,1] 佔位);兩軌以 highlight id 連結(`${groupId}:${i}` 後綴),但 per-highlight 刪除 UI 不存在、removeDrawing 零產品呼叫者;唯一同步點=handleClear 全清——加刪除/發布渲染只動一軌就靜默漂移。證據:PdfNodeView.tsx:280-288,359-364;pdfAdapter.ts:10-16,82-89;grep removeDrawing 僅定義+測試。→ 收進:NEW:pdf-annotation-rails

49. **highlight→card 的基底契約(使用者欽定 parent_id 模式,fire-and-forget)** — PDF 引文卡來源追蹤唯一機制=edge type='highlight_source',刻意不設 source_pdf_node_id attribute;新節點 parent_id=PDF 節點=使用者要的模式(展開 PDF 才見 highlights);pdf_page attr 僅選配;整條 fire-and-forget:spawn 失敗時視覺 highlight 仍存、節點靜默丟失——加 source attr 或改 parent 掛法都違反已定設計。證據:OverviewEditor.tsx:296-346(註解含使用者決策);PdfNodeView.tsx:59-64。→ 收進:NEW:pdf-annotation-rails

50. **前端 CSS 兩條硬慣例:--onden-* token 契約 + z-index 無中央階層表** — theme-tokens.css 是兩層公開 theming API(PRIMITIVES 12 階 Radix 式 / SEMANTIC);全庫大量使用的 --bg/--surface/--text/--line/--accent 短名是 backward-compat aliases、檔內明令 DO NOT use in new code——但既有碼滿是 alias,照抄舊慣例就違約。z-index 無 token/registry,de facto 階梯=rail 49<topbar 50<popover 60<bottom-nav 100<sheet 110-120<dropdown 200<palette 300<toast 400<FailedWriteRecovery 420<settings-overlay 9000<scrim 9999;新 overlay 不查階梯就被蓋住(global.css:2899 有修痕)。證據:theme-tokens.css:1-16,159-161;global.css:31-44,2899;grep 無 --z-* token。→ 收進:NEW:frontend-css-conventions

---

## 中優先(精簡,按建議落點聚類)

### read-gate-chokepoint.md
- **Task 讀面隱形契約**:每個 task row 來源必須自行 JOIN 活 host(deleted_at IS NULL);062 cascade 只涵蓋 tag POLICY,/api/sync 曾因此洩 trashed host id(compositionLaws LAW 3)。證據:tasksStore.ts:150-172 檔頭契約。
- **substrate 契約:edge/attr 列在 trash 後存活**,serving 讀須自行 alive-filter(edge 雙端都活)——與授權過濾平行的第二條讀取紀律。證據:sync.ts:226-234,253-255,500-515。
- **sync task 雙端 scope**:task 自身 id∈讀集 AND host id∈讀集,各缺一半都洩;修正記憶 line 38 的半句。證據:sync.ts:158-166,268-281。
- **listItems scopeActor 三態 footgun**:undefined=完全無 gate(internal/publish 刻意),新 caller 忘傳參數靜默拿全工作區,lint 只 presence-check 擋不住 callsite 漏傳。證據:services/collections.ts:198-211;require-read-gate.js:54。
- **canSeeTag 單-tag 讀閘**:所有按 tag id 端點走 canSeeTag(dec0863 修 list-vs-detail 縫,修前 8 面知道 uuid 即讀全 schema/policy);其 token 半刻意不同於 canReadNode(tag 本身就是 scope,直接比對 allowlist),一律映 404。勿誤統一成 canReadNode。證據:readPolicy.ts:388-402;tags.ts:156,217,664,852。
- **permissionMatrix 掃漏閘**:自動內省全部 GET 端點跑 anonymous→401/viewer byte-level/空 scope→403;新 GET 路由 path param 不認得就整套 FAIL(要擴 PARAM_FILL);公開面 allowlist 明列。證據:permissionMatrix.test.ts:1-27。
- **publiclyReadableNodeIds 是「公眾能看什麼」唯一 canonical 謂詞**,publish 路徑 MUST 從它推導、禁止重刻(舊 READ_RESTRICTED_EXCLUSION_SQL 因不遞迴祖先洩漏過)。證據:readPolicy.ts:77-86。

### restore-state.md
- **undelete 子樹靠 event 鏈**:cascade 給每個子孫發 NODE_DELETED(triggered_by 指根),undelete 用 deleted_by_event_id+triggered_by 鏈反查——事件是 restore 的資料結構非只 audit;清理/改 cascade 事件形狀會弄壞子樹 undelete。證據:routes/nodes.ts:495-531,566-576。
- **DMP UTF-16 surrogate 陷阱三層 fallback**:emoji 內編輯曾每次 500(上游 bug #69);現 fallback 全文替換 patch,lone surrogate 回空字串=該事件靜默無 inverse。證據:bodyPatch.ts:56-81;commit 73af000。
- **初始 schema 建立刻意不可自動 undo**(created:true 拒 422「edit forward instead」)。證據:restore.ts:1077-1091。
- **NODE_UPDATED 冪等守門=event-log probe**(tx_meta restored_from,命中 409);force 跳過 clean-patch 檢查會靜默腐蝕 body。證據:restore.ts:591-606;commit 34d1171。
- **attribute 事件值可為 value_ref(hash-pointer)**:任何讀 payload/prev_field_values 的消費者須雙形解析(ink_data 就是)。證據:restore.ts:860-868,926-929;commit 3a61209。
- **prune/GC 無任何自動排程**:唯一呼叫點=admin POST /api/maintenance/prune(前端=Empty trash,retention 0),90 天預設從未生效;task 子節點 parent_id 是 SET NULL,prune 顯式 fold-in 進 purge set——新硬刪路徑必須複製。證據:maintenance.ts:46;prune.ts:110-126。
- **domain_events append-only 由 DB trigger 強制**(mig 051+052):DELETE 需 tx-local GUC set_config('myapp.allow_event_prune'),帶 body_hash 事件永生;唯一許可刪除路=pruneEvents(預設 EVENT_PRUNE_EXPERIMENTAL 關)。證據:db.ts:183-199;index.ts:718-719。

### spine-refactor.md / effects-discipline.md
- **spine 不鑄 'system' actor**:伺服器側自動化(BODY_CONFLICT/ATTRIBUTE_CONFLICT)走 raw event() actor_type='system'+triggered_by;taskScheduler 同姿態更進一步(sentinel actor+裸 UPDATE,無 inverse txMeta→不走 inbox 治理、restore 無法逆轉,只留 TASK_OCCURRENCE_MISSED 審計)。是「nothing bypasses the spine」的成文例外。證據:nodes.ts:1148-1163,400-410;taskScheduler.ts:20-23,126-135。
- **suggested_link 邊刻意繞過 event log**(embeddings 衍生投影;確認成真邊才走受稽核 POST /api/edges)——audit 時會誤判違規。證據:embeddings.ts:140-173。
- **siteConfig 是 spine 覆蓋的精度缺口**:patchSiteConfig 自開 pool.connect()=獨立交易(外層 rollback 時 config 已 commit);per-key 值不進 event log=無版本史不可 undo;config class_tag 被 type-flip 有 ON CONFLICT 自癒。證據:siteConfig.ts:62-83,178-199;index.ts:612-626。
- **txHooks.afterCommit=post-commit effect 強制 chokepoint**(ALS 收集、COMMIT 後 flush、rollback 丟棄、無 tx 立即執行)——新服務要在 tx 內發 tick/效果都走這裡。證據:txHooks.ts:1-33。
- **installTagPackApproved 冪等收斂=outbox effect 範式**:at-least-once retry 下用「TAG_IMPORTED via_approval=true 事件存在否」區分前次已成功(收斂回傳,不 throw 免 dead-letter)vs 真撞名(必須 throw);新 outbox effect kind 照抄。證據:tagPacks.ts:95-117;commit d1575d1。

### membership-epoch.md
- **SSE 全頻道 PINNED CONTRACT**:唯三 frame kind(changed/effects/membership_changed)、payload 永不帶 id/title/event type、tick 是 delivery hint 非 fact;per-id 提示明文 out of scope——SSE 無 read-policy 過濾,加 id 即洩漏。證據:events.ts:135-152;realtime.ts:1-24。
- **realtime hub=單進程 emitter**:多副本下只有 node_tags trigger 的 membership tick 經 pg LISTEN/NOTIFY(mig 070)跨進程,changed/effects 與 afterCommit 系 bump 只達寫入進程;正確性由 handshake/poll 兜底;升級路徑已註明。證據:realtime.ts:17-24;membershipListener.ts:1-14。
- **membership-epoch 記憶 stale:slim bootstrap 現在是權威可讀集**,不在 payload 的節點會被 drop(H17 後含 tasks/edges/attrs cascade),唯一保留=id 出現在 pending write 的節點;slim upsert 用 COALESCE(NULLIF) 防 clobber。推翻記憶「refresh 是 merge 非清理」。證據:localDbPersist.ts:15,30,36;commits 54c8aee/7e8cf3c。
- **bootstrap slim 集合刻意 UNCAPPED**:BOOTSTRAP_NODE_LIMIT(5000) 只套 full-body;歷史 bug=曾對 slim 封頂→cap 外節點永久隱形+鏡像被 clobber 成截斷集(9ffcf78);前端 ≥2000 自動 slim。別把 LIMIT 加回 slim。證據:index.ts:308-345,420-425;commits bd3eb57/9ffcf78。
- **SSE-behind-nginx 反代陷阱**:/api/events/stream 是 exact-match location(proxy_buffering off+gzip off+1h timeout;程式端 X-Accel-Buffering no+25s heartbeat);新 SSE 端點走別的路徑會落進一般 /api/ 被緩衝;換反代不複製就壞。證據:docker/nginx/nginx.conf:26-43;events.ts:158-204。

### agent-capability-surface.md
- **MCP 雙表面+dryRun 陷阱**:REST /api/mcp/tools/* + 原生 MCP JSON-RPC /api/mcp/protocol(Streamable HTTP、刻意 stateless、ALS 傳 actor;Claude Desktop 可直連;Zod .refine() 在 MCP schema 面不可見靠 callTool full-parse 兜底);REST ?dryRun=true 照跑檢查跳過寫入,審計不對稱(dry-run 成功不記 AGENT_TOOL_CALLED、失敗永遠記 AGENT_TOOL_FAILED);陷阱=registry 仍無條件執行 handler,全靠每個寫工具自己 `if (dryRun) return`(現 6 個都有)——新寫工具忘了會真的寫;原生 protocol 面完全沒接 dryRun。證據:mcpProtocol.ts:11-40;registry.ts:78-124,109,130;routes/mcp.ts:51;commit 9c7c28f。
- **逐工具 scoped-token 邊界契約 + scope.ts 檔頭已過時**:createNode 必帶 allowlist 內 tag_id(create+tag 原子)/applyTag claimable 規則(零 tag 節點可收編,已知 tag-laundering 風險靠 audit 監控)/removeTag 無 claimable/queryView tag-scope LITERAL/updateNode 只開 title+markdown;scope.ts 檔頭「read 是 workspace-wide」已與實碼相反(getNode 走 canReadNode、searchNodes scope 推進 query)。證據:各工具檔頭;scope.ts:12-14 vs getNode.ts:54。
- **agent 永不 grade(FSRS 設計決策)+ registry 數 stale**:review 模組只註冊 read-only reviewQueue,明文拒 grade tool(「排程模型的是人類記憶」);registry 現 11 核心+module=12(另掃描計 14 含 proposeTagPack 批次)。證據:modules/review/index.ts:11,21;reviewQueueTool.ts:7-19。
- **agent-authored body 使 preview 渲染翻成不信任姿態**:renderNode 已 SANITIZED、與 publish 共用 extendedSanitizeSchema;新渲染路徑必須沿用共享 schema。證據:renderNode.ts:10-21。

### tag-module-contract.md / tag-unification-decision.md
- **Tag policy per-op default-allow 是刻意相容性決策**(operations[op] ?? required_role ?? 'viewer';未宣告=無限制是合約),別當「修洞」改 default-deny。證據:dispatcher/permissions.ts:33-36,76-78。
- **schema 編輯下放時必加 self-escalation guard(條件式鐵律)**:policy 編輯現在安全只因編輯者已是 admin;下放到 admin 以下 MUST 加 guard(actor 不得授予自己不滿足的 policy)。證據:tags.ts:313-321。
- **schema field 單一識別符=name**:寫入邊界必過 normalizeFieldIdentifiers(key→name,mig 056 回填);漏了欄位對所有讀站隱形;且 PATCH schema 只 merge jsonb 不遷移 attribute rows→欄位改名讓既有值靜默失配。證據:tagPacks.ts:38-53;schemaValidation.ts:21-22;tags.ts:336,873,405-415。
- **modules/README 機制強制細節**:spineGate 掃 modules/ allowlist 保持空;startBackground 絕不在 test 跑、背景工作走 outbox;mountModules 可重跑(同物件 no-op、搶同名 reject);pack-borne behaviour server-side clamp 是合約(#review retention 0.7–0.97/interval ≤36500/new_per_day 0–500),FSRS 17 權重明文不可配置。證據:modules/README.md;fsrs.ts:55-56;routes.ts:63-70。
- **tag merge 可逆性設計**:成員走完整 apply 路徑(全鏈到單一 TAG_MERGED 根,cascade-preview 可見);source soft-DELETE 非剝除(junction 隱形存活,Trash undelete #source=溶解 merge);schema=target WINS;merge_event_id=全量 undo 把手;子 tag reparent 各發 NODE_UPDATED。**開放 bug:merge 進自己子孫→parent_id 環**(descendantsOf CTE 是 UNION ALL 無環偵測;fullTagPath 16 層 cap 是唯一防線且其引用的 cycle-reject trigger 不存在;M4 環守門只修在 nodes PATCH,merge reparent 繞過)。證據:tags.ts:947-959,1019,1056-1122;tagHierarchy.ts:148-177;schema.sql grep cycle 零命中。→ 可獨立 NEW:tag-merge-design
- **markdown→attribute 同步是 additive-only 已出貨**(從 body 刪 key:: value 不刪 attribute)——與 tag 統一 v1 拍板同哲學的先例。證據:services/nodes.ts:166-171。→ tag-unification-decision.md

### offline-sync-decision.md
- **屬性離線衝突偵測協議**:client 每筆 upsertAttribute 帶 client_updated_at(=編輯時刻非 drain 時刻),server 比 stored updated_at(500ms 容差),衝突不拒絕——LWW 覆寫+補發 system ATTRIBUTE_CONFLICT(帶 overridden_value)當審計軌;協議細節不在任何 doc/memory。證據:graphMutations.ts:179,192;nodes.ts:1048,1078-1081,1153。→ collab-merge-model.md
- **queueWrite 排隊失敗救援面**:quota/OPFS 掛時回滾 pending 計數+發 OFFLINE_QUEUE_FAILED_EVENT,FailedWriteRecovery banner 保住打的字;繞過 queueWrite 的新排隊路徑失去保護。證據:offline.ts:17-41。
- **TasksMode 離線 #tag 仍無聲蒸發(bug)**:addTask tag 腿 `if (task && opts?.tags?.length && ctx.online)`——離線/排隊時 tag 已從標題剝除且永不套用;QuickCapture 修了、這軌沒有;bug-tracker 未收錄。證據:graphMutations.ts:54;TasksMode.tsx:251 vs QuickCapture.tsx:186-195。
- **離線套 tag MIRROR GAP=刻意取捨**:只鏡像 membership,server-side automation(defaults/template/on_apply)不在 client 重現,等 drain 後 /api/sync 補齊。證據:graphMutations.ts:249-252。
- **本地鏡像 schema 演進=probe-and-ALTER**(無版本化 migration):加欄位必須同時改 CREATE TABLE+try/catch ALTER probe;只改 CREATE TABLE 老用戶鏡像靜默缺欄。證據:localDbWorker.ts:154-160,208-214,244-249。
- **offline-parity 寫入不變量**:寫入按鈕永不因離線 grey out;saveStatus='rejected'(4xx)必須可點顯示 Retry、絕不像已存。證據:OverviewEditor.tsx:529-539;NodeInspector.tsx:329。
- **sw.js 鐵律:永不快取 hashed chunk**(cache-first 曾凍死 lazy route,da71aad);hashed asset 交給 HTTP immutable cache;語義改動 bump CACHE 常數——約束「離線冷啟動」缺口的修法。證據:sw.js:1-12。
- **TagPack.id 可由 client 預鑄**(離線建 tag 契約,d10e334);**本機儲存可切 File System Access 資料夾**且該面板 show 條件是 !ctx.online(by-design 非 bug);離線 parity 批次(07-01/02)已關掉 capability-map canvas ⚠️ 與 server-mints-id 缺口。證據:tagPacks.ts:15-18;registry.tsx:53-116,653-660;commits 80bd3fd/d831543/d10e334/8daf66b。

### site-builder-direction.md
- **Studio globalBlocks 只在 publish 時持久化**(debounce timer body 只 clearTimeout 從不存;重載讀最近 snapshot)——「沒按 Publish 就 reload=全丟」是預期行為。證據:useWebsiteMode.ts:189-193,157-167。
- **per-page layout 資料模型=#page class_tag+node attrs**;manifest.pageBlocks 有消費端(SiteTemplate)但全庫無生產者=休眠能力。證據:publishing/collections.ts:37-70;grep pageBlocks 無寫入者。
- **puckUtils.ts 是死的舊格式副本、卻有綠測試**(唯一 importer=自己的測試;活版在 PuckStudioCanvas.tsx)——假信心陷阱,應刪或改指向。證據:grep import 僅 puckUtils.test.ts。
- **siteSettings 單物件契約 + baseline-guard 不變量**:新增站台設定=lib/siteSettings.ts 加欄位;mount/hydration 絕不 PATCH(曾造成 spurious config 寫+default 蓋掉已存設定)。證據:siteSettings.ts:1-7;useWebsiteMode.ts:64-135。
- **發布站只載 published-site.css 單一樣式表**(元件 CSS 到不了發布頁,要 @import);styles/editor.css 是 Puck-studio 專用非 markdown 編輯器。證據:published-site.css:1-17;editor.css:1-3。
- **發布 gate=read policy 是使用者拍板方案 b**(推翻 doc 07 的 #published capability-tag 建議),別回頭實作 capability-tag 版;redaction.ts 註解「schema-tagged nodes can't be published」已 stale 矛盾,attachPublishedTags 只收 schema-less label tag(schema-tag 標題靜默不出現公開站,刻意還是副作用未定)。證據:collections.ts:111-151(「方案 b (2026-06-12 拍板)」);redaction.ts:40-41,52;README.md:204-208。

### canvas-scale.md
- **canvas/node_positions 三契約**:data.nodes/data.sections 各是 FULL-SYNC(key present 才跑;空陣列=清空,曾咬過人);surface 是自由字串含保留值 'graph';DELETE canvas=node 軟刪、刻意不清 positions/sections。證據:canvases.ts:234-244,272-283;nodePositions.ts:3-6,76,93-97。
- **Canvas 儲存=整份 LWW 的兩條會咬人契約**:save 漏 sections key=整板群組框抹掉(必須 spread 完整 data,測試釘住);迴圈逐卡 save 互相 race——批次操作必須落成單一 save。證據:useCanvasActions.ts:414-418,299-315。
- **no-mutate-on-view + sticky board**:瀏覽 Canvas tab 絕不 createCanvas+persist(唯一建 board 路徑=顯式按鈕);Canvas tab 要「掙得」才顯示;board STICKY(點卡只切 focus 不 unmount);決策抽成 canvasViewDecision.ts 純函式。證據:BuilderApp.tsx:700-770,891-913,1414-1420。
- **hybrid-lite v1(ink-only)已出貨**(CanvasInkLayer:Pixi WebGL committed+GPU 失敗退 Canvas2D;v2 明確 out of scope)——canvas-scale 記憶仍當「未動工選項」。證據:CanvasInkLayer.tsx:14-34。
- **Section 群組=純幾何 membership 無持久歸屬**(section id 只活在 canvas data blob)。證據:sectionCarry.ts:1-9。
- **D2 canvas 語意契約**:board 永遠錨定 folder/tag(drag-in=membership op:folder 板建 note_pointers、tag 板套 tag);明文不做 canvas-local 散卡與裝飾箭頭層。證據:00-decisions.md:36-44。
- **canvas 節點已收進讀取集**(原刻意排除,top-bar collapse d8c6f42 後反轉;照舊直覺排回去會弄斷 board deep-link)。證據:readPolicy.ts:28-31。→ mobile-nav-two-axis.md

### e2e-verification.md
- **fullstack e2e requireAdmin 閘**:~10 支 owner-gated spec 在本地舊 stack 靜默 skip 仍全綠,只有 E2E_REQUIRE_ADMIN=1(CI 有)才 fail-loud——「本地 fullstack 綠」≠治理/發布套件真的跑過。證據:helpers.ts:3-15;run.sh:12,113;ci.yml:153,178。
- **global-setup 已改固定 owner 帳號 e2e-owner@example.com + run.sh 無條件 down -v**;記憶 24,58-59 行仍寫舊方案(每次 mint 新使用者/手動 down -v)。證據:global-setup.ts:9-15;run.sh:73-77;commit 2c67cf1。
- **harness 三合約**:setOffline 只切傳輸、app 連線狀態掛 window 事件須手動 dispatchEvent(canonical=syncStatus.spec);大量 fixture 必須掛單一收合 container note;e2e 強制 data-theme 不能 addInitScript(applyPersistedSettings 會蓋)要 ready() 後 evaluate。證據:offline-capture-sync.spec:10-16;virtSidebar.spec:5-9;uxAudit.spec:7-9。
- **NODE_ENV 三態**:image 烤死 production;e2e stack 顯式 NODE_ENV=e2e(第三態,migrate+reconciler 都跑、保住 SSRF guard prod 性質);記憶「e2e 跑 production」過時。證據:compose.e2e.yaml:48-56;backend Dockerfile:26。
- **instant outbox drain 預設 disarmed**(只在 production bootstrap 或 _armInstantDrainForTests arm)——新 outbox 測試要驗 performed 必須 arm。證據:outbox.ts:331-373,539-548。(原標 low,置此便於聚類)

### 其餘中優先(單條)
- **時區三鐘分裂**:前端本地日 / pg session 時區(day-lens+agenda CURRENT_DATE,碼註明刻意一致)/ Node UTC(taskScheduler today);due 存無 zone TEXT;docker 常 UTC→台灣使用者 08:00 前活動落「昨天」。證據:day.ts:59-61;dayNode.ts:8-11;taskScheduler.ts:38-44,87。→ NEW:day-node-conventions
- **Day-node 身分=名字即身分**:「非 hidden、title 或 slug 恰為 YYYY-MM-DD」跨四模組字串契約;改名/加 slug 靜默失去身分(lens/streak/mood 退役);doc 08 指名全部 vendored PKM 都避開此脆弱模式,attribute/class 身份從未採納。證據:dayNode.ts:1-6;day.ts:53-57;useNodeCreation.ts:94-110。→ NEW:day-node-conventions
- **loadServedSite 是兩公開面單一真相**(/api/site 與 /api/share/:token 都只回它;第三個公開面必須走它);**share token 只放大 audience 永不放大 content**(token mode 下 share 訪客仍要過 learner gate)、gate bypass=任何已認證 actor 非 admin-only。證據:publish.ts:183-186,207-221,173-182;share.ts:17-20。→ NEW:public-surface-security
- **BETTER_AUTH_SECRET 三階+OAuth opt-in**:prod 未設=自產 32-byte 持久化 content/.auth-secret(0600;砍 volume=session 全失效),明設 dev fallback 值 prod 拒啟(authSecret.test 釘);GitHub/Google OAuth per-provider opt-in(兩 env 都在才註冊),前端從 GET /api/auth/providers 拿 ids;POSTGRES_PASSWORD ${VAR:?} fail-fast;CORS default=APP_URL。structural-gaps/satisfaction-snapshot 相關條目 stale。證據:auth.ts:12-112;composeSecrets.test;commits 35772f7/b793c6e。→ NEW:auth-posture
- **authn default-deny 全域閘**:所有 API 含 GET 一律要 actor,唯一公開面=單一 middleware 明列 allowlist(/api/auth/*、/health、GET /api/site、GET /api/share/<token>、GET /api/media/*);新公開端點必改這一個 chokepoint;actor 解析序=bearer>cookie>native。證據:index.ts:173-209;commit 4ebb228。→ NEW:auth-posture
- **production 硬閘家族**:CORS * 拒 boot;dev 逃生 flag(SAFE_FETCH_ALLOW_PRIVATE、ALLOW_NATIVE_BYPASS)prod 一律硬封;NODE_ENV=test 跳過 migrate() 與 boot gate(所以 SAFE_FETCH 閘 key 在非 production 而非是 test)。證據:index.ts:79-113;safeFetch.ts:122-133;nativeBypass.ts:9-18。→ NEW:auth-posture(env/boot 段)
- **前端手設 Origin: http://localhost=native-origin admin bypass 掛鉤非死碼**(24 處 fetch;真瀏覽器忽略 forbidden header,只在 Capacitor/測試生效;prod 無條件 force-disabled)。證據:grep 24 處;index.ts:65-84。→ NEW:native-origin-bypass
- **review 模組三內部契約**:deck 無實體(=直接 parent 有 ≥1 張 #review 卡,due 只算直下、巢狀排除,雙重過 readableNodeIdSet);?now= 只在 NODE_ENV=test 生效(對 docker 用會被無聲忽略像 bug);_review_state 刻意不呼叫 dispatchAttributeChange(「複習後自動化」走 attr hook 是死路);parseReviewState 壞 JSON 靜默回 null=卡片無聲重置;?root= 子樹 session 刻意 newBudget=Infinity(別當 bug 修);deck 發現 direct-parent vs session scope 遞迴子樹=刻意不對稱。證據:modules/review/routes.ts:95-111,131-145,163-176,237-241,314-316;fsrs.ts:150-169;ReviewPanel.tsx:50-58。→ NEW:review-module-design
- **wikilink 靠 #wl: href sentinel 不能靠 className**(sanitize 剝 className 曾造成死鏈);block-ref 用 ?bid=;未解析 wikilink 刻意 click-to-create。**frontmatter 剝除必須是字串前處理**(remark-parse 會把 --- 下一行解析成 setext heading,寫成 remark plugin 會回歸)。**互動 checkbox=render 順序索引對齊 source 行掃描**(sanitizeSchema 特別 allowlist input checked;動 schema 或插 checkbox 增減 plugin 會錯行)。證據:MarkdownRenderer.tsx:293-305,341-356,265-267,509-511,233-259,411-431;sanitizeSchema.ts:37,42-46。→ NEW:markdown-render-security
- **搜尋 snippet <mark> HTML=XSS 面**:agent/RSS/匯入來源可夾敵意 HTML;契約=絕不 dangerouslySetInnerHTML(舊 renderer 曾用),必須 renderHighlightedSnippet 安全 walker;新 snippet 消費端(手機/site 搜尋)必沿用。證據:CommandPalette.tsx:61-85。→ NEW:search-dsl-pgroonga-contract(XSS 段)
- **pgroonga query syntax 隱藏能力+fail-soft**:自由文字原生支援 OR/-排除/"片語",畸形語法回 false 不 500;attr filter 註解與實作矛盾(same-key 多值註解說 OR、實作全 AND+UNIQUE(node_id,key)→永遠回空)。證據:nodeSearch.ts:46,65-78;searchQuery.ts:18,60-62。→ NEW:search-dsl-pgroonga-contract
- **兩查詢表面已漂移但分頁已出貨**:/api/query attribute sort 只有 raw-text lexicographic("10"<"9")、tags 按 title 等值不展開子孫;executeView 是 typed 三層 sort+含子孫——同 spec 不同結果;capability-map「500 無分頁靜默截斷」stale(offset+hasMore/nextOffset 都有)。證據:query.ts:63-138 vs collectionViewQuery.ts:52-160。→ onden-capability-map.md
- **edge_type 開放式 substrate + manifest planned 三保留槽**(parent/canvas_member/embed=未入 memory 的 roadmap 事實;未註冊 type accept-with-warn)。證據:edges.ts:30-46;edgeManifest.ts:1-16,87-112。→ onden-capability-map.md
- **media 攝取對等契約**:GET /api/media 刻意匿名公開,128-bit CSPRNG opaque 檔名=唯一防列舉屏障(token IS the capability;明文禁再嵌 timestamp/原檔名,mediaKey.test 釘);SVG=上傳 sanitizeSvg+服務 CSP sandbox 雙層;新檔案攝取路徑必鏡像三件套(authority 在落盤前+capFor+opaqueMediaName),import.ts 已照做直接 import 這三原語。證據:media.ts:15-28,124-132,146-170;import.ts:191-233;commits 6fd819e/4f31646。→ NEW:media-storage-posture
- **GitHub 備份兩軌模型**:writeAndCommit(容器本地 git)+pushNoteToBackup(每存檔推單檔 markdown 到遠端,兼 Actions 觸發面);設了 GITHUB_BACKUP_REPO 每筆存檔不論 _published 都推全文出境;真推送失敗必須 throw 才進 outbox retry;舊記憶 project_git_retire_roadmap superseded 且碼內引用懸空。另本地 simple-git content/ 鏡像層仍活著、2026-06-04 退役曾失敗回滾(c0ee306→0facd8a)。證據:githubBackup.ts:1-32,74-148;git.ts:1-30。→ NEW:github-backup-two-track
- **mobile roadmap skip-ahead 已被推翻(兩記憶互相矛盾)**:mobile roadmap P0④ 仍記「5xx skip-ahead 已出貨」,但 b0d082c 推翻(skip-ahead 破壞 create→edge 依賴序=data loss;現行=5xx 一律 break,連炸 6 次才 dead-letter);修正只記在 autonomous-loops:37。證據:commit b0d082c;兩 memory 對照。→ mobile-tablet-research-roadmap.md
- **觸控拖曳=long-press 啟動**:touch pointer 上 move-threshold drag start 活不下來(瀏覽器搶手勢發 pointercancel),useSidebarDrag 對 touch 用 long-press;照桌面 threshold 寫真機必壞且 harness 驗不出。證據:useSidebarDrag.ts:185,217,251。→ mobile-touch-scroll-traps.md
- **dogfood 生產 DB 使用剖面**:tag 僅 9 membership/4 tags(tag=capability 論述幾乎沒被行使)、真實重載=RSS(rss_staging 1729 篇/僅 1 save)、agent_tokens=10 但全是 06-01/02 建(之後一個月零新 token,MCP 近乎閒置)、publish_snapshots=49=發布真用、live nodes=66。註:另一掃描報 agent_tokens=0 是錯的。證據:docker exec psql 實測。→ NEW:dogfood-usage-snapshot
- **convergence-plan P0 deferred 安全清單只存在 doc 一行,至少兩項仍開**:svgSanitize 完全沒處理 <style>/@import(發布 SVG 可 CSS 外連 exfil)、index.ts 無全站 secure-headers(nosniff 僅 media.ts)、better-auth 無 rate limit;7e5b700 只補了 CSP 一角。backlog 安全殘留節沒收。證據:convergence-plan.md:62;svgSanitize.ts grep;index.ts。→ backlog.md
- **D3 明文否決 staged pipeline UI**(lens strip 必須 flat,推翻 02-maturity-loop);settled roadmap item 7 只出貨一半(hidden→maturity 置換 README 明記 remains open)。證據:00-decisions.md:62-66;README.md:209-211。→ frontend-redesign-decisions.md
- **class_tag 的 markdown body 是刻意留下的 dead surface**(後端回傳 body because class_tag IS a node;前端聚焦開 schema lens 永不進 editor;doc 04 建議 #1=class 可撰寫主頁)。證據:04-tag-as-node.md:37,45;BuilderApp.tsx ~1396-1402。→ frontend-redesign-decisions.md
- **showcase 雙來源快照陷阱**:GitHub Pages 展示站建自 committed intro-site.json 快照;改 introSite.ts 必須對運行實例跑 npm run snapshot-intro-site 重抓 commit,且 workflow paths 不含 introSite.ts=連 redeploy 都不觸發。證據:deploy-static-site.md:43-56;deploy-site.yml:3-27。→ dogfood-official-site.md
- **sql.js wasm vendored 版本鎖**:public/sql.js/ 兩 wasm 須與 npm sql.js 手動同步(現 md5 一致 1.14.1),無 postinstall 自動同步——升級錯配=整條 localDb 掛。與 pdfjs 宿主/Fraunces woff2 同類。證據:md5sum 三檔同 hash;localDbWorker locateFile。→ NEW:vendored-asset-version-locks
- **clone 清單盲區**:2026-06-20 的 8 個 MCP/AI-native 筆記 app clone(hillnote/hjarni/zennotes=MIT、inkdrop/voiden=Apache-2.0、vmark=ISC、helixnotes=AGPL 只學設計、scratch-erictli 無 LICENSE)零記憶覆蓋;clone/claw-code-main=自稱外洩 Claude Code harness 檔案庫,無 LICENSE 且性質敏感——明記「僅存在、勿抄」或刪除;且全部 clone 已搬到 repo 根 /clone/(competitor-app-survey「under onden/」找不到)。證據:stat mtime;LICENSE 實測;commits 7a9746f/cb43db1。→ license-gate-clones.md
- **ink_data 單一 key 兩宿主格式**(PDF 多頁 envelope vs 手寫單一 InkDocument,靠 parseMultiPageDoc 判別);**palm rejection 實作=tldraw 式終身閂鎖非記憶記的 500ms 啟發式**(用過筆後手指畫不出=by-design);**PDF ink commit 刻意丟壓感**(與壓感一等資產框架反向);**多頁手繪 session=registry 跨頁存活+zoom 觸發強制 commit(單 group 永不混 scale)**。證據:OverviewEditor.tsx:224;engine.ts:93-103,278-295;drawSession.ts:1-27,44-51。→ handwriting-direction.md + NEW:pdf-annotation-rails
- **settings/registry.tsx=前端唯一模組註冊點 + applyPersistedSettings 開機重放契約**(重放走 def.get() 非 localStorage.getItem(def.id),theme.mode 持久 key≠id;custom widget 不被重放要自套;新模組設定/widget 掛這裡別另開表面)。證據:registry.tsx:19-21,515-546,701;main.tsx:16;AppRoot.tsx:11。→ NEW:settings-registry
- **BuilderApp 開機契約**:閘順序=ServerSetup 已改 opt-in(同源 /api 預設)→AUTH→StorageSetup(LoginGate 內 post-auth),native 跳過;FS-Access 資料夾儲存(pref localStorage onden-storage-pref、handle 存 IDB、onden.sqlite3;Settings UI 標「OPFS」與實作 IndexedDB 不符);landing=today/home/resume,deep link 一律贏,resume 必須在 state 初始化器搶讀 onden.lastLocation(effect 裡讀已太遲)。證據:BuilderApp.tsx:136-189,772-822;fileSystemStorage.ts:1-30。→ NEW:builderapp-boot-contracts
- **inbox feed-traffic 升級已出貨**(8d39544):?actor_id/?event_type/?since、root_event_id(walk 上限 20)、共根收合 groups、facets;/groups/:root/approve|reject 整鏈審批;quirk:掃描窗固定 500 非 limit;group-reject cascade:false vs 單筆/batch cascade:true=刻意不對稱。證據:inbox.ts:176-243,357-476,446 vs 576/695。→ inbox-governance.md
- **PDF 上傳全文抽進 body=RAG 可見性唯一來源**(extractPdfText;加密/掃描/壞檔回空=該 PDF 對搜尋永久隱形無警告)。證據:OverviewEditor.tsx:413-425;commit 17ae508。→ onden-has-rag.md
- **80ms capture-speed 是明文 thesis 級效能預算**(a2TimingSmoke:median PATCH<80ms+dispatcher cascade 不在 critical path)。證據:a2TimingSmoke.ts:74-75。→ note-use-cases.md
- **嵌套 lockfile 是死的**(packages/*/package-lock 凍在 e39e735;docker 與 npm ci 只用 root lock);**自訂 postgres image**:pgvector 0.8.2-pg18+PGroonga(bookworm apt 釘死)+Apache AGE 從源碼 build 且 compose 掛 preload——但全 src 零 ag_catalog/cypher 使用=白揹重 build 死依賴;釘版漏網:frontend node:22-alpine、e2e nginx:alpine 浮動。證據:git log lockfile;docker/postgres/Dockerfile:1-30;grep 零命中。→ ci-and-migrations.md
- **Tasks quick-add 短語法+token chips(66ebc48)**:captureSyntax 升為雙表面共用 parser(新 ignore/tokens API);QuickCapture 尚未接 chips,補齊時重用別另造;QuickCapture 只解析第一行(first line=command surface)。證據:captureSyntax.ts:28,94-111;TasksMode.tsx:229-235。→ ux-onboarding-batch-2026-06-22.md
- **QuickCapture 語音口述已出貨**(Web Speech API,b669955;backlog/mobile-roadmap 反向框成「缺、需原生」);**筆記模板 registry 已出貨**(純資料 registry+{date} idempotent-by-title,走既有 rails);**#toread 閱讀佇列已出貨**(schema-less name-based label,同 #task 改名脆弱);**license 已拍板 MIT**(product-thesis「AGPL vs permissive still open」「non-commercial」皆與 LICENSE/package.json/licenseDeclared.test 不一致);**human auth baseURL 陷阱**(authClient baseURL 必須站點 origin 非 /api prefix,否則 /api/sign-in/email 401)。證據:QuickCapture.tsx:14-93;noteTemplates.ts:1-28;NodeInspector.tsx:219-233;LICENSE/package.json:4;auth-client.ts:4-25。→ onden-capability-map.md / product-thesis.md / NEW:auth-posture
- **allow_indexing=false 只擋 robots meta,sitemap 照常枚舉全站 slug**(index toggle 不是隱匿機制)。證據:sitemap.xml.ts:1-5 檔頭。→ onden-capability-map.md
- **CSS 次要慣例**:正典手機斷點 900px(CSS 15 處+TS matchMedia 重複硬寫無常數);--onden-text-* 全是 base font-size 的 calc 比例(寫死 px 破壞 Settings 縮放);動效走 --onden-motion-*;CJK 永不 bundle(靠 --onden-cjk 系統字列,別 vendor CJK woff2)。證據:theme-tokens.css:342-405;fonts.css:10-12;global.css:422-439。→ NEW:frontend-css-conventions
- **ink 兩套 shape 已拍板「合理分離、可不做」**(4c1c0da rescope;backlog/convergence-tracks 仍列開放債會白做)。證據:convergence-plan.md:272。→ backlog.md

---

## 低優先(一行一條)

- Task API 形狀 FROZEN 在退役 node_tasks 契約、062 重用舊 id,別「現代化」(tasksStore.ts:19-22)→ onden-capability-map.md
- 月週期 recur setUTCMonth 無月底 clamp:29-31 號重複任務靜默漂移(taskScheduler.ts:63)→ onden-capability-map.md
- Day-lens 四桶三條刻意設計(attr churn 不算 edited/agent 桶重疊/created dedupe),別當 bug 修(day.ts:16-24)→ NEW:day-node-conventions
- Postgres 無 year-0000:'0000-01-01'::date 直接 throw,日期參數要 round-trip+字典序兜底(day.ts:80-85)→ NEW:day-node-conventions
- isSystemNode 前後端雙胞胎手抄(day.ts:42-51),capability-map 漂移清單沒列這對 → onden-capability-map.md
- Dispatcher 鏈終止=MAX_DEPTH 6+visited 三元組,靜默抑制;無 tag 掛 hook 時跳過授權檢查(tagDispatcher.ts:53,62-64,296-314)→ tag-module-contract.md
- Dispatcher 未知 handler kind fail-soft 靜默 no-op(registry.ts:38-55),capability-map「dispatch 時爆」誤導 → onden-capability-map.md
- 上傳允許清單已擴音訊/視訊/office+分級 cap(圖50/pdf音訊200/視訊500MB;media.ts:30-83)→ onden-capability-map.md
- actors.ts 治理契約群:roster owner-only+反探測早閘+不能自升/自刪+phantom no-op+TOKEN_* 事件無機密(actors.ts:13-19 等)→ principal-authority.md
- backlog「scoped_tag_ids 零寫入路徑待決」已 stale:POST/PATCH 三態+驗證+epoch bump+專屬測試齊(actors.ts:51-100)→ backlog.md
- CSV 匯入屬性 source='explicit' 刻意取捨(無 'import' source;import.ts:529-538)→ architecture-debt-2026-06-14.md
- bookmark v1 只抓 metadata、regex 不引 Cheerio;特殊節點=well-known attribute marker 慣例(bookmark.ts:8-24)→ onden-capability-map.md
- approved publish_site 在 drain 時建 snapshot(內容取批准當下 _published 集)——agent-extensibility 的 staleness careful-spot 已 resolve(outbox.ts:192-298)→ agent-extensibility-and-approval.md
- roles.ts rank 雙 fallback 慣例(roleRank=?? 0 地板;admin gate 必須自己 ?? -1)只活在檔頭(roles.ts:1-27)→ read-gate-chokepoint.md
- NODE_UPDATED 還原涵蓋 parent_id 且只 emit 真還原欄位(restore.ts:628-649;f177fe0)→ restore-state.md
- rating 欄位有真 validator+星星 widget 非空殼,convergence-tracks 盤點錯(schemaValidation.ts:50-59)→ onden-convergence-tracks.md
- tag 名字元集與 dispatcher attr-key 字元集刻意耦合(tagPacks.ts:61-65)→ tag-module-contract.md
- 發布站 per-page layout 掛 title==='page' 的 class_tag,改名=全站 layout 靜默失效(collections.ts:37-71)→ onden-capability-map.md
- 發布端 KaTeX 刻意自寫 lite 版(sanitize 後跑、保 byte-equal drift-test;math.ts:1-17);前後端 katex major 分裂 0.16 vs 0.17 → onden-capability-map.md
- migration 064 重號合法(version key=完整檔名)+ migrate() 每 boot ON CONFLICT 補種 default workspace/System actor(db.ts:156-173)→ ci-and-migrations.md
- inline attr `key:: value` 刻意要求空格、與 Logseq 分岔;fenced code 不掃(utils.ts:43-77)→ tag-unification-decision.md
- template `_tpl_origin` 冪等標記+移除 tag 不刪 spawned children(026 migration:12-19)→ tag-module-contract.md
- Anthropic key 優先序=DB 蓋 env;maskApiKey ≤8 字元只回「...」(appSettings.ts:3-6)→ onden-capability-map.md
- edgeManifest 是新 edge 型別唯一註冊點(重複註冊 throw;edgeManifest.ts:1-40)→ onden-capability-map.md
- mermaid securityLevel:'strict' 鎖死+暗色三層判定;YouTube/Vimeo 只在裸連結才升級 iframe,有 label 保持普通連結(MarkdownRenderer.tsx:148-191,384-392)→ NEW:markdown-render-security
- edge 換型=刪除+重建(unique index 語意;BuilderApp.tsx:1818-1827)→ NEW:edge-model-quirks
- graphMutations.importRss 離線靜默 no-op,與已離線化的 RssReaderPanel 平行雙軌(graphMutations.ts:95)→ offline-sync-decision.md
- queryCache=刻意極小查詢層,長大就換 TanStack Query,新 GET 走此 chokepoint(queryCache.ts:1-6)→ offline-sync-decision.md
- idbSave 失敗事件發在 worker self、主執行緒收不到+全 app 無消費者=雙重未接線 TODO(indexedDbStorage.ts:28-56)→ backlog.md
- getApiBase 自動清同 hostname 不同 port 的 stale override;優先序=localStorage onden_api_base>build-time PUBLIC_API_BASE_URL(api.ts:319-380)→ insecure-context-crypto-trap.md
- pinned tag views:pin 刻意存 localStorage 不進後端;同 tab 同步靠自訂 CHANGE_EVENT(usePinnedTagViews.ts:1-14)→ frontend-redesign-decisions.md
- Sidebar Sort「Created date」是 no-op 死選項(comparator return 0;OverviewSidebar.tsx:240),bug-tracker 未收 → silky-audit-punchlist.md
- removePageBorders:true 是全部 legacy pdf 註解幾何對齊前提(PdfViewerHost.tsx:25-29)→ NEW:pdf-annotation-rails
- lib/pdf 必須零 pdfjs import(pdfjs6 需 DOMMatrix、jsdom 沒有;coords.ts:1-3)→ NEW:pdf-annotation-rails
- 跨頁文字選取刻意 clamp 到第一頁(capture.ts:121-136)→ NEW:pdf-annotation-rails
- ink_data legacy 空 rects quirk 靠 boundingRect fallback 修復,新讀者(尤其發布端)要複製(PdfHighlights.tsx:62-66)→ NEW:pdf-annotation-rails
- #review membership 可能在 class_tag_ids 或 label_tag_ids,消費端必須雙軌查(NodeInspector.tsx:260-304)→ onden-capability-map.md
- publish 控制單一入口=NoteActions Share popover(inspector 複製版曾漂移已收斂;NodeInspector.tsx:211-217)→ frontend-redesign-decisions.md
- 事件 actor_type 原始值='ai_agent' 非 'agent'(NodeInspector.tsx:520-521)→ inbox-governance.md
- iOS 相機膠卷唯一插圖路徑=工具列隱藏 file input,別當桌面冗餘砍(OverviewEditor.tsx:94-107)→ mobile-tablet-research-roadmap.md
- /pdf-spike 舊 spike 頁殘留可清理(PdfViewerSpike.tsx+pdf-spike.astro)→ backlog.md
- palette 已是 Fuse.js 模糊+三前綴(>/#/?)+lastRun recency,capability-map「只 substring」stale(useCommandPalette.ts:233-284)→ onden-capability-map.md
- 發布站色彩客製=accent 單 token,全 palette 客製刻意等 published-CSS 變數化(palettes.ts:1-10)→ site-builder-direction.md
- 資料夾匯入 upsert 預設 ON(match by title=progressive pull 非 fork;registry.tsx:215-217)→ onden-capability-map.md
- TagsMode 已退役:tagpack import 在 Settings→Your Data、export 在 tag node schema lens(registry.tsx:348-357)→ onden-capability-map.md
- Studio「Delete page」實為 hidden:true 軟藏非 trash;「page」有兩個不同 predicate(useWebsiteMode.ts:268-275 vs WebsiteStudio.tsx:72)→ site-builder-direction.md
- SSR /site 靠 SSR_API_URL,漏設靜默 fallback localhost→全站 'Site unavailable'([slug].astro:13;compose.yaml:78)→ site-builder-direction.md
- PUBLIC_API_BASE_URL 必須 build-arg 空字串,烤進 /api 產生 /api/api(compose.yaml:68-73 記錄事故)→ NEW:auth-posture(deploy 段)
- nginx /api/ client_max_body_size 20m 是上傳硬上限(後端零線索);/_astro/ 1 年 immutable(nginx.conf:45-68)→ NEW:auth-posture(deploy 段)
- deploy-site.yml 只認 intro-site.json 等 paths,只改 introSite.ts 連 redeploy 都不觸發(deploy-site.yml:3-27)→ dogfood-official-site.md
- 日記 mood(普通 node_attribute 5 emoji)+streak(純計算零持久化)已出貨(moodStreak.ts:1-27)→ onden-capability-map.md
- 系統節點藏匿慣例:workspace-config class_tag attrs / source_type='system' + isSystemNode 過濾,新 app 自用節點照走(systemNodes.ts:1-10)→ onden-capability-map.md
- packages/frontend/docker/nginx.conf 是死檔(容器實跑 Astro SSR node server),可刪 → backlog.md
- frontend pretest「48 DB suites SKIPPED」警告是搬家殘骸(script 不存在)→ e2e-verification.md
- 後端 scripts/ 四支 smoke 對 live dev DB 跑=刻意例外;NODE_ENV=test gate serve()+app.request() 是寫 smoke 標準手法(bMcpSmoke.ts:19-23)→ e2e-verification.md
- mental-model v2 deferred infra 兩 guardrail:span-citation 管線落地前不做 span 精度 UI;reactive read-axis 只騎 /api/query 單軌(roadmap-v2:130-132)→ mental-model-corrections.md
- MEMORY.md 索引行過期:offline-sync-decision 正文已詳記 07-01/02 批次,索引仍寫「剩 3 缺口」;正文另記未修 bug(canvas 事件 target_type='canvas' 漏過 sync.ts ==='node')→ offline-sync-decision.md(刷索引行)
- _review_state 繞過 dispatch 是設計豁免,attr-provenance 工作別當 bug(routes.ts:314-316)→ architecture-debt-2026-06-14.md
- boundarySweep 品質契約:敵意 wellformed 輸入乾淨 4xx,central onError 映射,別手包 parse(boundarySweep.integration.test:1-25)→ audit-sweep-2026-06-13.md
- scoped review 刻意 bypass 每日新卡預算(reviewScope.spec:1-5)→ onden-capability-map.md
- 新 AppMode 必須進 useUrlLocation VIEWS allowlist(rss/review 各漏過一次;f4e1488)→ mobile-nav-two-axis.md
- 桌面左側 nav rail 已出貨(鏡射手機底欄;Read/Review 是 action-panel 非 AppMode,active 態 key off activePanel;fde778c)→ mobile-nav-two-axis.md
- stateGallery.spec 全 UI 狀態截圖矩陣工具存在(dark/light×en/zh-TW×lens),視覺總審別重造(011aca4)→ frontend-self-verify.md
- 根 package.json overrides pin React 19.2.7 防 dual-React(zustand peer 曾拉第二份 React 18;d086a8e)→ NEW:monorepo-react-pin(或 ci-and-migrations)
- GITHUB_PAGES_TOKEN/GITHUB_BACKUP_TOKEN 最小權限拆分,fallback GITHUB_TOKEN(8c74696)→ publishing-priority.md
- Canvas mindmap auto-arrange(treeLayout+palette a-arrange-tree)是活能力,capability-map canvas 域漏列(347e315)→ onden-capability-map.md
- instant outbox drain / fs-access 誤標 OPFS / settings registry 等已併入中優先對應條目。

---

## 建議新開的記憶檔(NEW:slug 聚類)

多路掃描提案的 NEW slug 有重疊,建議合併成以下 **17 檔**:

1. **public-surface-security** — 合併 public-surface-security / public-surface-csp / published-surface-csp / published-csp-posture / published-site-csp-contract / published-csp:siteConfig 秘密+overlaySiteConfig allowlist、loadServedSite 單一真相、share token×learner gate 組合、7e5b700 CSP 縱深批次(含 ga4 hash 契約、刻意不改的 canvas iframe)、publishedCsp.test。
2. **publish-static-freshness-contract** — 靜態產物凍結原樣、撤權不 republish、redaction 必須進 snapshot builder。
3. **media-storage-posture** — 媒體第三存儲軌(off-spine/永無 GC/purge 升格可讀/webp re-encode)+ 匿名公開+opaque capability URL+SVG 雙層+攝取三件套對等契約。
4. **authz-write-read-asymmetry** — write_node 不蘊含讀權、跨節點引用雙邊模板、404 姿態(與 read-gate 寫側條目相互引用)。
5. **db-tx-discipline** — withTransaction 重入 JOIN、syncBlockIds 死鎖事故、poisoned eviction、txHooks(collections.ts stale 註解警告)。
6. **workspace-tenancy-boundary** — 合併 single-tenant-rls-posture / single-tenant-workspace:不用 RLS 取捨、getWorkspaceId 釘死點、workspaceBoundary lint-test。
7. **auth-posture** — 合併 auth-posture / human-auth-stack / authn-public-allowlist / selfhost-security-posture / selfhost-deploy-posture / prod-boot-guards / env-flag-posture:BETTER_AUTH_SECRET 三階、OAuth opt-in、全域 default-deny allowlist、production 硬閘家族、native-origin bypass(可含 NEW:native-origin-bypass)、compose/nginx/PUBLIC_API_BASE_URL 部署陷阱。
8. **app-i18n-two-layer** — 合併 app-i18n-layer-b / app-i18n-two-layers / i18n-two-layer:雙層架構、t()/useT() 紀律、identity tokens、已知漏譯區、無 lint 閘的回歸風險。
9. **module-seam-contract** — 模組 seam 硬契約+capability-tag self-heal 姿態(capability-tag-self-heal 可折入此檔或 tag-module-contract)。
10. **markdown-render-security** — iframe host allowlist、data: urlTransform、wikilink #wl: sentinel、frontmatter 字串前處理、checkbox 索引契約、mermaid strict/bare-URL。
11. **search-dsl-pgroonga-contract** — 合併 search-snippet-xss-posture:snippet text[]/span 漂移 bug、<mark> XSS 姿態、pgroonga query syntax fail-soft、attr filter 矛盾。
12. **pdf-annotation-rails** — 雙軌 lockstep、highlight→card 欽定模式、drawSession zoom 不變量、removePageBorders、lib/pdf 純模組、跨頁 clamp、ink_data 判別+空 rects quirk、PDF 丟壓感。
13. **day-node-conventions** — 合併 day-node-string-identity:名字即身分、三鐘分裂、lens bucket 取捨、year-0000 guard。
14. **builderapp-boot-contracts** — share-target 消費順序、閘順序、landing/resume 搶讀、FS-Access 儲存。
15. **frontend-css-conventions** — token 契約(短名 alias 禁用)、z-index 階梯、900px 斷點、calc 型階、CJK 不 bundle;可併入 ime-composition-guards(IME 鐵律)與 settings-registry(前端唯一註冊點+開機重放)成一個「前端慣例」叢,或各自獨立小檔。
16. **ops-backup-restore** — 合併 ops-floor:backup/restore 腳本(從未實跑警告+三陷阱)、logger。
17. **零散小檔(可各一行併入既有記憶代替新開)** — tag-slug-cjk-trap(或進 bug-tracker)、tag-merge-design(或併 tag-module-contract)、review-module-design、node-route-contracts+zod-partial-default-trap(可合一「backend route 契約」檔)、github-backup-two-track(或併 effects-discipline)、dogfood-usage-snapshot、vendored-asset-version-locks、edge-model-quirks、monorepo-react-pin、frontend-api-base-resolution(可併 insecure-context-crypto-trap)。

**優先落檔順序建議**:先修三個真 bug 進 bug-tracker(SettingsModal theme / chrome blocks / learner deep-link)+ 兩個真讀洩漏(collections read gate / canvasMemberships)進 read-gate-chokepoint;再改五個「主動錯誤」記憶(agent-extensibility、onden-has-rag、structural-gaps、site-builder-direction、architecture-debt);NEW 檔按 1(public-surface-security)、7(auth-posture)、8(i18n)、12(pdf-annotation-rails)先開——這四叢是「零覆蓋+高踩雷頻率」交集。