import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const image = "otel/opentelemetry-collector-contrib:0.161.0@sha256:fd328de2552466ad78385e1b1289c3f2402b1c45f265b252aab1955b42845ac1";
const traceId = "11111111111111111111111111111111";
const spanId = "2222222222222222";

function docker(args) {
  const result = spawnSync("docker", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return `${result.stdout}${result.stderr}`.trim();
}

function attribute(key, value) {
  return { key, value: { stringValue: value } };
}

function integerAttribute(key, value) {
  return { key, value: { intValue: String(value) } };
}

test("Collector exports allowed metadata and strips every protected OTLP field", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "friday-collector-privacy-"));
  const container = `friday-otel-privacy-${process.pid}`;
  let started = false;
  try {
    const production = await readFile(path.join(root, "container/otel-collector.yaml"), "utf8");
    const config = production
      .replace("  otlphttp/phoenix:\n    traces_endpoint: http://phoenix:6006/v1/traces", "  debug:\n    verbosity: detailed")
      .replace("exporters: [otlphttp/phoenix]", "exporters: [debug]");
    assert.notEqual(config, production);
    assert.match(config, /exporters: \[debug\]/);
    const configPath = path.join(directory, "collector.yaml");
    await writeFile(configPath, config, { mode: 0o600 });
    docker([
      "run", "-d", "--rm", "--name", container,
      "-p", "127.0.0.1:14318:4318",
      "-v", `${configPath}:/etc/otelcol-contrib/config.yaml:ro`,
      image, "--config=/etc/otelcol-contrib/config.yaml",
    ]);
    started = true;

    const payload = {
      resourceSpans: [{
        schemaUrl: "FRIDAY_SENTINEL_RESOURCE_SCHEMA",
        resource: { attributes: [attribute("service.name", "FRIDAY_SENTINEL_SERVICE"), attribute("secret.resource", "FRIDAY_SENTINEL_RESOURCE")] },
        scopeSpans: [{
          schemaUrl: "FRIDAY_SENTINEL_SCOPE_SCHEMA",
          scope: {
            name: "FRIDAY_SENTINEL_SCOPE_NAME",
            version: "FRIDAY_SENTINEL_SCOPE_VERSION",
            attributes: [attribute("secret.scope", "FRIDAY_SENTINEL_SCOPE")],
          },
          spans: [{
            traceId,
            spanId,
            name: "openclaw.tool.execution",
            attributes: [
              attribute("openclaw.outcome", "ok"),
              attribute("openclaw.toolName", "FRIDAY_SENTINEL_TOOL"),
              attribute("openclaw.errorCategory", "FRIDAY_SENTINEL_ERROR"),
              attribute("openclaw.errorCode", "FRIDAY_SENTINEL_ERROR_CODE"),
              attribute("gen_ai.provider.name", "FRIDAY_SENTINEL_PROVIDER"),
              attribute("gen_ai.request.model", "FRIDAY_SENTINEL_MODEL"),
              attribute("gen_ai.usage.input_tokens", "FRIDAY_SENTINEL_TOKEN_AS_TEXT"),
              integerAttribute("gen_ai.usage.output_tokens", 999),
              attribute("gen_ai.operation.name", "FRIDAY_SENTINEL_OPERATION"),
              attribute("secret.span", "FRIDAY_SENTINEL_SPAN"),
            ],
            events: [{ name: "FRIDAY_SENTINEL_EVENT", attributes: [attribute("secret.event", "FRIDAY_SENTINEL_EVENT_ATTRIBUTE")] }],
            links: [{ traceId, spanId, attributes: [attribute("secret.link", "FRIDAY_SENTINEL_LINK")] }],
            status: { code: 2, message: "FRIDAY_SENTINEL_STATUS" },
            traceState: "FRIDAY_SENTINEL_TRACESTATE=present",
          }, {
            traceId,
            spanId: "3333333333333333",
            name: "FRIDAY_SENTINEL_UNKNOWN_SPAN",
          }, {
            traceId,
            spanId: "4444444444444444",
            name: "openclaw.message.processed",
            attributes: [
              attribute("openclaw.channel", "FRIDAY_SENTINEL_CHANNEL"),
              attribute("openclaw.outcome", "FRIDAY_SENTINEL_OUTCOME"),
              attribute("gen_ai.tool.name", "FRIDAY_SENTINEL_GEN_AI_TOOL"),
            ],
          }, {
            traceId,
            spanId: "5555555555555555",
            name: "openclaw.model.usage",
            attributes: [
              integerAttribute("gen_ai.usage.input_tokens", 42),
              integerAttribute("gen_ai.usage.output_tokens", 12),
              integerAttribute("gen_ai.usage.cache_read.input_tokens", 7),
              integerAttribute("gen_ai.usage.cache_creation.input_tokens", 3),
              attribute("gen_ai.provider.name", "openai"),
              attribute("gen_ai.request.model", "openai/gpt-5.6-sol"),
              attribute("openclaw.tokens.input", "FRIDAY_SENTINEL_TOKEN_AS_TEXT"),
              attribute("gen_ai.input.messages", "FRIDAY_SENTINEL_PROMPT"),
            ],
          }, {
            traceId,
            spanId: "6666666666666666",
            name: "openclaw.tool.execution",
            attributes: [
              attribute("openclaw.errorCategory", "timeout"),
              attribute("openclaw.errorCode", "AUTH_REQUIRED"),
            ],
          }, {
            traceId,
            spanId: "7777777777777777",
            name: "openclaw.harness.run",
            attributes: [attribute("secret.harness", "FRIDAY_SENTINEL_HARNESS")],
          }, {
            traceId,
            spanId: "8888888888888888",
            parentSpanId: "7777777777777777",
            name: "openclaw.run",
            attributes: [attribute("openclaw.outcome", "success")],
          }, {
            traceId,
            spanId: "9999999999999999",
            parentSpanId: "8888888888888888",
            name: "openclaw.model.call",
            attributes: [
              attribute("gen_ai.system", "openai"),
              attribute("gen_ai.request.model", "openai/gpt-5.6-luna"),
              integerAttribute("openclaw.model_call.prompt.input_messages_count", 2),
              integerAttribute("openclaw.model_call.prompt.input_messages_chars", 123),
              integerAttribute("openclaw.model_call.prompt.system_prompt_chars", 44),
              integerAttribute("openclaw.model_call.prompt.tool_definitions_count", 3),
              integerAttribute("openclaw.model_call.prompt.tool_definitions_chars", 55),
              integerAttribute("openclaw.model_call.prompt.total_chars", 222),
              attribute("secret.model", "FRIDAY_SENTINEL_MODEL_CONTENT"),
            ],
            events: [
              { name: "openclaw.provider.request", attributes: [attribute("openclaw.upstreamRequestIdHash", "FRIDAY_SENTINEL_REQUEST_HASH")] },
              { name: "FRIDAY_SENTINEL_UNKNOWN_EVENT", attributes: [attribute("secret.event", "FRIDAY_SENTINEL_EVENT_CONTENT")] },
            ],
            status: { code: 2, message: "FRIDAY_SENTINEL_RAW_STATUS" },
          }, {
            traceId,
            spanId: "aaaaaaaaaaaaaaaa",
            name: "openclaw.model.usage",
            attributes: [
              attribute("gen_ai.system", "openai"),
              attribute("gen_ai.request.model", "openai/gpt-5.6-terra"),
            ],
          }, {
            traceId,
            spanId: "bbbbbbbbbbbbbbbb",
            name: "openclaw.model.call",
            attributes: [
              attribute("gen_ai.system", "FRIDAY_SENTINEL_PROVIDER"),
              attribute("gen_ai.request.model", "FRIDAY_SENTINEL_MODEL"),
              attribute("openclaw.model_call.prompt.input_messages_count", "FRIDAY_SENTINEL_BAD_COUNT"),
              integerAttribute("openclaw.model_call.prompt.total_chars", -1),
              attribute("openclaw.errorCategory", "timeout"),
            ],
            status: { code: 2, message: "FRIDAY_SENTINEL_RAW_STATUS_TWO" },
          }],
        }],
      }],
    };
    let response;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        response = await fetch("http://127.0.0.1:14318/v1/traces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(response, "Collector receiver did not start");
    assert.equal(response.status, 200, await response.text());

    let output = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      output = docker(["logs", container]);
      if (output.includes(traceId)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(output, new RegExp(traceId));
    assert.match(output, /openclaw\.outcome.*ok/s);
    assert.match(output, /openclaw\.channel: Str\(other\)/);
    assert.match(output, /openclaw\.outcome: Str\(other\)/);
    assert.match(output, /gen_ai\.usage\.input_tokens: Int\(42\)/);
    assert.match(output, /gen_ai\.usage\.output_tokens: Int\(12\)/);
    assert.match(output, /gen_ai\.usage\.cache_read\.input_tokens: Int\(7\)/);
    assert.match(output, /gen_ai\.usage\.cache_creation\.input_tokens: Int\(3\)/);
    assert.match(output, /gen_ai\.provider\.name: Str\(openai\)/);
    assert.match(output, /gen_ai\.request\.model: Str\(openai\/gpt-5\.6-sol\)/);
    assert.match(output, /openclaw\.errorCategory: Str\(timeout\)/);
    assert.match(output, /openclaw\.errorCode: Str\(AUTH_REQUIRED\)/);
    assert.match(output, /openclaw\.harness\.run/);
    assert.match(output, /Parent ID\s+: 7777777777777777\n\s+ID\s+: 8888888888888888/);
    assert.match(output, /gen_ai\.request\.model: Str\(openai\/gpt-5\.6-luna\)/);
    assert.match(output, /gen_ai\.request\.model: Str\(openai\/gpt-5\.6-terra\)/);
    assert.match(output, /gen_ai\.provider\.name: Str\(openai\)/);
    assert.match(output, /openclaw\.model_call\.prompt\.input_messages_count: Int\(2\)/);
    assert.match(output, /openclaw\.model_call\.prompt\.input_messages_chars: Int\(123\)/);
    assert.match(output, /openclaw\.model_call\.prompt\.system_prompt_chars: Int\(44\)/);
    assert.match(output, /openclaw\.model_call\.prompt\.tool_definitions_count: Int\(3\)/);
    assert.match(output, /openclaw\.model_call\.prompt\.tool_definitions_chars: Int\(55\)/);
    assert.match(output, /openclaw\.model_call\.prompt\.total_chars: Int\(222\)/);
    assert.match(output, /openclaw\.provider\.request/);
    assert.match(output, /gen_ai\.request\.model: Str\(other\)/);
    assert.match(output, /gen_ai\.provider\.name: Str\(other\)/);
    assert.match(output, /Status message : timeout/);
    assert.doesNotMatch(output, /openclaw\.model_call\.prompt\.total_chars: Int\(-1\)/);
    assert.doesNotMatch(output, /Int\(999\)/);
    assert.match(output, /service\.name: Str\(friday-gateway\)/);
    assert.doesNotMatch(output, /FRIDAY_SENTINEL_/);
  } finally {
    if (started) spawnSync("docker", ["stop", container], { encoding: "utf8" });
    await rm(directory, { recursive: true, force: true });
  }
});
