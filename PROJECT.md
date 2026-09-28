---
title: Agent Tools project facts
updated: 2026-09-28
sources:
  - package.json
  - AGENTS.md
  - server.ts
  - host.ts
  - skills.ts
  - contract.ts
  - agents.ts
---
# Agent Tools project facts

## Identity

- BB plugin `agent-tools`; package: `bb-plugin-agent-tools` (`package.json:1-3`, `package.json:25-37`).
- Purpose: inventory MCP servers, CLI plugins, and skills across connected BB hosts (`server.ts:555-598`, `server.ts:891-952`).
- Detailed entry page: [docs/overview.md](docs/overview.md); architecture owner: [docs/architecture.md](docs/architecture.md).

## Entry points

- Server: `server.ts`; host: `host.ts`; UI: `app.tsx`; declared in `package.json:25-37`.
- Contracts: `contract.ts` (`contract.ts:348-436`).
- CLI group: `bb tools`, registered in `server.ts:2153-2265`; full command reference: [docs/api.md](docs/api.md).
- User-facing features: [MCP](docs/features/mcp-catalog.md), [skills](docs/features/skills.md), [OpenCode](docs/features/opencode.md), [CLI plugins](docs/features/cli-plugins.md).

## Critical invariants

- Host writes require an existing config or confirmed path (`server.ts:652-665`; see [docs/gotchas.md](docs/gotchas.md)).
- Config writes create a timestamped adjacent backup, preserve permissions, and use temp-file rename (`host.ts:435-463`).
- Existing server fields not modeled by this plugin survive because entry updates merge (`normalize.ts:194-203`, `host.ts:465-483`).
- Catalog auto sync and scheduled skills fan-out use separate controls; defaults and sweep behavior: [deployment](docs/deployment.md) (`server.ts:493-500`, `server.ts:528-529`, `server.ts:2057-2087`).
- Skills policy is centralized in `skills.ts`; do not define a new home policy elsewhere (`skills.ts:103-138`).
- Preserve BB host failures in output and check per-operation results (`server.ts:543-553`, `server.ts:1930-1960`).
- Full data ownership and retention: [docs/data-model.md](docs/data-model.md).

## Conventions

- Add a supported CLI only in `agents.ts`; dialect conversion belongs in `normalize.ts` (`agents.ts:1-4`, `AGENTS.md:12-19`).
- Add a skill home in both `skills.ts` policy/path maps and `host.ts` locations (`skills.ts:103-133`, `host.ts:485-495`).
- User-facing strings pass through `t`, `tp`, or `plural`; English entries live in `i18n.en.ts` (`AGENTS.md:55-57`, `i18n.ts:31-69`).
- Host machine-specific paths are derived at runtime from the machine home; host IDs come from BB host listing (`server.ts:555-564`, `host.ts:77-81`).

## Common gotchas

- `forget` removes catalogue state only; `remove` alters machine files (`server.ts:2365-2397`).
- Commented JSONC is read-only (`host.ts:373-434`, `host.ts:802-813`).
- Equal-time conflicting skill versions need a human choice (`skills.ts:267-330`).
- See [docs/gotchas.md](docs/gotchas.md) for the evidence-backed list.

## Useful commands

- `npm ci`; `npm run typecheck`; `npm test`; `npm run build` (`package.json:74-78`).
- `bb plugin install .`; `bb plugin build .`; `bb plugin reload agent-tools` (`AGENTS.md:10`).
- `bb tools status`; `bb tools plan`; `bb tools scan --json` (`server.ts:2157-2173`, `AGENTS.md:26-28`).
- Deployment instructions: [docs/deployment.md](docs/deployment.md).
