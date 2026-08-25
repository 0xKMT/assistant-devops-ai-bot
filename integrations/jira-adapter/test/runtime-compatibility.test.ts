import assert from "node:assert/strict";
import { accessSync, globSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { DraftRecord } from "../draft-store.js";
import { buildTicketReviewBlocks } from "../slack-ticket-ui.js";

const root = path.resolve(import.meta.dirname, "../../..");

function executableOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try { accessSync(candidate); return candidate; } catch { /* try next PATH entry */ }
  }
  return undefined;
}

function namedFunction(source: string, name: string): string {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `missing ${name} in pinned Slack bundle`);
  const start = source.slice(functionStart - 6, functionStart) === "async " ? functionStart - 6 : functionStart;
  const nextFunction = source.indexOf("\nfunction ", functionStart + 1);
  const nextAsyncFunction = source.indexOf("\nasync function ", functionStart + 1);
  const sectionEnd = source.indexOf("\n//#endregion", functionStart + 1);
  const ends = [nextFunction, nextAsyncFunction, sectionEnd].filter((candidate) => candidate !== -1);
  const end = ends.length === 0 ? source.length : Math.min(...ends);
  return source.slice(start, end);
}

function configuredSlackRoot(): string | undefined {
  const explicitRoot = process.env.FRIDAY_SLACK_PLUGIN_ROOT;
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(homedir(), ".openclaw");
  const roots = explicitRoot
    ? [path.resolve(explicitRoot)]
    : globSync(path.join(stateDir, "npm/projects/*/node_modules/@openclaw/slack"));
  if (roots.length === 0) return undefined;
  assert.equal(roots.length, 1, "the configured Slack plugin root must resolve uniquely");
  return roots[0];
}

test("installed OpenClaw exposes the pinned interactive handler contract", (t) => {
  const executable = executableOnPath("openclaw");
  if (!executable) {
    t.skip("Pinned OpenClaw runtime is not installed; install openclaw@2026.7.1-2 to run this probe.");
    return;
  }
  const packageRoot = path.dirname(realpathSync(executable));
  const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version?: string };
  assert.equal(packageJson.version, "2026.7.1-2", "an installed unknown OpenClaw version is not compatible");
  const declarations = globSync(path.join(packageRoot, "dist/**/*.d.ts"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.match(declarations, /registerInteractiveHandler:\s*\(registration:\s*PluginInteractiveHandlerRegistration\)\s*=>\s*void/);
  assert.match(declarations, /type PluginInteractiveRegistration<[\s\S]{0,800}?handler:\s*\(ctx:\s*TContext\)\s*=>\s*Promise<TResult>\s*\|\s*TResult/);
});

test("configured Slack plugin constructs and dispatches the pinned callback contract", async (t) => {
  const pluginRoot = configuredSlackRoot();
  if (!pluginRoot) {
    t.skip("Pinned @openclaw/slack runtime is not installed; install @openclaw/slack@2026.7.1 to run this probe.");
    return;
  }
  const packageJson = JSON.parse(readFileSync(path.join(pluginRoot, "package.json"), "utf8")) as { version?: string };
  assert.equal(packageJson.version, "2026.7.1", "an installed unknown Slack version is not compatible");
  const manifest = JSON.parse(readFileSync(path.join(root, "compat/slack/manifest.json"), "utf8")) as {
    flows: { identityRefresh: { file: string } };
  };
  const slackProvider = readFileSync(path.join(pluginRoot, manifest.flows.identityRefresh.file), "utf8");
  const buildDataSource = namedFunction(slackProvider, "buildSlackPluginInteractionData");
  const buildData = new Function(
    "normalizeOptionalString",
    `return (${buildDataSource});`,
  )((value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined) as
    (params: { actionId: string; summary: { value: string } }) => string | null;
  const draft = {
    id: "opaque-draft", version: 7, status: "Drafted", priorityId: "3", epicKey: null, expiresAt: 9_999,
    idempotencyKey: null, jiraIssueKey: null, jiraIssueUrl: null, failureCode: null, linkPostStatus: "pending",
    slackAccountId: "everfit", slackWorkspaceId: "T-EVERFIT", slackChannelId: "C-DEVOPS", threadTs: "1710000000.000100",
    requesterUserId: "U-REQUESTER", snapshotCutoffTs: "1710000001.000200", title: "Prepare release", issueType: "Task",
    description: "Prepare the English release process.", references: [], missingFields: [],
  } satisfies DraftRecord;
  const actions = buildTicketReviewBlocks(draft)
    .flatMap((block) => (block as { elements?: Array<{ action_id: string; value: string }> }).elements ?? []);
  assert.deepEqual(actions.map((action) => buildData({ actionId: action.action_id, summary: { value: action.value } })), [
    "friday-jira:approve:opaque-draft:7",
    "friday-jira:edit:opaque-draft:7",
    "friday-jira:cancel:opaque-draft:7",
  ]);

  const buttonDispatch = namedFunction(slackProvider, "dispatchSlackPluginInteraction");
  assert.match(buttonDispatch, /conversationId:\s*params\.parsed\.channelId\s*\?\?\s*""/);
  assert.match(buttonDispatch, /threadId:\s*params\.parsed\.threadTs/);
  assert.match(buttonDispatch, /kind:\s*params\.parsed\.actionSummary\.actionType\s*===\s*"button"\s*\?\s*"button"\s*:\s*"select"/);
  assert.match(buttonDispatch, /data:\s*params\.pluginInteractionData/);
  assert.match(buttonDispatch, /reply:\s*async\s*\(\{\s*text,\s*responseType\s*\}\)\s*=>/);
  assert.match(buttonDispatch, /response_type:\s*responseType\s*\?\?\s*"ephemeral"/);
  assert.doesNotMatch(buttonDispatch, /workspaceId/);

  const modalDispatch = namedFunction(slackProvider, "dispatchSlackModalPluginInteractiveHandler");
  assert.match(modalDispatch, /conversationId:\s*params\.sessionRouting\.channelId\s*\?\?\s*""/);
  assert.match(modalDispatch, /threadId:\s*void 0/);
  assert.match(modalDispatch, /kind:\s*params\.interactionType/);
  assert.match(modalDispatch, /stateValues:\s*params\.stateValues/);
  assert.match(modalDispatch, /data:\s*params\.data/);
  assert.doesNotMatch(modalDispatch, /workspaceId/);
  let dispatchedContext: Record<string, unknown> | undefined;
  let modalResponseResults: unknown[] = [];
  const interactiveDispatchSource = namedFunction(slackProvider, "dispatchSlackPluginInteractiveHandler");
  const dispatchInteractive = new Function(
    "dispatchPluginInteractiveHandler",
    "createInteractiveConversationBindingHelpers",
    `return (${interactiveDispatchSource});`,
  )(
    async (params: { invoke: (input: Record<string, unknown>) => Promise<unknown> }) => {
      const result = await params.invoke({
        registration: {
          async handler(context: Record<string, unknown> & {
            respond: {
              acknowledge: () => Promise<unknown>;
              reply: () => Promise<unknown>;
              followUp: () => Promise<unknown>;
              editMessage: () => Promise<unknown>;
            };
          }) {
            dispatchedContext = context;
            modalResponseResults = await Promise.all([
              context.respond.acknowledge(), context.respond.reply(),
              context.respond.followUp(), context.respond.editMessage(),
            ]);
            return { handled: true };
          },
        },
        namespace: "friday-jira",
        payload: "edit:opaque-draft:7",
      });
      return { matched: true, handled: true, duplicate: false, result };
    },
    () => ({}),
  ) as (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  const dispatchModal = new Function(
    "dispatchSlackPluginInteractiveHandler",
    "resolveSlackModalPluginNamespace",
    "resolveSlackPluginSystemEventPayload",
    `return (${modalDispatch});`,
  )(
    dispatchInteractive,
    () => "friday-jira",
    () => undefined,
  ) as (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  await dispatchModal({
    data: "friday-jira:edit:opaque-draft:7",
    interactionType: "view_submission",
    ctx: { accountId: "everfit" },
    sessionRouting: { channelId: "C-DEVOPS" },
    payload: { callbackId: "openclaw:friday-jira:edit", viewId: "V1", userId: "U-REQUESTER", inputs: [] },
    stateValues: { title: { title: { value: "Edited" } } },
    body: { trigger_id: "trigger-modal" },
    auth: { isAuthorizedSender: true },
  });
  assert.deepEqual(modalResponseResults, [undefined, undefined, undefined, undefined]);
  assert.equal(dispatchedContext?.accountId, "everfit");
  assert.equal(dispatchedContext?.conversationId, "C-DEVOPS");
  assert.equal(dispatchedContext?.threadId, undefined);
  assert.equal(Object.hasOwn(dispatchedContext ?? {}, "workspaceId"), false);
  assert.deepEqual((dispatchedContext?.interaction as { kind?: string; data?: string } | undefined)?.kind, "view_submission");
  assert.equal((dispatchedContext?.interaction as { data?: string } | undefined)?.data, "friday-jira:edit:opaque-draft:7");

  const registerModalSource = namedFunction(slackProvider, "registerModalLifecycleHandler");
  let registeredModalHandler: ((input: { ack: () => Promise<void>; body: object }) => Promise<void>) | undefined;
  let emittedModalEvents = 0;
  const registerModal = new Function(
    "shouldHandleSlackModalLifecycleBody",
    "emitSlackModalLifecycleEvent",
    `return (${registerModalSource});`,
  )(
    () => true,
    async () => { emittedModalEvents += 1; },
  ) as (params: Record<string, unknown>) => void;
  registerModal({
    matcher: "view_submission",
    interactionType: "view_submission",
    register: (_matcher: unknown, handler: typeof registeredModalHandler) => { registeredModalHandler = handler; },
    ctx: { shouldDropMismatchedSlackEvent: () => true, runtime: { log() {} } },
  });
  let acknowledgements = 0;
  assert.ok(registeredModalHandler);
  await registeredModalHandler({ ack: async () => { acknowledgements += 1; }, body: {} });
  assert.equal(acknowledgements, 1);
  assert.equal(emittedModalEvents, 0);

  const eventRegistration = namedFunction(slackProvider, "registerSlackInteractionEvents");
  assert.match(eventRegistration, /registerSlackBlockActionHandler/);
  assert.match(eventRegistration, /interactionType:\s*"view_submission"/);
  assert.match(eventRegistration, /interactionType:\s*"view_closed"/);
});

test("Jira package entry stays callback-only and runtime-loadable", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    files?: string[];
    openclaw?: { extensions?: string[] };
  };
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as {
    contracts?: { tools?: string[] };
    configSchema?: { properties?: { slack?: { required?: string[]; properties?: Record<string, unknown> } } };
  };
  assert.deepEqual(packageJson.openclaw?.extensions, ["./dist/index.js"]);
  assert.ok(packageJson.files?.includes("dist/index.js"));
  assert.deepEqual(manifest.contracts?.tools, ["friday_jira_get_context", "friday_jira_prepare_ticket"]);
  assert.equal(manifest.contracts?.tools?.some((tool) => /create/i.test(tool)), false);
  assert.ok(manifest.configSchema?.properties?.slack?.required?.includes("workspaceId"));
  assert.ok(manifest.configSchema?.properties?.slack?.properties?.workspaceId);
});
