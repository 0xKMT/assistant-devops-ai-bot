# Core

Core packages do not depend on a concrete integration implementation:

- `@friday/shared` provides OpenClaw-neutral contracts and schemas.
- `@friday/security-shield` provides the OpenClaw security boundary.

Code under `core/` must not import from `integrations/`, `scripts/`, or
`container/`. See [Architecture](../docs/ARCHITECTURE.md) for dependency rules.
