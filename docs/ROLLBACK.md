# Rollback

Native full setup creates a timestamped backup before changing OpenClaw
configuration or workspace. The state `.env` is backed up only when it existed
before `--write-env`.

```bash
find build/backups -maxdepth 2 -type f
npm run setup:rollback -- --config config/instance.json --backup build/backups/<timestamp>
```

The command prints the exact restore plan. After review:

```bash
npm run setup:rollback -- --config config/instance.json --backup build/backups/<timestamp> --apply
```

Rollback restores only artifacts present in the selected backup and restarts the
gateway. It does not delete newer unrelated files and never selects a backup
automatically. Re-run config validation, gateway/channel health checks, and the
[Acceptance Checklist](ACCEPTANCE.md) afterward.

Backups are local machine data and may contain private configuration or secrets;
they must not be committed or shared. Rollback does not remove OAuth/API
profiles created by login. Revoke those separately with the official provider or
OpenClaw logout command after verifying the intended account.

## Jira Workflow Recovery

Rollback disables the Jira workflow by restoring the selected OpenClaw
configuration/workspace snapshot and preserves `friday-jira.sqlite` in the
OpenClaw state directory for recovery and
reconciliation. The database contains requester-bound structured draft state,
idempotency keys, created issue URLs, and link-post state; it does not contain
raw Slack transcripts.

Before rolling back a partial or ambiguous create, make a filesystem backup of
the state directory using the platform's normal backup process and record the
draft ID, timestamp, and Jira audit evidence. Do not delete the database simply
to clear a failed draft: deleting `friday-jira.sqlite` and its possible `-wal`
and `-shm` sidecars is a separate destructive operator action that removes the
ability to safely reconcile or retry. Restore configuration first, then run
`openclaw plugins doctor`, Slack health checks, and the Jira acceptance cases.

For Container Edition, use the explicit archive flow in
[Container Setup](CONTAINER_SETUP.md#7-backup-and-rollback). It restores the
selected persistent volume but deliberately leaves Docker secret files alone.
