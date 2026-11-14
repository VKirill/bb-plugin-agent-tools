---
title: Agent Tools overview
type: overview
created: 2026-09-27
updated: 2026-11-14
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
  - host-skills.ts
  - hub-only.ts
---
# Agent Tools overview
Agent Tools is a BB plugin that inventories MCP servers, CLI plugins, and agent skills on enrolled BB machines, then provides explicit operations to reconcile those resources (`server.ts:477-595`, `host.ts:789-826`).

## What it is

The plugin has a server entry, a trusted host entry, and a UI entry declared by its package manifest (`package.json:20-38`). The server collects machine scans, computes catalogue and skill drift, persists plugin state through BB key-value storage, and exposes BB RPC and CLI operations (`server.ts:477-627`, `server.ts:2043-2253`, `server.ts:2350-2954`). The host entry runs on each enrolled machine and reads or writes local CLI configuration and skill directories (`host.ts:789-826`, `host-skills.ts:113-259`).

The main areas are the MCP catalogue and sync, BB hub skill management (including experimental `hubOnly` enforcement), OpenCode configuration comparison, CLI plugin inventory, and Settings (`app.tsx:900-960`, `app.tsx:3520-3580`, `settings-page.tsx:130-289`). The plugin supports Russian and English UI and CLI text: CLI and server text read KV `"lang"`, while the UI resolves `uiLang` (`auto | ru | en`) through `resolveUiLang` / `applyUiLang` (`app.tsx:100-165`, `settings-page.tsx:130-162`, `i18n.ts:6-130`, `i18n.en.ts:4-63`).

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
