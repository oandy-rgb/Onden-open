// The modules this build ships, as the core sees them. registerModuleEffects
// (modules/index.ts) fills it, so a service can ask about modules without
// importing the registry, which imports every module and, through them, the
// routes.

const shipped = new Set<string>();

export function registerShippedModule(id: string): void {
  shipped.add(id);
}

const personalTables = new Set<string>();

/** Per-actor progress tables a module declares (ModuleDefinition.personalTables);
 *  removing a member deletes their rows from each (services/actors.ts). The
 *  names go into SQL, so only plain identifiers are accepted. */
export function registerPersonalTables(tables: readonly string[]): void {
  for (const table of tables) {
    if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new Error(`[modules] bad personal table name: ${table}`);
    personalTables.add(table);
  }
}

export function registeredPersonalTables(): string[] {
  return [...personalTables];
}

/** The module ids this build ships — TagPack import checks a pack's declared
 *  `modules` against this set to emit the (non-blocking) missing_modules
 *  warning. A pack's `modules` come from the tag functions switched on in
 *  its behaviour (services/tagPacks.ts); no module binds a tag by name. */
export function presentModuleIds(): Set<string> {
  return new Set(shipped);
}
