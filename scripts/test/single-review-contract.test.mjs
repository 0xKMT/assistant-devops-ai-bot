import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const schema = await readFile(new URL("../../core/shared/src/schemas.ts", import.meta.url), "utf8");
const unified = await readFile(new URL("../../integrations/git-adapter/unified-review.ts", import.meta.url), "utf8");
const agentPolicy = await readFile(new URL("../../templates/workspace/AGENTS.md", import.meta.url), "utf8");

test("Slack review aliases cannot reintroduce a fast mode", () => {
  assert.doesNotMatch(schema, /reviewMode/);
  assert.doesNotMatch(schema, /outputDetail/);
  assert.doesNotMatch(unified, /reviewMode/);
  assert.match(agentPolicy, /`review`, `review nhanh`,\s+`review chi tiết`/);
  assert.match(agentPolicy, /same full review/);
});
