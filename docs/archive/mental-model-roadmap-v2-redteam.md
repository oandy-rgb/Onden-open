# Mental-Model Roadmap v2 — red-teamed, de-risked, mechanism-grounded

> 狀態：歷史紀錄（最後確認 2026-11-01）

> 2026-06-27, ~88-agent adversarial workflow: 16 correction red-teams + 32 tool-mechanism teardowns + 32 behavioral/tools-for-thought lenses, synthesized across 6 themes. Pressure-tests the first (constructive) mental-model-corrections pass BEFORE building.

This is a synthesis task. I have all five upstream syntheses in the prompt and they converge tightly. Producing the final report directly.

# Onden Mental-Model Roadmap v2: Generation Without Killing Capture

**Verdict in one line:** The first roadmap's learning science was sound but it put the generative effort in the wrong place — on the capture instant — and framed kept material as debt. Both attack the one asset every teardown confirms is load-bearing. The fix is uniform and needs **no new mechanism**: relocate every generative beat off capture onto a deliberately-entered review/inbox surface, route AI through the inbox as a *proposal*, make signals decaying/optional/unscored, and reuse the existing `#review` tag + FSRS engine.

---

## 1. What survived the red-team

Of the 16 first-pass corrections, **0 survive as written.** The breakdown:

**SURVIVES (narrow, ship-it):**
- **Recent-filter bug fix (from P0-B).** Real defect: the filter drops *typed* notes (a capture that later gets a class tag) from Recent. Fix to gate on `node_type === 'content'` only. Ship standalone, with a test (class-tagged content node appears; `class_tag` node does not). The metric-swap half is dropped.
- **Span-citation as infra (from P0-C).** The pedagogical gate is dropped; the char-offset citation plumbing survives as a *decoupled infra track* — but don't ship the label until offsets exist, or you get fake-precise citations (worse than honest title-level).

**KEEP-WITH-GUARDRAILS (good beat, defused):**
- **Highlight → optional recall prompt (P1-C):** change "Replaces" → "augments." Keep one-click quote-card; difficulty lands at review time, not mid-read.
- **/explain self-explanation (P2-A):** best-evidenced understand mechanic (Bisra g≈0.55). Strip the AI-verification clause, drop auto-FSRS, register a real `why` callout type (currently renders as a bare blockquote in-app *and on publish*).
- **Retrieval signal (P2-C):** keep, but **drop the chain/streak metaphor** — make it a monotonic, never-decrementing, no-zero-state count.
- **"Move friction off capture" meta (P2-G):** right science; the word **"ONTO"** is the bug. Onden already separates the rails — strengthen the existing decoupled review beat, don't tax capture.

**SOFTENED (right motive, wrong placement/framing):** P0-A debt lifecycle, P0-D forced restatement, P1-A cloze-default, P1-B by-construction enrollment, P1-D calibration bundle, P1-E typed-why links, P2-B reflective day-note, P2-D promotion gate, P2-E publishing-as-drill, P2-F offline reconcile.

**DROPPED OUTRIGHT:**
- **Debt framing entirely (P0-A).** A counter that climbs while you're away is the GTD-bankruptcy / Anki-650-due quit trigger. For a no-thesis learner whose tolerance model is "I owe this system nothing," debt = fastest path to guilt-abandonment.
- **Ask answer-gate as default (P0-C).** Khanmigo: ~15% usage, "a non-event," kids went back to videos. A self-directed adult has a 2-second escape to ChatGPT.
- **AI-as-judge in any hot path (P1-A, P2-A).** False-marks paraphrases (most rage-inducing SRS bug), breaks offline/local-first, breeds authority-deference.
- **"Whole corpus / by construction" enrollment (P1-B).** The avalanche mechanic verbatim.

**Where the first roadmap was honestly wrong:**
1. It **fact-checked HomeStart wrong** — proposed replacing "collected counts" that don't exist; `ReviewHomeSection` already self-hides at `due===0`.
2. It **bundled opposite-risk mechanics under single labels** (P0-C gate vs citation; P1-D tap vs scoreboard vs deferral; P2-E three independent changes). Unbundling reverses the verdict on half of each.
3. It **re-imposed the exact failure modes the research forbids** — debt counters, capture-time friction, authoritative auto-cards, AI-as-judge.
4. It **mis-targeted the tag seam (P2-D)** — would re-split the just-unified tag model; the real leak is SchemaLens ejecting on `node_type==='class_tag'` (= every label now).
5. It **re-subordinated publishing (P2-E)** to a loop the user explicitly lifted it out of on 2026-06-23.

---

## 2. The central tension resolved

**Capture stays a sacred zero-decision write rail; every generative beat moves to a *separately-entered*, opt-in surface, routed through the existing inbox/FSRS/tag rails — never inlined, never debt-counted, never AI-withheld.**

The resolution rests on a load-bearing fact: **effort and felt payoff must be co-located.** Capture-on-the-move is the lowest-capacity, mid-flow moment (interruption research: a generative beat there can *delete the thought being captured*). The FSRS review surface is the highest-capacity moment, deliberately entered, where effort and the reward of remembering coincide. The first roadmap charged effort where capacity is lowest and payoff is days away — the "active-learning students learned more but *felt* they learned less" trap, fatal for an N=1 dogfooder with no exam forcing function.

**The two-rail model, made explicit:**
- **Capture = the read/write-fast axis** (cheap, dumb, deterministic, sacred). Day-node, QuickCapture, highlight. Emits nothing generative, synchronous, or AI.
- **Generation = the review/inbox axis** (effortful, opt-in, pulled). FSRS review, inbox proposals, a "revisit" lens you enter. The agent *scaffolds* the Q:/A:; the human *supplies* the recall; the reward is visible memory.

They are two habits on two cues. The entire resolution is **keeping them on two cues.** This falls cleanly out of Onden's existing inbox/outbox boundary, node=primitive, tag=capability substrate — no third mechanism.

**The deeper reframe (what the learning-science pass couldn't see):** the differentiator isn't a better scheduler (ts-fsrs is a commodity). It's **memory woven into reading** (Matuschak/Nielsen mnemonic medium) — remembering as a byproduct of reading, not a deck you visit. Every separate-deck app structurally cannot do this; Onden's node=card substrate makes it nearly free.

---

## 3. Concrete mechanics to borrow + the traps

| Mechanic that SHIPPED well | Source | Why it retained | Trap that made users quit |
|---|---|---|---|
| **Card = a note you tagged** (cloze-from-selection, `::`, `#card`, `---`-splits-a-note) | Anki Ctrl+Shift+C, RemNote, Mochi, Supernotes, Logseq | Card is a render-transform of a note line, not a new object | Rich authoring → 56% of Anki users (97.6% of med students) defected to pre-made decks to dodge it |
| **Highlight → review, one auto-enrolled rail, zero promotion** | Readwise Reader (>60% DAU) | Capture↔review are one object | Auto-enrolling the *whole* pile → "nagging stranger asking you to judge your memories" churn |
| **Source-anchored prompt + first rep inline at read time** | Quantum Country / Orbit | Memory is a property of reading | 71% drop before 1-month — prompts were the *author's*, not the reader's. Lesson: reader-owned |
| **Clickable inline citation grounded in your own corpus** | NotebookLM (72% D30) | Answer + evidence as one explorable object; users credit *citations*, not the LLM | Confident-wrong output poured straight at the user (Notion Q&A); citations can *worsen* overreliance (Buçinca 2021) |
| **Opt-in per-card "Generate Questions" tab** | Recall | Conspicuously *absent* from churn complaints — review never firehosed | SmartFlash: a med student built cards for 3 months and never reviewed — "scaffolding displaces learning" |
| **`newPerDay` budget + "pending, not yet studying" staging** | RemNote Daily Learning Goal | New cards never inflate the due-count | Anki/RemNote: "miss 3 days → 200–1000 due → quit." The number is the wall |
| **Capture-streak fused to the protected act** | (Onden already mints a day-node free) | Nothing extra to maintain | Duolingo streak: "performative midnight check-ins," cliff-shaped abandonment when broken |

**The throughline trap:** every form of *obligation bolted onto the capture object* — debt counters, backlog totals, forced authoring, auto-enrolled cards, withholding tutors — is the churn engine. The mechanic that retains is **capture and review fused into one object with zero authoring step.**

---

## 4. De-risked roadmap

**Cross-cutting invariants (encode as non-goals in `note-use-cases` / `backlog` so future loop rounds can't re-break them):**
1. **Capture is sacred.** No synchronous generation, AI-ask, counter, or gate on capture/save — ever. Acceptance test: real-device stopwatch, hotkey→type→persisted is one uninterrupted gesture.
2. **No deficit/debt counters anywhere on capture/home.** Signals are windowed, decay-to-zero, opt-in, never monotonic-accusatory. Backlog lives only in a deliberately-entered lens, framed *available* not *owed*.
3. **AI offers, never withholds or auto-applies.** Generation/clarify/restatement = inbox proposals (apply-then-review). Silence is a valid recorded outcome.
4. **Never AI-judge the user's own reasoning in any hot path.** Verification is self-invoked, offline-safe, surfaces sources not verdicts.
5. **Measure re-visits / capture-frequency**, never processed-% / streak-length / cards-created. Pre-register a revert-on-regression threshold on capture latency + re-visit rate (the N=1 substitute for population averaging).
6. **Single mechanism.** Cards = `#review`-tagged nodes. No parallel scheduler, no card table, no third rail.

### P0 — Cheap, honest, pure-upside (ship first, no behavioral backfire)

| Item | Safest form | Borrowed mechanic | Guardrail | Effort | Impact |
|---|---|---|---|---|---|
| **Recent-filter fix** | Gate on `node_type==='content'` only; typed notes stay in Recent | — (bug fix) | Test: class-tagged content appears, `class_tag` node doesn't | **S** | **High** |
| **Grade-consequence line** | On `grade()`, render next interval in plain language ("back in about 9 days") from the value `/grade` already returns — a *date, not the model* | Every SR tool's most-motivating moment | No SRS jargon (no stability/ease/difficulty) | **S** | **High** (best impact-per-effort) |
| **Inline AskPanel citations** | Each `[n]` expands a read-only snippet *under* the answer; "open note" secondary; land at the source range | NotebookLM grounded citations | Pure representation change on data already returned | **S** | **High** |
| **Kill all debt/deficit counters** | Replace climbing totals with windowed, decaying, gain-framed signals; backlog → pull-only "revisit" lens (sibling to orphan lens) | (inverse of Anki due-count) | No badge on capture/home; bucket counts ("a few to read"), compute on open not every SSE tick | **S** | **High** |
| **Defang the streak** | "days you showed up" heatmap; missed day reads neutral, never red/zero/reset | (Onden capture-streak, relabeled) | Never compete with capture | **S** | **Medium** |
| **SchemaLens conditional on content** | A tag with null/empty `tag_schema` opens to its **members** (notes); only a tag with fields opens the schema form. Adding a field *is* the promotion (lazy write) | (avoids Tana schema-wall) | Agent proposes schema via inbox; "just show the notes" escape | **S→M** | **High** (kills the real programmer-UI leak) |
| **`tagCountsOf` de-dup** | Count distinct nodes per tag name across both rails | — | Test: body `#todo` + `#todo` membership = 1. *Gates* the offline-reconcile work | **M** | **Medium** |

> **FIRST-ROADMAP ERRORS FIXED HERE:** P0-A debt framing (dropped), P0-B metric-swap (dropped — only Recent fix survives), P0-C answer-gate (dropped), P2-D promotion gate (replaced by the SchemaLens-on-content fix).

### P1 — The genuine learning win, defused

| Item | Safest form | Borrowed mechanic | Guardrail | Effort | Impact |
|---|---|---|---|---|---|
| **One-tap "remember this"** | Optional tap at capture / post-Ask / highlight → applies `#review`, span-scoped, card links back to source node | Readwise highlight→review one rail | Never auto, never whole-corpus; reuse `#review` (no second path) | **M** | **High** |
| **New-card budget + staging** | New cards sit "pending, not yet studying," capped via `newPerDay`; never inflate the due-count until pulled | RemNote Daily Learning Goal + stale-drip | Port the backlog governors *before* promoting review, not after | **M** | **High** |
| **Body-markup-as-card** | `term ::def` / `{{cloze}}` in any node body renders that node as a latent card, scheduled by existing FSRS | RemNote/Supernotes transform | Opt-in per card, markdown-as-truth, never workspace-wide. Keep shipped recall-before-reveal | **M** | **Medium** |
| **Save-as-note decoupled** | Keep one-tap save (`source_type:'ai'`, body intact, citations). "Add my take" = optional `source_type:'human'`. "Make a card" = separate gesture requiring a one-line human gloss before FSRS | (provenance survives) | Gate FSRS *promotion*, not save — closes the laundering path | **M** | **High** |
| **Highlight → recall prompt** | Keep one-click quote-card (verbatim span + source edge); "make a recall prompt" = optional chip *after* capture or agent-proposed via inbox | RemNote Reader zero-keystroke capture | "augments" not "replaces"; difficulty at review time; first review ≥1 day | **M** | **Medium** |
| **Local corrective feedback** | String-diff against the user's *own* authored answer; typed answer never overrides honest self-grade | — | **Never an AI judge in-loop**; offline-safe; ink/empty-body cards exempt | **M** | **Medium** |
| **Confidence (from P1-D bundle)** | Optional long-press on the existing recall-commit button (zero added taps), stored label-less; per-card teaching moment on reveal | — | **No aggregate shame-summary by default**; gate any aggregate behind opt-in + N≥30; drop forced ≥1-day deferral | **M** | **Low-Med** |

> **FIRST-ROADMAP ERRORS FIXED HERE:** P1-A cloze-default + AI-judge (→ opt-in + local-diff; recall-before-reveal already ships, don't regress), P1-B "by construction / whole corpus" (→ one-tap, span-scoped, budgeted), P1-C "Replaces" (→ augments), P1-D scoreboard + forced deferral (unbundled, scoreboard dropped), P0-D restatement-gate + auto-enroll (→ decoupled, gloss-gated promotion).

### P2 — Understand-axis + governance, on-thesis

| Item | Safest form | Borrowed mechanic | Guardrail | Effort | Impact |
|---|---|---|---|---|---|
| **/explain self-explanation** | Register a real `why` callout type (in-app + publish). AI *proposes* via inbox; learner authors/edits/rejects | Bisra g≈0.55 | **Drop the verified/unverified gate** → self-invoked "check against my sources" (evidence, not verdict). No auto-FSRS. Sequence after P0-A is measured | **M** | **Medium** |
| **Plan-first Ask (CFF)** | Surface retrieval plan + "what I think you're asking" → one click to stream. Tutor/Socratic = opt-in toggle, off by default, "show me anyway" always one click | Buçinca plan-engagement CFF | Never gate summarize/recall/connect; doubles as transparency win | **M** | **Medium** |
| **Inline read-mode prompts** | Collapsible recall widget that lives *in* the note; review scrolls to the prompt's home note with surrounding prose | Quantum Country mnemonic medium | A `#review` card with no source edge surfaces in a "weak cards" lens, not silently in rotation | **M** | **High** (the real differentiator) |
| **Route generative beats through inbox** | All AI-ask/restatement/card/schema proposals = apply-then-review | (reuses inbox=governance) | Structurally enforces "offered not compelled"; zero new mechanism | **M** | **High** |
| **Reflect template** | Opt-in "Reflect" in the existing `NOTE_TEMPLATES` registry; route "re-explain from memory" through FSRS (older note = whatever's due) | — | **Never seed the blank day note**; no second unscheduled recall mechanism | **M** | (protects chokepoint) |
| **"Why" on links** | Optional additive label from a small *open* vocab + free-text fallback; agent-proposed via inbox; shown only in understanding-mode surfaces | — | Bare `[[wikilink]]` stays zero-decision; **reframe counts, don't demote** (graph = tag/permission governance overview) | **M** | **Medium** |
| **Retrieval signal** | Monotonic, never-decrementing, no-zero-state count ("12 recalls this week") from FSRS grade events | (Duolingo return-hook minus loss-aversion) | **No chain** = nothing for loss-aversion to grab; gate behind a sub-2s recall beat actually existing | **M** | **Medium** |
| **Offline @date symmetry** | Keep the `@date` token in body when offline (mirror `#tag`); strip only after the `due_date` write confirms | — | Reconcile is **additive-only**, never strips the body hashtag; gated behind `tagCountsOf` de-dup | **M** | **Med-High** |
| **Publishing** | Keep public-URL default; "explain to a beginner" = opt-in AI writing mode over existing notes | Obsidian Publish zero-friction public URL | **Drop private-default + first-run-publish**; first-run drives *capture*; day-one aha = labeled seed-demo preview (satisfies D9 "what's public") | **S** | **Medium** |

> **FIRST-ROADMAP ERRORS FIXED HERE:** P2-A AI-verification + auto-FSRS (dropped; callout-render bug fixed), P2-B seeded day-note (→ opt-in template, route through FSRS), P2-C streak/chain metaphor (→ monotonic count), P2-D (handled in P0), P2-E publishing-as-drill + private-default + first-run-publish (all dropped), P2-F (3 parts already shipped — verify don't rebuild; the @date asymmetry is the real residual).

### Deferred infra track (real architecture, not a UX commit)
- **Span-citation plumbing** (char-offset → scroll-to-line for node sources). Until it lands, keep honest title-level citations. **L, Medium.**
- **Reactive read-axis** (draggable query filters, live match-count, debounced through one `/api/query` read; "Save query" = the only write). Belongs on the consolidation/read-axis backlog. Rides the read axis only — never a second non-event-sourced state channel, never per-tick writes, never `touch-action:none` on a scroll surface. **L, Medium.**

**Sequencing rule:** ship all P0 (S, pure-upside) first. Then the one-tap `#review` + staging budget. Defer anything that touches capture latency or invents a counter. **Dogfood each behavioral beat OFF-by-default for a week; if it depresses capture frequency, cut it.**