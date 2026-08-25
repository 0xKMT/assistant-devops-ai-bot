import test from "node:test";
import assert from "node:assert/strict";
import { defaultState, processGatewayLines } from "../friday-slack-watchdog.js";

test("tracks reconnect failures and clears them after identity refresh", () => {
  const state = defaultState();
  processGatewayLines(["slack auth.test failed at boot"], state);
  assert.equal(state.pendingReason, "auth-test-failed");
  processGatewayLines(["slack identity refreshed"], state);
  assert.equal(state.pendingReason, null);
});

test("detects blank identity and missing team failures", () => {
  const state = defaultState();
  processGatewayLines(["Inbound app_mention slack:: event"], state);
  assert.equal(state.pendingReason, "blank-slack-identity");
  processGatewayLines(["missing_recipient_team_id"], state);
  assert.equal(state.pendingReason, "missing-recipient-team");
});

test("valid inbound mention clears a stale failure", () => {
  const state = defaultState();
  state.pendingReason = "auth-test-failed";
  processGatewayLines(["Inbound app_mention slack:C123 event"], state);
  assert.equal(state.pendingReason, null);
});
