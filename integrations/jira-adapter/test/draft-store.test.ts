import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDraftStore } from "../draft-store.js";

const sampleDraft = {
  slackAccountId: "A1",
  slackWorkspaceId: "W1",
  slackChannelId: "C1",
  threadTs: "1700000000.000001",
  requesterUserId: "U1",
  snapshotCutoffTs: "1700000100.000002",
  title: "Create the deployment runbook",
  issueType: "Task" as const,
  description: "Document how to deploy the API safely.",
  references: ["https://example.test/runbook"],
  missingFields: [],
  priorityId: "3",
  epicKey: "ED-1",
};

function patch(title = "Edited deployment runbook") {
  return {
    title,
    issueType: "Bug" as const,
    description: "Document how to recover a failed API deployment.",
    priorityId: "2",
    epicKey: "ED-7",
  };
}

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "friday-jira-draft-store-"));
  return { directory, databasePath: path.join(directory, "friday-jira.sqlite") };
}

test("creates a private requester-bound draft without raw Slack transcripts", () => {
  const { directory, databasePath } = temporaryDatabase();
  const store = openDraftStore(databasePath);
  try {
    const created = store.create(sampleDraft, { now: 1_000, expiresAt: 61_000 });

    assert.equal(created.requesterUserId, "U1");
    assert.equal(created.version, 1);
    assert.deepEqual(created.references, ["https://example.test/runbook"]);
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);
    for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
      assert.equal(existsSync(sidecar), true, `${path.basename(sidecar)} must exist while the WAL store is open`);
      assert.equal(statSync(sidecar).mode & 0o777, 0o600);
    }

    const database = new DatabaseSync(databasePath);
    const columns = database.prepare("PRAGMA table_info(jira_drafts)").all() as Array<{ name: string }>;
    database.close();
    assert.equal(columns.some(({ name }) => /(?:raw|transcript|message)/i.test(name)), false);

    assert.throws(() => store.edit(created.id, 1, "U2", patch(), 2_000), /requester/i);
    assert.throws(() => store.approve(created.id, 1, "U2", 2_000), /requester/i);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("edits a current draft atomically and rejects stale or expired versions", () => {
  const { directory, databasePath } = temporaryDatabase();
  const store = openDraftStore(databasePath);
  try {
    const created = store.create(sampleDraft, { now: 1_000, expiresAt: 61_000 });
    const edited = store.edit(created.id, 1, "U1", patch(), 2_000);

    assert.equal(edited.version, 2);
    assert.equal(edited.status, "Edited");
    assert.equal(edited.title, "Edited deployment runbook");
    assert.equal(edited.priorityId, "2");
    assert.equal(edited.epicKey, "ED-7");
    assert.throws(() => store.edit(created.id, 1, "U1", patch("Stale update"), 3_000), /stale draft version/);
    assert.throws(() => store.edit(created.id, 2, "U1", patch("Expired update"), 61_000), /expired/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("permits only documented state transitions and immutable-state edits", () => {
  const { directory, databasePath } = temporaryDatabase();
  const store = openDraftStore(databasePath);
  try {
    const drafted = store.create(sampleDraft, { now: 1_000, expiresAt: 61_000 });
    const approved = store.approve(drafted.id, 1, "U1", 2_000);
    const creating = store.transition(approved.id, "Approved", "Creating", "U1", 3_000);

    assert.equal(creating.status, "Creating");
    assert.throws(() => store.transition(drafted.id, "Creating", "Edited", "U1", 4_000), /invalid transition/);
    assert.throws(() => store.edit(drafted.id, creating.version, "U1", patch(), 4_000), /cannot edit/i);

    const failed = store.markFailed(drafted.id, "jira-503", 5_000);
    assert.equal(failed.status, "Failed");
    assert.equal(store.transition(drafted.id, "Failed", "Creating", "U1", 6_000).status, "Creating");
    assert.throws(() => store.transition(drafted.id, "Creating", "Cancelled", "U1", 7_000), /invalid transition/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("derives and looks up the approval idempotency key, then records creation and link delivery", () => {
  const { directory, databasePath } = temporaryDatabase();
  const store = openDraftStore(databasePath);
  try {
    const drafted = store.create(sampleDraft, { now: 1_000, expiresAt: 61_000 });
    const approved = store.approve(drafted.id, 1, "U1", 2_000);

    const key = approved.idempotencyKey;
    assert.match(key ?? "", /^[a-f0-9]{64}$/);
    assert.ok(key);
    assert.equal(store.findByIdempotencyKey(key)?.id, drafted.id);
    assert.equal(store.findByIdempotencyKey("not-a-key"), undefined);

    store.transition(drafted.id, "Approved", "Creating", "U1", 3_000);
    const created = store.markCreated(drafted.id, "ED-99", "https://example.atlassian.net/browse/ED-99", 4_000);
    assert.equal(created.status, "Created");
    assert.equal(created.jiraIssueKey, "ED-99");
    assert.equal(created.linkPostStatus, "pending");
    const claim = store.claimLinkPost(drafted.id, "U1", 5_000);
    assert.equal(claim.claimed, true);
    assert.equal(claim.draft.linkPostStatus, "posting");
    assert.equal(store.markLinkPosted(drafted.id, "U1", 6_000).linkPostStatus, "posted");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("atomically rejects a stale approval and replays a matching approval without mutation", () => {
  const { directory, databasePath } = temporaryDatabase();
  const store = openDraftStore(databasePath);
  try {
    const drafted = store.create(sampleDraft, { now: 1_000, expiresAt: 61_000 });
    const edited = store.edit(drafted.id, 1, "U1", patch(), 2_000);

    assert.throws(() => store.approve(drafted.id, 1, "U1", 3_000), /stale draft version/);

    const approved = store.approve(drafted.id, edited.version, "U1", 4_000);
    const replayed = store.approve(drafted.id, edited.version, "U1", 61_000);
    assert.equal(replayed.status, "Approved");
    assert.equal(replayed.idempotencyKey, approved.idempotencyKey);

    const database = new DatabaseSync(databasePath);
    const row = database.prepare("SELECT updated_at FROM jira_drafts WHERE id = ?").get(drafted.id) as { updated_at: number };
    database.close();
    assert.equal(row.updated_at, 4_000);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("replays completed Jira and Slack mutations only when their result matches", () => {
  const { directory, databasePath } = temporaryDatabase();
  const store = openDraftStore(databasePath);
  try {
    const drafted = store.create(sampleDraft, { now: 1_000, expiresAt: 61_000 });
    store.approve(drafted.id, 1, "U1", 2_000);
    store.transition(drafted.id, "Approved", "Creating", "U1", 3_000);
    const created = store.markCreated(drafted.id, "ED-99", "https://example.atlassian.net/browse/ED-99", 4_000);
    const replayedCreation = store.markCreated(drafted.id, "ED-99", "https://example.atlassian.net/browse/ED-99", 5_000);
    assert.deepEqual(replayedCreation, created);
    assert.throws(() => store.markCreated(drafted.id, "ED-100", "https://example.atlassian.net/browse/ED-100", 6_000), /mismatched/i);

    assert.equal(store.claimLinkPost(drafted.id, "U1", 7_000).claimed, true);
    const posted = store.markLinkPosted(drafted.id, "U1", 8_000);
    assert.deepEqual(store.claimLinkPost(drafted.id, "U1", 9_000), { claimed: false, draft: posted });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("claims link delivery atomically and preserves an ambiguous posting claim", () => {
  const { directory, databasePath } = temporaryDatabase();
  const store = openDraftStore(databasePath);
  try {
    const drafted = store.create(sampleDraft, { now: 1_000, expiresAt: 61_000 });
    store.approve(drafted.id, 1, "U1", 2_000);
    store.transition(drafted.id, "Approved", "Creating", "U1", 3_000);
    store.markCreated(drafted.id, "ED-99", "https://example.atlassian.net/browse/ED-99", 4_000);

    assert.equal(store.claimLinkPost(drafted.id, "U1", 5_000).claimed, true);
    assert.deepEqual(store.claimLinkPost(drafted.id, "U1", 6_000), {
      claimed: false,
      draft: store.get(drafted.id),
    });
    assert.throws(() => store.claimLinkPost(drafted.id, "U2", 7_000), /requester/i);
    assert.equal(store.get(drafted.id)?.linkPostStatus, "posting");
    assert.equal(store.claimLinkPost(drafted.id, "U1", 9_000).claimed, false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restricts an existing database parent directory to the owner", () => {
  const { directory, databasePath } = temporaryDatabase();
  chmodSync(directory, 0o755);
  const store = openDraftStore(databasePath);
  try {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
