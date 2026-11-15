// Onden's AI is vendor-neutral (owner decision 2026-11-01): what people read and what self-hosters follow never names an
// AI company, product or model family. The guards (backend and frontend aiVendorNames.guard.test.ts) scan with this.
// The one place allowed to name a provider is the protocol adapter folder, found through the entry-point catalog.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { repoRoot } from './paths.mjs';

/** Company, product and model-family names (a model id such as `claude-…`, `gpt-…`, `gemini-…` starts with one). */
export const VENDOR_NAMES = /claude|anthropic|openai|chatgpt|gemini|copilot|mistral|llama|ollama|deepseek|qwen|\bgpt|google ai/i;

const isTestPath = (rel) => /(^|\/)(test|tests|e2e|__tests__)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);

/** Files under `path` (a file or a folder, relative to the repo root); tests are not product, so they are skipped. */
export function productFiles(path, { exts = /\.(ts|tsx|mjs|js|css|md|json|yaml|yml|example)$/ } = {}) {
  const walk = (full) => {
    if (!existsSync(full)) return [];
    if (!statSync(full).isDirectory()) return [full];
    return readdirSync(full).flatMap((name) => (name === 'node_modules' || name === 'dist' ? [] : walk(join(full, name))));
  };
  return walk(join(repoRoot, path)).filter((file) => {
    const rel = relative(repoRoot, file).split('\\').join('/');
    return !isTestPath(rel) && (exts.test(rel) || rel.endsWith('.env.example'));
  });
}

/** `rel:line` of every line naming a vendor, outside the exempt folder. */
export function vendorHits(files, exemptFolder) {
  const hits = [];
  for (const file of files) {
    const rel = relative(repoRoot, file).split('\\').join('/');
    if (exemptFolder && rel.startsWith(exemptFolder)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (VENDOR_NAMES.test(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
  return hits;
}

/** The one folder that may name a provider: the folder of the catalog entry for "call an AI API format". */
export function protocolFolder() {
  const catalog = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'entrypoints.catalog.json'), 'utf8'));
  const entry = catalog.entries.find((e) => e.id === 'ai-protocol-client');
  if (!entry) throw new Error('scripts/entrypoints.catalog.json has no entry "ai-protocol-client"');
  return `${dirname(entry.entry[0].file)}/`;
}
