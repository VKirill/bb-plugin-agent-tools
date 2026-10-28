---
title: MCP server catalogue
type: component
created: 2026-09-27
updated: 2026-10-28
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
  - i18n.ts
  - i18n.en.ts
---
# MCP server catalogue
The MCP feature scans managed CLI configurations across connected BB machines, compares them with a stored desired-state catalogue, and offers explicit add, update, enable, and removal actions (`server.ts:603-645`, `server.ts:701-736`).

## Purpose

The catalogue record stores a normalized server definition, `global` or `local-only` scope, up to 32 CLI-kind targets, nullable origin host/kind, and an update timestamp in epoch milliseconds (`contract.ts:500-509`). Machine scans distinguish installed agents, writable configuration files, gateways, and CLIs without adapters (`contract.ts:21-45`, `agents.ts:56-231`).

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

1. `scanAll` lists enrolled BB machines, filters to connected hosts, then calls host `scan` (`server.ts:603-612`).
2. `host.ts` searches configured CLI binaries and candidate config paths, parses supported JSON/TOML dialects, and returns each machine's detected agents (`host.ts:151-210`, `host.ts:782-818`, `agents.ts:56-219`).
3. The server normalizes entries and calculates missing/different catalogue entries plus unrecognized pending servers (`server.ts:663-725`, `normalize.ts:27-86`, `normalize.ts:227-283`).
4. An operator adopts a pending item globally or as local-only, ignores it, or edits/removes a catalogue entry (`server.ts:1882-1900`, `server.ts:2051-2091`).
5. `plan` compares the catalogue with scans; `sync` sends requested upserts to eligible hosts and returns applied/failed counts (`server.ts:1110-1144`, `server.ts:1596-1641`).
6. `host.ts` merges modeled fields into existing config entries, creates a backup, and writes atomically; `dryRun` skips the file write (`host.ts:213-241`, `host.ts:1118-1189`).
7. `probe` starts MCP handshakes for configured servers on explicit request and retains the latest 400 probe results (`server.ts:1780-1878`).
8. The server refreshes configured MetaMCP namespaces through their OpenAPI documents and caches the returned namespace summaries for the UI (`server.ts:621-640`, `metamcp.ts:18-60`).

### Agent registry

`AGENTS` is a static list; each definition provides a `kind`, label, executable names, ordered candidate config files, BB provider ids, and optional gateway/path-confirmation flags (`agents.ts:27-46`, `agents.ts:56-129`). The catalogue uses these fields to select installed CLIs and interpret their files; this declaration does not probe machines or parse configs (`host.ts:782-818`).

The host checks each entry's executable names to mark a CLI installed, loads all config candidates, and selects the first candidate with text in declared order; if none has text, it falls back to the first candidate (`agents.ts:18-46`, `host.ts:151-210`). `format`, `pointer`, and `style` route the selected file to its parser; `confirmedPath` supports the rule that a missing config path is writable only when confirmed; `bbProviders` identifies BB thread providers; `gateway` marks aggregators (`agents.ts:18-46`, `server.ts:664-670`). The supported path/format/style values are listed above. A missing binary marks a non-gateway CLI as not installed; a gateway is treated as installed when its config exists. An aborted scan throws at the host scan entry (`host.ts:785-818`). The static registry itself has no error branch (`agents.ts:56-129`).

### RPC contract

`rpcContract` declares a Zod input and output schema for each plugin RPC method; `hostContract` separately defines host RPC payloads. `defineRpcContract` exposes the plugin methods to the runtime and app. The table below covers plugin RPC definitions through `probe`; later methods continue after this excerpt (`server.ts:201-260`, `contract.ts:355-452`).

| Method group | Input branches and bounds | Output / rejection |
|---|---|---|
| `overview`, `rescan` | No input; rescan accepts nullable `hostId` | `overviewSchema`; invalid input is rejected by the contract (`server.ts:216-217`). |
| `adopt`, `ignore`, `unignore` | `names` must contain 1–100 strings; adopt scope is nullable `global` or `local-only` | Overview; invalid name counts or scope fail schema validation (`server.ts:218-226`). |
| `catalog_update`, `catalog_remove` | Update accepts name, nullable scope, nullable targets up to 32, and nullable server spec; remove accepts a name | Overview; schema validation rejects excess targets or invalid fields (`server.ts:227-236`). |
| `purge` | Name, nullable host id, `includeGateways` default false, `dryRun` default false | Removed/failed counts, at most 100 error strings, and overview (`server.ts:223-237`). |
| `plan`, `sync` | Nullable host id; sync also requires `dryRun` and `includeDifferent` booleans | Plan schema or applied/failed counts, up to 100 errors, and overview (`server.ts:238-250`). |
| Auto-sync toggles and `probe` | Boolean `enabled` toggles; probe accepts nullable host id and name | Overview for toggles; probe returns checked/failed counts and overview (`server.ts:252-260`). |

The contract describes validation and payload shapes, not the operation bodies. It has no domain-error handling branch; RPC handlers return operation results separately (`server.ts:201-260`, `server.ts:2045-2111`).

### Config loading

`loadConfig` expands the configured home-relative path, stats it, rejects non-regular files through the same read-failure branch, and refuses to load a file larger than `MAX_CONFIG_BYTES` (`host.ts:151-163`). A missing or unreadable path returns an empty writable candidate with `text: null`; the later write path still decides whether the path is confirmed (`host.ts:151-163`, `server.ts:664-670`).

For TOML, it reads the configured server table and converts only entries recognized by `fromDialect`; this branch returns writable text without a warning (`host.ts:165-173`). For JSON/JSONC, it strips comments before parsing, reads only the configured pointer when it is an object map, and omits entries that do not convert (`host.ts:175-205`). Invalid JSON returns no servers, `writable: false`, and a parse warning. Valid commented JSON returns parsed servers but remains non-writable with a comments warning (`host.ts:175-205`). TOML parse errors are not caught in `loadConfig` (`host.ts:165-173`).

### Dialect normalization (`fromDialect`)

`fromDialect` converts one raw config entry into the shared `McpServer` model. It has no throw-based validation branch: malformed or incomplete shapes return `null`, so the config loader omits that entry (`normalize.ts:28-37`, `host.ts:172-203`). Its order is:

1. Reject null, arrays, and non-object entries. Set normalized `disabled: true` only when `disabled === true`, `enabled === false`, or `enable === false`; otherwise leave the field undefined (`normalize.ts:33-38`).
2. For OpenCode, check `type === "remote"` first. This branch needs a non-empty `url` and returns HTTP; otherwise treat the entry as local, requiring a non-empty all-string command array and taking its first item as `command` (`normalize.ts:40-62`).
3. For other dialects, a non-empty string `command` takes precedence and returns stdio, with string-array `args` and normalized `env` (`normalize.ts:65-75`).
4. If there is no command, try the URL fields in order: `url`, `serverUrl`, `serverURL`, `httpUrl`. A usable URL returns SSE only when a type/transport field equals `sse`; all other declarations normalize to HTTP. Otherwise return `null` (`normalize.ts:65-87`).
5. Header/environment maps retain string values, stringify numbers and booleans, discard other values, and become undefined when empty (`normalize.ts:9-24`).

| Dialect branch | Accepted shape | Result or omission |
|---|---|---|
| Input is null, array, or non-object | Not a record | Returns `null`; caller omits the entry (`normalize.ts:33-34`). |
| OpenCode remote | `type: "remote"`, non-empty URL | HTTP server; missing URL returns `null` (`normalize.ts:40-51`). |
| OpenCode local | Any other OpenCode type; command is an all-string non-empty array | First item is command, remaining items are args; missing/invalid command returns `null` (`normalize.ts:52-62`). |
| Other dialect, stdio | Non-empty string `command` | Stdio takes precedence over URL aliases (`normalize.ts:65-75`). |
| Other dialect, URL | First non-empty URL alias | SSE only for exact `sse`; otherwise HTTP; no usable URL returns `null` (`normalize.ts:65-87`). |

String arrays are accepted only when every member is a string. Header/env records keep string values and stringify numbers and booleans; unsupported values are skipped, and an empty normalized record becomes undefined (`normalize.ts:8-23`).

### Codex TOML upsert

`upsertServer` removes an existing table with the same name, renders the supplied values as a replacement table, strips trailing whitespace from the remaining text, and appends the rendered section with a final newline (`toml-mcp.ts:173-182`). The remove step consumes immediately preceding blank lines but leaves preceding comment lines in the source; unrelated sections remain (`toml-mcp.ts:162-170`).

`renderTable` omits `undefined`, writes arrays as quoted scalar arrays, writes non-empty objects as child tables, and writes other values as scalars; table keys outside letters, digits, underscore, and hyphen are quoted (`toml-mcp.ts:133-160`). There is no error-result branch in this pure text helper: it returns the rewritten TOML string. Parse, serialization, and filesystem failures are handled by its callers (`toml-mcp.ts:162-182`, `host.ts:1157-1188`).

### Catalog screen

- `DeviceList` starts in the all-machines selection when `selected` is null; clicking a machine calls `onSelect(hostId)`. Rows calculate drift count and installed non-gateway CLI count, display scan age for connected hosts or “not connected”, and show an empty-state prompt when there are no hosts. Each fetched hub namespace has one shared block whose coverage lists machines with a matching namespace; per-machine MetaMCP blocks show only children whose namespace is not one of those fetched from the hub (`app.tsx:1030-1077`, `app.tsx:1079-1118`). This component only changes selection; it does not initiate scans or handle RPC errors (`app.tsx:937-1118`).
- `CatalogTable` resolves the selected machine, then uses host columns for the all-machines view or that machine's manageable CLI columns for a single-machine view. An empty catalogue shows an adopt-pending message when pending entries exist; otherwise it directs the user to configure an MCP server and rescan (`app.tsx:1119-1158`).
- For a non-empty catalogue it renders state and enabled legends, a row per entry, the entry description and local-only scope marker, and one state cell per host/agent column (`app.tsx:1160-1235`). The remove action calls `onRemove` immediately and keeps machine configs; purge first sets a per-entry confirmation state, then calls `onPurge` on the second click. Both controls are disabled while `busy` (`app.tsx:1132-1133`, `app.tsx:1237-1274`).
- `CatalogTable` does not perform RPCs or render an error result itself. The parent handles thrown RPC errors through `act`/`report`, updates overview data on success, and shows purge's returned removed/failed counts and error list in a notice. Purge targets the current selected host or all hosts, includes gateway configs, and disables dry-run (`app.tsx:128-145`, `app.tsx:3168-3181`, `app.tsx:3444-3452`).
- `hostState` ignores agents that are not manageable, installed, configured, or targeted by the entry. It returns `n/a` when none qualify, `missing` when none contain the entry, `partial` when only some contain it, `different` when a non-local-only entry differs, and `present` otherwise (`app.tsx:539-570`). The state and enabled-state accessible labels, along with pending-server filter labels, are resolved from `t()` during render, so they follow BB’s document locale (`app.tsx:114-119`, `app.tsx:325-348`, `app.tsx:377-405`, `app.tsx:1299-1324`, `i18n.ts:31-39`, `i18n.en.ts:4-63`).
- An empty catalogue explains either that pending servers can be adopted or that an MCP server must first be configured in a CLI and scanned (`app.tsx:1147-1156`).

## Modes, variants, and states

| Mode or state | Input / condition | Result |
|---|---|---|
| Global | `scope: global`; targets empty or include agent kind | Desired server participates in sync (`server.ts:658-661`). |
| Local-only | `scope: local-only` | Entry remains in catalogue but `wantsHere` returns false (`server.ts:658-661`). |
| Pending | Seen in an installed agent but absent from catalogue and ignored list | Aggregates occurrences across machines; classifies local paths/secrets/loopback (`server.ts:682-725`, `normalize.ts:256-283`). |
| Drift: missing / different | Desired global entry is absent / differs from normalized config | `plan` reports upsert operations (`server.ts:672-693`, `server.ts:1110-1144`). |
| Dry run | `dryRun: true` | Plan and per-host results are returned without config writes (`server.ts:1596-1641`, `host.ts:1173-1177`). |
| Disabled | Agent format carries a disabled flag | `enable` or `disable` edits supported dialects; unsupported agents are skipped (`agents.ts:235-246`, `server.ts:1692-1750`). |
| MetaMCP gateway | Gateway config exists and is writable | Gateway children are displayed separately; JSON import upserts into its local config (`server.ts:1783-1832`, `app.tsx:1284-1316`). |
| MetaMCP namespace fetch | Gateway URL and API key are configured; namespaces come from the comma-separated setting or default to `secondary` | Each namespace is fetched from its encoded OpenAPI URL with `X-API-Key`; tool paths are grouped by the server prefix before `__`, counted, and sorted (`server.ts:625-639`, `metamcp.ts:18-46`). |

## Failures

- Disconnected hosts are excluded from scan and sync targets (`server.ts:603-612`, `server.ts:1645-1671`). A rejected main `scan` stores its error message in the host snapshot (`server.ts:592-600`).
- A guessed config path cannot be created: the agent must have an existing file or `confirmedPath` set (`server.ts:642-655`, `agents.ts:40-46`).
- A non-writable config returns a failure for each requested operation (`host.ts:1143-1154`). A JSON/TOML parse or write exception marks operations failed and returns the error (`host.ts:1157-1188`).
- Gateway import rejects invalid JSON, a missing/non-writable gateway config, or input with no supported server entries (`server.ts:1783-1832`).
- Probe failures are stored as result records; failure to call a host is logged and the older results remain for unprobed servers (`server.ts:1780-1878`).
- MetaMCP HTTP errors, fetch/JSON errors, and aborts return a namespace result with an error and an empty server list; other namespaces still resolve through `Promise.all` (`metamcp.ts:26-49`, `metamcp.ts:52-60`).

## Business rules

- Only `global` entries whose target list is empty or includes the agent kind are desired on that agent (`server.ts:672-675`).
- Sync plans only create/update missing or differing entries; automatic sync passes `includeDifferent: false` (`server.ts:1110-1144`, `server.ts:2257-2277`).
- The scheduled sweep runs automatic catalogue sync only when its toggle is enabled; `forget` removes only the catalogue row while `remove` invokes host purge (`server.ts:2302-2312`, `server.ts:2613-2645`, `server.ts:1688-1729`). Toggle defaults are documented in [deployment](../deployment.md).
- Machine-bound entries are classified from absolute executable paths, loopback URLs, and secret references (`normalize.ts:256-283`).
- Config entry merging preserves fields outside the plugin's normalized model (`normalize.ts:194-203`, `host.ts:1160-1170`).
- Writes keep the last five timestamped backups and preserve the existing file mode through temp-file rename (`host.ts:213-241`).
- Codex TOML is updated textually through `readServers` / `upsertServer`, preserving unrelated sections (`toml-mcp.ts:80-107`, `toml-mcp.ts:162-183`).

## Public API or commands

See [API and commands](../api.md) for all RPC and CLI signatures. The catalogue-specific methods include `overview`, `rescan`, `adopt`, `ignore`, `unignore`, `catalog_update`, `catalog_remove`, `purge`, `plan`, `sync`, `probe`, `set_server_enabled`, and `gateway_add` (`server.ts:201-288`).

## Gotchas

- `forget` removes only the catalogue entry; `remove` also edits machine configs (`server.ts:2613-2645`, `server.ts:1688-1729`). See the [removal gotcha](../gotchas.md#removing-a-catalogue-row-is-not-the-same-as-removing-a-server).
- `opencode.jsonc` and other commented JSON configs can be scanned but are not writable through this path (`host.ts:175-205`, `host.ts:638-698`).
- A gateway config can only be updated when its file exists; the host does not create an unconfirmed path (`host.ts:151-163`, `server.ts:664-670`).

See [gotchas](../gotchas.md) and [data model](../data-model.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools API and commands](../api.md)
- [Agent Tools architecture](../architecture.md)
- [Agent Tools data model](../data-model.md)
- [Agent Tools decisions](../decisions.md)
- [Agent Tools gotchas](../gotchas.md)
- [Agent Tools overview](../overview.md)
