---
title: Agent Tools project facts
type: overview
created: 2026-09-27
updated: 2026-10-28
status: active
confidence: high
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
  - settings-page.tsx
  - host-skills.ts
---
# Agent Tools project facts
Facts for agents working on this plugin; deeper behavior and domain detail live in the linked documentation pages.

## Identity

- BB plugin `agent-tools`; package: `bb-plugin-agent-tools` (`package.json:1-3`, `package.json:25-37`).
- Purpose: inventory MCP servers, CLI plugins, and skills across connected BB hosts (`server.ts:555-598`, `server.ts:881-942`).
- Detailed entry page: [docs/overview.md](docs/overview.md); architecture owner: [docs/architecture.md](docs/architecture.md).

## Entry points

- Server: `server.ts`; host: `host.ts`; UI: `app.tsx`; declared in `package.json:25-37`.
- Contracts: `contract.ts` (`contract.ts:355-452`).
- CLI group: `bb tools`, registered in `server.ts:2143-2255`; full command reference: [docs/api.md](docs/api.md).
- User-facing features: [MCP](docs/features/mcp-catalog.md), [hub skills and categories](docs/features/skills-hub.md), [legacy machine skills](docs/features/skills.md), [OpenCode](docs/features/opencode.md), [CLI plugins](docs/features/cli-plugins.md).

## Critical invariants

- Catalogue rollout selects installed, writable, non-gateway agents whose config exists or whose agent definition marks the path confirmed (`server.ts:701-707`, `agents.ts:46-67`; see [docs/gotchas.md](docs/gotchas.md)).
- Config writes create a timestamped adjacent backup, preserve permissions, and use temp-file rename (`host.ts:213-241`, `host.ts:1118-1189`).
- Existing server fields not modeled by this plugin survive because entry updates merge (`normalize.ts:194-203`, `host.ts:1160-1170`).
- Scheduled MCP sync remains separate from hub skill processing. The hourly sweep refreshes machine skill counts and runs classification according to its setting; the cleanup offer is off by default, while cleanup itself remains an explicit action (`server.ts:2302-2312`, `server.ts:530-540`, `skills-hub-service.ts:728-735`). See [deployment](docs/deployment.md).
- Skills policy is centralized in `skills.ts`; do not define a new home policy elsewhere (`skills.ts:103-138`).
- A classifier run left active in KV by plugin reload is cleared and restarted by the service's recovery task; failures are logged (`skills-hub-service.ts:390-398`; see [hub skills and categories](docs/features/skills-hub.md)).
- Hub skills live in the BB server process's `experimental_dataDir/skills`; machine skills are imported by copy, and cleanup is an explicit operation, while the setting controls whether its UI button is offered (`skills-hub-service.ts:593-609`, `skills-hub-service.ts:724-735`, `server.ts:530-540`; see [hub skills](docs/features/skills-hub.md)).
- Preserve host scan failures in the snapshot error field and bulk action failures in returned counts and errors (`server.ts:586-594`, `server.ts:2159-2189`).
- Full data ownership and retention: [docs/data-model.md](docs/data-model.md).

## Conventions

- Supported CLI definitions live in the `AGENTS` table; dialect conversion is implemented by normalization functions (`agents.ts:16-25`, `normalize.ts:194-203`).
- Skill-import scanning uses `MACHINE_SKILL_HOMES`; it resolves links, ignores owned paths and `bb-cli`, requires `SKILL.md`, and keeps the newest copy per name (`host-skills.ts:14-25`, `host-skills.ts:132-163`).
- User-facing strings pass through `t`, `tp`, or `plural`; the UI follows BB’s document locale before storing response data and computes state labels and filters during render. English entries live in `i18n.en.ts` (`i18n.ts:31-69`, `app.tsx:114-119`, `app.tsx:325-332`, `app.tsx:431-501`, `i18n.en.ts:4-63`).
- Host machine-specific paths are derived at runtime from `os.homedir()`; host IDs and machine statuses come from BB's host listing (`host.ts:69-73`, `server.ts:555-568`).

## Common gotchas

- `forget` removes catalogue state only; `remove` alters machine configs and then removes the catalogue row (`server.ts:2595-2627`).
- Commented JSONC is read-only (`host.ts:175-205`, `host.ts:638-698`).
- Equal-time conflicting skill versions need a human choice (`skills.ts:267-330`).
- See [docs/gotchas.md](docs/gotchas.md) for the evidence-backed list.

## Useful commands

- `npm ci`; `npm run typecheck`; `npm test`; `npm run build` (`package.json:74-78`).
- `npm run build` (`package.json:74-78`).
- `bb tools status`; `bb tools plan`; `bb tools scan --json` (`server.ts:2343-2363`).
- Deployment instructions: [docs/deployment.md](docs/deployment.md).
