#!/usr/bin/env node
// npm run catalog：從 scripts/entrypoints.catalog.json 產生 docs/agents/entrypoints-catalog.md。
import { CATALOG_DOC, writeCatalogDoc } from "./entrypointsCatalog.mjs";

writeCatalogDoc();
console.log(`已產生 ${CATALOG_DOC}`);
