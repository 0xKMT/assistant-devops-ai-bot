import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { evaluateCase, evaluateCases } from "../lib/golden-eval.mjs";

const root = path.resolve(import.meta.dirname, "../..");

const rows = [
  ["readonly-authorized", true, "ok", false],
  ["requester-denied", false, "not_called", false],
  ["tool-bounded-error", true, "bounded_error", false],
  ["jira-unapproved", true, "not_called", false],
].map(([id, authorized, toolStatus, jiraCreated]) => ({
  datasetVersion: "container-v1",
  id,
  observed: { authorized, toolStatus, jiraCreated },
  assert: { authorized, toolStatus, jiraCreated },
}));

test("four synthetic golden cases pass deterministically", () => {
  const results = evaluateCases(rows);
  assert.deepEqual(results.map(({ id, passed }) => ({ id, passed })), rows.map(({ id }) => ({ id, passed: true })));
  for (const row of rows) {
    const changed = { ...row, assert: { ...row.assert, authorized: !row.assert.authorized } };
    assert.deepEqual(evaluateCase(changed).failures, ["authorized"]);
  }
});

test("golden evaluator rejects unsupported assertions, duplicates, and mixed versions", () => {
  assert.throws(() => evaluateCase({ ...rows[0], assert: { ...rows[0].assert, unknown: true } }), /unknown|assert/i);
  assert.throws(() => evaluateCase({ ...rows[0], observed: { ...rows[0].observed, toolStatus: "unsafe" } }), /toolStatus/i);
  assert.throws(() => evaluateCases([rows[0], rows[0]]), /duplicate/i);
  assert.throws(() => evaluateCases([rows[0], { ...rows[1], datasetVersion: "container-v2" }]), /version/i);
});

test("golden runner emits identical bounded results on repeated runs", () => {
  const run = () => spawnSync(process.execPath, ["scripts/run-golden-eval.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  const first = run();
  const second = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.match(first.stdout, /"total":4,"passed":4,"failed":0/);
});
