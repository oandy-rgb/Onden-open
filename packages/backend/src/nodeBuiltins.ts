// Node built-ins that only some code paths need (reading migration files, the
// default request-context provider). Looked up at call time through
// process.getBuiltinModule instead of a static `node:` import, so a bundle for a
// browser worker or desktop shell never has to resolve or alias them: where
// they do not exist the lookup answers undefined and the caller says what to
// install instead (see docs/architecture/portable-backend.md).

export function nodeBuiltin<T>(id: `node:${string}`): T | undefined {
  const getBuiltin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule;
  return getBuiltin?.(id) as T | undefined;
}
