---
title: CLI plugin inventory
type: component
created: 2026-09-27
updated: 2026-09-30
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
The plugin inventory scans supported CLI plugin registries on each machine and combines the results into a host-by-plugin view (`host.ts:700-780`, `server.ts:913-975`).

## Purpose

Each plugin record contains ID, agent name, display name, marketplace, version, scope, enabled state, and install path (`contract.ts:255-292`). The UI groups the inventory by agent and supports filters for all plugins, Claude Code, OpenCode, and Codex (`app.tsx:2333-2448`).

## How it works

1. The server's regular scan calls host method `plugins_scan` for each connected host and stores its result (`server.ts:601-610`).
2. The host parses supported local registries and returns plugin records (`host.ts:700-780`).
3. The server aggregates records using agent and plugin IDs, then builds an installed/enabled/version/path cell for every BB machine (`server.ts:913-965`).
4. The UI displays the cross-machine table; the `bb tools plugins` command groups the same records by agent (`app.tsx:2333-2448`, `server.ts:2825-2850`).

### Agent adapter registry (`AGENTS`)

`AGENTS` is the ordered adapter table used by host scans. Each entry supplies a stable `kind`, label, executable candidates, ordered config candidates, format and dialect pointer, BB provider IDs, and optional gateway or confirmed-path flags (`agents.ts:56-219`).

1. The host walks the table in order, checks the first matching executable from each entry's `bins`, and loads its config candidates (`host.ts:785-790`).
2. Config candidates are expanded from the host home and loaded concurrently. The first candidate with readable text wins; if none has text, the first candidate remains the selected path (`host.ts:151-163`, `host.ts:207-210`).
3. For JSON/JSONC, the loader strips comments and parses the selected file, then reads the configured pointer and converts valid entries from that CLI dialect. TOML goes through the TOML reader and the same dialect conversion (`host.ts:165-203`).
4. The scan reports `installed` from config presence for gateway entries and from executable presence for other entries. It returns config path, existence, writability, warning, and parsed servers with the agent record (`host.ts:791-803`).

| Adapter branch | What changes | Scan result or write consequence |
|---|---|---|
| Multiple executable names | `findBin` uses the entry's ordered `bins`; entries with no binaries skip executable lookup (`agents.ts:56-63`, `agents.ts:102-107`, `agents.ts:205-217`, `host.ts:789`). | The first found path is reported; a missing executable yields `binPath: null` (`host.ts:789-803`). |
| Multiple config candidates | OpenCode and Antigravity declare two ordered paths; selection prefers the first candidate whose file loaded (`agents.ts:80-99`, `agents.ts:109-129`, `host.ts:207-210`). | If no candidate loads text, the first path is reported as the fallback (`host.ts:207-210`). |
| Gateway | `gateway: true` changes installed detection to config presence, despite the empty `bins` list (`agents.ts:205-218`, `host.ts:789-803`). | It appears installed only when its config has readable text. Server MCP management excludes gateway agents (`server.ts:673-680`). |
| Confirmed path | `confirmedPath` is metadata on adapters such as Claude Code and Codex; some adapters omit it (`agents.ts:56-78`, `agents.ts:153-159`). | Server writes require the adapter to be installed, non-gateway, writable, and backed by an existing config or confirmed path (`server.ts:673-680`). |
| Unsupported CLI inventory | `EXTRA_CLI_BINS` lists binaries without a managed MCP adapter (`agents.ts:221-225`, `host.ts:805-809`). | Found binaries appear in `otherClis`; they do not become entries in `agents` (`host.ts:805-817`). |

Failures are represented at config-load time where possible: missing/unreadable files yield an empty parsed server list and writable fallback; an oversized config yields no text and is read-only; malformed JSON yields no servers and a parse warning; JSONC comments preserve parsed values but mark the config non-writable (`host.ts:151-163`, `host.ts:175-203`). TOML parsing errors are not caught there, and an abort signal or uncaught filesystem/process error can reject the enclosing host scan (`host.ts:165-173`, `host.ts:785-790`).

## Modes and states

| State | Meaning |
|---|---|
| Installed | Matching plugin ID was found on that host (`server.ts:935-945`). |
| Not installed | No matching plugin record exists on that host (`server.ts:935-945`). |
| Enabled | Source registry reports `enabled: true` (`contract.ts:255-269`). |
| Unknown / not scanned | The host has no plugin scan snapshot; the aggregate cell is not installed (`server.ts:935-945`). |
| Filter | UI shows all, Claude Code, OpenCode, or Codex records (`app.tsx:2375-2418`). |

## Failures

- A failed host plugin scan is logged and does not fail the overall scan operation (`server.ts:601-610`).
- A failed scan leaves no fresh plugin snapshot for the host; the view derives presence from available cached scans (`server.ts:635-642`, `server.ts:913-945`).
- This feature is an inventory only: its host contract exposes `plugins_scan` and no plugin install/remove operation (`contract.ts:451`).

## Business rules

- Plugin identity in the aggregation is the pair `agent:id` (`server.ts:922-929`).
- Host coverage is built against every machine returned by BB, including disconnected machines (`server.ts:932-945`).
- Display order prioritizes Claude Code, OpenCode, then Codex; other agent IDs follow (`server.ts:968-974`).
- The host scan implementation reads registry/config data for plugins and does not perform marketplace installation (`host.ts:700-780`).

## Public API or commands

See [API and commands](../api.md). The host RPC method is `plugins_scan`; the user command is `bb tools plugins [--json]` (`contract.ts:451`, `server.ts:2441-2444`).

## Gotchas

- A host can be connected and still appear empty if its plugin scan has not succeeded (`server.ts:601-610`, `server.ts:935-945`).
- The visible CLI filter set is narrower than the MCP agent adapter list (`app.tsx:2375-2418`, `agents.ts:56-219`).

See [API](../api.md) and [architecture](../architecture.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools API and commands](../api.md)
- [Agent Tools overview](../overview.md)
