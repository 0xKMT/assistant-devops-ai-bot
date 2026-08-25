/**
 * OpenClaw lifecycle adapter for Friday's security boundary.
 * Authorization is repeated at ingress, agent start, prompt construction and
 * tool execution so a partial/missing host hook fails closed rather than
 * silently widening access.
 */
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { openSecurityAuditStore } from "./audit-store.js";
import {
  SECURITY_SYSTEM_CONTEXT,
  PerTurnAuthorizationRegistry,
  authorizeSlack,
  parseSecurityPolicy,
  resolveBoundWorkspaceId,
  resolveFinalizedSlackAuthorizationInput,
  resolveSlackConversationId,
  resolveSlackWorkspaceId,
  sanitizeFridayOutput,
  enforceReviewHeadline,
  extractVerifiedReviewGate,
  type SlackAuthorizationInput,
  type VerifiedReviewGate,
} from "./core.js";

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function conversationId(event: Record<string, unknown>, ctx: Record<string, unknown>): string {
  return resolveSlackConversationId(event, ctx);
}

function workspaceId(event: Record<string, unknown>, ctx: Record<string, unknown>): string {
  return resolveSlackWorkspaceId(event, ctx);
}

function authorizationInput(event: Record<string, unknown>, ctx: Record<string, unknown>): SlackAuthorizationInput {
  return {
    transport: text(ctx.messageProvider || ctx.channelId || event.channel),
    sessionKey: text(event.sessionKey || ctx.sessionKey),
    accountId: text(event.accountId || ctx.accountId),
    workspaceId: workspaceId(event, ctx),
    channelId: conversationId(event, ctx),
    senderId: text(event.senderId || ctx.senderId),
  };
}

function completeAuthorizationInput(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  policy: ReturnType<typeof parseSecurityPolicy>,
): SlackAuthorizationInput {
  const input = authorizationInput(event, ctx);
  return {
    ...input,
    workspaceId: resolveBoundWorkspaceId(input.accountId, input.workspaceId, policy),
  };
}

export default definePluginEntry({
  id: "friday-security-shield",
  name: "Friday Security Shield",
  description: "Owner-only exact Slack account/workspace/channel/user tuple authorization and persona protection for Friday.",
  register(api) {
    // Phase 1: parse immutable policy and open the privacy-preserving audit
    // store once for the gateway lifetime.
    const policy = parseSecurityPolicy(api.pluginConfig);
    const audit = openSecurityAuditStore(
      path.join(api.runtime.state.resolveStateDir(), "friday-security.sqlite"),
      policy.auditRetentionDays,
    );
    const authorizedTurns = new PerTurnAuthorizationRegistry();
    // Tool results are tied to one agent run; a later Slack message cannot
    // borrow a verdict from another conversation or request.
    const verifiedReviewGates = new Map<string, VerifiedReviewGate>();

    // Phase 2: release per-run grants and persistence handles on gateway stop.
    api.on("gateway_stop", () => {
      authorizedTurns.clear();
      verifiedReviewGates.clear();
      audit.close();
    });

    // Phase 3: reject unauthorized Slack ingress before model inference or any
    // tool work. Non-Slack transports remain outside this plugin's scope.
    api.on("before_dispatch", async (event, ctx) => {
      const input = completeAuthorizationInput(
        event as unknown as Record<string, unknown>,
        ctx as unknown as Record<string, unknown>,
        policy,
      );
      const decision = authorizeSlack(input, policy);
      if (!decision.applies) return;
      if (!decision.allowed) {
        audit.record({ decision: "deny", reason: decision.reason, accountId: input.accountId, workspaceId: input.workspaceId, senderId: input.senderId, channelId: input.channelId, sessionKey: input.sessionKey });
        return policy.silentDeny ? { handled: true } : { handled: true, text: "Friday không xử lý yêu cầu này." };
      }
      audit.record({ decision: "allow", reason: `dispatch:${decision.reason}`, accountId: input.accountId, workspaceId: input.workspaceId, senderId: input.senderId, channelId: input.channelId, sessionKey: input.sessionKey });
    }, { priority: 10_000, timeoutMs: 1_000 });

    // Phase 4: bind an authorized principal to one unique agent run. A channel
    // or session alone is never sufficient because it can contain many users.
    api.on("before_agent_run", async (event, ctx) => {
      const recordEvent = event as unknown as Record<string, unknown>;
      const recordContext = ctx as unknown as Record<string, unknown>;
      const input = completeAuthorizationInput(recordEvent, recordContext, policy);
      if (!input.sessionKey?.toLowerCase().includes(":slack:") && text(recordContext.messageProvider).toLowerCase() !== "slack") return;
      const decision = authorizeSlack(input, policy);
      if (decision.allowed) {
        const runId = text(recordContext.runId);
        if (!runId) {
          audit.record({ decision: "deny", reason: "agent-run:missing-run-id", accountId: input.accountId, workspaceId: input.workspaceId, senderId: input.senderId, channelId: input.channelId, sessionKey: input.sessionKey });
          return { outcome: "block", reason: "missing per-turn identity", category: "identity" } as const;
        }
        authorizedTurns.grant({
          runId,
          accountId: text(input.accountId),
          workspaceId: text(input.workspaceId),
          channelId: text(input.channelId),
          senderId: text(input.senderId),
        });
        audit.record({ decision: "allow", reason: "authorized-turn-granted", accountId: input.accountId, workspaceId: input.workspaceId, senderId: input.senderId, channelId: input.channelId, sessionKey: input.sessionKey });
        return { outcome: "pass" } as const;
      }
      audit.record({ decision: "deny", reason: `agent-run:${decision.reason}`, accountId: input.accountId, workspaceId: input.workspaceId, senderId: input.senderId, channelId: input.channelId, sessionKey: input.sessionKey });
      return { outcome: "block", reason: "unauthorized Slack principal", category: "identity" } as const;
    }, { priority: 10_000, timeoutMs: 1_000 });

    // Additive compatibility path for harnesses that do not emit
    // before_agent_run. OpenClaw invokes reply_dispatch before acquiring and
    // starting the agent dispatch; the finalized inbound context and runId are
    // available together. Existing gates remain fail-closed if this hook is
    // absent, late, incomplete, or changes in a future runtime.
    api.on("reply_dispatch", async (event) => {
      const input = resolveFinalizedSlackAuthorizationInput(event, policy);
      const decision = authorizeSlack(input, policy);
      if (!decision.applies) return;
      const runId = text(event.runId);
      if (!decision.allowed || !runId) {
        audit.record({ decision: "deny", reason: !decision.allowed ? `reply-dispatch:${decision.reason}` : "reply-dispatch:missing-run-id", accountId: input.accountId, workspaceId: input.workspaceId, senderId: input.senderId, channelId: input.channelId, sessionKey: input.sessionKey });
        return;
      }
      authorizedTurns.grant({
        runId,
        accountId: text(input.accountId),
        workspaceId: text(input.workspaceId),
        channelId: text(input.channelId),
        senderId: text(input.senderId),
      });
      audit.record({ decision: "allow", reason: "authorized-turn-granted:reply-dispatch", accountId: input.accountId, workspaceId: input.workspaceId, senderId: input.senderId, channelId: input.channelId, sessionKey: input.sessionKey });
    }, { priority: 10_000, timeoutMs: 1_000 });

    // Phase 5: every Slack tool call must present the run-scoped grant created
    // above. Missing or stale run IDs fail closed.
    api.on("before_tool_call", async (event, ctx) => {
      const sessionKey = text(ctx.sessionKey);
      if (!sessionKey.toLowerCase().includes(":slack:")) return;
      const runId = text(event.runId || ctx.runId);
      if (authorizedTurns.has(runId)) return;
      audit.record({ decision: "deny", reason: "tool-call:unverified-turn", channelId: text(ctx.channelId), sessionKey });
      return { block: true, blockReason: "Friday security policy blocked an unverified Slack turn." };
    }, { priority: 10_000, timeoutMs: 1_000 });

    // Only the unified deterministic review can establish a merge verdict.
    // Store its verified result for the final egress hook to enforce.
    api.on("after_tool_call", async (event, ctx) => {
      if (text(event.toolName) !== "friday_unified_pr_review") return;
      const runId = text(event.runId || ctx.runId);
      const gate = extractVerifiedReviewGate(event.result);
      if (runId && gate) verifiedReviewGates.set(runId, gate);
    }, { priority: 10_000, timeoutMs: 1_000 });

    // Grants are single-run capabilities and must not survive agent completion.
    api.on("agent_end", async (_event, ctx) => {
      const runId = text(ctx.runId);
      authorizedTurns.revoke(runId);
      verifiedReviewGates.delete(runId);
    }, { priority: 10_000, timeoutMs: 1_000 });

    // Phase 6: repeat authorization at prompt construction and append the
    // untrusted-content policy only for Slack turns.
    api.on("before_prompt_build", async (event, ctx) => {
      const recordEvent = event as unknown as Record<string, unknown>;
      const recordContext = ctx as unknown as Record<string, unknown>;
      const sessionKey = text(recordContext.sessionKey);
      const isSlack = sessionKey.toLowerCase().includes(":slack:") || text(recordContext.messageProvider).toLowerCase() === "slack";
      if (!isSlack) return;
      const input = completeAuthorizationInput(recordEvent, recordContext, policy);
      const decision = authorizeSlack(input, policy);
      const runId = text(recordEvent.runId || recordContext.runId);
      if (decision.allowed && runId) {
        authorizedTurns.grant({
          runId,
          accountId: text(input.accountId),
          workspaceId: text(input.workspaceId),
          channelId: text(input.channelId),
          senderId: text(input.senderId),
        });
        audit.record({ decision: "allow", reason: "authorized-turn-granted:prompt-build", accountId: input.accountId, workspaceId: input.workspaceId, senderId: input.senderId, channelId: input.channelId, sessionKey: input.sessionKey });
      } else {
        audit.record({ decision: "deny", reason: !decision.allowed ? `prompt-build:${decision.reason}` : "prompt-build:missing-run-id", accountId: input.accountId, workspaceId: input.workspaceId, senderId: input.senderId, channelId: input.channelId, sessionKey: input.sessionKey });
      }
      return { appendSystemContext: SECURITY_SYSTEM_CONTEXT };
    }, { priority: 1_000, timeoutMs: 1_000 });

    // Phase 7: sanitize the final Slack payload as the last egress boundary.
    api.on("message_sending", async (event, ctx) => {
      if (text(ctx.channelId).toLowerCase() !== "slack") return;
      const runId = text(ctx.runId);
      const gate = verifiedReviewGates.get(runId);
      const sanitized = sanitizeFridayOutput(event.content);
      const content = gate ? enforceReviewHeadline(sanitized, gate) : sanitized;
      if (content === event.content) return;
      audit.record({
        decision: "sanitize",
        reason: gate ? "authoritative-review-verdict" : "internal-or-sensitive-output",
        channelId: text(ctx.conversationId),
        sessionKey: text(ctx.sessionKey),
      });
      return { content };
    }, { priority: 10_000, timeoutMs: 1_000 });
  },
});
