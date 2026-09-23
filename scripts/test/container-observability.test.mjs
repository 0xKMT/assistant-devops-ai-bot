import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function composeConfig(files, profile) {
  const args = ["compose", ...files.flatMap((file) => ["-f", file])];
  if (profile) args.push("--profile", profile);
  args.push("config", "--format", "json");
  const result = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FRIDAY_REPOSITORIES_DIR: "/tmp" },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("plain Compose retains the uninstrumented gateway", () => {
  const config = composeConfig(["compose.yaml"]);
  assert.ok(config.services["friday-gateway"]);
  assert.equal(config.services["friday-gateway"].environment.FRIDAY_OBSERVABILITY, undefined);
  assert.equal(config.services["otel-collector"], undefined);
  assert.equal(config.services.phoenix, undefined);
});

test("opt-in profile keeps Collector private and Phoenix UI loopback-only", () => {
  const config = composeConfig(["compose.yaml", "compose.observability.yaml"], "observability");
  assert.equal(config.services["friday-gateway"].environment.FRIDAY_OBSERVABILITY, "1");
  assert.deepEqual(config.services["otel-collector"].ports, undefined);
  assert.match(config.services["otel-collector"].image, /^otel\/opentelemetry-collector-contrib:0\.161\.0@sha256:[a-f0-9]{64}$/);
  assert.match(config.services.phoenix.image, /^arizephoenix\/phoenix:version-20\.15\.0-nonroot@sha256:[a-f0-9]{64}$/);
  assert.deepEqual(config.services.phoenix.ports.map(({ host_ip, published, target }) => ({ host_ip, published, target })), [
    { host_ip: "127.0.0.1", published: "6006", target: 6006 },
  ]);
  assert.ok(config.volumes.friday_phoenix_data);
});
