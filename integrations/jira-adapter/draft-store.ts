/** Durable, private workflow state for requester-approved Jira drafts. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JiraDraftInput, JiraIssueType } from "@friday/shared";

export type DraftStatus =
  | "Drafted" | "Edited" | "Approved" | "Creating"
  | "Created" | "Failed" | "Cancelled";

export type DraftRecord = Omit<JiraDraftInput, "epicKey" | "storyPoints"> & {
  readonly id: string;
  readonly version: number;
  readonly status: DraftStatus;
  readonly priorityId: string;
  readonly epicKey: string | null;
  readonly storyPoints?: string | null;
  readonly expiresAt: number;
  readonly idempotencyKey: string | null;
  readonly jiraIssueKey: string | null;
  readonly jiraIssueUrl: string | null;
  readonly failureCode: string | null;
  readonly linkPostStatus: "pending" | "posting" | "posted";
};

export interface LinkPostClaim {
  readonly claimed: boolean;
  readonly draft: DraftRecord;
}

export interface EditableDraftPatch {
  readonly title: string;
  readonly issueType: JiraIssueType;
  readonly description: string;
  readonly priorityId: string;
  readonly epicKey: string | null;
  readonly storyPoints?: string | null;
}

export interface DraftStore {
  create(input: JiraDraftInput & { priorityId: string; epicKey: string | null }, timing: { now: number; expiresAt: number }): DraftRecord;
  get(id: string): DraftRecord | undefined;
  edit(id: string, expectedVersion: number, requesterUserId: string, patch: EditableDraftPatch, now: number): DraftRecord;
  approve(id: string, expectedVersion: number, requesterUserId: string, now: number): DraftRecord;
  transition(id: string, expected: DraftStatus, next: DraftStatus, requesterUserId: string, now: number): DraftRecord;
  markCreated(id: string, issueKey: string, issueUrl: string, now: number): DraftRecord;
  markFailed(id: string, failureCode: string, now: number): DraftRecord;
  claimLinkPost(id: string, requesterUserId: string, now: number): LinkPostClaim;
  resetLinkPost(id: string, requesterUserId: string, now: number): DraftRecord;
  markLinkPosted(id: string, requesterUserId: string, now: number): DraftRecord;
  findByIdempotencyKey(key: string): DraftRecord | undefined;
  close(): void;
}

type DraftRow = {
  readonly id: string;
  readonly slack_account_id: string;
  readonly slack_workspace_id: string;
  readonly slack_channel_id: string;
  readonly thread_ts: string;
  readonly requester_user_id: string;
  readonly snapshot_cutoff_ts: string;
  readonly draft_version: number;
  readonly title: string;
  readonly issue_type: JiraIssueType;
  readonly description: string;
  readonly references_json: string;
  readonly missing_fields_json: string;
  readonly epic_key: string | null;
  readonly epic_confidence: Exclude<JiraDraftInput["epicConfidence"], undefined> | null;
  readonly epic_evidence: string | null;
  readonly priority_id: string;
  readonly story_points: string | null;
  readonly status: DraftStatus;
  readonly expires_at: number;
  readonly idempotency_key: string | null;
  readonly jira_issue_key: string | null;
  readonly jira_issue_url: string | null;
  readonly failure_code: string | null;
  readonly link_post_status: "pending" | "posting" | "posted";
};

const transitions: Readonly<Record<DraftStatus, readonly DraftStatus[]>> = {
  Drafted: ["Edited", "Approved", "Cancelled"],
  Edited: ["Edited", "Approved", "Cancelled"],
  Approved: ["Creating"],
  Creating: ["Created", "Failed"],
  Created: [],
  Failed: ["Creating"],
  Cancelled: [],
};

function record(row: DraftRow): DraftRecord {
  const base: Omit<DraftRecord, "epicConfidence" | "epicEvidence"> = {
    id: row.id,
    slackAccountId: row.slack_account_id,
    slackWorkspaceId: row.slack_workspace_id,
    slackChannelId: row.slack_channel_id,
    threadTs: row.thread_ts,
    requesterUserId: row.requester_user_id,
    snapshotCutoffTs: row.snapshot_cutoff_ts,
    version: row.draft_version,
    title: row.title,
    issueType: row.issue_type,
    description: row.description,
    references: JSON.parse(row.references_json) as string[],
    missingFields: JSON.parse(row.missing_fields_json) as string[],
    priorityId: row.priority_id,
    epicKey: row.epic_key,
    ...(row.story_points === null ? {} : { storyPoints: row.story_points }),
    status: row.status,
    expiresAt: row.expires_at,
    idempotencyKey: row.idempotency_key,
    jiraIssueKey: row.jira_issue_key,
    jiraIssueUrl: row.jira_issue_url,
    failureCode: row.failure_code,
    linkPostStatus: row.link_post_status,
  };
  return {
    ...base,
    ...(row.epic_confidence === null ? {} : { epicConfidence: row.epic_confidence }),
    ...(row.epic_evidence === null ? {} : { epicEvidence: row.epic_evidence }),
  };
}

function idempotencyKey(id: string, approvedVersion: number): string {
  return createHash("sha256").update(`${id}:${approvedVersion}`).digest("hex");
}

function setOwnerOnly(databasePath: string): void {
  for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(file)) chmodSync(file, 0o600);
  }
}

/** Opens a private SQLite database containing only structured Jira draft state. */
export function openDraftStore(databasePath: string): DraftStore {
  const databaseDirectory = path.dirname(databasePath);
  mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
  chmodSync(databaseDirectory, 0o700);
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS jira_drafts (
      id TEXT PRIMARY KEY,
      slack_account_id TEXT NOT NULL,
      slack_workspace_id TEXT NOT NULL,
      slack_channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      snapshot_cutoff_ts TEXT NOT NULL,
      draft_version INTEGER NOT NULL,
      title TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      description TEXT NOT NULL,
      references_json TEXT NOT NULL,
      missing_fields_json TEXT NOT NULL,
      epic_key TEXT,
      epic_confidence TEXT,
      epic_evidence TEXT,
      priority_id TEXT NOT NULL,
      story_points TEXT,
      status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      idempotency_key TEXT UNIQUE,
      jira_issue_key TEXT,
      jira_issue_url TEXT,
      failure_code TEXT,
      link_post_status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jira_drafts_idempotency
      ON jira_drafts(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);
  const columns = database.prepare("PRAGMA table_info(jira_drafts)").all() as Array<{ name?: unknown }>;
  if (!columns.some((column) => column.name === "story_points")) {
    database.exec("ALTER TABLE jira_drafts ADD COLUMN story_points TEXT");
  }
  setOwnerOnly(databasePath);

  const byId = database.prepare("SELECT * FROM jira_drafts WHERE id = ?");
  const byIdempotencyKey = database.prepare("SELECT * FROM jira_drafts WHERE idempotency_key = ?");
  const insert = database.prepare(`
    INSERT INTO jira_drafts(
      id, slack_account_id, slack_workspace_id, slack_channel_id, thread_ts,
      requester_user_id, snapshot_cutoff_ts, draft_version, title, issue_type,
      description, references_json, missing_fields_json, epic_key, epic_confidence,
      epic_evidence, priority_id, story_points, status, expires_at, idempotency_key,
      jira_issue_key, jira_issue_url, failure_code, link_post_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateEdit = database.prepare(`
    UPDATE jira_drafts SET
      title = ?, issue_type = ?, description = ?, priority_id = ?, epic_key = ?, story_points = ?,
      status = 'Edited', draft_version = draft_version + 1, updated_at = ?
    WHERE id = ? AND requester_user_id = ? AND draft_version = ?
      AND status IN ('Drafted', 'Edited')
  `);
  const updateTransition = database.prepare(`
    UPDATE jira_drafts SET status = ?, idempotency_key = ?, updated_at = ?
    WHERE id = ? AND requester_user_id = ? AND status = ?
  `);
  const approveDraft = database.prepare(`
    UPDATE jira_drafts SET status = 'Approved', idempotency_key = ?, updated_at = ?
    WHERE id = ? AND requester_user_id = ? AND draft_version = ?
      AND status IN ('Drafted', 'Edited')
  `);
  const updateCreated = database.prepare(`
    UPDATE jira_drafts SET
      status = 'Created', jira_issue_key = ?, jira_issue_url = ?, failure_code = NULL, updated_at = ?
    WHERE id = ? AND status = 'Creating'
  `);
  const updateFailed = database.prepare(`
    UPDATE jira_drafts SET status = 'Failed', failure_code = ?, updated_at = ?
    WHERE id = ? AND status = 'Creating'
  `);
  const claimLinkPost = database.prepare(`
    UPDATE jira_drafts SET link_post_status = 'posting', updated_at = ?
    WHERE id = ? AND requester_user_id = ? AND status = 'Created'
      AND link_post_status = 'pending'
  `);
  const resetLinkPost = database.prepare(`
    UPDATE jira_drafts SET link_post_status = 'pending', updated_at = ?
    WHERE id = ? AND requester_user_id = ? AND status = 'Created'
      AND link_post_status = 'posting'
  `);
  const updateLinkPosted = database.prepare(`
    UPDATE jira_drafts SET link_post_status = 'posted', updated_at = ?
    WHERE id = ? AND requester_user_id = ? AND status = 'Created'
      AND link_post_status = 'posting'
  `);

  const get = (id: string): DraftRecord | undefined => {
    const row = byId.get(id) as DraftRow | undefined;
    return row ? record(row) : undefined;
  };
  const requireDraft = (id: string): DraftRecord => {
    const draft = get(id);
    if (!draft) throw new Error("draft not found");
    return draft;
  };
  const requireRequester = (draft: DraftRecord, requesterUserId: string): void => {
    if (draft.requesterUserId !== requesterUserId) throw new Error("draft requester mismatch");
  };
  const requireLive = (draft: DraftRecord, now: number): void => {
    if (draft.expiresAt <= now) throw new Error("draft expired");
  };
  const changes = (result: unknown): number => (result as { changes: number }).changes;

  return {
    create(input, timing) {
      const id = randomUUID();
      insert.run(
        id, input.slackAccountId, input.slackWorkspaceId, input.slackChannelId, input.threadTs,
        input.requesterUserId, input.snapshotCutoffTs, 1, input.title, input.issueType,
        input.description, JSON.stringify(input.references), JSON.stringify(input.missingFields), input.epicKey,
        input.epicConfidence ?? null, input.epicEvidence ?? null, input.priorityId, input.storyPoints ?? null, "Drafted", timing.expiresAt,
        null, null, null, null, "pending", timing.now, timing.now,
      );
      setOwnerOnly(databasePath);
      return requireDraft(id);
    },

    get,

    edit(id, expectedVersion, requesterUserId, patch, now) {
      const draft = requireDraft(id);
      requireRequester(draft, requesterUserId);
      requireLive(draft, now);
      if (draft.version !== expectedVersion) throw new Error("stale draft version");
      if (draft.status !== "Drafted" && draft.status !== "Edited") throw new Error("cannot edit draft in its current state");

      database.exec("BEGIN IMMEDIATE");
      try {
        if (changes(updateEdit.run(
          patch.title, patch.issueType, patch.description, patch.priorityId, patch.epicKey, patch.storyPoints ?? null,
          now, id, requesterUserId, expectedVersion,
        )) !== 1) throw new Error("stale draft version");
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      setOwnerOnly(databasePath);
      return requireDraft(id);
    },

    approve(id, expectedVersion, requesterUserId, now) {
      const draft = requireDraft(id);
      requireRequester(draft, requesterUserId);
      if (draft.version !== expectedVersion) throw new Error("stale draft version");
      const key = idempotencyKey(id, expectedVersion);
      if (draft.status === "Approved" || draft.status === "Creating" || draft.status === "Created") {
        if (draft.idempotencyKey === key) return draft;
        throw new Error("stale draft status");
      }
      requireLive(draft, now);
      if (draft.status !== "Drafted" && draft.status !== "Edited") throw new Error("invalid transition");
      if (changes(approveDraft.run(key, now, id, requesterUserId, expectedVersion)) !== 1) {
        const current = requireDraft(id);
        requireRequester(current, requesterUserId);
        if (current.version !== expectedVersion) throw new Error("stale draft version");
        if ((current.status === "Approved" || current.status === "Creating" || current.status === "Created")
          && current.idempotencyKey === key) return current;
        throw new Error("stale draft status");
      }
      setOwnerOnly(databasePath);
      return requireDraft(id);
    },

    transition(id, expected, next, requesterUserId, now) {
      const draft = requireDraft(id);
      requireRequester(draft, requesterUserId);
      requireLive(draft, now);
      if (draft.status !== expected) throw new Error("stale draft status");
      if (next === "Approved") throw new Error("approval requires a draft version");
      if (!transitions[expected].includes(next)) throw new Error("invalid transition");
      if (changes(updateTransition.run(next, draft.idempotencyKey, now, id, requesterUserId, expected)) !== 1) {
        throw new Error("stale draft status");
      }
      setOwnerOnly(databasePath);
      return requireDraft(id);
    },

    markCreated(id, issueKey, issueUrl, now) {
      const draft = requireDraft(id);
      if (draft.status === "Created") {
        if (draft.jiraIssueKey === issueKey && draft.jiraIssueUrl === issueUrl) return draft;
        throw new Error("mismatched Jira creation result");
      }
      if (draft.status !== "Creating" || changes(updateCreated.run(issueKey, issueUrl, now, id)) !== 1) {
        const current = requireDraft(id);
        if (current.status === "Created") {
          if (current.jiraIssueKey === issueKey && current.jiraIssueUrl === issueUrl) return current;
          throw new Error("mismatched Jira creation result");
        }
        throw new Error("invalid transition");
      }
      setOwnerOnly(databasePath);
      return requireDraft(id);
    },

    markFailed(id, failureCode, now) {
      if (changes(updateFailed.run(failureCode, now, id)) !== 1) throw new Error("invalid transition");
      setOwnerOnly(databasePath);
      return requireDraft(id);
    },

    claimLinkPost(id, requesterUserId, now) {
      const draft = requireDraft(id);
      requireRequester(draft, requesterUserId);
      if (draft.status !== "Created") throw new Error("invalid transition");
      if (draft.linkPostStatus !== "pending") return { claimed: false, draft };
      if (changes(claimLinkPost.run(now, id, requesterUserId)) !== 1) {
        const current = requireDraft(id);
        requireRequester(current, requesterUserId);
        if (current.status === "Created" && current.linkPostStatus !== "pending") {
          return { claimed: false, draft: current };
        }
        throw new Error("invalid transition");
      }
      setOwnerOnly(databasePath);
      return { claimed: true, draft: requireDraft(id) };
    },

    resetLinkPost(id, requesterUserId, now) {
      const draft = requireDraft(id);
      requireRequester(draft, requesterUserId);
      if (draft.status !== "Created") throw new Error("invalid transition");
      if (draft.linkPostStatus === "pending") return draft;
      if (draft.linkPostStatus === "posted") throw new Error("invalid transition");
      if (changes(resetLinkPost.run(now, id, requesterUserId)) !== 1) throw new Error("invalid transition");
      setOwnerOnly(databasePath);
      return requireDraft(id);
    },

    markLinkPosted(id, requesterUserId, now) {
      const draft = requireDraft(id);
      requireRequester(draft, requesterUserId);
      if (draft.status !== "Created") throw new Error("invalid transition");
      if (draft.linkPostStatus === "posted") return draft;
      if (draft.linkPostStatus !== "posting" || changes(updateLinkPosted.run(now, id, requesterUserId)) !== 1) {
        const current = requireDraft(id);
        requireRequester(current, requesterUserId);
        if (current.status === "Created" && current.linkPostStatus === "posted") return current;
        throw new Error("invalid transition");
      }
      setOwnerOnly(databasePath);
      return requireDraft(id);
    },

    findByIdempotencyKey(key) {
      const row = byIdempotencyKey.get(key) as DraftRow | undefined;
      return row ? record(row) : undefined;
    },

    close() {
      database.close();
    },
  };
}
