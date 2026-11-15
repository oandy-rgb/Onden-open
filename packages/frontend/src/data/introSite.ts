// Onden's own intro site — the SINGLE SOURCE OF TRUTH for the dogfood site.
//
// These six notes ARE the official website (built from Onden notes, published
// via the in-app publish path, viewed at /site/<slug> as Astro SSR). The same
// content is reused in two places, so it lives here once:
//
//   1. The fullstack screenshot spec (e2e/fullstack/officialSite.spec.ts)
//      authors + publishes these pages, then screenshots the served SSR site.
//   2. The first-run WelcomeBanner "Explore the Onden intro" action installs
//      them into a brand-new workspace as ordinary, deletable, interlinked
//      notes — so a new user immediately HAS meaningful, self-explaining
//      content instead of a blank canvas.
//
// Honest, calm copy — no marketing hype (project ethos). Wikilinks ([[Title]])
// resolve by title; every page is plain Markdown.

export type IntroPage = {
  /** Note title; also the wikilink target and the nav label. */
  title: string;
  /** True = appears in the top nav (in this array's order). Colophon = false
   *  (a footer/linked page, not top nav). */
  nav: boolean;
  /** The page body as plain Markdown. */
  markdown: string;
};

// The site, authored as plain Markdown notes. Array order = nav order.
export const INTRO_PAGES: IntroPage[] = [
  {
    title: "Home",
    nav: true,
    markdown: `# Onden

A quiet place to keep what you know, connect it, and share the boundary with an agent you trust.

Onden is an open-source, non-commercial notebook. Notes are connected by links; tags give them capabilities; and everything that crosses in or out — from you or from an agent — passes through one reviewed boundary.

This whole website is built from Onden notes. Start with [[The idea]], see [[What you can do]], or jump to [[Get started]].`,
  },
  {
    title: "The idea",
    nav: true,
    markdown: `# The idea

Three moves, and the rest follows.

**A node is a connection.** A note isn't a file in a folder — it's a point in a graph. Its meaning comes from what it links to.

**A tag is a capability.** Tagging a note doesn't just label it; it grants behavior — a shape for its fields, a view, a function. Structure *emerges* from tagging, instead of being set up in advance like a database.

**The inbox and outbox are the boundary.** Everything from outside — a captured thought, an article, an agent's proposed change, a publish — arrives in the inbox to be reviewed, or leaves through the outbox once you approve it. There is no third door.

Governance isn't bolted on top. It's the precondition for what Onden is actually for: working alongside an autonomous agent without handing over the keys. The beachhead is small and honest — one human, one agent, one reviewed boundary between them.`,
  },
  {
    title: "What you can do",
    nav: true,
    markdown: `# What you can do

**Learn.** Capture what you read, connect it, and let the graph become your review. Ask your own notes a question and get an answer with citations back to the source.

**Publish.** Toggle a note public and it becomes part of a website — like this one. No export step, no second CMS to keep in sync.

**Brainstorm with an agent.** An agent works inside the same boundary you do: it proposes, you review in the inbox, approved changes apply. Nothing reaches the world unseen.

**Capture.** Inbox first, decide later. A thought, a task, a daily note — get it down in one keystroke and shape it when you're ready.`,
  },
  {
    title: "Why local-first",
    nav: true,
    markdown: `# Why local-first, open source

Your notes are plain Markdown. They live on your device and work offline; clearing a browser cache doesn't touch them, and you can export everything — body, frontmatter, media — at any time. No lock-in.

Onden is open source and non-commercial. There's no growth metric quietly pulling the design toward engagement traps. The trade is honest: you run it yourself, and it's young. If that's the trade you want, it's yours.`,
  },
  {
    title: "Get started",
    nav: true,
    markdown: `# Get started

1. **Run it.** \`docker compose up\` — that's the whole server.
2. **Write.** Open today's note and start capturing, or write your first note.
3. **Share.** When something's worth sharing, open **Share** and toggle **Published**. It joins your site.

No account wall to look around. The code and self-hosting notes live in the repository.

When you're curious how this very page works, read the [[Colophon]].`,
  },
  {
    title: "Colophon",
    nav: false,
    markdown: `# Colophon

This website is Onden.

Every page you've read is an ordinary Onden note with one attribute flipped — *Published*. The navigation is a list of notes; the links between pages are note-to-note links; the words are Markdown. There's no separate site builder behind a curtain.

If you're reading this, the simplest demo of what Onden can do is the page itself.`,
  },
];

// The title of the page to land on after install / the home node.
export const INTRO_HOME_TITLE = "Home";

// The static (nodeId-free) part of the site config. The screenshot spec PATCHes
// /api/workspace/config with this object + a `nav` array of { label, nodeId }
// built from the created nodes. Keeping the nodeId-free shape here lets both the
// spec and the in-app flow share one source for brand / accent.
export type IntroSiteConfig = {
  brand: string;
  tagline: string;
  accent: string;
  locale: string;
  description: string;
};

export const INTRO_SITE_CONFIG: IntroSiteConfig = {
  brand: "Onden",
  tagline: "Keep what you know. Share the boundary.",
  accent: "#7b2d26",
  locale: "en",
  description:
    "Onden — an open-source, non-commercial notebook where notes connect, tags grant capability, and one reviewed boundary sits between you and your agent.",
};
