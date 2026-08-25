# Technology Stack

- Runtime: Node.js \`>=24\`; current onboarding environment was Node v24.18.0.
- Package manager: npm \`>=11\`; current onboarding environment was npm 11.16.0.
- Layout: private npm monorepo with five workspaces:
  `core/shared`, `core/security-shield`, `integrations/git-adapter`, `integrations/jira-adapter`, `integrations/slack-recovery`.
- Module system: ESM (`"type": "module"`), TypeScript with `NodeNext` module/moduleResolution.
- Compiler baseline: target ES2022, strict mode, noUnusedLocals/noUnusedParameters, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride, useUnknownInCatchVariables, verbatimModuleSyntax, noEmit.
- Tooling: TypeScript ^5.9, tsup ^8.5, tsx ^4.20, @types/node ^24; package lock is committed.
- Tests: Node built-in test runner; TypeScript tests run through `tsx --test`, JavaScript module tests through `node --test`.
- Build: tsup emits Node 24 ESM bundles into package-local `dist/`; workspace check also runs `node --check` on the emitted entrypoint.
- Runtime/deployment ecosystem: OpenClaw \`2026.7.1-2\`, Docker Compose v2, Slack Socket Mode, GitHub CLI OAuth; optional validators include TFLint, Trivy, Helm, Kustomize, and kubeconform.