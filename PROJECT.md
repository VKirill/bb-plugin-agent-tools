---
title: Agent Tools project facts
type: overview
created: 2026-09-27
updated: 2026-09-30
status: active
confidence: medium
tags: [agents, architecture, operations]
sources:
  - package.json
  - AGENTS.md
  - server.ts
  - host.ts
  - skills.ts
  - skills-sync.ts
  - skills-server.ts
  - skill-tree.ts
  - contract.ts
  - agents.ts
---
# Agent Tools project facts
Facts for agents working on this plugin; deeper behavior and domain detail live in the linked documentation pages.

## Identity

- BB plugin `agent-tools`; package: `bb-plugin-agent-tools` (`package.json:1-3`, `package.json:25-37`).
- Purpose: inventory MCP servers, CLI plugins, and skills across connected BB hosts (`server.ts:555-598`, `server.ts:891-952`).
- Detailed entry page: [docs/overview.md](docs/overview.md); architecture owner: [docs/architecture.md](docs/architecture.md).

## Entry points

- Server: `server.ts`; host: `host.ts`; UI: `app.tsx`; declared in `package.json:25-37`.
- Contracts: `contract.ts` (`contract.ts:355-452`).
- CLI group: `bb tools`, registered in `server.ts:2153-2265`; full command reference: [docs/api.md](docs/api.md).
- User-facing features: [MCP](docs/features/mcp-catalog.md), [skills](docs/features/skills.md), [OpenCode](docs/features/opencode.md), [CLI plugins](docs/features/cli-plugins.md).

## Critical invariants

- Host writes require an existing config or confirmed path (`server.ts:652-665`; see [docs/gotchas.md](docs/gotchas.md)).
- Config writes create a timestamped adjacent backup, preserve permissions, and use temp-file rename (`host.ts:213-241`, `host.ts:1118-1189`).
- Existing server fields not modeled by this plugin survive because entry updates merge (`normalize.ts:194-203`, `host.ts:1160-1170`).
- Catalog auto sync and scheduled skills fan-out use separate controls; defaults and sweep behavior: [deployment](docs/deployment.md) (`server.ts:487-514`, `server.ts:528-529`, `server.ts:2267-2287`).
- Skills policy is centralized in `skills.ts`; do not define a new home policy elsewhere (`skills.ts:103-138`).
- Skill rollout copies recognized clean trees, checks the BB byte threshold, and mirrors into the BB server process's `experimental_dataDir/skills` (`skill-tree.ts:12-29`, `skills.ts:145-162`, `skills.ts:582-612`, `server.ts:1361-1532`; see [skills](docs/features/skills.md)).
- Preserve BB host failures in output and check per-operation results (`server.ts:558-567`, `server.ts:2122-2160`).
- Full data ownership and retention: [docs/data-model.md](docs/data-model.md).

## Conventions

- Add a supported CLI only in `agents.ts`; dialect conversion belongs in `normalize.ts` (`agents.ts:1-4`, `AGENTS.md:12-19`).
- Add a skill home in both `skills.ts` policy/path maps and `host.ts` locations (`skills.ts:103-133`, `host.ts:254-273`).
- User-facing strings pass through `t`, `tp`, or `plural`; English entries live in `i18n.en.ts` (`AGENTS.md:55-57`, `i18n.ts:31-69`).
- Host machine-specific paths are derived at runtime from `os.homedir()`; host IDs and machine statuses come from BB's host listing (`host.ts:69-73`, `server.ts:569-578`).

## Common gotchas

- `forget` removes catalogue state only; `remove` alters machine files (`server.ts:2365-2397`).
- Commented JSONC is read-only (`host.ts:175-205`, `host.ts:638-698`).
- Equal-time conflicting skill versions need a human choice (`skills.ts:267-330`).
- See [docs/gotchas.md](docs/gotchas.md) for the evidence-backed list.

## Useful commands

- `npm ci`; `npm run typecheck`; `npm test`; `npm run build` (`package.json:74-78`).
- `bb plugin install .`; `bb plugin build .`; `bb plugin reload agent-tools` (`AGENTS.md:10`).
- `bb tools status`; `bb tools plan`; `bb tools scan --json` (`server.ts:2353-2373`, `AGENTS.md:26-28`).
- Deployment instructions: [docs/deployment.md](docs/deployment.md).
