import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file) => readFile(path.join(root, file), "utf8");

test("Jira workflow names and safety constraints are documented", async () => {
  const [architecture, setup, acceptance, adapter, slack, rollback, troubleshooting] = await Promise.all([
    read("docs/ARCHITECTURE.md"), read("docs/FULL_SETUP.md"), read("docs/ACCEPTANCE.md"),
    read("integrations/jira-adapter/README.md"), read("docs/SLACK_APP.md"),
    read("docs/ROLLBACK.md"), read("docs/TROUBLESHOOTING.md"),
  ]);

  assert.match(architecture, /@friday\/jira-adapter/);
  assert.match(architecture, /five independent workspaces/i);
  assert.match(setup, /FRIDAY_JIRA_API_TOKEN/);
  assert.match(acceptance, /Approve & Create/);
  assert.match(acceptance, /No Epic/);
  assert.match(acceptance, /only the Jira ticket URL/i);
  assert.match(adapter, /explicit description.*primary/is);
  assert.match(adapter, /Task.*Bug.*Story/is);
  assert.match(adapter, /no Jira write before/i);
  assert.match(adapter, /friday-jira\.sqlite/);
  assert.match(slack, /Socket Mode callback/i);
  assert.match(rollback, /preserves?\s+`?friday-jira\.sqlite`?/i);
  assert.match(troubleshooting, /429/);
});
