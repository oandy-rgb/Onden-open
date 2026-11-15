# Onden Mental-Model Corrections — research-backed, via the learning-student workflow

> 狀態：歷史紀錄（最後確認 2026-11-01）

> 2026-06-27, 98-agent workflow: 75 learning-science/HCI topic deep-dives + 15 Onden subsystem mental-model baselines, synthesized across 7 student-workflow stages.

# Onden Mental-Model Correction Plan: Serving the Learning Student

The 7 stage-syntheses converge on **one** failure and **one** fix. This report collapses them into a decision-ready plan.

---

## 1. The core mental-model shifts

Six research-backed reframings. Onden currently sits on the wrong side of every one.

| Shift | Research (one line) | What it means for Onden |
|---|---|---|
| **Capture ≠ learning; a note is MADE, not taken** | Verbatim transcription predicts *worse* conceptual learning (Mueller & Oppenheimer 2014); the generation effect makes learner-produced text the durable asset (Slamecka & Graf 1978). | Every clip / highlight / AI-save / quick-capture is **raw debt** until the learner restates it in their own words. "Saved" must visibly differ from "understood." |
| **Retrieval over review/re-reading** | Testing effect (Roediger & Karpicke 2006); retrieval beats elaborative organizing/concept-mapping (Karpicke & Blunt 2011); highlighting/organizing are low-utility (Dunlosky 2013). | The whole corpus — not a 5%-curated #review deck — needs a resurfacing schedule. Organizing, linking, and a tidy graph are *encoding theater*, not progress. |
| **Desirable friction beats frictionless at the remember stage** | Desirable difficulties / fluency illusion (Bjork & Bjork 2011); recognition is the weakest format (Rowland 2014); feedback ~doubles the testing effect. | Reviews must be **recall-before-reveal with a produced answer** (cloze by default), not free-reveal + self-rate. Move friction OFF capture, ONTO the one generative beat. |
| **The AI asks before it tells** | AI assistance → metacognitive laziness (Fan et al. 2024); Google/offloading effect (Sparrow 2011); generation precedes provision (Bjork). | Ask-your-notes and save-as-note are the sharpest anti-learning surfaces. Gate answers behind a self-attempt; save the *learner's* restatement, quarantine AI prose as `source_type:ai` reference. |
| **A link is an authored "why," not an edge you count** | Constructing a concept map (g≈0.72) >> studying one (g≈0.43) (Nesbit & Adesope); the labeled proposition is the learning-bearing unit (Novak & Cañas). | Demote backlink/graph counts. A connection earns its keep only when the learner states *why* ("because / contradicts / example-of"). Confirms Onden's own "linking is theater." |
| **Progress = what I can retrieve, not what I've collected** | Fluency illusion / foresight bias (Koriat & Bjork 2005); learning vs performance (Soderstrom & Bjork 2015); collector's fallacy (Tietze). | Kill note-count / link-density / "N due" debt as headline signals. Surface FSRS retrievability/stability Onden *already computes* as "memories stabilized / starts slipping ~date." |

---

## 2. Where Onden's current model fights the learner

Honest, grounded in the baselines:

- **Frictionless capture is the collector's-fallacy engine.** QuickCapture → daily-note sink reads as "handled." The proudest feature optimizes the lowest-value act.
- **The reader rewards accumulation.** RSS "Keep/Dismiss," highlight→quote-card (whose answer is its own text), one-click save-as-note — all reward saving, none demand generation.
- **RAG is an answer vending machine.** AskPanel streams a fluent cited answer instantly; save-as-note banks AI prose as if learned (`source_type:ai` exists but isn't gated behind a generative step).
- **The review deck is degenerate and tiny.** `#review`-gated, fed by syntactic Q:/A: carving; whole-note enroll = title-front / whole-body-back (recognition only). Free reveal + Again/Hard/Good/Easy captures **no produced response** (`routes.ts /grade` takes only `{rating}`). FSRS-4.5 ships with fixed weights, never re-fit to the user's own grade log.
- **The home surface foregrounds the wrong cues.** "N due" debt headline, mere-presence streak (a day-node exists), note/link counts. Worse: **`HomeStart.tsx:75` excludes tagged notes from "Recent"** — the more a student organizes coursework, the emptier their progress view gets (concrete bug).
- **"Understand" and "Reflect" are structurally empty rungs.** The loop names them; the app instruments only capture + retrieve. Today's day-note opens **blank**.
- **Concrete model-mismatch bugs:** QuickCapture header hard-codes "→ today" while filing as the selected note's child (`QuickCapture.tsx:293`); offline capture leaves `#tag` as literal body text instead of membership; tag-focus silently swaps the editor for SchemaLens (`BuilderApp.tsx:1407`); unlinked-mentions false-positive on any title substring; the first-run demo publishes **Onden marketing copy**, not the student's material.

---

## 3. Prioritized roadmap

Deduplicated across all 7 stages. The same generative beat recurs at every intake surface — built **once** as shared infrastructure (P0-A), then wired into each surface.

### P0 — The load-bearing reframings (build these first)

**P0-A. The "raw → processed" lifecycle: one generative beat, every intake surface**
*The single highest-leverage change, and the smallest.* Insert one inline "say it in your own words" beat between capture/clip/AI-answer/highlight and "done."
- **Onden change:** Add an event-sourced `_processed`/`_elaboration_state ∈ raw|processed` attribute (ATTRIBUTE_SET, inbox-governable, undoable) to **every** node minted by QuickCapture, RSS Keep, PDF/web highlight, and save-as-note. Default `raw`; render a subtle "unprocessed" pill + a one-tap own-words field that flips it to `processed`. It is a **nudge, not a gate** — ⌘↵ still saves instantly. Discard/declare-bankruptcy stays as cheap as Keep.
- **Research:** Mueller & Oppenheimer 2014; Slamecka & Graf 1978; collector's fallacy (Tietze; Matuschak).
- **Effort: M · Impact: Highest** (attacks the central failure at one substrate, across all surfaces).

**P0-B. Home/metric reframe: collected → retrievable (+ fix the Recent filter)**
- **Onden change:** Replace the "N due" debt headline and note/link counts with FSRS-derived growth signals Onden *already computes*: "X memories stabilized this week / starts slipping ~date" (`ReviewHomeSection.tsx:34`). Surface per-note retrievability as ordinary metadata (reuse InlineProps). Surface "N captures owe a re-expression" (debt), never "N captured." **Fix `HomeStart.tsx:75`** so tagged (actively-studied) notes are not excluded from Recent.
- **Research:** Soderstrom & Bjork 2015; Koriat & Bjork 2005; Dunlosky 2013.
- **Effort: S–M · Impact: High** (changes what "doing well" looks like every session; includes a real bug fix).

**P0-C. Ask = tutor that asks before it tells**
- **Onden change:** Add a learning-mode default to AskPanel: show retrieved evidence spans + a "your answer first" box, reveal the grounded answer only after an attempt (one-tap skip preserved). Cite the **span** (offset + quoted sentence), not the note title (`ask.ts:430`). Make hedging faithful to retrieval coverage; on empty corpus offer "create a note / broaden," not "add notes first."
- **Research:** Fan et al. 2024; Sparrow 2011; Roediger & Karpicke 2006; ALCE citation-faithfulness gap.
- **Effort: M · Impact: Highest** (turns the highest-risk, most-used surface into the strongest study mechanic; no retrieval-engine rework).

**P0-D. Save-as-note saves MY restatement, and seeds FSRS**
- **Onden change:** Default artifact = a forced "in your own words" field that becomes the node body, born `raw`; AI prose collapses to "## AI answer (reference)" with `source_type:ai` (`AskPanel.tsx:160-181`). Add one-tap "turn into a recall card" → mints a `#review` child (front = question, answer = the learner's restatement) via the existing `reviewExtract.ts` path. Allow appending into the **current** note, not only a new top-level node.
- **Research:** Slamecka & Graf 1978; Karpicke & Blunt 2011; Cepeda 2006.
- **Effort: M · Impact: High** (closes the understand→remember gap exactly where it's severed today).

### P1 — Close the loops the engine already supports

**P1-A. Review = earned reconstruction (recall-before-reveal + cloze + feedback)**
- **Onden change:** Require a produced response (typed answer or "I attempted" commit) before "Show answer" unlocks (`ReviewPanel.tsx:206`); on reveal show answer **+ source-context span** for corrective feedback. Default the cheapest card type to **cloze** (hide-a-span-in-place). Frame "hard-but-recalled" as the best outcome, not "Easy." Grade event unchanged.
- **Research:** Rowland 2014 (recognition weakest, feedback d=0.73 vs 0.39); Bjork 2011; Karpicke et al. 2009.
- **Effort: M · Impact: High.**

**P1-B. Capture→retrieval closes by construction (the whole corpus, not 5%)**
- **Onden change:** A near-zero-friction "remember this" at QuickCapture, RSS Keep, and post-Ask that mints a cloze/Q:A card and enrolls it (learner types the answer — preserve generation; never auto-fill both sides). Wire the existing highlight→quote-child (≥8-char selection) into the FSRS `#review` path. Let any note declare a **retention horizon** ("keep until June 15 / for years") that tunes `requestRetention`.
- **Research:** Cepeda 2006/2008; Karpicke & Blunt 2011.
- **Effort: M–L · Impact: High** (the structural leak: 95% of corpus never enters the only loop that fights forgetting).

**P1-C. Highlight = recall prompt, not stored quote**
- **Onden change:** On any selection, offer "Make a recall prompt": the learner types the **question**, the span becomes the hidden answer, auto-tag `#review`. Do **not** default the front to the answer text. Replaces the recognition-weak quote-card.
- **Research:** Roediger & Karpicke 2006; Pan et al. 2022 (learner-authored beats provided cards).
- **Effort: M · Impact: High.**

**P1-D. Predict-before-reveal confidence + calibration mirror**
- **Onden change:** Between the recall gate and reveal, capture a confidence tap stored in the **same** ATTRIBUTE_SET grade event (calibration history free). Surface "you felt sure about 9 cards you actually missed." Defer a fresh card's first review ≥1 day (delayed-JOL).
- **Research:** Koriat 1997; Koriat & Bjork 2005; Dunlosky & Rawson 2012.
- **Effort: M · Impact: Very high** (directly attacks the illusion of competence; rides the existing grade event).

**P1-E. Links carry an authored "why"**
- **Onden change:** On wikilink/backlink creation, optionally prompt a one-line relationship label + reason, stored as edge metadata via `syncWikilinkEdges`; surface it on the backlink card (`NodeInspector`). Reframe unlinked-mentions and suggest-links (faint orange edges, `useGraphLayout.ts:297`) from "accept connection" to "say how it relates?" Drop backlink/outgoing **counts** as a prominence signal; graph reads as navigation, not "your knowledge." Tighten the substring-matching false positives.
- **Research:** Novak & Cañas; Nesbit & Adesope; Onden's own "linking is theater."
- **Effort: M · Impact: Medium-high.**

### P2 — Fill the empty rungs and demote the wrong rewards

**P2-A. Self-explanation as the "understand" mechanic**
- **Onden change:** An `/explain` slash-command + inspector button opens a prompted block written into the body (`> [!why]` callout). Prompts are **specific** and name a concrete prior note where links exist ("How does this relate to [[X]]?"). Flag verified vs unverified (a wrong "why" entrenches misconceptions); route unverified through a RAG/source check. Eligible to become FSRS prompts.
- **Research:** Chi 1994; Bisra et al. 2018 (g≈0.55, specific inference-eliciting prompts).
- **Effort: M · Impact: High** (fills the structurally-empty rung).

**P2-B. Scaffolded reflective journaling (the "reflect" rung is empty)**
- **Onden change:** Today's day-note opens **blank** (`openDailyNote` mints `''`). Seed 1–3 metacognitive prompts ("What did you understand? What's still fuzzy?") + one auto-resurfaced older note to re-explain **from memory before reveal**. Wire "what's still fuzzy" into card/task creation. Just markdown in the day node.
- **Research:** Bangert-Drowns et al. 2004 (metacognitive prompts are the active moderator); Zimmerman SRL.
- **Effort: M · Impact: High.**

**P2-C. Streak rewards retrieval, forgivingly**
- **Onden change:** `computeDayStreak` (`moodStreak.ts:51`) counts any day-node. Recompute over days with an effortful **retrieval/reflection** act; make it opt-in, two-day-rule forgiving with a small freeze quota, frame lapse as "pick back up today," never red/zero. Informational only — **no points/XP** (overjustification).
- **Research:** Deci, Koestner & Ryan 1999; Lally et al. 2010; what-the-hell effect.
- **Effort: S · Impact: Medium-high** (small change to pure logic; removes a churn trap).

**P2-D. Defer classification; tags are graded labels, not databases**
- **Onden change:** Keep capture structureless (daily-note pile). Never let tag-focus silently swap to SchemaLens (`BuilderApp.tsx:1407`); make class_tag promotion an explicit "turn this tag into a database" action behind progressive disclosure. Default a tag's instances to a simple list, not an empty "create a Table view" state. Use existing embeddings for typeahead so duplicates (`#srs`/`#spaced-repetition`) converge.
- **Research:** Malone 1983 (piling beats premature filing); Rosch (basic-level/graded categories); Sweller (extraneous load).
- **Effort: L · Impact: Medium-high** (mostly demotion — cheap; stops teaching "tidy = learned").

**P2-E. Publishing = learning-by-teaching, not a CMS**
- **Onden change:** A low-stakes "Teach this" path (distinct from WebsiteStudio): write a from-**memory** explanation for "a beginner / next-year me" (source hidden while writing, reveal to self-compare), publish to a **private share-link by default**. Make the agent the questioning protégé ("explain step 3?") reusing Ask in reverse. Replace the first-run `buildIntroSite` (`BuilderApp.tsx:613`) so the celebrated publish fires on the **student's own** material, not Onden marketing copy. SEO/domain/analytics behind "Advanced."
- **Research:** Chase et al. 2009 (protégé effect); Fiorella & Mayer 2013-14; Rozenblit & Keil 2002 (illusion of explanatory depth).
- **Effort: L · Impact: High** (turns a Tier-2 feature the user personally values into a consolidation mechanic; uniquely fits the dogfood persona).

**P2-F. Capture-honesty bug cluster**
- **Onden change:** (1) Fix the QuickCapture header to reflect the actual parent or default to today's inbox with "into this note" an explicit choice (`QuickCapture.tsx:293`). (2) Make offline capture apply `#tags` as real membership on reconnect (wire to the planned additive body→membership reconcile) instead of leaving literal `#todo`. (3) Make the inline `#tag`/`@date` grammar discoverable in-flow (token highlighting / tiny cheatsheet).
- **Research:** Storm & Stone 2015 / Masicampo & Baumeister 2011 (offloading relief requires a *trusted* sink); Norman gulf-of-evaluation; Nielsen recognition-over-recall.
- **Effort: M · Impact: Medium-high** (model-mismatch bugs that silently betray intent at the Tier-2 mobile-capture moment).

---

### One-line build order
**P0-A (raw-state attribute)** is the spine — ship it first; **P0-B/C/D** ride directly on it. Everything in P1 reuses the FSRS engine, grade event, and embeddings Onden already has (mostly surfacing, not infrastructure). P2 fills the empty "understand"/"reflect" rungs and removes the wrong rewards. The recurring theme: **build the generative beat once, wire it everywhere; demote every count; surface the memory-state you already compute.**

---

# Appendix: per-stage syntheses

## Stage: READING &amp; intake: encountering material (RSS/read-later/import), active reading, annot

At the reading/intake stage Onden's conceptual model is a COLLECTOR'S model: read frictionlessly, clip/highlight, save articles, ask the RAG, and a tidy corpus accrues — with "Keep/Dismiss" triage, verbatim highlight→quote-card, and one-click save-as-note all rewarding accumulation. The learning-science literature is unanimous that this is the low-utility, illusion-of-competence half of learning: highlighting and re-reading barely move retention (Dunlosky 2013; Yue 2015), verbatim capture predicts WORSE conceptual learning (Mueller & Oppenheimer 2014), AI answers handed back fluently produce metacognitive laziness and offloading (Fan et al. 2024; Sparrow 2011), and the only acts that build durable understanding are GENERATION (paraphrase/question/self-explanation; Slamecka & Graf 1978; Chi 1994; Bisra 2018) and EFFORTFUL RETRIEVAL (Roediger & Karpicke 2006; Bjork). The corrections below re-present reading as the START of a generative loop, not the act of collecting — every clip enters as raw, unprocessed DEBT that owes a one-line own-words restatement before it counts; the RAG/reader must prompt the learner to attempt before it reveals; a highlight must be one gesture from becoming a recall prompt (not a quote-card whose answer is its own text); and the surface must distinguish "saved" from "understood" so the felt fluency of a full reader is not mistaken for learning. All corrections fit Onden's architecture (markdown-as-truth, node=connection, tag=capability, event-sourced, local-first) and the no-thesis-pressure student.

**Corrections:**

- **A clip/highlight/saved article is RAW INPUT (unprocessed debt), not a finished note. The intake act does not equal learning; a capture is incomplete until the learner restates it in their own words. R** (M/Highest — it attacks the central reading-stage failure (saving feels like learning) at every intake surface with one event-sourced state, and converts the existing inbox/dashboard machinery into an honest 'collected vs understood' signal.)
    - research: Collector's fallacy (Tietze; Matuschak 'create more than you consume'); verbatim capture predicts worse conceptual learning (Mueller & Oppenheimer 2014); highlighting is low-utility (Dunlosky et al. 2
    - Onden: Give every reader-origin node (RSS Keep, PDF/web highlight quote-card, save-as-note) an event-sourced `_processed:false` attribute and an 'unprocessed' lens/pill, surfaced on HomeStart as a 'reading debt' line (count of unprocessed intake) 
- **The reader/RAG is a sparring partner that ASKS before it TELLS, not an answer vending machine. At the read→understand seam the highest-value move is the learner generating a 'why is this true / what d** (M/High — directly fixes the sharpest violation (RAG/save-as-note as offloading) for the precise persona, with no retrieval-engine rework; turns the strongest convenience feature into the strongest learning feature.)
    - research: Elaborative interrogation & self-explanation (Bisra et al. 2018 g≈0.55; Chi 1994); cognitive offloading / Google effect (Sparrow et al. 2011); AI metacognitive laziness & illusion of competence (Fan e
    - Onden: In AskPanel, add a default 'predict-first' beat for learning-mode questions: show the question + a 'your answer first' box, reveal the grounded answer only after an attempt (one-tap 'skip' escape hatch preserved). On RSS/PDF read, intercept
- **A highlight is a TRIGGER for a recall prompt, not a stored quote. Onden currently mints a quote-card child whose 'answer' is the same source text (recognition, the weakest format). The model should ma** (M/High — closes the missing read→remember bridge (the single biggest learning leak the baselines flag), converts the weakest existing artifact (quote-card) into the strongest evidence-based one, and feeds Onden's already-shipped FSRS engine.)
    - research: Testing effect & retrieval beats recognition (Roediger & Karpicke 2006; Rowland 2014 recognition is weakest); generation effect — learner-authored cards beat provided ones (Pan et al. 2022; Slamecka &
    - Onden: On highlight (PDF/RSS/editor selection), in addition to (or instead of) the quote-card, offer 'Make a recall prompt': prefill a child node where the learner types the QUESTION (cloze or Q:), the highlighted span becomes the hidden answer, a
- **Make the learner mark sparingly and treat fluency/highlight-volume as a WARNING, not progress. Reading-stage success is not 'I read it / I clipped 14 passages' but 'I can restate and will be quizzed o** (S/Medium-high — cheap copy/metric reframing across HomeStart + reader that removes the reinforcement of the wrong behavior; complements corrections 1-3 by changing what 'doing well' looks like at the reading stage.)
    - research: Highlighting underperforms and breeds illusion of knowing (Dunlosky 2013; Yue et al. 2015); fluency illusion / foresight bias (Koriat & Bjork 2005; Benjamin/Bjork); calibration via retrieval feedback 
    - Onden: Replace intake vanity signals with calibration signals: HomeStart/reader shows 'X restated in your own words / Y recall prompts made' instead of unread/clip counts. Add a gentle density nudge in the reader ('you've marked most of this artic

## Stage: CAPTURE: getting thoughts/quotes in with minimal friction without losing flow; the daily s

Onden's CAPTURE surface (QuickCapture sheet, daily-note sink, markdown editor) currently presents a "frictionless storage" model: dump a thought into the daily note, and it's handled. The learning-science consensus across the capture literature is that this model optimizes the single LOWEST-value act in learning and actively manufactures the collector's fallacy and the fluency illusion — "I saved/clipped it" reads as "I learned it" while almost no encoding has occurred. Verbatim, frictionless capture is precisely the shallow-processing mode that predicts WORSE conceptual learning (Mueller & Oppenheimer 2014), and a saved-but-never-regenerated note is a near-zero learning asset (Slamecka & Graf 1978; Bjork). The correction is NOT to add friction to capture itself — capture should stay fast so flow isn't broken — but to (1) make the captured item VISIBLY UNFINISHED until the learner re-expresses it in their own words or turns it into a retrieval prompt, (2) make the generative byproduct (a one-line paraphrase, a question, a card) the near-zero-friction next beat rather than an optional later chore, (3) reframe the daily note as an explicit triage inbox with a forced/nudged fate rather than a write-only sink, and (4) stop letting capture volume read as progress. The top corrections below are chosen because each fits Onden's node=primitive / markdown-as-truth / event-sourced architecture, serves the no-thesis-pressure learning student, and closes the specific seam where capture currently dead-ends. Several also fix concrete model-mismatch bugs the baselines surface (the QuickCapture header lying about its destination; offline silently dropping #tags; the daily note being two unnamed places).

**Corrections:**

- **Capture is the START of encoding, not its completion. A raw captured line is UNPROCESSED INPUT — not yet a note, not yet learned. The mental model must shift from 'I saved it, it's handled' (storage/c** (M/Highest. This is the single load-bearing correction the entire capture literature converges on — without it, Onden's proudest feature (frictionless capture) is the exact mechanism that converts learning into passive hoarding.)
    - research: Mueller & Oppenheimer 2014 (verbatim transcription predicts worse conceptual learning); Slamecka & Graf 1978 (generation effect, d≈0.40, largest after >1 day per McCurdy 2020); Bjork & Bjork (desirabl
    - Onden: Give every QuickCapture-minted node a visible lifecycle STATE rendered as ordinary metadata (a node_attribute, e.g. _capture_state: raw | processed), defaulting to 'raw'. In the daily-note sink and Recent lists, raw captures render with a s
- **The generative byproduct (a paraphrase, a question, a recall prompt) must be the PATH OF LEAST RESISTANCE at capture/first-touch, not a separate manual ritual downstream. Today the high-value act (aut** (M/High. Closes the broken capture→remember seam that the baselines flag as the friction point where 'most captured material never becomes a card, so it never gets the only treatment that works.')
    - research: Roediger & Karpicke 2006 + Dunlosky 2013 (retrieval practice = highest-utility technique; the bottleneck is that students don't author cards); Cepeda 2006/2008 (spacing); Bisra 2018 / Chi 1994 (specif
    - Onden: Extend the inline #tag/@date capture grammar with a near-zero-friction generative beat: after a capture lands, offer a single inline chip 'turn into a recall card' that pre-fills a Q:/A: scaffold from the captured line and routes it straigh
- **The daily note is a TRIAGE INBOX with a fate, not a write-only sink. The capture literature is explicit that an undifferentiated daily-note pile mixing to-read / to-keep / to-process is the classic em** (L/High. Converts a passive sink into the loop-closing surface the persona actually needs; also gives the offloading benefit its precondition (trusted re-surfacing) so capture genuinely frees attention instead of relocating anxiety.)
    - research: Whittaker & Sidner 1996 (overloaded inbox fails); Sarrafzadeh ('later' decays to never without re-surfacing); Masicampo & Baumeister 2011 (an anchored PLAN, not the act of saving, quiets the Zeigarnik
    - Onden: Repurpose Onden's existing inbox primitive (currently agent-governance only) to ALSO be the learner's own capture-triage queue: a lens over raw-state captures with cheap one-tap fates — keep/process, schedule a re-encounter (writes a due_da
- **Quotes/clips are EXTERNAL-STORAGE pointers (reference), categorically different from the learner's own re-expression (encoding) — and the UI must distinguish them so a verbatim clip never masquerades ** (M/Medium-High. Directly attacks the highest-risk illusion surface (clip/RAG-save) for a learner while staying inside the no-programmer-UI line (provenance reads as ordinary 'quoted from…' metadata).)
    - research: Mueller & Oppenheimer 2014 (verbatim vs generative); Sparrow 2011 (Google effect — offloaded text is remembered as 'where', not 'what'); Fan et al. 2024 (AI-answer save-as-note = metacognitive lazines
    - Onden: Mark provenance on captured content at the node level (verbatim-clip vs learner-authored) — Onden already has source_type on AI/RSS nodes, so extend the same provenance stamp to QuickCapture clips vs typed thoughts. Render a verbatim clip w
- **Fix the destination/structure model so capture is HONEST and predictable: capture must land where the UI says it lands, the inline grammar must be discoverable in-flow, and the SAME gesture must produ** (M/Medium-High. These are model-mismatch BUGS, not just framing — they silently betray the student's intent at the exact moment (capture-on-the-go) the product claims as a Tier-2 priority, and they undermine the trust that makes offloading psychologically work.)
    - research: Storm & Stone 2015 / Masicampo & Baumeister 2011 (offloading relief requires TRUSTED retrieval — an unreliable/dishonest sink forfeits the benefit and leaves the loop open); Norman gulf-of-evaluation 
    - Onden: Three concrete fixes the baselines surface: (1) Make the QuickCapture header reflect the ACTUAL parent — when a note is selected it files as that note's child while the header hard-codes '→ today' (QuickCapture.tsx:293 vs the currentNodeId 

## Stage: ORGANIZE & CONNECT: tagging, linking, collections, building the associative web; filing co

Onden's organize/connect surfaces present a CLASSIFICATION + LINK-COUNT model: a #tag becomes a schema-bearing database (SchemaLens → collection views), links/backlinks/unlinked-mentions reward connection volume, and a force-graph visualizes "your knowledge." The learning-science evidence says this is precisely backwards for a no-thesis student: (1) organizing/linking/concept-mapping is ENCODING, which loses to retrieval practice (Karpicke & Blunt 2011) and inflates the fluency illusion (Bjork; Dunlosky); (2) the durable, transferable learning of the connect step lives in the LABELED, learner-AUTHORED relationship and the explanation behind it (Novak & Cañas; concept-map construction g≈0.72 vs studying g≈0.43), which Onden's unlabeled [[wikilinks]] discard; (3) up-front schema/class_tag/collection-view machinery is premature filing (Malone 1983; Shipman & Marshall) and extraneous cognitive load (Sweller) imposed before the student understands the material; (4) auto-surfaced backlinks/unlinked-mentions and RAG do the connecting FOR the learner, removing the generative act that actually builds memory (generation effect, Slamecka & Graf; offloading/Google effect, Sparrow). The corrections below re-anchor organize/connect on graded prototype-centered tags, learner-authored "why" links, recognition-based deferred filing, and routing every connection toward retrieval — all of which fit markdown-as-truth, tag=capability, node=connection, and event-sourcing cleanly. The biggest single design lever: stop rewarding link/note/graph COUNT as progress, and make "I generated and can retrieve this connection" the unit of value.

**Corrections:**

- **A link is not an edge you accumulate — it is a learner-AUTHORED relationship you must name ("because…", "contradicts", "is an example of"). The encoding payoff of the connect step lives in stating WHY** (M/high)
    - research: Novak & Cañas (concept maps: the labeled proposition is the learning-bearing unit); construction vs studying a map g≈0.72 vs 0.43 (Nesbit & Adesope meta-analysis); generation effect (Slamecka & Graf 1
    - Onden: When a wikilink is created (the [[ picker miss/hit in MarkdownEditor), optionally prompt a one-line relationship reason and store it as a typed edge attribute (relation label + 'why' text) on the knowledge_link edge — markdown stays truth (
- **Organizing and linking FEEL like learning but are encoding, not memory — and they actively breed the illusion of competence. The model must visibly separate 'collected/organized' (a full, tidy, well-l** (M/high)
    - research: Karpicke & Blunt (2011, retrieval practice beats elaborative concept mapping on comprehension/inference); Roediger & Karpicke (2006); Bjork & Bjork (desirable difficulties / fluency illusion); Dunlosk
    - Onden: Add a one-gesture bridge from any link/tag/note to FSRS: a learner-authored 'why' relationship can become a #review card ('How does X relate to Y? → <your why>') reusing the existing tag-as-card enroll path and ATTRIBUTE_SET event flow. Ref
- **A #tag should read as a graded, prototype-centered, multi-membership LABEL at the basic level — not as a schema-bearing database the student must design. Defer all classification past the moment of ca** (L/high)
    - research: Malone (1983, piling beats premature filing); Shipman & Marshall (cost of premature formalization); Rosch (basic-level categories; graded membership / prototypes); Bergman & Whittaker (user-subjective
    - Onden: Keep the plain label-tag as the default and make class_tag promotion an explicit, consented, behavior-triggered moment — never let focusing a tag silently swap the editor for SchemaLens (BuilderApp.tsx:1407). Demote Fields/Access/Automation
- **Auto-surfaced connections (backlinks, unlinked-mentions, suggest-links, RAG answers) are 'read'-grade and remove the generative act that builds memory — they should PROMPT the learner to generate/expl** (M/high)
    - research: Sparrow et al. (2011, Google/offloading effect — remember location not content); generation effect (Slamecka & Graf); Fan et al. (2024, metacognitive laziness from AI answers); Karpicke retrieval-befo
    - Onden: Reframe suggest-links (currently faint orange graph edges, useGraphLayout) from silent auto-edges into an inline 'these may connect — say how?' prompt the learner accepts only by authoring a reason. Make unlinked-mentions a generative promp
- **Collections/views and the graph are tools that change what the mind must COMPUTE, not a place where knowledge is stored or a trophy of how much you've connected. Present them as lenses/scaffolding ove** (L/medium)
    - research: Larkin & Simon (representations change inference); Bates (berrypicking / evolving need); Pirolli & Card (information scent / enrichment lowers future foraging cost); McCay-Peet & Toms / Makri & Blandf
    - Onden: Add high-scent previews everywhere a connection is a decision point (backlink/mention/collection rows carry a snippet, date, why-it-matched), not bare titles. Re-cast the force-graph from a 'how much have I connected' artifact toward a tag/

## Stage: UNDERSTAND & ELABORATE: note-making, summarizing, concept-mapping, writing-to-learn, self-

Onden currently presents a CUSTODIAL / STORAGE-AND-ORGANIZE model to a learning student: capture frictionlessly, file under #tags/schemas/collections, link into a graph, and let the AI (RAG save-as-note) synthesize and hand back answers. The understand/elaborate stage — where durable learning is actually constructed — is structurally empty. Every place the app currently lets the student READ or FILE (their own verbatim dump, an RSS clip, an AI answer, an auto-surfaced backlink, a populated schema) is a place the learning science (Chi/ICAP, Slamecka & Graf generation effect, Karpicke & Blunt retrieval-vs-mapping, Mueller & Oppenheimer, Bisra self-explanation meta-analysis, Fan et al. metacognitive laziness) says the student should be made to GENERATE — restate in their own words, explain why/how, author the connection, attempt before revealing. The corrected throughline: a note is the RESIDUE of a transformation the student performed, not a container they filled; capture is the unfinished state; the AI is a sparring partner that asks before it tells; and the act that makes a note count is the student producing/reconstructing it, not saving or organizing it. These corrections fit Onden's architecture cleanly — markdown-as-truth makes a "your-own-words" body field native; node=connection means an authored, reasoned link is a first-class event; event-sourcing means a save-as-note from an AI answer can be quarantined as source_type:'ai' (already is) and gated behind a generative step; and the no-thesis student needs the friction moved OFF capture and ONTO the one effortful generative beat that produces understanding. The single highest-leverage change is the smallest: insert a one-line "in your own words / why does this matter?" generative beat between capture (or AI answer, or highlight) and "done", visually marking un-elaborated material as RAW.

**Corrections:**

- **A note is the RESIDUE of a generative act, not a container you fill. Reframe the conceptual unit from 'text I captured/saved' to 'a transformation I performed on a source' (a paraphrase, a question, a** (M/Highest — this is the load-bearing correction; it converts Onden's frictionless-capture strength from a collector's-fallacy machine into the front of a learning loop, with one cheap markdown-native field.)
    - research: (see above)
    - Onden: Add a generative-state field to every content node (node_attribute, e.g. _elaboration_state ∈ raw|elaborated). On QuickCapture save and on RSS-clip / highlight-card creation, default to 'raw' and render a subtle visual marker (a thin left-b
- **The AI is a sparring partner that ASKS before it TELLS, not an answer vending machine. Ask-your-notes RAG and save-as-note are the single highest learning-RISK surface: they perform the synthesis the ** (M/High — directly defuses the product's most acute anti-learning trap (fluent answer → one-click bank) while preserving RAG's genuine find/lookup value.)
    - research: (see above)
    - Onden: Add a 'Learn mode' default to AskPanel: before streaming the cited answer, prompt 'What do you think — answer first' with a one-line textarea (skippable, but the default). On Save-as-note, require/strongly nudge a 'My takeaway (in my own wo
- **A connection is something you AUTHOR A REASON FOR, not an edge the system hands you. The durable-learning payoff of concept mapping comes from the learner generating and LABELING the relationship (con** (M/Medium-High — turns the existing link substrate (currently link-count theater) into the generative integration the understand stage needs, aligned with node=connection.)
    - research: (see above)
    - Onden: When the student creates a [[wikilink]] (MarkdownEditor wikilink picker) or accepts a suggested_link, surface an optional one-line 'why this connects?' captured as the edge's reason and quotable inline. Demote unlinked-mentions and the sugg
- **Self-explanation is the missing FIRST-CLASS mechanic of the 'understand' stage — and it must be specific and inference-demanding, anchored to prior knowledge, not a generic note field. The strongest m** (M/High — fills the structurally-empty 'understand' rung with the best-evidenced comprehension mechanic, using markdown callouts and the existing tag/link substrate for prior-knowledge anchoring.)
    - research: (see above)
    - Onden: Add an 'Explain' affordance on any note (slash-command '/explain' + inspector button) that opens a small prompted self-explanation block written into the markdown body (e.g. a '> [!why]' callout). Prompts are specific and, where the node ha
- **Organizing (tagging, schema-filling, collections, canvas-arranging) is ENCODING/FILING, not learning — and the app must stop letting organizational richness stand in for understanding. Filing a note i** (S/Medium-High — mostly a removal/demotion (cheap), and it stops the app from teaching the student that a tidy graph equals a learned mind; reorients the felt reward toward the generative loop.)
    - research: (see above)
    - Onden: Make capture structureless by default (no #tag/schema decision demanded at capture — keep the daily-note pile), and present class_tag schemas/collections strictly as a LATER, optional, system-proposed overlay ('these 6 raw captures look lik

## Stage: REMEMBER & REVIEW: spaced retrieval practice, card extraction, FSRS, fighting the collecto

Onden's review subsystem ships the right engine (FSRS-4.5 spaced repetition) but presents the wrong mental model around it: a flashcard sub-app gated behind a #review tag, fed by Q:/A: line-carving, that touches maybe 5% of the corpus while frictionless capture, RAG save-as-note, RSS clipping, and a link graph train the collector's fallacy across the other 95%. The learning science (Roediger & Karpicke; Bjork; Karpicke & Blunt; Cepeda; Dunlosky) is unanimous on the corrections: (1) memory is built by EFFORTFUL RECONSTRUCTION, not storage/recognition/re-reading — so the whole corpus, not just hand-curated cards, needs a resurfacing schedule with recall-before-reveal as the default re-encounter; (2) the card UI currently lets recognition/fluency masquerade as recall (free reveal + self-rate, whole-note "answers", no produced response, no cloze/generation); (3) "captured/organized" must be visibly distinguished from "learned/retrievable," because the app's most prominent progress signals (note count, links, graph density, "N due" debt) are exactly the fluency-illusion cues the evidence warns against; (4) FSRS should read as growing durable mastery against a retention horizon and surface retrievability/forgetting forecasts, not a chore queue; (5) AI/RAG and capture should re-insert the desirable difficulty they currently remove (predict-then-reveal, generate-your-own-card, restate-in-own-words). All of these fit Onden's substrate cleanly: cards are already nodes, grades are already spine ATTRIBUTE_SET events, FSRS already computes stability/retrievability per node — the corrections are mostly surfacing and default-flow changes, not new infrastructure. The single highest-leverage move is closing the capture→retrieval loop so the frictionless capture/RAG/RSS streams flow into spaced retrieval by construction instead of dying as a re-readable pile.

**Corrections:**

- **Retrieval, not re-reading or recognition, is the act that builds memory — so a 'review' must be an EARNED reconstruction (recall-before-reveal, ideally with a produced answer), not a free reveal that ** (M/high)
    - research: Roediger & Karpicke 2006 (testing effect); Rowland 2014 (recognition is the weakest format, free recall strongest; feedback ~doubles the effect d=0.73 vs 0.39); Bjork & Bjork 2011 (desirable difficult
    - Onden: Add a produced-response step before reveal: a one-line free-recall/typed-answer box (or 'I attempted' commit) that must be filled before 'Show answer' unlocks; on reveal, show the answer AND the source-context span for corrective feedback (
- **Spacing/retrieval is a property of the WHOLE corpus, not a flashcard sub-app you opt into. The model 'notes (a place you write) + review (a deck you hand-build with #review + Q:/A:)' is backwards: eve** (M/high)
    - research: Cepeda 2006/2008 (spacing benefits ANY re-retrieval; optimal gap scales to retention horizon); Karpicke & Blunt 2011 (retrieval beats elaborative organizing/concept-mapping); Sparrow 2011 + collector'
    - Onden: Make the capture→retrieval loop close by construction: at capture time (QuickCapture sheet), after a RAG answer (AskPanel save-as-note), and at RSS 'Keep', offer a near-zero-friction 'remember this' that mints a cloze/Q:A card and enrolls i
- **'Captured/organized' must be visibly distinguished from 'learned/retrievable,' and the app's progress signals must measure RETRIEVAL, not collection. The current headline signals — note count, link/ba** (M/high)
    - research: Dunlosky 2013 (low-utility highlighting/organizing; high-utility retrieval+spacing); Soderstrom & Bjork 2015 (learning vs performance; activity metrics conflate them); Koriat & Bjork 2005/Benjamin & B
    - Onden: Replace the home 'N due' debt headline with a competence/growth signal Onden already has via FSRS: 'X cards stabilized this week / you can now recall Y / next slipping ~<date>', and surface per-note retrievability ('starts slipping around …
- **AI/RAG and capture should RE-INSERT the desirable difficulty they currently remove. A frictionless cited answer plus one-click save-as-note is the sharpest cognitive-offloading / metacognitive-lazines** (M/high)
    - research: Fan et al. 2024 (metacognitive laziness with AI assistance); Sparrow 2011 (Google effect — remember the location not the content); Bjork & Bjork 2011 (offloading effort removes the difficulty that bui
    - Onden: Add an optional 'try first' gate on Ask for understand/remember questions: prompt the learner to predict/restate before the streamed answer reveals (the answer becomes feedback on their attempt). On save-as-note, require/nudge a one-line ow
- **Card AUTHORING is where the learning is won or lost: cards must be learner-GENERATED and bias toward why/how/apply, and a #review card whose front is a lecture TITLE and whose back is the whole note i** (M/medium-high)
    - research: Slamecka & Graf 1978 + Matuschak (writing the prompt IS much of the learning); Pan & Rickard 2018 (transfer d≈0.40 rides on application-style retrieval); Wozniak 20-rules / atomicity; Karpicke & Blunt
    - Onden: Demote whole-note enroll (or convert it into a prompt to author a cloze/question rather than a silent degenerate card), and when the agent or extractor proposes cards, require the learner to edit/complete each (e.g. fill the answer side, or
- **FSRS should be presented as a personalized forgetting-curve instrument tied to a retention HORIZON and made legible — not a fixed-cadence chore queue toward indefinite ~90% retention with all the SRS ** (L/medium-high)
    - research: Cepeda 2006/2008 (gap scales to retention horizon, ridgeline); Bjork & Bjork 1992 (new theory of disuse — storage vs retrieval strength); FSRS literature (log-fitting the 17 weights = the 20–30% effic
    - Onden: Surface retrievability as a plain 'how well remembered / starts slipping around <date>' signal per card and per topic (the DSR state already exists in _review_state); let the learner set a per-topic/per-card retention horizon that drives re

## Stage: RETRIEVE & APPLY (finding/foraging, AI-ask, reusing knowledge, teaching/publishing)

At the retrieve/apply stage Onden presents a STORAGE-AND-LOOKUP model: ask the AI and it answers, follow backlinks/the graph, triage feeds into a pile, and publish notes as a website. Every one of these surfaces optimizes the moment of effortless re-exposure — exactly the act the learning-science evidence identifies as where durable learning FAILS to happen. The single throughline correction: at the moment of retrieval, the student's own effort is the asset, and Onden currently does the retrieval, synthesis, and connection FOR them. The five highest-leverage corrections all re-route one frictionless lookup into a generative act the learner must perform: (1) gate the RAG answer behind a recall attempt and cite to the span not the note (turn Ask into a tutor that asks before it tells); (2) reposition save-as-note from "bank the AI's prose" to "save MY restatement, checked against evidence" and feed it into FSRS; (3) reframe wikilinks/backlinks/unlinked-mentions from link-count theater into learner-authored, reviewable propositions; (4) recast publishing from a webmaster CMS into the learning-by-teaching loop (the protégé effect — the strongest motivation lever available to a solo learner with no deadline); (5) make foraging/triage end in generation, not accumulation, with "reading debt" not "second brain" framing. All five fit markdown-as-truth, node=connection, tag=capability, event-sourced, and require no new substrate — they are mostly UX/flow inversions on surfaces that already exist (AskPanel, NodeInspector, WebsiteStudio, RssReaderPanel, reviewExtract).

**Corrections:**

- **The AI is a tutor that ASKS before it TELLS, not an answer vending machine. At the retrieve stage the student's own effortful recall/generation IS the learning event; a fluent cited answer handed back** (M/Highest — Ask-your-notes is the most-used and highest-risk retrieve surface; this single inversion converts the app's biggest anti-learning feature into its strongest study mechanic, and span-citations make every other 'reuse' workflow trustworthy.)
    - research: Roediger & Karpicke 2006 (testing effect); Bjork desirable difficulties / Soderstrom & Bjork 2015 (storage vs retrieval strength, fluency illusion); Fan et al. 2024 (AI assistance → metacognitive lazi
    - Onden: In AskPanel, add a learning-mode default where, for understand/remember-type questions, the panel first shows the retrieved evidence spans + a 'what do you think?' prompt and a recall/predict box BEFORE streaming the synthesized answer (ask
- **Save-as-note should capture the student's GENERATION, not the AI's synthesis. The durable asset is the learner re-expressing the answer in their own words (the generation effect) and later RE-RETRIEVI** (M/High — closes the understand→remember gap exactly where it's currently severed (RAG answers never reach FSRS), and stops the app from rewarding banked AI prose as knowledge.)
    - research: Slamecka & Graf 1978 (generation effect); Chi 1989/1994 + Bisra et al. 2018 (self-explanation, specific inference-eliciting prompts); Karpicke & Blunt 2011 (retrieval > elaborative organization); Cepe
    - Onden: Change AskPanel save-as-note (AskPanel.tsx:160-181) so the default artifact is a learner-written restatement (a forced 'in your own words' field + the question), with the AI answer kept as collapsed 'reference (AI-authored)' and citations a
- **Links are learner-AUTHORED propositions, not auto-surfaced topology to admire. The learning payoff lives in the act of stating WHY two notes connect (a labeled relationship integrating new material wi** (M/Medium-high — kills a documented theater loop (link-gardening busywork) and redirects the same gesture into the generative act that actually builds schemas; fits node=connection without new substrate.)
    - research: Novak & Cañas / Nesbit & Adesope (constructing a concept map g≈0.72 vs studying one g≈0.43; the linking PHRASE is where learning lives); Karpicke & Blunt 2011 (building an interlinked map loses to ret
    - Onden: When a wikilink/backlink is created, optionally prompt a one-line relationship label ('contradicts / example-of / because…') stored as edge metadata, and surface that label (not just a snippet) in the inspector. Reframe 'Unlinked mentions' 
- **Publishing is the LEARNING-BY-TEACHING loop, not a CMS. For a no-deadline learner, explaining material to an audience that can not-understand is the strongest motivation AND retention lever available ** (L/High — turns a Tier-2 feature the user personally values into a first-class consolidation mechanic; uniquely fits the dogfood persona (motivation + retention in one), with no thesis-output framing.)
    - research: Chase et al. 2009 (protégé effect); Kobayashi 2019 / Fiorella & Mayer 2013-14 (teaching/explaining beats preparing-to-teach, delayed-test advantage); Rozenblit & Keil 2002 (illusion of explanatory dep
    - Onden: Add a low-stakes 'Teach this' / explain-it path distinct from the WebsiteStudio CMS: pick a topic/tag, write a from-MEMORY explanation aimed at 'a beginner / next-year me' (source hidden while writing, reveal to self-compare), publish to a 
- **Foraging/triage is paying down READING DEBT, not filling a second brain. Re-finding works by orienteering through remembered context (recency, daily-stream, the source you read it in), not by query-te** (M/Medium — prevents the read→capture seam from becoming a high-volume clip pile that feels like learning; aligns triage with the event-sourced/local-first capture rails already present.)
    - research: Teevan et al. 2004 (orienteering/recognition beats teleporting/recall for re-finding); Tulving & Thomson 1973 (encoding specificity — context is the retrieval cue); Whittaker & Sidner 1996 + Bergman &
    - Onden: In RssReaderPanel, make 'Keep' end in a generative beat (a one-line 'why this matters / in my words' or a highlight→Q card) rather than promote-to-note alone (RssReaderPanel.tsx:139-172); surface unread age as a calm reading-debt meter and 

## Stage: REFLECT & METACOGNITION: self-regulated learning, judgments of learning, goals, reflective

Onden's REFLECT/metacognition surfaces present a CUSTODIAL + COMPLETION model: progress = a tidy, growing archive (Recent/To-read/Loose-ends on HomeStart) plus a backlog-debt to drain ("N notes ready to review", "N due"), with engagement gamified as a mere-presence streak (a day-node exists) and a mood emoji. The learning science says this is the fluency-illusion in product form: it foregrounds exactly the cues (collection volume, organization tidiness, due-count, streak-of-showing-up) that learners mistake for knowing while being uncorrelated with retention — and it leaves the one mechanism that actually recalibrates metacognition (a felt gap between predicted and actual recall) entirely absent. Crucially, Onden ALREADY computes the honest signal — per-card FSRS stability, difficulty, retrievability, reps, lapses, last_review (ReviewPanel.tsx:19-22, /api/review/stats) — but throws all of it away at the surface, showing only due/new/learned counts. The highest-leverage corrections are not new ML; they are surfacing the memory-state Onden already has, capturing a confidence judgment before reveal to expose miscalibration, reframing review from a debt-to-drain into a forgetting-curve instrument and a competence/growth signal, adding a scaffolded reflective-journaling beat to the daily note (the "reflect" stage is currently empty), and making the streak/home reward retrieval and self-explanation rather than presence and collection. These fit Onden's architecture cleanly: grades already flow as ATTRIBUTE_SET events (so a stored confidence rating + calibration history is event-sourced and free), retrievability is derivable from existing _review_state, and reflection prompts are just markdown in the day node (markdown-as-truth).

**Corrections:**

- **Reframe review from a DEBT-TO-DRAIN ('N due', a backlog the student is failing to keep up with) into a FORGETTING-CURVE INSTRUMENT the student reads to understand their own memory. Each card has two d** (M/Highest — converts the app's most evidence-aligned engine from a chore-counter into the metacognition mirror the whole stage is about, reusing data already on disk.)
    - research: Bjork & Bjork new theory of disuse (storage vs retrieval strength); Ebbinghaus/Murre & Dros 2015 forgetting curve + savings; FSRS-4.5 DSR model; Soderstrom & Bjork 2015 (learning vs performance — don'
    - Onden: Surface the per-card FSRS state Onden ALREADY computes (ReviewState.stability/retrievability/lapses, ReviewPanel.tsx:19-22) as plain-language signals: on the note, 'well-remembered' + 'starts slipping ~<date>'; on the home strip, replace th
- **Add a PREDICT-BEFORE-REVEAL judgment-of-learning and surface the CALIBRATION GAP. Subjective confidence is an invalid cue driven by fluency; the single highest-leverage metacognitive intervention is f** (M/Very high — directly attacks the illusion of competence the rest of Onden's collection/organization surfaces inflate; near-zero new infra (rides existing grade event).)
    - research: Koriat 1997 (cue-utilization / invalid fluency cues); Dunlosky & Rawson 2012; Koriat & Bjork 2005 (foresight bias); Roediger & Karpicke 2006 (testing effect); the delayed-JOL effect.
    - Onden: In ReviewPanel, between the recall gate (ReviewPanel.tsx:206-215) and reveal, capture a quick confidence tap; store it in the SAME ATTRIBUTE_SET grade event already used (routes.ts grade path), so calibration history is event-sourced for fr
- **The 'reflect' stage is structurally EMPTY — fill it with SCAFFOLDED, RETRIEVAL-based reflective journaling, not a blank page. Prompted/structured reflection (why? how does this connect? what changed i** (M/High — operationalizes the named-but-unbuilt 'reflect' step; cheap because it's day-node markdown + existing node sets.)
    - research: Bangert-Drowns et al. 2004 (writing-to-learn: metacognitive prompts are the active moderator); Gibbs/Kolb reflective cycle (forced return + revised model); Chi 1994 / Bisra et al. 2018 (self-explanati
    - Onden: Onden lands the student on a BLANK today day-note (openDailyNote mints markdown=''). Seed today's note with 1-3 reflection prompts ('What did you understand today? What's still fuzzy?') and an auto-resurfaced older note to re-explain from m
- **Stop letting COLLECTION/ORGANIZATION volume read as learning progress, and reward RETRIEVAL/self-explanation instead. The home dashboard's Recent/To-read/Loose-ends and the tidy graph are storage/find** (M/High — corrects the central felt-progress signal the learner reads every session; the 'Recent' filter fix is also a concrete correctness bug for the persona.)
    - research: Karpicke & Blunt 2011 (retrieval > elaborative concept-mapping/organizing); Dunlosky et al. 2013 (highlighting/summarizing/organizing = low utility); the collector's fallacy (Tietze); Sparrow 2011 (Go
    - Onden: Re-anchor HomeStart's headline from collection lists to a retrieval/competence summary (cards recalled, memories stabilized, prompts self-explained); demote Recent/To-read to secondary. Fix the inverted 'Recent' filter so a student's active
- **Redesign the STREAK from rewarding mere PRESENCE (a day-note exists) into rewarding effortful RETRIEVAL, and make it FORGIVING. A mere-presence chain trains the cheapest behavior, recruits loss aversi** (S/Medium-high — small change to existing pure logic; removes a documented churn trap and stops rewarding the wrong loop for the dogfood persona.)
    - research: Deci, Koestner & Ryan 1999 (overjustification — tangible contingent rewards undermine intrinsic interest; informational feedback helps); Lally et al. 2010 (a single miss doesn't reset the habit curve)
    - Onden: computeDayStreak (moodStreak.ts:51) counts any day with a day-node. Recompute it (or add a parallel chain) over days with an effortful retrieval/reflection act; make it opt-in, forgiving (anchor already tolerates the today-gap — extend to a

