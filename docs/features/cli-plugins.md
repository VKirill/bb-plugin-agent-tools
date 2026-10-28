---
title: CLI plugin inventory
type: component
created: 2026-09-27
updated: 2026-10-28
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
  - normalize.ts
---
# CLI plugin inventory
The plugin inventory scans supported CLI plugin registries on each machine and combines the results into a host-by-plugin view (`host.ts:707-786`, `server.ts:947-1008`).

## Purpose

Each plugin record contains ID, agent name, display name, marketplace, version, scope, enabled state, and install path (`contract.ts:255-292`). The Plugins tab groups records into a host-by-plugin table and filters all records, Claude Code, OpenCode, or Codex (`app.tsx:2468-2537`).

## How it works

1. The server's regular scan calls host method `plugins_scan` for each connected host and stores its result (`server.ts:635-644`).
2. The host parses Claude Code's installed registry and enabled settings, the first readable OpenCode config, and Codex plugin tables; read/parse errors are skipped (`host.ts:707-786`).
3. The server aggregates records using agent and plugin IDs, then builds an installed/enabled/version/path cell for every enrolled BB machine (`server.ts:947-1000`).
4. The UI displays the cross-machine table; `bb tools plugins` groups the same records by agent (`app.tsx:2468-2537`, `server.ts:2883-2908`).

### Agent adapter registry (`AGENTS`)

`AGENTS` is the ordered adapter table used by host scans. Each entry supplies a stable `kind`, label, executable candidates, ordered config candidates, format and dialect pointer, BB provider IDs, and optional gateway or confirmed-path flags (`agents.ts:56-219`).

1. The host visits `AGENTS` in declaration order. For each entry, `findBin` tries executable names and platform candidates until it finds a file or symlink; empty `bins` skips that lookup (`agents.ts:56-219`, `host.ts:87-102`, `host.ts:792-798`).
2. `pickConfig` loads all declared candidate paths concurrently and chooses the first with non-null text. If none has text, it returns the first candidate's load result (`host.ts:158-218`).
3. `loadConfig` reads TOML through `readServers`; for JSON/JSONC it strips comments, parses JSON, reads the configured pointer, and converts each object entry with `fromDialect` (`host.ts:158-210`, `normalize.ts:28-87`).
4. The scan marks a gateway installed when its selected config has text; other agents use executable presence. It returns the config path, existence, writability, warning, and parsed servers (`host.ts:792-810`).

| Adapter branch | What changes | Scan result or write consequence |
|---|---|---|
| Multiple executable names | `findBin` checks each declared name and its platform filename variants (`agents.ts:56-219`, `host.ts:87-102`). | The first executable path found is reported; otherwise `binPath` is null (`host.ts:792-803`). |
| Multiple config candidates | OpenCode and Antigravity declare two ordered paths (`agents.ts:81-99`, `agents.ts:109-129`). | First non-null text wins; no text selects the first candidate's result, including its warning/writability (`host.ts:214-218`). |
| Gateway | `gateway: true` changes installed detection to config text; the MetaMCP entry has no executable candidates (`agents.ts:205-218`, `host.ts:792-810`). | A gateway with no readable config text is not reported as installed. Server MCP management excludes gateways (`server.ts:701-713`). |
| Confirmed path | `confirmedPath` is metadata on some adapters and omitted on others (`agents.ts:56-219`). | Server write eligibility also requires installed, non-gateway, writable state and an existing config or confirmed path (`server.ts:701-713`). |
| Unsupported CLI inventory | `EXTRA_CLI_BINS` lists binaries without a managed MCP adapter (`agents.ts:221-225`). | Found binaries appear only in `otherClis`; they do not become managed-agent entries (`host.ts:812-824`). |

Failures are represented at config-load time where possible: missing/unreadable files yield null text and an empty server list; oversized files are read-only; malformed JSON yields a warning and no servers; JSONC comments preserve parsed values but make the config non-writable (`host.ts:158-210`). TOML parsing errors are not caught by `loadConfig`; an abort signal or uncaught filesystem/process error can reject the host scan (`host.ts:172-179`, `host.ts:792-810`).

## Modes and states

| State | Meaning |
|---|---|
| Installed | Matching plugin ID was found on that enrolled host (`server.ts:966-979`). |
| Not installed | No matching plugin record exists in the available scan snapshot (`server.ts:969-978`). |
| Enabled | Source registry reports `enabled: true` (`contract.ts:255-269`). |
| Unknown / not scanned | The host has no plugin scan snapshot; the aggregate cell is not installed (`server.ts:969-978`). |
| Filter | UI shows all, Claude Code, OpenCode, or Codex records (`app.tsx:2475-2520`). |

## Failures

- A failed host plugin scan is logged and does not fail the overall scan operation (`server.ts:635-644`).
- A failed scan leaves the stored snapshot untouched; the view derives presence from available snapshots (`server.ts:635-645`, `server.ts:947-979`).
- This feature is an inventory only: its host contract exposes `plugins_scan` and no plugin install/remove operation (`contract.ts:494`).

## Business rules

- Plugin identity in the aggregation is the pair `agent:id` (`server.ts:956-962`, `server.ts:969-972`).
- Host coverage is built against every enrolled machine returned by BB, including disconnected machines (`server.ts:966-979`).
- Display order prioritizes Claude Code, OpenCode, then Codex; other agent IDs follow (`server.ts:958-964`).
- The host scan implementation reads registry/config data for plugins and does not perform marketplace installation (`host.ts:700-780`).

## Public API or commands

See [API and commands](../api.md). The host RPC method is `plugins_scan`; the user command is `bb tools plugins [--json]` (`contract.ts:492-494`, `server.ts:2477-2480`, `server.ts:2883-2908`).

## Gotchas

- A host can be connected and still appear empty if its plugin scan has not succeeded (`server.ts:635-645`, `server.ts:969-978`).
- The visible CLI filter set is narrower than the MCP agent adapter list (`app.tsx:2475-2520`, `agents.ts:56-219`).

See [API](../api.md) and [architecture](../architecture.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools API and commands](../api.md)
- [Agent Tools overview](../overview.md)
