import assert from "node:assert/strict";
import test from "node:test";
import { jiraContextSchema, jiraPrepareTicketSchema } from "./schemas.js";

test("Jira context schema exposes no model-controlled Slack identity", () => {
  assert.equal(jiraContextSchema.additionalProperties, false);
  assert.equal("required" in jiraContextSchema, false);
  assert.deepEqual(Object.keys(jiraContextSchema.properties), []);
});

test("Jira preparation schema accepts only Task Bug or Story", () => {
  assert.equal(jiraPrepareTicketSchema.additionalProperties, false);
  for (const identity of [
    "slackAccountId", "slackWorkspaceId", "slackChannelId",
    "threadTs", "requesterUserId", "snapshotCutoffTs",
  ]) {
    assert.equal(identity in jiraPrepareTicketSchema.properties, false);
    assert.equal((jiraPrepareTicketSchema.required as readonly string[]).includes(identity), false);
  }
  assert.deepEqual(jiraPrepareTicketSchema.properties.issueType.enum, ["Task", "Bug", "Story"]);
  assert.equal(jiraPrepareTicketSchema.properties.references.maxItems, 20);
  assert.equal(jiraPrepareTicketSchema.properties.missingFields.maxItems, 10);
});
