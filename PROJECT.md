---
title: Agent Tools project facts
type: overview
created: 2026-09-27
updated: 2026-10-27
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
  - app.tsx
  - i18n.ts
  - i18n.en.ts
  - skills-hub-service.ts
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
- User-facing features: [MCP](docs/features/mcp-catalog.md), [legacy skills rollout](docs/features/skills.md), [hub skills and categories](docs/features/skills-hub.md), [OpenCode](docs/features/opencode.md), [CLI plugins](docs/features/cli-plugins.md).

## Critical invariants

- Catalogue rollout selects installed, writable, non-gateway agents whose config exists or whose agent definition marks the path confirmed (`server.ts:711-717`, `agents.ts:46-67`; see [docs/gotchas.md](docs/gotchas.md)).
- Config writes create a timestamped adjacent backup, preserve permissions, and use temp-file rename (`host.ts:213-241`, `host.ts:1118-1189`).
- Existing server fields not modeled by this plugin survive because entry updates merge (`normalize.ts:194-203`, `host.ts:1160-1170`).
- Catalog auto sync and scheduled skills fan-out use separate controls; defaults and sweep behavior: [deployment](docs/deployment.md) (`server.ts:487-514`, `server.ts:528-529`, `server.ts:2267-2287`).
- Skills policy is centralized in `skills.ts`; do not define a new home policy elsewhere (`skills.ts:103-138`).
- A classifier run left active in KV by plugin reload is cleared and restarted when the skills hub service initializes (`skills-hub-service.ts:335-343`; see [hub skills and categories](docs/features/skills-hub.md)).
- Skill rollout copies recognized clean trees, checks the BB byte threshold, and mirrors into the BB server process's `experimental_dataDir/skills` (`skill-tree.ts:12-29`, `skills.ts:145-162`, `skills.ts:582-612`, `server.ts:1361-1532`; see [skills](docs/features/skills.md)).
- Preserve host scan failures in the snapshot error field and bulk action failures in returned counts and errors (`server.ts:596-604`, `server.ts:2169-2199`).
- Full data ownership and retention: [docs/data-model.md](docs/data-model.md).

## Conventions

- Supported CLI definitions live in the `AGENTS` table; dialect conversion is implemented by normalization functions (`agents.ts:16-25`, `normalize.ts:194-203`).
- Add a skill home in both `skills.ts` policy/path maps and `host.ts` locations (`skills.ts:103-133`, `host.ts:254-273`).
- User-facing strings pass through `t`, `tp`, or `plural`; the UI follows BB’s document locale before storing response data and computes state labels and filters during render. English entries live in `i18n.en.ts` (`i18n.ts:31-69`, `app.tsx:113-118`, `app.tsx:324-331`, `app.tsx:430-500`, `i18n.en.ts:4-63`).
- Host machine-specific paths are derived at runtime from `os.homedir()`; host IDs and machine statuses come from BB's host listing (`host.ts:69-73`, `server.ts:569-578`).

## Common gotchas

- `forget` removes catalogue state only; `remove` alters machine configs and then removes the catalogue row (`server.ts:2635-2667`).
- Commented JSONC is read-only (`host.ts:175-205`, `host.ts:638-698`).
- Equal-time conflicting skill versions need a human choice (`skills.ts:267-330`).
- See [docs/gotchas.md](docs/gotchas.md) for the evidence-backed list.

## Useful commands

- `npm ci`; `npm run typecheck`; `npm test`; `npm run build` (`package.json:74-78`).
- `npm run build` (`package.json:74-78`).
- `bb tools status`; `bb tools plan`; `bb tools scan --json` (`server.ts:2353-2373`).
- Deployment instructions: [docs/deployment.md](docs/deployment.md).
