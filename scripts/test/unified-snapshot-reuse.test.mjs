import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const unified = await readFile(new URL("../../integrations/git-adapter/unified-review.ts", import.meta.url), "utf8");
const terraform = await readFile(new URL("../../integrations/git-adapter/terraform-review.ts", import.meta.url), "utf8");
const gitops = await readFile(new URL("../../integrations/git-adapter/gitops-review.ts", import.meta.url), "utf8");

test("Unified Review reuses one prepared snapshot across applicable engines", () => {
  assert.match(unified, /reviewTerraformPullRequest\(params, \{ snapshot \}\)/);
  assert.match(unified, /reviewGitOpsPullRequest\(params, \{ snapshot \}\)/);
  assert.match(terraform, /preparedSnapshot \?\? await preparePullRequest/);
  assert.match(gitops, /preparedSnapshot \?\? await preparePullRequest/);
});
