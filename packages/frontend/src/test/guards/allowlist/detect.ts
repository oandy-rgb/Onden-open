// Detectors for the allowlist guards (allowlist.guard.test.ts): pure functions of
// source text, so allowlistRules.guard.test.ts can feed each one a violating and
// a legal sample. TypeScript AST only — no identifier counting by regex.
import ts from "typescript";

export const PLATFORM_GLOBALS = [
  "window", "document", "navigator", "history", "location", "crypto", "localStorage",
  "sessionStorage", "matchMedia", "visualViewport", "ResizeObserver", "IntersectionObserver", "setPointerCapture",
] as const;
export type PlatformGlobal = (typeof PLATFORM_GLOBALS)[number];

/** Objects whose property of the same name is that global (`window.history`, `globalThis.crypto`). */
const GLOBAL_HOLDERS = new Set(["window", "globalThis", "self", "document"]);

export function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Names the file declares itself (variables, parameters, imports, functions, classes…). A bare `history`
 *  in a file that declares its own `history` is that variable, not the browser global. Coarse on purpose:
 *  it errs toward not counting, and `window.history` is still counted through its holder. */
function declaredNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const addBinding = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const el of name.elements) if (ts.isBindingElement(el)) addBinding(el.name);
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) addBinding(node.name);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node) || ts.isEnumDeclaration(node)) && node.name) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/** Whether an identifier is a name being declared or a property key, not a reference to a binding. */
function isNonReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
  if (ts.isQualifiedName(p) || ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p) || ts.isExpressionWithTypeArguments(p)) return true;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isPropertyDeclaration(p) || ts.isMethodSignature(p)) && p.name === id) return true;
  if (ts.isJsxAttribute(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return true;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p)) && p.name === id) return true;
  return false;
}

const lineOf = (file: ts.SourceFile, node: ts.Node): number => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

export interface Site<T extends string = string> { name: T; line: number }

/** Every use of a browser platform global in `source`, with its 1-based line (one entry per use). */
export function platformGlobalSites(path: string, source: string): Site<PlatformGlobal>[] {
  const file = parse(path, source);
  const own = declaredNames(file);
  const wanted = new Set<string>(PLATFORM_GLOBALS);
  const uses: Site<PlatformGlobal>[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && wanted.has(node.text) && !isNonReference(node) && !own.has(node.text)) {
      uses.push({ name: node.text as PlatformGlobal, line: lineOf(file, node) });
    } else if (ts.isPropertyAccessExpression(node) && wanted.has(node.name.text)) {
      const holder = ts.isIdentifier(node.expression) ? node.expression.text : "";
      // `window.history` is a use of history; `el.setPointerCapture()` a use of setPointerCapture.
      // `window.window` and `document.document` are not interesting, but harmless to count once.
      if (GLOBAL_HOLDERS.has(holder) || node.name.text === "setPointerCapture") uses.push({ name: node.name.text as PlatformGlobal, line: lineOf(file, node.name) });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return uses;
}

/** Every use of a browser platform global in `source`, as `global` names (one entry per use). */
export function platformGlobalUses(path: string, source: string): PlatformGlobal[] {
  return platformGlobalSites(path, source).map((site) => site.name);
}

/** Elements the design system owns: outside components/ui they are written through its components. */
export const UI_ELEMENTS = ["button", "input", "select", "textarea", "dialog", "a", "img"] as const;

/** JSX intrinsic (lowercase tag) elements of the given names, with line, one entry per opening/self-closing tag. */
export function intrinsicElementSites(path: string, source: string, names: readonly string[] = UI_ELEMENTS): Site[] {
  const uses: Site[] = [];
  const wanted = new Set(names);
  const file = parse(path, source);
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName) && wanted.has(node.tagName.text)) {
      uses.push({ name: node.tagName.text, line: lineOf(file, node.tagName) });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return uses;
}

/** JSX intrinsic (lowercase tag) elements of the given names, one entry per opening/self-closing tag. */
export function intrinsicElementUses(path: string, source: string, names: readonly string[] = UI_ELEMENTS): string[] {
  return intrinsicElementSites(path, source, names).map((site) => site.name);
}

/** A search / filter box written by hand: a `TextField` or `<input>` with `type="search"` or a search-wording
 *  placeholder, or a wrapper around one that draws its own magnifier (lucide `Search`). components/ui's SearchField
 *  is the one place these are drawn. */
const SEARCH_WORDS = /\b(Search|Find|Filter)\b|搜尋|篩選|找/;
export function searchInputSites(path: string, source: string): Site[] {
  const file = parse(path, source);
  const sites: Site[] = [];
  const isInput = (tag: ts.JsxTagNameExpression) => ts.isIdentifier(tag) && (tag.text === "TextField" || tag.text === "input");
  const attrOf = (el: ts.JsxOpeningLikeElement, name: string) =>
    el.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === name);
  const opening = (el: ts.JsxElement | ts.JsxSelfClosingElement) => (ts.isJsxElement(el) ? el.openingElement : el);
  const hasMagnifier = (node: ts.Node): boolean => {
    let found = false;
    const walk = (n: ts.Node) => {
      if (found) return;
      if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && ts.isIdentifier(n.tagName) && n.tagName.text === "Search") found = true;
      else ts.forEachChild(n, walk);
    };
    walk(node);
    return found;
  };
  const containsInput = (node: ts.Node): boolean => {
    let found = false;
    const walk = (n: ts.Node) => {
      if (found) return;
      if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && isInput(n.tagName)) found = true;
      else ts.forEachChild(n, walk);
    };
    walk(node);
    return found;
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      if (isInput(node.tagName)) {
        const type = attrOf(node, "type");
        const typeIsSearch = type?.initializer && ts.isStringLiteral(type.initializer) && type.initializer.text === "search";
        const placeholder = attrOf(node, "placeholder");
        if (typeIsSearch || (placeholder?.initializer && SEARCH_WORDS.test(placeholder.initializer.getText(file)))) sites.push({ name: "search-input", line: lineOf(file, node.tagName) });
      }
    }
    // A wrapper (label, div…) that holds both a magnifier and an input is a hand-made search box.
    if (ts.isJsxElement(node) && !isInput(node.openingElement.tagName) && node.children.some((c) => (ts.isJsxSelfClosingElement(c) || ts.isJsxElement(c)) && hasMagnifier(c) && !containsInput(c))
      && node.children.some((c) => (ts.isJsxSelfClosingElement(c) || ts.isJsxElement(c)) && containsInput(c))) {
      sites.push({ name: "search-wrapper", line: lineOf(file, opening(node)) });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}

/** Window extents a floating layer is kept inside: `window.innerWidth`, `document.documentElement.clientHeight`,
 *  a bare `innerWidth`, or the visible-area helper. */
function isViewportExtent(node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isIdentifier(node)) return node.text === "innerWidth" || node.text === "innerHeight";
  if (ts.isCallExpression(node)) return ts.isIdentifier(node.expression) && node.expression.text === "visibleViewportBottom";
  if (!ts.isPropertyAccessExpression(node)) return false;
  const holder = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
  if (node.name.text === "innerWidth" || node.name.text === "innerHeight") return GLOBAL_HOLDERS.has(holder);
  if (node.name.text === "clientWidth" || node.name.text === "clientHeight") return holder === "documentElement";
  return (node.name.text === "width" || node.name.text === "height") && holder === "visualViewport";
}

/** Places that keep a layer inside the window: `window.innerWidth - width` and the like. Placing a floating
 *  surface next to an anchor or a point is components/ui's usePopover; a second clamp is a second popover. */
export function viewportClampLines(path: string, source: string): number[] {
  const file = parse(path, source);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.MinusToken && isViewportExtent(node.left)) lines.push(lineOf(file, node));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}
export const viewportClampUses = (path: string, source: string): number => viewportClampLines(path, source).length;

/** Roots whose `.data.nodes` is an AppData's whole node list: a store snapshot (`getAppState().data`, `s`, `state`),
 *  a DataCtx's `ctx.data` (tests give it their own data) and any variable named `data` (hook, preview or site snapshot).
 *  Not listed: a bare `nodes` (props, filtered subsets) — its source is not provable from the expression alone. */
const STORE_NODE_ROOTS = new Set(["s", "state", "start", "now"]);

function isStoreNodes(node: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "nodes") return false;
  let data: ts.Expression = node.expression;
  if (ts.isNonNullExpression(data)) data = data.expression;
  // `data.nodes`, `ctx.data.nodes`
  if (ts.isIdentifier(data)) return data.text === "data";
  if (!ts.isPropertyAccessExpression(data) || data.name.text !== "data") return false;
  const root = data.expression;
  if (ts.isIdentifier(root)) return STORE_NODE_ROOTS.has(root.text) || root.text === "ctx";
  return ts.isCallExpression(root) && ts.isIdentifier(root.expression) && root.expression.text === "getAppState";
}

/** `p.id === x` / `x === p.id`, alone or as the first operand of `&&`. */
function isIdLookup(cb: ts.Expression): boolean {
  if (!ts.isArrowFunction(cb) || cb.parameters.length !== 1 || !ts.isIdentifier(cb.parameters[0]!.name)) return false;
  const param = cb.parameters[0]!.name.text;
  let body: ts.Node = cb.body;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  while (ts.isBinaryExpression(body) && body.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) body = body.left;
  if (!ts.isBinaryExpression(body) || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(body.operatorToken.kind)) return false;
  const isParamId = (e: ts.Expression) => ts.isPropertyAccessExpression(e) && e.name.text === "id" && ts.isIdentifier(e.expression) && e.expression.text === param;
  return isParamId(body.left) || isParamId(body.right);
}

/** Looking one store node up by id with a linear `find` / `some`: `nodeOf(data, id)` (lib/nodeIndex) and appStore's `getNode(id)` / `useNode(id)` are O(1). */
export function storeNodeFindLines(path: string, source: string): number[] {
  const file = parse(path, source);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["find", "some", "filter"].includes(node.expression.name.text)
      && isStoreNodes(node.expression.expression) && node.arguments.length === 1 && isIdLookup(node.arguments[0] as ts.Expression)) lines.push(lineOf(file, node));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}
export const storeNodeFindUses = (path: string, source: string): number => storeNodeFindLines(path, source).length;

/** appStore exports that read or write the WHOLE state; every other export is a named, narrow entry (`getNode`, `useNode`, `addToast`, `setSelectedId`, `selectOverviewNodes`…). */
export const APP_STORE_WIDE = ["getAppState", "useAppSelector", "setAppState", "setData", "subscribeApp"] as const;
const isAppStoreModule = (spec: string) => /(^|\/)appStore(\.ts)?$/.test(spec);

/** One use of a whole-state appStore entry: the export it names (`original`, whatever it was aliased to) and where. */
type AppStoreSite = { original: string; line: number; node: ts.Node };

/** Uses of a whole-state appStore entry (`APP_STORE_WIDE`), by the name imported (aliases and `import * as` included). The import itself is not a use.
 *  The one place that resolves which identifiers are the store's; the reach rule and the narrower rules below (inline selectors, writes) all read it. */
function appStoreReachSites(path: string, source: string): AppStoreSite[] {
  const file = parse(path, source);
  const wide = new Set<string>(APP_STORE_WIDE);
  const locals = new Map<string, string>(); // local name → the appStore export it stands for
  const namespaces = new Set<string>();
  const sites: AppStoreSite[] = [];
  for (const st of file.statements) {
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && isAppStoreModule(st.moduleSpecifier.text)) {
      const named = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements : [];
      if (!st.exportClause || named.some((el) => wide.has((el.propertyName ?? el.name).text))) sites.push({ original: "*", line: lineOf(file, st), node: st });
      continue;
    }
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !isAppStoreModule(st.moduleSpecifier.text)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else for (const el of bindings.elements) if (wide.has((el.propertyName ?? el.name).text)) locals.set(el.name.text, (el.propertyName ?? el.name).text);
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && locals.has(node.text) && !isNonReference(node)) sites.push({ original: locals.get(node.text)!, line: lineOf(file, node), node });
    else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text) && wide.has(node.name.text)) sites.push({ original: node.name.text, line: lineOf(file, node.name), node });
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}

/** Lines using a whole-state appStore entry (`APP_STORE_WIDE`). */
export const appStoreReachLines = (path: string, source: string): number[] => appStoreReachSites(path, source).map((s) => s.line);
export const appStoreReachUses = (path: string, source: string): number => appStoreReachLines(path, source).length;

/** The call `site` is the callee of (`useAppSelector(…)`, `store.useAppSelector(…)`), if any. */
function callOf(site: AppStoreSite): ts.CallExpression | undefined {
  const call = site.node.parent;
  return call && ts.isCallExpression(call) && call.expression === site.node ? call : undefined;
}

/** Lines of `useAppSelector((s) => …)` written in place. The shape of the state (`s.data.nodes`) is then known to the caller;
 *  a named selector / hook from lib/appStore (`useAppSelector(selectCanvases)`, `useNode(id)`) keeps it in one file.
 *  A subset of the whole-store reach (appStoreReachLines): the smaller number to drive down first. */
export function appStoreInlineSelectorLines(path: string, source: string): number[] {
  return appStoreReachSites(path, source)
    .filter((s) => s.original === "useAppSelector")
    .filter((s) => { const arg = callOf(s)?.arguments[0]; return !!arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)); })
    .map((s) => s.line);
}
export const appStoreInlineSelectorUses = (path: string, source: string): number => appStoreInlineSelectorLines(path, source).length;

/** Lines writing the store's state directly (`setData`, `setAppState`) instead of through a lib/data writer. A subset of the whole-store reach. */
export function appStoreWriteLines(path: string, source: string): number[] {
  return appStoreReachSites(path, source).filter((s) => s.original === "setData" || s.original === "setAppState").map((s) => s.line);
}
export const appStoreWriteUses = (path: string, source: string): number => appStoreWriteLines(path, source).length;

/** Lines calling `sendWrite(method, "/api/…", …)` with the server path spelled out in the caller (a string or template starting `/api/`).
 *  The path, body shape and idempotency key of a user action belong to its lib/data writer, not to the screen that offers the button. */
export function literalApiWriteLines(path: string, source: string): number[] {
  const file = parse(path, source);
  const lines: number[] = [];
  const isApiLiteral = (arg: ts.Expression) =>
    ((ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && arg.text.startsWith("/api/")) || (ts.isTemplateExpression(arg) && arg.head.text.startsWith("/api/"));
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "sendWrite" && node.arguments.some(isApiLiteral)) lines.push(lineOf(file, node));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}
export const literalApiWriteUses = (path: string, source: string): number => literalApiWriteLines(path, source).length;

/** Names given to app events on `window` (`onden:open-settings`, `onden-find-in-note`): the value of a `…EVENT` constant, or a literal passed to
 *  emitWindowEvent / onWindow / onDocument / CustomEvent / addEventListener. Distinct names across the app are counted by appStoreSurface.guard.test.ts. */
export function windowEventNames(path: string, source: string): string[] {
  const file = parse(path, source);
  const names: string[] = [];
  const own = (text: string) => /^onden[:-][a-z]/.test(text);
  const isText = (n: ts.Node | undefined): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
  const SENDERS = new Set(["emitWindowEvent", "onWindow", "onDocument", "CustomEvent", "addEventListener", "removeEventListener"]);
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /EVENT$/.test(node.name.text) && isText(node.initializer) && own(node.initializer.text)) names.push(node.initializer.text);
    else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : "";
      const first = node.arguments[0];
      if (SENDERS.has(callee) && isText(first) && own(first.text)) names.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/** Lines importing (or re-exporting from) hooks/useVirtualKeyboard: the on-screen keyboard's state has two readers, components/ui and lib/editorKeyboard. */
export function keyboardStateLines(path: string, source: string): number[] {
  const file = parse(path, source);
  const lines: number[] = [];
  const isIt = (spec: ts.Expression | undefined) => !!spec && ts.isStringLiteral(spec) && /(^|\/)useVirtualKeyboard(\.ts)?$/.test(spec.text);
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && isIt(node.moduleSpecifier)) lines.push(lineOf(file, node));
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && isIt(node.arguments[0])) lines.push(lineOf(file, node));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}
export const keyboardStateUses = (path: string, source: string): number => keyboardStateLines(path, source).length;

/** Lines using `EditorView.scrollMargins`: how far the caret stays from the editor's edges is decided in one place, lib/editorKeyboard. */
export function editorScrollMarginLines(path: string, source: string): number[] {
  const file = parse(path, source);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "scrollMargins") lines.push(lineOf(file, node.name));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}
export const editorScrollMarginUses = (path: string, source: string): number => editorScrollMarginLines(path, source).length;

/** Lines of a hand-written focus-keeping press handler: an `onMouseDown` / `onPointerDown` (JSX attribute or object property) whose
 *  function does nothing but `preventDefault()`, optionally behind an `if`, followed by at most one call (apply/select/pick).
 *  Drag handles, canvases and gestures prevent the default for other reasons and do more (capture a pointer, set state), so they
 *  have more statements and are not matched. The shared way to say it is components/ui `keepFocus`. */
export function focusStealLines(path: string, source: string): number[] {
  const file = parse(path, source);
  const lines: number[] = [];
  const isPrevent = (e: ts.Node): boolean => ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "preventDefault";
  const isCall = (n: ts.Node): boolean => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression);
  const preventing = (n: ts.Node): boolean => {
    if (ts.isExpressionStatement(n)) return isPrevent(n.expression);
    if (ts.isIfStatement(n) && !n.elseStatement) return ts.isBlock(n.thenStatement) ? n.thenStatement.statements.length === 1 && preventing(n.thenStatement.statements[0]!) : preventing(n.thenStatement);
    return false;
  };
  const keepsFocus = (fn: ts.Node): boolean => {
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
    const body = fn.body;
    if (!ts.isBlock(body)) return isPrevent(body);
    const st = body.statements;
    if (st.length === 0 || st.length > 2) return false;
    return preventing(st[0]!) && (st.length === 1 || isCall(st[1]!));
  };
  const isPress = (name: ts.Node) => (ts.isIdentifier(name)) && (name.text === "onMouseDown" || name.text === "onPointerDown");
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && isPress(node.name) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && keepsFocus(node.initializer.expression)) lines.push(lineOf(file, node));
    else if (ts.isPropertyAssignment(node) && isPress(node.name) && keepsFocus(node.initializer)) lines.push(lineOf(file, node));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}
export const focusStealUses = (path: string, source: string): number => focusStealLines(path, source).length;
