# Packaging Checklist

Before sharing Friday source with anyone, run:

```bash
npm ci
npm test
git status --ignored
```

The release artifact must contain tracked portable source only. Do not include:

- `node_modules/`, `dist/`, `build/`, or coverage output;
- `.DS_Store` and operating-system metadata;
- `config/instance.json` or `config/instance.container.json`;
- `.env*` files other than an intentional `.env.example`;
- tokens, OAuth profiles, credential stores, SQLite/WAL/SHM files, logs, cache,
  state, local repository clones, or instance-specific backup/history;
- `container/.env`, `container/secrets/`, or `container/backups/`;
- personal absolute paths, real Slack IDs, personal email addresses, or
  organization-specific repository data.

The root `.gitignore` protects runtime-local files from accidental staging. It
does not make a raw directory copy safe: create a release archive from tracked
files only, then perform an independent secret scan on that final artifact.

Do not publish until the owner has selected a license and completed the final
secret scan.
