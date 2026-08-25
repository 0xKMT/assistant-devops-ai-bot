import assert from "node:assert/strict";
import test from "node:test";
import { selectSuggestedEpic } from "../epic-matcher.js";

const candidates = [
  { key: "ED-12", summary: "Jira workflow", description: "", labels: [], components: [] },
];

test("preselects only a high-confidence candidate returned by Jira", () => {
  assert.equal(selectSuggestedEpic(candidates, { key: "ED-12", confidence: "high", evidence: "same objective" }), "ED-12");
  assert.equal(selectSuggestedEpic(candidates, { key: "ED-12", confidence: "medium", evidence: "weak" }), null);
  assert.equal(selectSuggestedEpic(candidates, { key: "OTHER-1", confidence: "high", evidence: "forged" }), null);
});
