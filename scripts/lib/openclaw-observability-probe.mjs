import { glob, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const declarationNames = {
  agent_context: "PluginHookAgentContext",
  agent_end: "PluginHookAgentEndEvent",
  model_call_started: "PluginHookModelCallStartedEvent",
  model_call_ended: "PluginHookModelCallEndedEvent",
  llm_input: "PluginHookLlmInputEvent",
  llm_output: "PluginHookLlmOutputEvent",
};

/**
 * Inspects only the package manifest and TypeScript declarations adjacent to
 * an OpenClaw executable. The returned report contains names, never values.
 */
export async function inspectOpenClawObservability({ executablePath, expectedVersion }) {
  const emptyHooks = createEmptyHooks();
  let packageRoot;

  try {
    packageRoot = path.dirname(await realpath(executablePath));
  } catch {
    return createReport({
      evidence: "missing-executable",
      expectedVersion,
      hooks: emptyHooks,
      version: null,
    });
  }

  let packageManifest;
  try {
    packageManifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  } catch {
    return createReport({
      evidence: "inconclusive-declarations",
      expectedVersion,
      hooks: emptyHooks,
      version: null,
    });
  }

  const version = typeof packageManifest.version === "string" ? packageManifest.version : null;
  if (version !== expectedVersion) {
    return createReport({
      evidence: "version-mismatch",
      expectedVersion,
      hooks: emptyHooks,
      version,
    });
  }

  try {
    const declarations = await readDeclarations(packageRoot);
    const hooks = createEmptyHooks();

    for (const [hookName, declarationName] of Object.entries(declarationNames)) {
      const expression = declarations.get(declarationName);
      if (!expression) continue;
      hooks[hookName].declared = true;
      hooks[hookName].fields = collectFields(declarationName, declarations);
      if (hookName === "llm_output") hooks[hookName].usageFields = collectNestedFields(expression, "usage");
    }

    const complete = Object.values(hooks).every((hook) => hook.declared);
    return createReport({
      evidence: complete ? "validated-declarations" : "inconclusive-declarations",
      expectedVersion,
      hooks,
      version,
    });
  } catch {
    return createReport({
      evidence: "inconclusive-declarations",
      expectedVersion,
      hooks: emptyHooks,
      version,
    });
  }
}

async function readDeclarations(packageRoot) {
  const declarations = new Map();
  const required = new Set(Object.values(declarationNames));
  const files = [];
  for await (const file of glob("dist/**/*.d.ts", { cwd: packageRoot })) files.push(file);
  files.sort();

  for (const relativeFile of files) {
    const source = await readFile(path.join(packageRoot, relativeFile), "utf8");
    for (const match of source.matchAll(/(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g)) {
      const name = match[1];
      if (!required.has(name) && name !== "PluginHookModelCallBaseEvent") continue;
      declarations.set(name, extractTypeExpression(source, match.index + match[0].length));
    }
    if ([...required].every((name) => declarations.has(name))) break;
  }

  return declarations;
}

function extractTypeExpression(source, start) {
  let braces = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") braces += 1;
    else if (source[index] === "}") braces -= 1;
    else if (source[index] === ";" && braces === 0) return source.slice(start, index).trim();
  }
  return source.slice(start).trim();
}

function collectFields(name, declarations, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const expression = declarations.get(name);
  if (!expression) return [];

  const fields = new Set(fieldsFromObject(expression));
  const objectStart = expression.indexOf("{");
  const baseExpression = objectStart === -1 ? expression : expression.slice(0, objectStart);
  for (const match of baseExpression.matchAll(/\b(PluginHook[A-Za-z0-9_$]+)\b/g)) {
    for (const field of collectFields(match[1], declarations, seen)) fields.add(field);
  }
  return [...fields].sort();
}

function fieldsFromObject(expression) {
  const objectStart = expression.indexOf("{");
  if (objectStart === -1) return [];
  const body = expression.slice(objectStart);
  const fields = [];
  let depth = 0;

  for (const line of body.split("\n")) {
    if (depth === 1) {
      const match = line.match(/^\s*([A-Za-z_$][\w$]*)\??\s*:/);
      if (match) fields.push(match[1]);
    }
    depth += count(line, "{") - count(line, "}");
  }
  return [...new Set(fields)].sort();
}

function collectNestedFields(expression, propertyName) {
  const pattern = new RegExp(`\\b${propertyName}\\??\\s*:\\s*\\{`);
  const match = pattern.exec(expression);
  if (!match) return [];
  const objectStart = match.index + match[0].lastIndexOf("{");
  return fieldsFromObject(expression.slice(objectStart));
}

function count(value, character) {
  return [...value].filter((entry) => entry === character).length;
}

function createEmptyHooks() {
  return Object.fromEntries(Object.keys(declarationNames).map((name) => [
    name,
    name === "llm_output"
      ? { declared: false, fields: [], usageFields: [] }
      : { declared: false, fields: [] },
  ]));
}

function createReport({ evidence, expectedVersion, hooks, version }) {
  const allFields = Object.values(hooks).flatMap((hook) => [
    ...hook.fields,
    ...(hook.usageFields ?? []),
  ]);
  return {
    version,
    expectedVersion,
    evidence,
    hooks,
    conclusions: {
      tokenUsage: hooks.llm_output.usageFields.length > 0
        ? "declared-on-llm_output"
        : "unavailable",
      hookCost: allFields.some((field) => /^(?:cost|costUsd)$/i.test(field))
        ? "declared"
        : "unavailable",
      runtimeEmission: "not-runtime-proven",
    },
  };
}
