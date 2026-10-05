import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectOpenClawObservability } from "../lib/openclaw-observability-probe.mjs";

const expectedVersion = "2026.7.1-2";

const completeDeclarations = `
export type PluginHookAgentContext = {
  sessionId: string;
  agentId?: string;
};

export type PluginHookAgentEndEvent = {
  runId?: string;
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

export type PluginHookModelCallStartedEvent = {
  provider: string;
  model: string;
};

export type PluginHookModelCallEndedEvent = PluginHookModelCallStartedEvent & {
  durationMs: number;
  outcome: string;
};

export type PluginHookLlmInputEvent = {
  provider: string;
  model: string;
};

export type PluginHookLlmOutputEvent = {
  provider: string;
  model: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};
`;

async function createFixture(t, { declarations = completeDeclarations, version = expectedVersion } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "friday-openclaw-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executablePath = path.join(root, "openclaw.mjs");

  await mkdir(path.join(root, "dist"));
  await writeFile(executablePath, "#!/usr/bin/env node\n", "utf8");
  await chmod(executablePath, 0o755);
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "openclaw", version })}\n`, "utf8");
  await writeFile(path.join(root, "dist", "hooks.d.ts"), declarations, "utf8");

  return executablePath;
}

test("reports normalized lifecycle and usage declarations for the pinned version", async (t) => {
  const executablePath = await createFixture(t);
  const report = await inspectOpenClawObservability({ executablePath, expectedVersion });

  assert.equal(report.evidence, "validated-declarations");
  assert.equal(report.version, expectedVersion);
  assert.deepEqual(report.hooks.agent_context.fields, ["agentId", "sessionId"]);
  assert.deepEqual(report.hooks.agent_end.fields, ["durationMs", "error", "messages", "runId", "success"]);
  assert.deepEqual(report.hooks.model_call_started.fields, ["model", "provider"]);
  assert.deepEqual(report.hooks.model_call_ended.fields, ["durationMs", "model", "outcome", "provider"]);
  assert.deepEqual(report.hooks.llm_input.fields, ["model", "provider"]);
  assert.deepEqual(report.hooks.llm_output.fields, ["model", "provider", "usage"]);
  assert.deepEqual(report.hooks.llm_output.usageFields, ["cacheRead", "cacheWrite", "input", "output", "total"]);
  assert.equal(report.conclusions.tokenUsage, "declared-on-llm_output");
  assert.equal(report.conclusions.hookCost, "unavailable");
  assert.equal(report.conclusions.runtimeEmission, "not-runtime-proven");
  assert.equal(JSON.stringify(report).includes(rootPath(executablePath)), false);
});

test("classifies a package version mismatch", async (t) => {
  const executablePath = await createFixture(t, { version: "2026.7.1-1" });
  const report = await inspectOpenClawObservability({ executablePath, expectedVersion });

  assert.equal(report.evidence, "version-mismatch");
  assert.equal(report.version, "2026.7.1-1");
});

test("classifies declarations without llm_output as inconclusive", async (t) => {
  const executablePath = await createFixture(t, {
    declarations: completeDeclarations.replace(/export type PluginHookLlmOutputEvent[\s\S]*?\n};\n/, ""),
  });
  const report = await inspectOpenClawObservability({ executablePath, expectedVersion });

  assert.equal(report.evidence, "inconclusive-declarations");
  assert.equal(report.hooks.llm_output.declared, false);
});

test("reports token telemetry unavailable when llm_output has no usage", async (t) => {
  const executablePath = await createFixture(t, {
    declarations: completeDeclarations.replace(/  usage\?: \{[\s\S]*?\n  };/, "  responseId?: string;"),
  });
  const report = await inspectOpenClawObservability({ executablePath, expectedVersion });

  assert.equal(report.evidence, "validated-declarations");
  assert.deepEqual(report.hooks.llm_output.usageFields, []);
  assert.equal(report.conclusions.tokenUsage, "unavailable");
});

test("reports hook-level cost telemetry unavailable when no cost field is declared", async (t) => {
  const executablePath = await createFixture(t);
  const report = await inspectOpenClawObservability({ executablePath, expectedVersion });

  assert.equal(report.evidence, "validated-declarations");
  assert.equal(report.conclusions.hookCost, "unavailable");
});

test("classifies unsupported declaration structures as inconclusive", async (t) => {
  const declarations = Object.values({
    agentContext: "PluginHookAgentContext",
    agentEnd: "PluginHookAgentEndEvent",
    modelStarted: "PluginHookModelCallStartedEvent",
    modelEnded: "PluginHookModelCallEndedEvent",
    llmInput: "PluginHookLlmInputEvent",
    llmOutput: "PluginHookLlmOutputEvent",
  }).map((name) => `export type ${name} = unknown;`).join("\n");
  const executablePath = await createFixture(t, { declarations });
  const report = await inspectOpenClawObservability({ executablePath, expectedVersion });

  assert.equal(report.evidence, "inconclusive-declarations");
});

test("parses supported object declarations written on one line", async (t) => {
  const declarations = completeDeclarations.replaceAll("\n", " ");
  const executablePath = await createFixture(t, { declarations });
  const report = await inspectOpenClawObservability({ executablePath, expectedVersion });

  assert.equal(report.evidence, "validated-declarations");
  assert.deepEqual(report.hooks.agent_end.fields, ["durationMs", "error", "messages", "runId", "success"]);
  assert.deepEqual(report.hooks.llm_output.usageFields, ["cacheRead", "cacheWrite", "input", "output", "total"]);
  assert.equal(report.conclusions.tokenUsage, "declared-on-llm_output");
});

function rootPath(executablePath) {
  return path.dirname(executablePath);
}
