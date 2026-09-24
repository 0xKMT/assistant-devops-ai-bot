import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { observabilityConfig } from "../lib/observability-config.mjs";
import { render } from "../render-observability-config.mjs";

test("opt-in diagnostics preserves existing plugins and denies content capture", () => {
  const base = {
    plugins: {
      load: { paths: ["/opt/friday/plugins/slack-project/node_modules/@openclaw/slack"] },
      allow: ["slack", "friday-security-shield"],
      entries: { slack: { enabled: true }, "friday-security-shield": { enabled: true } },
    },
  };
  const before = JSON.stringify(base);
  const actual = observabilityConfig(base);

  assert.equal(JSON.stringify(base), before);
  assert.deepEqual(actual.plugins.load.paths, base.plugins.load.paths);
  assert.deepEqual(actual.plugins.allow, ["slack", "friday-security-shield", "diagnostics-otel"]);
  assert.equal(actual.plugins.entries["friday-security-shield"].enabled, true);
  assert.equal(actual.plugins.entries["diagnostics-otel"].enabled, true);
  assert.deepEqual(actual.diagnostics.otel, {
    enabled: true,
    endpoint: "http://otel-collector:4318",
    tracesEndpoint: "http://otel-collector:4318/v1/traces",
    protocol: "http/protobuf",
    serviceName: "friday-gateway",
    traces: true,
    metrics: false,
    logs: false,
    sampleRate: 1,
    captureContent: {
      enabled: false,
      inputMessages: false,
      outputMessages: false,
      toolInputs: false,
      toolOutputs: false,
      systemPrompt: false,
      toolDefinitions: false,
    },
  });
  assert.deepEqual(observabilityConfig(actual).plugins.allow, actual.plugins.allow);
});

test("opt-in diagnostics removes a stale external copy so bundled plugin is selected", () => {
  const externalPath = "/opt/friday/plugins/diagnostics-project/node_modules/@openclaw/diagnostics-otel";
  const slackPath = "/opt/friday/plugins/slack-project/node_modules/@openclaw/slack";
  const base = { plugins: { load: { paths: [slackPath, externalPath] } } };

  const actual = observabilityConfig(base);

  assert.deepEqual(actual.plugins.load.paths, [slackPath]);
  assert.deepEqual(base.plugins.load.paths, [slackPath, externalPath]);
  assert.equal(actual.plugins.entries["diagnostics-otel"].enabled, true);
});

test("render writes a private alternate config and never changes source bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "friday-observability-"));
  try {
    const input = path.join(directory, "openclaw.json");
    const output = path.join(directory, "openclaw-observability.json");
    const source = '{"plugins":{"allow":["slack"],"entries":{"slack":{"enabled":true}}}}\n';
    await writeFile(input, source, { mode: 0o600 });
    await render(input, output);
    assert.equal(await readFile(input, "utf8"), source);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const rendered = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(rendered.plugins.allow, ["slack", "diagnostics-otel"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("render rejects malformed or absent input without writing output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "friday-observability-"));
  try {
    const input = path.join(directory, "openclaw.json");
    const output = path.join(directory, "openclaw-observability.json");
    await writeFile(input, "not json", { mode: 0o600 });
    await assert.rejects(render(input, output), SyntaxError);
    await assert.rejects(stat(output), { code: "ENOENT" });
    await rm(input);
    await assert.rejects(render(input, output), { code: "ENOENT" });
    await assert.rejects(stat(output), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
