const pluginPath = "/opt/friday/plugins/diagnostics-project/node_modules/@openclaw/diagnostics-otel";

const captureContent = Object.fromEntries([
  "enabled",
  "inputMessages",
  "outputMessages",
  "toolInputs",
  "toolOutputs",
  "systemPrompt",
  "toolDefinitions",
].map((key) => [key, false]));

const otelSettings = Object.freeze({
  enabled: true,
  endpoint: "http://otel-collector:4318",
  tracesEndpoint: "http://otel-collector:4318/v1/traces",
  protocol: "http/protobuf",
  serviceName: "friday-gateway",
  traces: true,
  metrics: false,
  logs: false,
  sampleRate: 1,
  captureContent,
});

export function observabilityConfig(base) {
  if (!base || typeof base !== "object" || Array.isArray(base)) {
    throw new TypeError("OpenClaw config must be an object.");
  }
  const next = structuredClone(base);
  next.plugins ??= {};
  next.plugins.load ??= {};
  next.plugins.load.paths = [...new Set([...(next.plugins.load.paths ?? []), pluginPath])];
  next.plugins.allow = [...new Set([...(next.plugins.allow ?? []), "diagnostics-otel"])];
  next.plugins.entries = { ...next.plugins.entries, "diagnostics-otel": { enabled: true } };
  next.diagnostics = { ...next.diagnostics, enabled: true, otel: otelSettings };
  return next;
}
