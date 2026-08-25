/**
 * Namespaced TTL cache for redacted PR snapshots.
 * The cache is an optimization only: callers fall back to the authoritative
 * controlled-fetch path whenever lookup or persistence fails.
 */
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface SnapshotStore<T = unknown> {
  lookup(key: string): Promise<T | undefined>;
  register(key: string, value: T, options?: { readonly ttlMs?: number }): Promise<void>;
}

/** Opens the cache database and creates isolated stores per schema version. */
export function openFridayCacheDatabase(databasePath: string) {
  // Phase 1: initialize a private generic cache table. Namespace is part of the
  // primary key so schema versions cannot accidentally reuse incompatible data.
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS cache_entries (
      namespace TEXT NOT NULL,
      entry_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (namespace, entry_key)
    );
    CREATE INDEX IF NOT EXISTS idx_friday_cache_expiry
      ON cache_entries(namespace, expires_at)
      WHERE expires_at IS NOT NULL;
  `);
  chmodSync(databasePath, 0o600);
  const deleteExpired = database.prepare(
    "DELETE FROM cache_entries WHERE namespace = ? AND expires_at IS NOT NULL AND expires_at <= ?",
  );
  const lookupEntry = database.prepare(`
    SELECT value_json FROM cache_entries
    WHERE namespace = ? AND entry_key = ?
      AND (expires_at IS NULL OR expires_at > ?)
  `);
  const upsertEntry = database.prepare(`
    INSERT INTO cache_entries(namespace, entry_key, value_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(namespace, entry_key) DO UPDATE SET
      value_json = excluded.value_json,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `);
  const deleteOldest = database.prepare(`
    DELETE FROM cache_entries
    WHERE namespace = ? AND entry_key IN (
      SELECT entry_key FROM cache_entries
      WHERE namespace = ?
      ORDER BY created_at ASC
      LIMIT MAX(0, (
        SELECT COUNT(*) FROM cache_entries WHERE namespace = ?
      ) - ?)
    )
  `);
  // Phase 2: each logical store closes over its namespace and capacity, exposing
  // no raw SQL or cross-namespace access to review code.
  return {
    openStore<T = unknown>({ namespace, maxEntries }: {
      readonly namespace: string;
      readonly maxEntries: number;
    }): SnapshotStore<T> {
      const safeMaxEntries = Math.max(1, Number(maxEntries) || 1);
      // Expired rows are removed first, then the oldest live rows are evicted to
      // enforce a deterministic per-namespace upper bound.
      const cleanup = () => {
        deleteExpired.run(namespace, Date.now());
        deleteOldest.run(namespace, namespace, namespace, safeMaxEntries);
      };
      return {
        async lookup(key: string): Promise<T | undefined> {
          cleanup();
          const row = lookupEntry.get(namespace, String(key), Date.now()) as { value_json: string } | undefined;
          return row ? JSON.parse(row.value_json) : undefined;
        },
        async register(key: string, value: T, options: { readonly ttlMs?: number } = {}): Promise<void> {
          const now = Date.now();
          const expiresAt = options.ttlMs ? now + options.ttlMs : null;
          upsertEntry.run(namespace, String(key), JSON.stringify(value), now, expiresAt);
          cleanup();
        },
      };
    },
    close() {
      database.close();
    },
  };
}
