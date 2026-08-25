/**
 * Enforces monorepo boundaries that TypeScript alone cannot express: every
 * package must be a private @friday workspace, internal versions must match and
 * source files must not use relative imports across workspace boundaries.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const rootManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const workspacePaths = rootManifest.workspaces ?? [];
const findings = [];
const packages = new Map();

// Phase 1: build the authoritative workspace registry from the root manifest.
for (const workspacePath of workspacePaths) {
  const directory = path.join(root, workspacePath);
  const manifestPath = path.join(directory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest.name?.startsWith("@friday/")) {
    findings.push(`${workspacePath}: package name must use the @friday scope`);
  }
  if (manifest.private !== true) findings.push(`${workspacePath}: package must remain private`);
  if (!manifest.scripts?.check) findings.push(`${workspacePath}: missing check script`);
  if (packages.has(manifest.name)) findings.push(`${workspacePath}: duplicate package name ${manifest.name}`);
  packages.set(manifest.name, { directory, manifest, workspacePath });
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["dist", "node_modules"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else files.push(target);
  }
  return files;
}

// Phase 2: validate dependency declarations and scan source imports at each
// package boundary.
for (const current of packages.values()) {
  const dependencyGroups = [
    current.manifest.dependencies ?? {},
    current.manifest.devDependencies ?? {},
    current.manifest.peerDependencies ?? {},
  ];
  for (const dependencies of dependencyGroups) {
    for (const [name, version] of Object.entries(dependencies)) {
      if (!name.startsWith("@friday/")) continue;
      const target = packages.get(name);
      if (!target) findings.push(`${current.workspacePath}: unknown internal dependency ${name}`);
      else if (version !== target.manifest.version) {
        findings.push(`${current.workspacePath}: ${name} must match workspace version ${target.manifest.version}`);
      }
    }
  }

  if (current.manifest.name === "@friday/shared") {
    const internalDependencies = dependencyGroups.flatMap((group) => Object.keys(group))
      .filter((name) => name.startsWith("@friday/"));
    if (internalDependencies.length) findings.push("core/shared: shared contracts cannot depend on another Friday package");
  }

  for (const file of (await walk(current.directory)).filter((candidate) => candidate.endsWith(".ts"))) {
    const source = await readFile(file, "utf8");
    const importPattern = /(?:from\s+|import\s*\()(["'])(\.\.?\/[^"']+)\1/g;
    for (const match of source.matchAll(importPattern)) {
      const resolved = path.resolve(path.dirname(file), match[2]);
      for (const target of packages.values()) {
        if (target === current) continue;
        if (resolved === target.directory || resolved.startsWith(`${target.directory}${path.sep}`)) {
          findings.push(`${path.relative(root, file)}: cross-workspace relative import ${match[2]}; use ${target.manifest.name}`);
        }
      }
    }
  }
}

// Phase 3: catch packages added under architectural areas but forgotten in the
// root workspace list.
for (const area of ["core", "integrations"]) {
  for (const file of (await walk(path.join(root, area))).filter((candidate) => candidate.endsWith("package.json"))) {
    const directory = path.dirname(file);
    if (![...packages.values()].some((workspace) => workspace.directory === directory)) {
      findings.push(`${path.relative(root, directory)}: package is not registered as a workspace`);
    }
  }
}

if (findings.length) {
  process.stderr.write(`Architecture audit failed:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Architecture audit passed for ${packages.size} workspaces.\n`);
}
