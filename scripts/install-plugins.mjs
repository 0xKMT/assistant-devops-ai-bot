/** Builds deployable OpenClaw workspaces before installing local paths. */
import { access } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
}

run("npm", ["run", "build", "--workspace", "@friday/git-adapter"]);
run("npm", ["run", "build", "--workspace", "@friday/jira-adapter"]);
run("npm", ["run", "build", "--workspace", "@friday/security-shield"]);

const plugins = [
  path.join(root, "integrations", "git-adapter"),
  path.join(root, "integrations", "jira-adapter"),
  path.join(root, "core", "security-shield"),
];
for (const plugin of plugins) {
  await access(path.join(plugin, "dist", "index.js"));
  run("openclaw", ["plugins", "install", "--force", plugin]);
}

process.stdout.write("Friday plugins installed. Apply and validate build/openclaw.patch.json next.\n");
