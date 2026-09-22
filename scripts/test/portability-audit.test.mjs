import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { auditPortability } from "../lib/portability-audit.mjs";

const hostLocalPath = path.join(path.sep, "Users", "synthetic-owner", "private-repository");

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "friday-portability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("ignores generated GitNexus metadata containing a host-local path", async (t) => {
  const root = await temporaryRoot(t);
  await mkdir(path.join(root, ".gitnexus"));
  await writeFile(
    path.join(root, ".gitnexus", "meta.json"),
    JSON.stringify({ repoPath: hostLocalPath }),
  );

  assert.deepEqual(await auditPortability(root), []);
});

test("still reports a host-local path in distributable documentation", async (t) => {
  const root = await temporaryRoot(t);
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "leak.md"), `${hostLocalPath}\n`);

  assert.match((await auditPortability(root)).join("\n"), /docs\/leak\.md:1/);
});
