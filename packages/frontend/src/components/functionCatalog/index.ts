// The function catalog's zh-TW strings (names are the modules' own; these are
// the descriptions and examples of the functions added with the catalog and
// the words the catalog's surfaces share). Importing this registers them: the
// tag page, the info panel and the paragraph tools each import it, so none of
// them carries the others' copy and the boot dictionary stays as it was.
import { registerDictionary } from "../../lib/i18n";
import { FUNCTION_CATALOG_ZH_TW } from "./strings.zh-TW";

registerDictionary("zh-TW", FUNCTION_CATALOG_ZH_TW);
export { FUNCTION_EXAMPLES, exampleOf, type FunctionExample } from "./examples";
export { catalogRows } from "./catalogRows";
