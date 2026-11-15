type Suffix = 'test' | 'bench' | 'drill';
export function databaseName(url: string | undefined): string;
export function isLocalDatabaseHost(url: string | undefined): boolean;
export function isDisposableDatabase(url: string | undefined, suffix: Suffix, opts?: { localOnly?: boolean }): boolean;
export function assertDisposableDatabase(url: string | undefined, suffix: Suffix, opts?: { localOnly?: boolean }): string;
