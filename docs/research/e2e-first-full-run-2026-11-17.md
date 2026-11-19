# 完整端對端測試第一次補跑：紅的清單（2026-11-17）

> 狀態：歷史紀錄（寫於 2026-11-17）。公開庫 ci.yml run 44074610697，main `fe370e44a`，`-f fullstack=true`。

完整端對端測試從 2026-11-15 檢查搬到公開庫起沒有跑過（要帶 `-f fullstack=true`，沒有人帶；見 [mistakes.md](../agents/mistakes.md) 2026-11-17 那一筆）。
這是第一次補跑的結果，給修正的工作當起點。每一條下面是記錄檔裡的頭幾行錯誤訊息，**只是線索，不是結論**。

每一條的答案必須是三種之一，附證據：
(a) 測試過時——產品是故意改的（指出 commit 或 PR，引用說明它的文件或更新說明）；讓測試跟上現在的行為，保留它原本要保護的東西。
(b) 產品壞了——指出弄壞它的 commit，寫一個最小的單元或整合測試以同樣的原因失敗，依「一類問題一個機制」修產品，並說明還有誰共用這個原因。
(c) 環境或測試順序——讓測試變成確定的，並說明原本不確定的是什麼。
不准：重試、加長等待、skip、`.fixme`、把斷言放寬到通過、刪掉測試。判斷不了就讓它紅著，寫清楚看到了什麼。

## 每個工作的結論

| 工作 | 結論 | 失敗／通過／跳過 |
| --- | --- | --- |
| Guard lane、Backend 單元、真 Postgres 1–4、Pairing/relay、Critical-path E2E | success | — |
| Frontend 單元 | failure | 9509 個測試通過，1 個未處理的錯誤（`touchHold.ts:85`，`window is not defined`） |
| Full-stack chromium 1/4 | failure | 1／112／6 |
| Full-stack chromium 2/4 | failure | 4／108／4 |
| Full-stack chromium 3/4 | failure | 11／102／3 |
| Full-stack chromium 4/4 | failure | 37／70／9 |
| Full-stack cross-engine | failure | 4／37／15 |
| Full-stack faults | failure | 8／8／0 |

共 65 個端對端測試失敗。

## chromium 1/4

```text
  1) [chromium] › fullstack/calendar-nav.spec.ts:40:5 › calendar layout: a dated row lands on its day cell; prev/next month navigates 
      Error: expect(locator).toHaveText(expected) failed
      Locator:  locator('.cv-cal').locator('.cv-cal-cell').filter({ has: locator('.cv-cal-chip').filter({ hasText: 'Launch 1794915329925' }) }).locator('.cv-cal-daynum')
      Expected: "15"
```

## chromium 2/4

```text
  1) [chromium] › fullstack/i18nVisual.spec.ts:7:5 › language setting switches app chrome to zh-TW live 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for locator('.account-dialog').getByRole('button', { name: /^(Settings|設定)$/ })
  2) [chromium] › fullstack/inkFingerTools.spec.ts:171:7 › handwriting page tools (phone, 390×844, touch) › toolbar: one row, tools first, Hand is a tool, no finger toggle, undo/redo reachable 
      Error: expect(received).toEqual(expected) // deep equality
      - Expected  - 0
      + Received  + 4
  3) [chromium] › fullstack/mobileBackScroll.spec.ts:9:5 › mobile: Back from a note returns the list to its scroll position @critical 
      Error: expect(received).not.toBe(expected) // Object.is equality
      Expected: not ""
  4) [chromium] › fullstack/navigationMenuParity.spec.ts:111:5 › desktop shows the core pages and the imported modules' pages; the phone More sheet opens the shared destinations 
      Error: expect(locator).toHaveText(expected) failed
      Locator: getByRole('dialog', { name: '更多', exact: true }).locator('.mobile-more-grid .mobile-more-group').first().locator('.mobile-more-items button')
      Timeout: 15000ms
```

## chromium 3/4

```text
  1) [chromium] › fullstack/perf.spec.ts:44:7 › performance › lens-switch interaction latency
      TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
      - waiting for locator('.view-tabs [role=tab]:has-text("Canvas")') to be visible
  2) [chromium] › fullstack/personas.spec.ts:66:5 › writer: a drafted post with a wikilink publishes and is publicly readable 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for locator('.info-fn-idle').filter({ hasText: /^(Website|網站)/ }).getByRole('button', { name: /^(Publish|發布)$/ })
  3) [chromium] › fullstack/personas.spec.ts:97:5 › project manager: tasks partition into overdue, today, and unscheduled buckets 
      Error: expect(locator).toBeVisible() failed
      Locator: getByRole('tabpanel', { name: /^Today/ }).getByRole('region', { name: 'Not scheduled yet' }).getByRole('group', { name: /^Left over from earlier days/ }).locator('.tk-row').filter({
      Expected: visible
  4) [chromium] › fullstack/rssReader.spec.ts:78:5 › rss loop: subscribe → fetch lands in staging → read → highlight becomes an excerpt in a note → same passage is recognised → next 
      Error: expect(received).toMatch(expected)
      Expected pattern: /^My notes\.\n\n> Highlightable sentence \d of run 1794915536870\.\n>\n> — \[[^\]]+\]\([^)]+#:~:text=[^)]+\)[^\n]*\n> \^[A-Za-z0-9-]+/
      Received string:  "My notes.·
  5) [chromium] › fullstack/scaleIntegrity.spec.ts:65:5 › 5k-node workspace stays intact: no loss, slim→hydrate, search, export, backlinks 
      Error: export missing entry for scaleint-container 1794915564907
      Expected value: "scaleint-container-1794915564907.md"
      Received array: ["Recovery deck 1794915505328/503 grade 1794915505328.md", "About 1794915431751.md", "ACME deal 1794915481504.md", "Basics Note 1794915344303.md", "Shelf 1794915336365/Book 1
  6) [chromium] › fullstack/sidebarDragSpringOpen.spec.ts:51:5 › desktop: stay over a folded note → it opens; drop inside keeps only that path open 
      Error: expect(locator).toHaveAttribute(expected) failed
      Locator:  locator('[data-sb-id="f791131e-bb12-4c2e-82ca-fb14bf78d5c2"]')
      Expected: "true"
  7) [chromium] › fullstack/siteStudioHome.spec.ts:72:5 › drag 一篇筆記 from 區塊 onto the home page, choose the note on the right: it shows that note, and is saved 
      TypeError: Cannot read properties of null (reading 'x')
  8) [chromium] › fullstack/siteStudioHome.spec.ts:96:5 › change a tag view: pick a tag, change how it is shown, and the canvas follows 
      Error: expect(locator).toBeVisible() failed
      Locator: locator('.hs-canvas__frame').locator('.s-view').last()
      Expected: visible
  9) [chromium] › fullstack/siteStudioHome.spec.ts:167:5 › publish with a note that is not published: the review lists it and 一起發布 publishes it together 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for getByRole('tabpanel').getByRole('button', { name: /Draft on home 1794915795167-1/ })
  10) [chromium] › fullstack/subtreePublish.spec.ts:14:5 › '+ subtree' cascades publish to every descendant of the note 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for locator('.info-fn-idle').filter({ hasText: /^(Website|網站)/ }).getByRole('button', { name: /^(Publish|發布)$/ })
  11) [chromium] › fullstack/subtreePublish.spec.ts:45:5 › '+ subtree' is absent for a leaf note (no descendants) 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for locator('.info-fn-idle').filter({ hasText: /^(Website|網站)/ }).getByRole('button', { name: /^(Publish|發布)$/ })
```

## chromium 4/4

```text
  1) [chromium] › fullstack/embedEditSheet.spec.ts:11:5 › phone: tap an embed -> sheet -> edit -> close -> embed and source note have the new text 
      Error: expect(locator).toContainText(expected) failed
      Locator: locator('.cm-embed .md-transclusion-body')
      Timeout: 20000ms
  2) [chromium] › fullstack/mobileEditor.spec.ts:13:5 › mobile: Enter breaks lines in the editor; checkbox lines continue 
      Error: expect(locator).toHaveCount(expected) failed
      Locator:  locator('.quick-capture-overlay')
      Expected: 0
  3) [chromium] › fullstack/tagMembershipJourney.spec.ts:5:5 › configure a tag, apply it without losing the note, and remove only this note's membership 
      Error: giving the tag review
      Expected: true
      Received: false
  4) [chromium] › fullstack/todayChanges.spec.ts:82:5 › a tag that holds functions shows them on its page, and none otherwise 
      Error: giving the tag review
      Expected: true
      Received: false
  5) [chromium] › fullstack/tokenMint.spec.ts:22:5 › issue and revoke a key through Spaces and members 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for getByRole('button', { name: 'Revoke', exact: true })
  6) [chromium] › fullstack/uxP0.spec.ts:101:5 › F6: a card made by double-clicking the board takes typing in its title 
      Error: expect(locator).toBeVisible() failed
      Locator: locator('.card-node-title-input:focus')
      Expected: visible
  7) [chromium] › fullstack/zzAuditEditor.spec.ts:64:5 › PDF-01: import a PDF from the sidebar, it renders and survives reload 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for getByRole('button', { name: 'Create new node' })
  8) [chromium] › fullstack/zzAuditEditor.spec.ts:100:5 › PDF-02: text selection → card and Alt+drag area capture keep page + source 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for getByRole('button', { name: 'Create new node' })
  9) [chromium] › fullstack/zzAuditProbes.spec.ts:56:5 › HIST-10: empty trash purges only the named trashed notes; a live note is skipped 
      SyntaxError: Unexpected non-whitespace character after JSON at position 4 (line 1 column 5)
  10) [chromium] › fullstack/zzAuditTokens.spec.ts:97:5 › AI-08 + TOKEN-03: agent stats separate success/failure; soft revoke refuses 
      TypeError: Cannot read properties of undefined (reading 'id')
  11) [chromium] › fullstack/zzDeepAi05.spec.ts:18:5 › AI-05: inbox facets, empty, volume, failure and phone 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for locator('.obsidian-sidebar').getByText('Inbox', { exact: true }).filter({ visible: true }).first()
  12) [chromium] › fullstack/zzDeepCan01.spec.ts:28:5 › CAN-01: board create / rename / delete through the UI 
      Error: locator.click: Timeout 1000ms exceeded.
      - waiting for getByRole('menu', { name: /^(More|更多)$/ }).getByRole('menuitem', { name: 'Canvas', exact: true })
      - Timeout 15000ms exceeded while waiting on the predicate
  13) [chromium] › fullstack/zzDeepCan05.spec.ts:8:5 › CAN-05: undo vs later remote move; board switch during save 
      Error: locator.click: Timeout 1000ms exceeded.
      - waiting for getByRole('menu', { name: /^(More|更多)$/ }).getByRole('menuitem', { name: 'Canvas', exact: true })
      - Timeout 15000ms exceeded while waiting on the predicate
  14) [chromium] › fullstack/zzDeepCol01.spec.ts:9:5 › COL-01: view CRUD via API vs UI, delete active/last, create failure, reopen, phone 
      Error: expect(locator).toBeVisible() failed
      Locator: locator('.cv-root')
      Expected: visible
  15) [chromium] › fullstack/zzDeepCol02.spec.ts:8:5 › COL-02: multi-sort, compound filter, partial PATCH, builder offline/503, phone 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for locator('button[title="Filter, sort and group this view"]')
  16) [chromium] › fullstack/zzDeepCol06.spec.ts:9:5 › COL-06: calendar date change, year boundary, undated, crowded day, timezone, reopen, phone 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for locator('.cv-layout-btn').filter({ hasText: 'Table' })
      83 |     await page.waitForTimeout(800);
  17) [chromium] › fullstack/zzDeepFind04.spec.ts:12:5 › FIND-04: backlinks follow saves, removal, caret handoff and phone 
      Error: expect(received).toBe(expected) // Object.is equality
      Expected: 1
      Received: -1
  18) [chromium] › fullstack/zzDeepHist02.spec.ts:7:5 › HIST-02: phone filters and same-query failure 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for locator('.tl-tab').filter({ hasText: 'Events' }).filter({ visible: true }).first()
  19) [chromium] › fullstack/zzDeepHist04.spec.ts:28:5 › HIST-04: phone restore
      Error: expect(locator).toBeVisible() failed
      Locator: locator('.ov-history-open').filter({ visible: true }).first()
      Expected: visible
  20) [chromium] › fullstack/zzDeepHist04.spec.ts:48:5 › HIST-04: two notes restored concurrently from two tabs 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for locator('.ov-history-open').filter({ visible: true }).first()
  21) [chromium] › fullstack/zzDeepHist05.spec.ts:9:5 › HIST-05: preview target stable across merged saves and offline 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for locator('.ov-history-open').first()
  22) [chromium] › fullstack/zzDeepHist08.spec.ts:13:5 › HIST-08: subtree restore, offline restore, retry, permissions, phone 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for locator('.tl-tab').filter({ hasText: 'Trash' }).filter({ visible: true }).first()
  23) [chromium] › fullstack/zzDeepNav02.spec.ts:18:5 › NAV-02: lens availability, deep links, refresh and back/forward 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for locator('.view-tabs [role=tab]:has-text("Canvas")')
  24) [chromium] › fullstack/zzDeepNav03.spec.ts:9:5 › NAV-03: back across wikilink / search / graph, scroll restore, phone 
      Error: locator.scrollIntoViewIfNeeded: Element is not attached to the DOM
      - waiting for element to be stable
      28 |   await page.waitForTimeout(500);
  25) [chromium] › fullstack/zzDeepNote09.spec.ts:21:5 › NOTE-09: palette mints each template with its scaffold and default tag, no carry-over 
      Error: expect(received).toContain(expected) // indexOf
      Expected substring: "Agenda"
      Received string:    "·
  26) [chromium] › fullstack/zzDeepRss04.spec.ts:29:5 › RSS-04: skip failure, counts, reopen, scope, shared state 
      Error: expect(received).toBeGreaterThanOrEqual(expected)
      Expected: >= 3
      Received:    0
  27) [chromium] › fullstack/zzDeepRss05.spec.ts:11:5 › RSS-05: save race, foreign node_id, lost response, deleted note, offline 
      Error: expect(received).toBeGreaterThanOrEqual(expected)
      Expected: >= 4
      Received:    0
  28) [chromium] › fullstack/zzDeepRss05b.spec.ts:9:5 › RSS-05b: reader save — lost response, offline, reopen 
      Error: expect(received).toBeGreaterThanOrEqual(expected)
      Expected: >= 2
      Received:    0
  29) [chromium] › fullstack/zzDeepTag01.spec.ts:9:5 › TAG-01: slug, resolve-path, import vs path, resend, rename projections 
      Error: expect(locator).toBeVisible() failed
      Locator: getByRole('region', { name: 'Note tags', exact: true }).getByRole('button', { name: '#ren1794916847300', exact: true })
      Expected: visible
  30) [chromium] › fullstack/zzDeepTag02.spec.ts:12:5 › TAG-02: projections agree, duplicate names, offline entries, renamed task tag 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for locator('.note-document .title-tag-row').locator('.prop-tag--add')
      - waiting for element to be visible, enabled and stable
  31) [chromium] › fullstack/zzDeepTag04.spec.ts:16:5 › TAG-04: field types through API, featured cells, inspector and phone 
      TimeoutError: locator.innerText: Timeout 15000ms exceeded.
      - waiting for locator('.ff-cell').filter({ has: locator('.ff-label').filter({ hasText: /^f_num$/ }) })
  32) [chromium] › fullstack/zzDeepTag05.spec.ts:9:5 › TAG-05: multi-value, relation, media, stale options, failures 
      Error: expect(locator).toBeVisible() failed
      Locator: locator('.attr-panel')
      Expected: visible
  33) [chromium] › fullstack/zzDeepTag06.spec.ts:12:5 › TAG-06: inheritance, overrides, rollup, sources, revoked access 
      Error: expect(locator).toBeVisible() failed
      Locator: locator('.attr-panel')
      Expected: visible
  34) [chromium] › fullstack/zzDeepTag10.spec.ts:24:5 › TAG-10: round trip, malformed, versions, multi-file partial, starter, export, proposal rail, phone 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for locator('.settings-nav-item').filter({ hasText: 'Your Data' })
  35) [chromium] › fullstack/zzDeepToken01.spec.ts:16:5 › TOKEN-01: UI create / role change / remove, and the minted token follows 
      TimeoutError: locator.click: Timeout 15000ms exceeded.
      - waiting for getByText('Manage Users')
  36) [chromium] › fullstack/zzDeepToken04.spec.ts:36:5 › TOKEN-04: allowlist, space scope, actor∩token scope and rate limit across all tools 
      Error: searchNodes-only token reached other tools
      Expected: 0
      Received: 11
  37) [chromium] › fullstack/zzI18nAudit.spec.ts:70:5 › zh-TW: no English left on the main screens
      Error: expect(received).toEqual(expected) // deep equality
      - Expected  - 1
      + Received  + 8
```

## cross-engine

```text
  1) [webkit] › fullstack/inkTouch.spec.ts:139:7 › handwriting page on touch › with the Hand tool, a one-finger drag scrolls instead of drawing 
      Error: expect(received).toBeGreaterThan(expected)
      Expected: > 100
      Received:   0
  2) [webkit] › fullstack/inkTouch.spec.ts:179:7 › handwriting page on touch › a two-finger pinch zooms; saved strokes keep their coordinates 
      Error: expect(received).toBeGreaterThan(expected)
      Expected: > 1.5
      Received:   1
  3) [mobile-safari] › fullstack/inkTouch.spec.ts:139:7 › handwriting page on touch › with the Hand tool, a one-finger drag scrolls instead of drawing 
      Error: expect(received).toBeGreaterThan(expected)
      Expected: > 100
      Received:   0
  4) [mobile-safari] › fullstack/inkTouch.spec.ts:179:7 › handwriting page on touch › a two-finger pinch zooms; saved strokes keep their coordinates 
      Error: expect(received).toBeGreaterThan(expected)
      Expected: > 1.5
      Received:   1
```

## faults

```text
  1) [faults] › fullstack/faults/randomSync.spec.ts:469:7 › random sync round 1 @faults
      Error: expect(locator).toBeHidden() failed
      Locator:  locator('.quick-capture-textarea')
      Expected: hidden
  2) [faults] › fullstack/faults/randomSync.spec.ts:469:7 › random sync round 2 @faults
      Error: expect(locator).toBeHidden() failed
      Locator:  locator('.quick-capture-textarea')
      Expected: hidden
  3) [faults] › fullstack/faults/randomSync.spec.ts:469:7 › random sync round 3 @faults
      Error: expect(locator).toBeHidden() failed
      Locator:  locator('.quick-capture-textarea')
      Expected: hidden
  4) [faults] › fullstack/faults/staleDeploy.spec.ts:39:5 › 8a: a stale chunk reloads once and the draft survives @faults 
      TimeoutError: page.waitForEvent: Timeout 30000ms exceeded while waiting for event "load"
      waiting for event "load"
  5) [faults] › fullstack/faults/staleDeploy.spec.ts:55:5 › 8b: with the reload guard spent, the error screen offers Reload and keeps the draft @faults 
      Error: expect(locator).toBeVisible() failed
      Locator: locator('.app-error-boundary')
      Expected: visible
  6) [faults] › fullstack/faults/stalledSave.spec.ts:44:5 › 3: a never-answered save must not block later saves @faults 
      Expected to fail, but passed.
  7) [faults] › fullstack/faults/stalledSave.spec.ts:52:7 › phone viewport › 9b (scenario 3 on a Pixel-like phone) @faults 
      Expected to fail, but passed.
  8) [faults] › fullstack/faults/storageQuota.spec.ts:17:5 › 6: snapshot saves failing on quota are reported and edits survive @faults 
      Error: cdpSession.send: Protocol error (Storage.overrideQuotaForOrigin): Internal error
```


## 預期失敗（已知但沒人在修）

2026-11-18 盤點故障注入那一組的 8 個 `test.fail`（`packages/frontend/e2e/fullstack/faults/`）。三個標記點名的修正分支其實都在加標記之前就合併了
（#609 `fix/a1-save-path`、#616 `fix/b1-offline-queue`、#617 `fix/b2-sync-liveness`，都是 2026-10-24 squash 合併，所以原本的 commit 不在 main 上）；
#612 加標記時沒有實際跑過（它的說明寫明「完全沒有實際執行這些測試」），之後也沒人回頭看。結果：

- 已修好、拿掉標記的 5 個：`twoTabQueue` 1、2、9a（#616 修好；舊的測試卡在一個只存在不到半秒的前置條件上，而且通過時其實是 B 把 A 的修改送出去的，
  改寫後要拿掉世代檢查才會紅）、`stalledSave` 3、9b（#616 修好；測試的 `page.unroute` 會放掉被扣住的請求，所以從來沒有真的卡住過）。
- 還在、保留標記的 3 個（標記文字寫的是今天的事實，不再點名分支）：

| 測試 | 會發生什麼 | 同一件事的確定性測試 |
| --- | --- | --- |
| `closeMidSave.spec.ts` 5b | 存檔請求送出、還沒回應時分頁被直接殺掉（當機、系統收回、沒電）。**存檔開始後約 2 秒內**被殺：那段字不見。**約 2 秒到 25 秒之間**被殺：字留在這台裝置的本機副本裡、但沒有排進佇列，重開後編輯器顯示得像存好了，卻永遠不會送出；之後每日的整份重新整理、或在大工作區打開那則筆記，就換回伺服器的版本；在那之前再編輯同一則，改在別的段落時伺服器合併會把那段字當成被刪掉而丟掉，改在同一行時當成衝突留下。都沒有提示。 | `localDbJournal.test.ts`「a save the page died during …」、`writeQueue.test.ts`「a save on the wire when the tab is killed …」（`it.fails`）；後端 `bodyMergeStrandedBase.test.ts`（合併的行為） |
| `stuckWrite.spec.ts` 4 | 伺服器對某一筆一直回 500 時，佇列停在那一筆，其他筆記的修改也送不出去；要等那一筆失敗 8 次（約 4.4 分鐘）才在同步狀態出現「移到復原區」（電腦在頭像打開的帳號視窗裡，手機在底部那條）。不會丟資料，只是卡住。 | `writeQueue.test.ts`「a write to another note behind a head answered 500 …」（`it.fails`） |
| `workerDeath.spec.ts` 7 | 本機資料庫的背景執行緒無聲結束時，要等 60 秒的呼叫期限才發現；這一分鐘裡存檔在等、畫面不說。之後會重建並送出。修法要分得出「死了」和「在忙」。 | `localDbWorkerHealth.test.ts`「a worker that ended itself is noticed within 30 seconds, and a busy one is left alone for 40」（`it.fails`） |

每一條的程式路徑、證據與修法草案在盤點 PR（#1877）的說明裡。`FAULTS_FLIP=1` 讓上面的單元測試以一般測試執行，會印出失敗的原因。
