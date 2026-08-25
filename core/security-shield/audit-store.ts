/**
 * Privacy-preserving security audit storage.
 * Identifiers are HMAC-hashed with a database-local salt; message content and
 * model output are deliberately never persisted.
 */
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SecurityAuditEvent {
  readonly decision: "allow" | "deny" | "sanitize";
  readonly reason: string;
  readonly accountId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly senderId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly sessionKey?: string | undefined;
  readonly timestamp?: number | undefined;
}

export interface SecurityAuditStore {
  record(event: SecurityAuditEvent): void;
  close(): void;
}

/** Opens the local audit database and returns its narrow record/close API. */
export function openSecurityAuditStore(databasePath: string, retentionDays = 30): SecurityAuditStore {
  // Phase 1: create a private WAL database and migrate only additive columns so
  // existing audit history remains readable across compatible upgrades.
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS security_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS security_audit(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER NOT NULL,
      decision TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      account_hash TEXT,
      workspace_hash TEXT,
      sender_hash TEXT,
      channel_hash TEXT,
      session_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_security_audit_time ON security_audit(occurred_at);
  `);
  const columns = new Set((database.prepare("PRAGMA table_info(security_audit)").all() as Array<{ name: string }>).map(({ name }) => name));
  if (!columns.has("account_hash")) database.exec("ALTER TABLE security_audit ADD COLUMN account_hash TEXT");
  if (!columns.has("workspace_hash")) database.exec("ALTER TABLE security_audit ADD COLUMN workspace_hash TEXT");
  chmodSync(databasePath, 0o600);
  // Phase 2: persist one random local salt. Stable hashes support correlation
  // inside this database but cannot be compared across Friday installations.
  const saltRow = database.prepare("SELECT value FROM security_meta WHERE key = 'audit_salt'").get() as { value?: string } | undefined;
  const salt = saltRow?.value || randomBytes(32).toString("hex");
  if (!saltRow?.value) database.prepare("INSERT INTO security_meta(key, value) VALUES ('audit_salt', ?)").run(salt);
  const insert = database.prepare(`
    INSERT INTO security_audit(occurred_at, decision, reason_code, account_hash, workspace_hash, sender_hash, channel_hash, session_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const prune = database.prepare("DELETE FROM security_audit WHERE occurred_at < ?");
  const hash = (value?: string): string | null => value
    ? createHmac("sha256", salt).update(value).digest("hex").slice(0, 24)
    : null;
  let nextPrune = 0;
  // Phase 3: insert only bounded reason codes and hashed identifiers. Retention
  // pruning is amortized to once per day rather than performed on every event.
  return {
    record(event) {
      const now = event.timestamp ?? Date.now();
      insert.run(now, event.decision, String(event.reason).slice(0, 80), hash(event.accountId), hash(event.workspaceId), hash(event.senderId), hash(event.channelId), hash(event.sessionKey));
      if (now >= nextPrune) {
        prune.run(now - Math.max(1, Math.min(90, retentionDays)) * 86_400_000);
        nextPrune = now + 86_400_000;
      }
    },
    close() { database.close(); },
  };
}
