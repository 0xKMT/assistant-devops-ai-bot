import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createJiraClient, JiraClientError } from "../jira-client.js";
import { parseJiraRuntimeConfig } from "../runtime-config.js";

const rawConfig = {
  jira: {
    baseUrl: "https://everfit.atlassian.net",
    emailEnv: "FRIDAY_JIRA_EMAIL",
    apiTokenEnv: "FRIDAY_EVERFIT_JIRA_API_TOKEN",
    projectId: "10001",
    projectKey: "ED",
    assigneeAccountId: "712020:tri",
    defaultPriorityId: "3",
    storyPointFieldId: "customfield_10028",
    allowedIssueTypes: { Task: "10010", Bug: "10011", Story: "10012" },
    epicJql: "project = ED AND issuetype = Epic AND statusCategory != Done",
    maxEpicCandidates: 25,
  },
  slack: { accountId: "everfit", workspaceId: "T-EVERFIT", botTokenEnv: "FRIDAY_EVERFIT_SLACK_BOT_TOKEN" },
  workflow: { draftTtlMinutes: 1440, maxCreateAttempts: 3 },
};

const config = parseJiraRuntimeConfig(rawConfig, {
  FRIDAY_JIRA_EMAIL: "tri@example.com",
  FRIDAY_EVERFIT_JIRA_API_TOKEN: "jira-token-not-for-errors",
  FRIDAY_EVERFIT_SLACK_BOT_TOKEN: "xoxb-secret",
});

const projectMetadata = {
  issueTypes: [
    { id: "10010", name: "Task" },
    { id: "10011", name: "Bug" },
    { id: "10012", name: "Story" },
  ],
  priorities: [{ id: "3", name: "Medium" }],
};

const activeEpic = {
  key: "ED-12",
  fields: {
    summary: "Jira workflow",
    description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Improve triage" }] }] },
    labels: ["triage"],
    components: [{ name: "Platform" }],
  },
};

type SeenRequest = { readonly url: string; readonly method: string; readonly headers: Headers; readonly body: unknown };

function json(status: number, value: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function fakeFetch(responses: readonly Response[], seen: SeenRequest[]): typeof fetch {
  let index = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    seen.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" ? undefined : JSON.parse(await request.text()),
    });
    const response = responses[index++];
    if (!response) throw new Error("unexpected Jira request");
    return response;
  }) as typeof fetch;
}

const approvedInput = {
  title: "Create Jira ticket from Slack",
  issueType: "Task" as const,
  description: "First line\nSecond line",
  priorityId: "3",
  epicKey: null,
  correlationId: "draft-123:2",
};

test("loads only configured project metadata and bounded active Epics", async () => {
  const seen: SeenRequest[] = [];
  const client = createJiraClient(config, fakeFetch([
    json(200, projectMetadata),
    json(200, { issues: [activeEpic] }),
  ], seen));

  const context = await client.getContext();

  assert.deepEqual(context.project, { id: "10001", key: "ED", name: "Everfit Devops" });
  assert.equal(context.epicCandidates.length, 1);
  assert.match(seen[0]?.url ?? "", /\/rest\/api\/3\/issue\/createmeta\/10001\/issuetypes$/);
  assert.match(seen[1]?.url ?? "", /\/rest\/api\/3\/search\/jql$/);
  assert.deepEqual(seen[1]?.body, {
    jql: "project = ED AND issuetype = Epic AND statusCategory != Done",
    fields: ["summary", "description", "labels", "components"],
    maxResults: 25,
  });
});

test("creates an ADF issue with configured identities and an atomic correlation label", async () => {
  const seen: SeenRequest[] = [];
  const client = createJiraClient(config, fakeFetch([
    json(200, { fields: [
      { fieldId: "labels" },
      { fieldId: "priority", allowedValues: [{ id: "3" }, { id: "2" }] },
    ] }),
    json(201, { key: "ED-101", self: "https://everfit.atlassian.net/rest/api/3/issue/10001" }),
  ], seen));

  const created = await client.createIssue(approvedInput);
  const label = `friday-correlation-${createHash("sha256").update("draft-123:2").digest("hex")}`;

  assert.deepEqual(created, { key: "ED-101", url: "https://everfit.atlassian.net/browse/ED-101" });
  assert.match(seen[0]?.url ?? "", /\/rest\/api\/3\/issue\/createmeta\/10001\/issuetypes\/10010$/);
  assert.deepEqual(seen[1]?.body, {
    fields: {
      project: { id: "10001" },
      issuetype: { id: "10010" },
      assignee: { accountId: "712020:tri" },
      priority: { id: "3" },
      summary: "Create Jira ticket from Slack",
      description: {
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "First line" }] },
          { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
        ],
      },
      labels: [label],
    },
  });
  assert.equal("parent" in (seen[1]?.body as { fields: object }).fields, false);
});

test("sends the validated numeric story point estimate to Everfit's configured field", async () => {
  const seen: SeenRequest[] = [];
  const client = createJiraClient(config, fakeFetch([
    json(200, { fields: [
      { fieldId: "labels" },
      { fieldId: "priority", allowedValues: [{ id: "3" }] },
      { fieldId: "customfield_10028" },
    ] }),
    json(201, { key: "ED-102" }),
  ], seen));

  await client.createIssue({ ...approvedInput, storyPoints: "5" });
  assert.equal((seen[1]?.body as { fields: Record<string, unknown> }).fields.customfield_10028, 5);
});

test("fails closed when Jira's create screen omits Story point estimate", async () => {
  const seen: SeenRequest[] = [];
  const client = createJiraClient(config, fakeFetch([
    json(200, { fields: [
      { fieldId: "labels" },
      { fieldId: "priority", allowedValues: [{ id: "3" }] },
    ] }),
  ], seen));

  await assert.rejects(
    client.createIssue({ ...approvedInput, storyPoints: "5" }),
    (error: unknown) => error instanceof JiraClientError && error.code === "JIRA_METADATA_INVALID",
  );
  assert.equal(seen.length, 1);
});

test("accepts an editable priority offered by selected create metadata", async () => {
  const seen: SeenRequest[] = [];
  const client = createJiraClient(config, fakeFetch([
    json(200, { fields: [
      { fieldId: "labels" },
      { fieldId: "priority", allowedValues: [{ id: "3" }, { id: "2" }] },
    ] }),
    json(201, { key: "ED-102" }),
  ], seen));

  const created = await client.createIssue({ ...approvedInput, priorityId: "2" });

  assert.equal(created.key, "ED-102");
  assert.equal((seen[1]?.body as { fields: { priority: { id: string } } }).fields.priority.id, "2");
});

test("rejects a priority absent from selected create metadata before issue creation", async () => {
  const seen: SeenRequest[] = [];
  const client = createJiraClient(config, fakeFetch([json(200, { fields: [
    { fieldId: "labels" },
    { fieldId: "priority", allowedValues: [{ id: "3" }, { id: "2" }] },
  ] })], seen));

  await assert.rejects(
    client.createIssue({ ...approvedInput, priorityId: "999" }),
    (error: unknown) => error instanceof JiraClientError && error.code === "JIRA_METADATA_INVALID",
  );
  assert.equal(seen.length, 1);
});

test("fails closed when the selected create screen does not allow correlation labels", async () => {
  const seen: SeenRequest[] = [];
  const client = createJiraClient(config, fakeFetch([json(200, { fields: [
    { fieldId: "summary" },
    { fieldId: "priority", allowedValues: [{ id: "3" }] },
  ] })], seen));

  await assert.rejects(client.createIssue(approvedInput), (error: unknown) => error instanceof JiraClientError && error.code === "JIRA_METADATA_INVALID");
  assert.equal(seen.length, 1);
});

test("reconciles only the configured project and exact derived label", async () => {
  const seen: SeenRequest[] = [];
  const client = createJiraClient(config, fakeFetch([json(200, { issues: [{ key: "ED-101" }] })], seen));

  const result = await client.findByCorrelationId("draft-123:2");

  assert.deepEqual(result, { key: "ED-101", url: "https://everfit.atlassian.net/browse/ED-101" });
  assert.deepEqual(seen[0]?.body, {
    jql: `project = ED AND labels = "friday-correlation-${createHash("sha256").update("draft-123:2").digest("hex")}"`,
    fields: [],
    maxResults: 2,
  });
});

test("fails closed rather than choosing a duplicate reconciliation result", async () => {
  const client = createJiraClient(config, fakeFetch([json(200, { issues: [{ key: "ED-101" }, { key: "ED-102" }] })], []));
  await assert.rejects(client.findByCorrelationId("draft-123:2"), (error: unknown) => error instanceof JiraClientError && error.code === "JIRA_RECONCILIATION_AMBIGUOUS");
});

test("classifies authentication, throttling, and server errors without leaking Basic credentials", async () => {
  for (const [status, expectedCode, headers] of [
    [401, "JIRA_AUTH", {}],
    [403, "JIRA_FORBIDDEN", {}],
    [429, "JIRA_RATE_LIMITED", { "retry-after": "120" }],
    [503, "JIRA_TRANSIENT", {}],
  ] as const) {
    const seen: SeenRequest[] = [];
    const client = createJiraClient(config, fakeFetch([json(status, { errorMessages: ["jira-token-not-for-errors"] }, headers)], seen));
    await assert.rejects(client.getContext(), (error: unknown) => {
      assert.ok(error instanceof JiraClientError);
      assert.equal(error.code, expectedCode);
      assert.equal(error.message.includes("jira-token-not-for-errors"), false);
      if (status === 429) assert.equal(error.retryAfterMs, 30_000);
      return true;
    });
    assert.equal(seen.length, 1);
    assert.match(seen[0]?.headers.get("authorization") ?? "", /^Basic (?!jira-token-not-for-errors$)/);
  }
});

test("marks a server failure after Jira create dispatch as an ambiguous sent outcome", async () => {
  const seen: SeenRequest[] = [];
  const client = createJiraClient(config, fakeFetch([
    json(200, { fields: [
      { fieldId: "labels" },
      { fieldId: "priority", allowedValues: [{ id: "3" }] },
    ] }),
    json(503, { errorMessages: ["accepted state unknown"] }),
  ], seen));

  await assert.rejects(client.createIssue(approvedInput), (error: unknown) => {
    assert.ok(error instanceof JiraClientError);
    assert.equal(error.code, "JIRA_TRANSIENT");
    assert.equal((error as JiraClientError & { createRequestSent?: boolean }).createRequestSent, true);
    return true;
  });
  assert.equal(seen.filter((request) => request.method === "POST" && request.url.endsWith("/issue")).length, 1);
});

test("marks a malformed success response after Jira create dispatch as an ambiguous sent outcome", async () => {
  const seen: SeenRequest[] = [];
  const client = createJiraClient(config, fakeFetch([
    json(200, { fields: [
      { fieldId: "labels" },
      { fieldId: "priority", allowedValues: [{ id: "3" }] },
    ] }),
    json(201, { id: "accepted-without-key" }),
  ], seen));

  await assert.rejects(client.createIssue(approvedInput), (error: unknown) => {
    assert.ok(error instanceof JiraClientError);
    assert.equal(error.code, "JIRA_RESPONSE_INVALID");
    assert.equal(error.createRequestSent, true);
    return true;
  });
  assert.equal(seen.filter((request) => request.method === "POST" && request.url.endsWith("/issue")).length, 1);
});

test("rejects malformed and oversized Jira responses", async () => {
  const malformed = createJiraClient(config, fakeFetch([json(200, { issueTypes: "not-an-array" })], []));
  await assert.rejects(malformed.getContext(), (error: unknown) => error instanceof JiraClientError && error.code === "JIRA_RESPONSE_INVALID");

  const oversized = createJiraClient(config, fakeFetch([
    json(200, projectMetadata),
    json(200, { issues: Array.from({ length: 26 }, () => activeEpic) }),
  ], []));
  await assert.rejects(oversized.getContext(), (error: unknown) => error instanceof JiraClientError && error.code === "JIRA_RESPONSE_INVALID");
});
