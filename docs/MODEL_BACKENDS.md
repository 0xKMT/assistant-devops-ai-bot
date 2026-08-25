# Codex and Claude Code Backends

Friday uses OpenClaw as its gateway, but generated configuration explicitly pins
the model turn to one backend. Enable one profile per instance.

## Codex

```json
{
  "modelBackend": {
    "profile": "codex",
    "primaryModel": "openai/gpt-5.6-sol",
    "command": ""
  }
}
```

`openai/*` models route through the Codex app-server runtime
(`agentRuntime.id=codex`). `npm run setup:full -- --login ...` starts the
OpenClaw OpenAI login flow. A separate Codex CLI is optional for diagnostics:

```bash
npm install --global @openai/codex
codex login
codex login status
```

## Claude Code

Install Claude Code through Anthropic's official method, then authenticate:

```bash
claude auth login
claude auth status --text
command -v claude
```

```json
{
  "modelBackend": {
    "profile": "claude-code",
    "primaryModel": "anthropic/claude-opus-4-8",
    "command": "/absolute/path/to/claude"
  }
}
```

The generated configuration uses `agentRuntime.id=claude-cli` and the absolute
command path.

## Switching Backends

Change `profile`, `primaryModel`, and `command`, then run preflight and dry-run,
review the generated patch, apply it, and repeat the acceptance checklist. Do
not enable both runtime profiles in one policy without reviewing allowlist and
plugin behavior again.
