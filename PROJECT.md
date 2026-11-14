---
title: Agent Tools project facts
type: overview
created: 2026-09-27
updated: 2026-11-14
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
  - hub-only.ts
  - required-session-policy.ts
  - hub-skills.ts
---
# Agent Tools project facts
Facts for agents working on this plugin; deeper behavior and domain detail live in the linked documentation pages.

## Identity

- BB plugin `agent-tools`; package: `bb-plugin-agent-tools` (`package.json:1-3`, `package.json:25-37`).
- Purpose: inventory MCP servers, CLI plugins, and skills across connected BB hosts (`server.ts:651-696`, `server.ts:875-1183`).
- Detailed entry page: [docs/overview.md](docs/overview.md); architecture owner: [docs/architecture.md](docs/architecture.md).

## Entry points

- Server: `server.ts`; host: `host.ts`; UI: `app.tsx`; declared in `package.json:25-37`.
- Contracts: `contract.ts` (`contract.ts:359-498`).
- CLI group: `bb tools`, registered in `server.ts:2350-2954`; full command reference: [docs/api.md](docs/api.md).
- User-facing features: [MCP](docs/features/mcp-catalog.md), [hub skills and categories](docs/features/skills-hub.md), [machine skill discovery](docs/features/machine-skill-discovery.md), [skill suggestion](docs/features/skill-suggest.md), [legacy machine skills](docs/features/skills.md), [OpenCode](docs/features/opencode.md), [CLI plugins](docs/features/cli-plugins.md).

## Critical invariants

- Catalogue rollout selects installed, writable, non-gateway agents whose config exists or whose agent definition marks the path confirmed (`server.ts:755-762`, `agents.ts:40-67`; see [docs/gotchas.md](docs/gotchas.md)).
- Config writes create a timestamped adjacent backup, preserve permissions, and use temp-file rename (`host.ts:228-270`, `host.ts:1102-1178`).
- Existing server fields not modeled by this plugin survive because entry updates merge (`normalize.ts:194-203`, `host.ts:1150-1170`).
- Scheduled MCP sync remains separate from hub skill processing. The hourly sweep refreshes machine skill counts, runs `enforceHubOnly` only when `skillsHubOnly` is enabled (and skips machine cleanup if any missing skill hits a blocking or transient error), and starts classification according to its setting (`server.ts:2256-2270`, `server.ts:523-528`, `hub-only.ts:63-118`, `skills-hub-service.ts:1317-1325`). See [deployment](docs/deployment.md).
- Legacy machine-home policy is centralized in `skills.ts`; do not define a new home policy elsewhere (`skills.ts:103-138`).
- A classifier run left active in KV by plugin reload is cleared and restarted by the service's recovery task; hidden classifier and card-writer threads apply `requiredSessionPolicySpawnField` when core advertises `experimental_vkRequiredSessionPolicy` (`skills-hub-service.ts:404-408`, `skills-hub-service.ts:464-470`, `required-session-policy.ts:73-103`; see [hub skills and categories](docs/features/skills-hub.md)).
- Hub skills live in the BB server process's `experimental_dataDir/skills`, protected from machine scans/cleanup by KV `skillCanonToken` stamped into `<root>/.agent-tools-canon`; machine skills absent from `loadableHubNames(hub)` are imported by copy (`skills-hub-service.ts:927-959`, `skills-hub-service.ts:1163-1179`, `host-skills.ts:113-145`, `hub-only.ts:46-57`; see [hub skills](docs/features/skills-hub.md)).
- Preserve host scan failures in the snapshot error field and bulk action failures in returned counts and errors (`server.ts:640-650`, `server.ts:2119-2150`).
- Full data ownership and retention: [docs/data-model.md](docs/data-model.md).

## Conventions

- Supported CLI definitions live in the `AGENTS` table; dialect conversion is implemented by normalization functions (`agents.ts:16-25`, `normalize.ts:194-203`).
- Skill-import scanning uses `MACHINE_SKILL_HOMES`; it skips protected canon marker roots, resolves links, ignores owned paths and `bb-cli`, requires `SKILL.md`, and keeps the newest copy per name (`host-skills.ts:14-25`, `host-skills.ts:113-207`).
- User-facing strings pass through `t`, `tp`, or `plural`; the UI resolves page language (`uiLang` choice `"auto" | "ru" | "en"`) through `resolveUiLang` / `applyUiLang`, while CLI/server language uses KV `"lang"`. English entries live in `i18n.en.ts` (`i18n.ts:6-130`, `app.tsx:100-165`, `settings-page.tsx:130-162`, `i18n.en.ts:4-63`).
- Host machine-specific paths are derived at runtime from `os.homedir()`; host IDs and machine statuses come from BB's host listing (`host.ts:69-73`, `server.ts:651-696`).

## Common gotchas

- `forget` removes catalogue state only; `remove` alters machine configs and then removes the catalogue row (`server.ts:2590-2623`).
- Commented JSONC is read-only (`host.ts:185-214`, `host.ts:581-705`).
- Equal-time conflicting skill versions need a human choice (`skills.ts:267-330`).
- See [docs/gotchas.md](docs/gotchas.md) for the evidence-backed list.

## Useful commands

- `npm ci`; `npm run typecheck`; `npm test`; `npm run build` (`package.json:74-78`).
- `npm run build` (`package.json:74-78`).
- `bb tools status`; `bb tools plan`; `bb tools scan --json`; `bb tools skills-hub-only --dry-run` (`server.ts:2350-2954`, `skills-hub-service.ts:1485-1511`).
- Deployment instructions: [docs/deployment.md](docs/deployment.md).
