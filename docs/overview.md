---
title: Agent Tools overview
type: overview
created: 2026-09-27
updated: 2026-10-28
status: active
confidence: medium
tags: [bb-plugin, mcp, agent-skills]
sources:
  - package.json
  - server.ts
  - host.ts
  - agents.ts
  - skills.ts
  - app.tsx
  - contract.ts
  - i18n.ts
  - i18n.en.ts
  - tsconfig.json
  - AGENTS.md
  - settings-page.tsx
---
# Agent Tools overview
Agent Tools is a BB plugin that inventories MCP servers, CLI plugins, and agent skills on enrolled BB machines, then provides explicit operations to reconcile those resources (`server.ts:479-525`, `host.ts:783-785`).

## What it is

The plugin has a server entry, a trusted host entry, and a UI entry declared by its package manifest (`package.json:20-38`). The server collects machine scans, computes catalogue and skill drift, persists plugin state through BB key-value storage, and exposes BB RPC and CLI operations (`server.ts:479-525`, `server.ts:2044-2255`, `server.ts:2343-2346`). The host entry runs on each enrolled machine and reads or writes local CLI configuration and skill directories (`host.ts:783-785`, `host.ts:785-817`).

The main areas are the MCP catalogue and sync, BB hub skill management, OpenCode configuration comparison, CLI plugin inventory, and skill classifier settings (`app.tsx:919-941`, `app.tsx:3551-3558`, `settings-page.tsx:100-199`). The plugin supports Russian and English UI and CLI text. UI labels are translated during render using BB’s document locale (`ru*` → Russian, otherwise English); CLI language remains a saved choice (`app.tsx:114-119`, `app.tsx:325-332`, `app.tsx:431-451`, `i18n.ts:8-69`, `i18n.en.ts:4-63`).

## Stack

- TypeScript with ES2022, ES modules, bundler resolution, and React JSX (`tsconfig.json:1-29`).
- BB Plugin SDK `0.4.87` and BB engine `>=0.43` (`package.json:20-38`, `package.json:45-49`).
- Runtime dependencies include Zod `^4.3.6`, Radix UI tabs/checkbox/separator/slot, and HugeIcons (`package.json:38-45`).
- Development dependencies include TypeScript `^5.7.0`, Hono `^4.11.9`, better-sqlite3 `^12.0.0`, and `@get-bb/plugin-sdk` `0.4.87` (`package.json:47-72`).

## Quick start

The build, type-check, and test scripts are defined in `package.json:74-78`; the manifest declares the server, host, app, and bundled skill entry points (`package.json:25-37`).

```sh
npm ci
npm run typecheck
npm test
npm run build
bb plugin install .
```

## Where to look next

- [Architecture](architecture.md) — runtime parts and call paths.
- [MCP catalogue](features/mcp-catalog.md) — inventory, drift, adoption, sync, removal, probes, and MetaMCP.
- [Hub skills](features/skills-hub.md) — hub library, category placement, machine import and optional cleanup.
- [Legacy machine skills](features/skills.md) — retained scanner and deprecated fan-out RPC behavior.

- [OpenCode](features/opencode.md) — provider and model drift and updates.
- [CLI plugins](features/cli-plugins.md) — inventory of installed CLI plugins.
- [API and commands](api.md) — all BB RPC methods and `bb tools` commands.
- [Data model](data-model.md) — persisted state and host-side files.
- [Deployment](deployment.md) and [gotchas](gotchas.md) — installation and sharp edges.
