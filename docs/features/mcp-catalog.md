---
title: MCP server catalogue
type: component
created: 2026-09-27
updated: 2026-09-27
status: active
confidence: medium
tags: [mcp, catalogue, sync]
sources:
  - server.ts
  - contract.ts
  - agents.ts
  - host.ts
  - normalize.ts
  - toml-mcp.ts
  - metamcp.ts
  - probe.ts
  - app.tsx
---
# MCP server catalogue
The MCP feature scans managed CLI configurations across connected BB machines, compares them with a stored desired-state catalogue, and offers explicit add, update, enable, and removal actions (`server.ts:543-598`, `server.ts:673-735`).

## Purpose

The catalogue records server definitions, scope, optional CLI targets, origin, and update time (`contract.ts:441-451`). Machine scans distinguish installed agents, writable configuration files, gateways, and CLIs without adapters (`contract.ts:21-45`, `agents.ts:56-231`).

## Supported configuration adapters

| Agent | Config path(s) | Format / server map |
|---|---|---|
| Claude Code | `~/.claude.json` | JSON `mcpServers` (`agents.ts:56-64`) |
| Codex | `~/.codex/config.toml` | TOML `[mcp_servers.*]` (`agents.ts:65-79`) |
| OpenCode | `~/.config/opencode/opencode.json`, `opencode.jsonc` | JSON or JSONC `mcp` (`agents.ts:81-100`) |
| Cursor | `~/.cursor/mcp.json` | JSON `mcpServers` (`agents.ts:102-108`) |
| Antigravity | `~/.agents/mcp_config.json`, `~/.antigravity/mcp_config.json` | JSON `mcpServers` (`agents.ts:110-129`) |
| Gemini CLI | `~/.gemini/settings.json` | JSON `mcpServers` (`agents.ts:131-144`) |
| Qwen Code | `~/.qwen/settings.json` | JSON `mcpServers` (`agents.ts:145-152`) |
| Kimi CLI | `~/.kimi-code/mcp.json` | JSON `mcpServers`; path not confirmed (`agents.ts:153-159`) |
| Grok CLI | `~/.grok/config.toml` | TOML `[mcp_servers.*]` (`agents.ts:160-174`) |
| Crush | `~/.config/crush/crush.json` | JSON `mcp`; path not confirmed (`agents.ts:175-188`) |
| MimoCode | `~/.config/mimocode/mimocode.json` | JSON `mcp` (`agents.ts:190-203`) |
| MetaMCP gateway | `~/.agents/metamcp.mcp.json` | JSON `mcpServers`; gateway configuration (`agents.ts:205-219`) |

Additional detected CLI binaries with no MCP adapter are `aider`, `amp`, `copilot`, `droid`, and `goose`; they appear in the machine inventory only (`agents.ts:221-231`).

## How it works

1. `server.ts` lists enrolled BB machines, selects connected machines, and calls host `scan` (`server.ts:555-564`).
2. `host.ts` searches configured CLI binaries and candidate config paths, parses supported JSON/TOML dialects, and returns each machine's detected agents (`host.ts:998-1034`, `agents.ts:56-219`).
3. The server normalizes entries and calculates missing/different catalogue entries plus unrecognized pending servers (`server.ts:673-735`, `normalize.ts:27-86`, `normalize.ts:227-283`).
4. An operator adopts a pending item globally or as local-only, ignores it, or edits/removes a catalogue entry (`server.ts:1691-1710`, `server.ts:1861-1901`).
5. `plan` compares the catalogue with scans; `sync` sends requested upserts to eligible hosts and returns applied/failed counts (`server.ts:1098-1150`, `server.ts:1400-1451`).
6. `host.ts` merges modeled fields into existing config entries, creates a backup, and writes atomically; `dryRun` skips the file write (`host.ts:435-483`, `host.ts:1341-1369`).
7. `probe` starts MCP handshakes for configured servers on explicit request and retains the latest 400 probe results (`server.ts:1637-1688`).

## Modes, variants, and states

| Mode or state | Input / condition | Result |
|---|---|---|
| Global | `scope: global`; targets empty or include agent kind | Desired server participates in sync (`server.ts:668-671`). |
| Local-only | `scope: local-only` | Entry remains in catalogue but `wantsHere` returns false (`server.ts:668-671`). |
| Pending | Seen in an installed agent but absent from catalogue and ignored list | Aggregates occurrences across machines; classifies local paths/secrets/loopback (`server.ts:692-735`, `normalize.ts:256-283`). |
| Drift: missing / different | Desired global entry is absent / differs from normalized config | `plan` reports upsert operations (`server.ts:673-690`, `server.ts:1098-1150`). |
| Dry run | `dryRun: true` | Plan and per-host results are returned without config writes (`server.ts:1400-1451`, `host.ts:1354-1358`). |
| Disabled | Agent format carries a disabled flag | `enable` or `disable` edits supported dialects; unsupported agents are skipped (`agents.ts:235-246`, `server.ts:1460-1504`). |
| MetaMCP gateway | Gateway config exists and is writable | Gateway children are displayed separately; JSON import upserts into its local config (`server.ts:1593-1635`, `app.tsx:1278-1310`). |

## Failures

- Disconnected hosts are excluded from scan and sync targets (`server.ts:555-564`, `server.ts:1400-1410`). A failed main `scan` is stored with an error string (`server.ts:543-553`).
- A guessed config path cannot be created: the agent must have an existing file or `confirmedPath` set (`server.ts:652-665`, `agents.ts:40-46`).
- A non-writable config returns a failure for each requested operation (`host.ts:1324-1336`). A JSON/TOML parse or write exception marks operations failed and returns the error (`host.ts:1341-1369`).
- Gateway import rejects invalid JSON, a missing/non-writable gateway config, or input with no supported server entries (`server.ts:1551-1585`, `server.ts:1593-1635`).
- Probe failures are stored as result records; failure to call a host is logged and the older results remain for unprobed servers (`server.ts:1643-1688`).

## Business rules

- Only `global` entries whose target list is empty or includes the agent kind are desired on that agent (`server.ts:668-671`).
- Sync plans only create/update missing or differing entries; automatic sync passes `includeDifferent: false` (`server.ts:1098-1150`, `server.ts:2068-2073`).
- The hourly sync toggle defaults to false, and removal is a separate operation from catalogue-only `forget` (`server.ts:528-529`, `server.ts:2068-2073`, `server.ts:2365-2397`).
- Machine-bound entries are classified from absolute executable paths, loopback URLs, and secret references (`normalize.ts:256-283`).
- Config entry merging preserves fields outside the plugin's normalized model (`normalize.ts:194-203`, `host.ts:465-483`).
- Writes keep the last five timestamped backups and preserve the existing file mode through temp-file rename (`host.ts:435-463`).
- Codex TOML is updated textually through `readServers` / `upsertServer`, preserving unrelated sections (`toml-mcp.ts:80-107`, `toml-mcp.ts:162-183`).

## Public API or commands

See [API and commands](../api.md) for all RPC and CLI signatures. The catalogue-specific methods include `overview`, `rescan`, `adopt`, `ignore`, `unignore`, `catalog_update`, `catalog_remove`, `purge`, `plan`, `sync`, `probe`, `set_server_enabled`, and `gateway_add` (`server.ts:201-288`).

## Gotchas

- `forget` removes only the catalogue entry; `remove` also edits machine configs (`server.ts:2365-2397`).
- `opencode.jsonc` and other commented JSON configs can be scanned but are not writable through this path (`host.ts:373-434`).
- A gateway config can only be updated when its file exists; the host does not create an unconfirmed path (`server.ts:1593-1624`).

See [gotchas](../gotchas.md) and [data model](../data-model.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools API and commands](../api.md)
- [Agent Tools architecture](../architecture.md)
- [Agent Tools data model](../data-model.md)
- [Agent Tools decisions](../decisions.md)
- [Agent Tools gotchas](../gotchas.md)
- [Agent Tools overview](../overview.md)
