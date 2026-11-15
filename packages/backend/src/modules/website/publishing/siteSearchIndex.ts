// The search index of the static copy, made with Pagefind (pagefind.app) once
// when the copy is made (siteBundle.ts) and shipped inside it, so search works
// from the zip and any static host, and the live site serves the very same
// files (GET /api/site/search.idx/*).
//
// What is indexed: the note pages (`site/<slug>/index.html`), and of those only
// what the article frame marks `data-pagefind-body` — title, tags and body, not
// the header, the tree, the table of contents, backlinks or prev/next. The home
// page and tag pages list notes the note pages already hold, so they would only
// duplicate results and are left out. Pagefind picks the language from the
// page's <html lang> (the site's locale), which decides how text is split into
// words: zh and ja are indexed per character, so a Chinese word is found
// without spaces around it.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import * as pagefind from "pagefind";
import { SEARCH_INDEX_DIR } from "./staticSite.js";

const NOTE_PAGES = "site/*/index.html";

// The Node API drives one pagefind process; builds take turns so closing it
// after one never cuts another short.
let turn: Promise<unknown> = Promise.resolve();

/** Index the copy in `tree` and write the index files to `site/search.idx/`
 *  there. Returns how many pages went in. Throws when Pagefind reports errors. */
export function indexStaticSite(tree: string): Promise<{ pages: number }> {
  const run = turn.then(async () => {
    const { index, errors: startErrors } = await pagefind.createIndex({});
    if (!index) throw new Error(`pagefind could not start: ${startErrors.join("; ")}`);
    try {
      const added = await index.addDirectory({ path: tree, glob: NOTE_PAGES });
      if (added.errors.length > 0) throw new Error(`pagefind could not read the pages: ${added.errors.join("; ")}`);
      // Not index.writeFiles(): its reply comes before the helper process has
      // finished writing, and close() below kills that process, which left
      // pagefind-ui.js cut at 64 KB and the wasm empty in a stored copy. The
      // files come back in memory instead and are written here, awaited.
      const built = await index.getFiles();
      if (built.errors.length > 0) throw new Error(`pagefind could not build the index: ${built.errors.join("; ")}`);
      const out = resolve(tree, SEARCH_INDEX_DIR);
      for (const file of built.files) {
        const target = resolve(out, file.path);
        if (!target.startsWith(out + sep)) throw new Error(`pagefind file escapes its folder: ${file.path}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
      return { pages: added.page_count };
    } finally {
      await index.deleteIndex();
      await pagefind.close();
    }
  });
  turn = run.catch(() => {});
  return run;
}
