export const RENEWAL_SQL_FILE: string;
export const RENEWAL_FUNCTIONS: readonly ["sync_take_node_id", "sync_carried_labels", "sync_renew_node_id"];
export function lastDefinition(fn: string, migrations: readonly (readonly [string, string])[]): { file: string; sql: string } | undefined;
export function readMigrations(dir?: string): [string, string][];
export function keptTableDefinition(migrations: readonly (readonly [string, string])[]): { file: string; sql: string };
export function renewalSql(migrations: readonly (readonly [string, string])[]): string;
