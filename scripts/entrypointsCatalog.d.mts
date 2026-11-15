export interface CatalogFile { file: string; exports?: string[] }
export interface CatalogEntry {
  id: string; need: string; area: string; entry: CatalogFile[]; use: string; useLang?: "ts" | "css" | "none";
  replaces: string; rules: string[]; why: string;
}
export interface Catalog { areas: string[]; entries: CatalogEntry[] }
export const CATALOG_FILE: string;
export const CATALOG_DOC: string;
export const CATALOG_DOC_FILE: string;
export function loadCatalog(file?: string): Catalog;
export function entriesForRule(rule: string, catalog?: Catalog): CatalogEntry[];
export function ownerCovered(owner: string, rules: string[], srcPrefix: string, catalog?: Catalog, stripExt?: boolean): boolean;
export function locationOf(entry: CatalogEntry): string;
export function describeEntry(entry: CatalogEntry): string;
export function hintForRule(rule: string, catalog?: Catalog): string | null;
export function entryHint(id: string, catalog?: Catalog): string;
export function renderCatalogMarkdown(catalog?: Catalog): string;
export function writeCatalogDoc(): void;
