---
title: CLI plugin inventory
type: component
created: 2026-09-27
updated: 2026-09-27
status: active
confidence: medium
tags: [cli-plugins, inventory]
sources:
  - host.ts
  - contract.ts
  - server.ts
  - app.tsx
  - package.json
  - agents.ts
---
# CLI plugin inventory
The plugin inventory scans supported CLI plugin registries on each machine and combines the results into a host-by-plugin view (`host.ts:916-996`, `server.ts:891-952`).

## Purpose

Each plugin record contains ID, agent name, display name, marketplace, version, scope, enabled state, and install path (`contract.ts:248-285`). The UI groups the inventory by agent and supports filters for all plugins, Claude Code, OpenCode, and Codex (`app.tsx:2333-2448`).

## How it works

1. The server's regular scan calls host method `plugins_scan` for each connected host and stores its result (`server.ts:555-598`).
2. The host parses supported local registries and returns plugin records (`host.ts:916-996`).
3. The server aggregates records using agent and plugin IDs, then builds an installed/enabled/version/path cell for every BB machine (`server.ts:891-952`).
4. The UI displays the cross-machine table; the `bb tools plugins` command groups the same records by agent (`app.tsx:2333-2448`, `server.ts:2624-2649`).

## Modes and states

| State | Meaning |
|---|---|
| Installed | Matching plugin ID was found on that host (`server.ts:910-923`). |
| Not installed | No matching plugin record exists on that host (`server.ts:913-923`). |
| Enabled | Source registry reports `enabled: true` (`contract.ts:248-263`). |
| Unknown / not scanned | The host has no plugin scan snapshot; the aggregate cell is not installed (`server.ts:913-923`). |
| Filter | UI shows all, Claude Code, OpenCode, or Codex records (`app.tsx:2375-2418`). |

## Failures

- A failed host plugin scan is logged and does not fail the overall scan operation (`server.ts:587-598`).
- A failed scan leaves no fresh plugin snapshot for the host; the view derives presence from available cached scans (`server.ts:621-628`, `server.ts:891-923`).
- This feature is an inventory only: its host contract exposes `plugins_scan` and no plugin install/remove operation (`contract.ts:433-436`).

## Business rules

- Plugin identity in the aggregation is the pair `agent:id` (`server.ts:900-907`).
- Host coverage is built against every machine returned by BB, including disconnected machines (`server.ts:910-923`).
- Display order prioritizes Claude Code, OpenCode, then Codex; other agent IDs follow (`server.ts:946-952`).
- The host scan implementation reads registry/config data for plugins and does not perform marketplace installation (`host.ts:916-996`).

## Public API or commands

See [API and commands](../api.md). The host RPC method is `plugins_scan`; the user command is `bb tools plugins [--json]` (`contract.ts:433-436`, `server.ts:2241-2244`).

## Gotchas

- A host can be connected and still appear empty if its plugin scan has not succeeded (`server.ts:587-598`, `server.ts:913-923`).
- The visible CLI filter set is narrower than the MCP agent adapter list (`app.tsx:2375-2418`, `agents.ts:56-219`).

See [API](../api.md) and [architecture](../architecture.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools API and commands](../api.md)
- [Agent Tools overview](../overview.md)
