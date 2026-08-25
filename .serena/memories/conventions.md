# Code Conventions

- Use ESM imports with explicit `.js` specifiers, including imports from local TypeScript source; use `import type` for type-only dependencies.
- Keep TypeScript strict and satisfy the shared compiler baseline; prefer explicit interfaces/types and readonly input fields/collections where values are not mutated.
- Use camelCase for functions/variables, PascalCase for types/interfaces, UPPER_SNAKE_CASE for module constants; keep deterministic ordering via explicit rank maps/comparators when output is user-visible.
- Public tool contracts live in `core/shared` and stay host-neutral. JSON schemas are colocated with their TypeScript input types and use `as const satisfies JsonSchema`; reject additional properties where the contract requires it.
- Preserve workspace boundaries: import `@friday/shared` by package name, never by relative path across workspaces; core must not import integrations/scripts/container.
- OpenClaw plugin entrypoints are thin registration boundaries; business/security logic belongs in package modules and setup scripts are orchestration only.
- Security-sensitive paths fail closed, bound reads/results/concurrency, redact secrets, and avoid returning secret values or raw credential/state data.
- Comments/docstrings explain invariants, security boundaries, line attribution, or non-obvious algorithms; avoid comments that merely restate code.
- Tests use `node:test` and `node:assert/strict`; TypeScript tests are run with `tsx --test`. Keep fixtures under each package's `test/fixtures`; test names state the behavioral contract.
- No repository lint/format script is defined; formatting follows existing source style (two-space indentation, semicolons, trailing commas in multiline literals).