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
        resource: { attributes: [attribute("service.name", "friday-gateway"), attribute("secret.resource", "FRIDAY_SENTINEL_RESOURCE")] },
        scopeSpans: [{
          scope: { name: "openclaw", attributes: [attribute("secret.scope", "FRIDAY_SENTINEL_SCOPE")] },
          spans: [{
            traceId,
            spanId,
            name: "openclaw.tool.execution",
            attributes: [attribute("openclaw.outcome", "ok"), attribute("secret.span", "FRIDAY_SENTINEL_SPAN")],
            events: [{ name: "FRIDAY_SENTINEL_EVENT", attributes: [attribute("secret.event", "FRIDAY_SENTINEL_EVENT_ATTRIBUTE")] }],
            links: [{ traceId, spanId, attributes: [attribute("secret.link", "FRIDAY_SENTINEL_LINK")] }],
            status: { code: 2, message: "FRIDAY_SENTINEL_STATUS" },
            traceState: "FRIDAY_SENTINEL_TRACESTATE=present",
          }, {
            traceId,
            spanId: "3333333333333333",
            name: "FRIDAY_SENTINEL_UNKNOWN_SPAN",
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
    assert.doesNotMatch(output, /FRIDAY_SENTINEL_/);
  } finally {
    if (started) spawnSync("docker", ["stop", container], { encoding: "utf8" });
    await rm(directory, { recursive: true, force: true });
  }
});
