# Slack runtime compatibility

This directory contains only deterministic transformations for two verified
gaps in `@openclaw/slack@2026.7.1`; it does not contain copied vendor bundles.

- `runIdPropagation` creates a new `crypto.randomUUID()` for every Slack turn
  and passes it through `replyOptions`, allowing Security Shield to bind tool
  authorization to that exact run.
- `identityRefresh` calls `auth.test` before every Socket Mode start/restart,
  validates the returned identity, and refreshes the mutable Slack context.

`manifest.json` pins the package version plus SHA-256 hashes of the pristine and
patched bundles. `patches.mjs` requires exact source anchors and is idempotent.
`scripts/slack-compat.mjs` refuses unknown versions, filenames, hashes, partial
patches, or ambiguous installations. Apply mode validates both flows before any
write, saves original files, and replaces each bundle atomically.

`--no-backup` is reserved for the Docker build, where install and patch happen
in one immutable image layer. Native setup always keeps rollback copies.

Read-only verification:

```bash
npm run setup:slack-compat -- --state-dir /absolute/openclaw/state
```

Explicit apply outside the full setup flow:

```bash
npm run setup:slack-compat:apply -- --state-dir /absolute/openclaw/state
```

The native full setup integrates check, pinned Slack installation, backup and
apply. The Dockerfile applies the same command during image build.
