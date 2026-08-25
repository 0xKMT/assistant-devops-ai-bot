import assert from "node:assert/strict";
import test from "node:test";
import { patchIdentityRefresh, patchRunIdPropagation } from "../patches.mjs";

test("runId patch is deterministic and idempotent", () => {
  const original = "\t\t\treplyOptions: {\n\t\t\t\tskillFilter: prepared.channelConfig?.skills,";
  const once = patchRunIdPropagation(original);
  assert.equal(once.state, "patched");
  assert.match(once.source, /runId: globalThis\.crypto\.randomUUID\(\)/);
  assert.deepEqual(patchRunIdPropagation(once.source), { source: once.source, state: "already-patched" });
});

test("identity patch refreshes the context before every socket start", () => {
  const original = [
    "\tconst trackEvent = opts.setStatus ? () => {",
    "\t\t\twhile (!opts.abortSignal?.aborted) try {",
    "\t\t\t\tconst disconnect = await startSlackSocketAndWaitForDisconnect({",
  ].join("\n");
  const once = patchIdentityRefresh(original);
  assert.equal(once.state, "patched");
  assert.match(once.source, /ctx\.apiAppId = refreshedApiAppId/);
  assert.match(once.source, /try \{\n\t\t\t\tawait refreshSlackIdentity\(\);/);
  assert.deepEqual(patchIdentityRefresh(once.source), { source: once.source, state: "already-patched" });
});

test("identity patch refuses a partially patched bundle", () => {
  const partial = [
    "\tconst refreshSlackIdentity = async () => {",
    "\tconst trackEvent = opts.setStatus ? () => {",
    "\t\t\twhile (!opts.abortSignal?.aborted) try {",
    "\t\t\t\tconst disconnect = await startSlackSocketAndWaitForDisconnect({",
  ].join("\n");
  assert.throws(() => patchIdentityRefresh(partial), /partial patch detected/);
});
