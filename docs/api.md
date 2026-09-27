---
title: Agent Tools API and commands
type: component
created: 2026-09-27
updated: 2026-09-27
status: active
confidence: medium
tags: [api, rpc, cli]
sources:
  - server.ts
  - contract.ts
  - host.ts
  - app.tsx
  - package.json
---
# Agent Tools API and commands
The plugin exposes BB plugin RPC methods, machine-local host RPC methods, and the `bb tools` CLI; this repository registers no plugin-owned HTTP routes (`server.ts:1854-2065`, `server.ts:2153-2265`).

## How it works

1. The plugin UI calls a named server RPC, or BB invokes the `tools` CLI handler (`app.tsx:114-138`, `server.ts:2153-2166`).
2. `rpcContract` validates the UI/server method inputs, while `hostContract` defines the methods and payloads the server can call on a selected host (`server.ts:201-434`, `contract.ts:348-436`).
3. The server handler reads stored state or orchestrates host calls; host RPC targets a BB host ID (`server.ts:520-525`, `server.ts:1854-1921`).
4. The host performs the requested scan or file operation and returns a typed result; write calls return per-operation outcomes and backups (`host.ts:998-1000`, `host.ts:1299-1369`).
5. The server returns the result to the UI/CLI and publishes refreshed overview state after mutations (`server.ts:1081-1085`, `server.ts:1854-1917`, `server.ts:2266-2282`).

### Modes and branches

| Mode | Branch | Result |
|---|---|---|
| Read/report | `overview`, scans, plans, and inventory CLI commands read snapshots or collect host scans | Overview or report data; scan failures are retained as host errors (`server.ts:543-553`, `server.ts:779-820`). |
| Mutating RPC/CLI | Catalogue, skill, OpenCode, and config commands call server handlers that update KV state or host files | Updated overview, counts, and operation results (`server.ts:1861-2055`, `server.ts:2324-2727`). |
| Dry run | `sync`, `purge`, `skills_fanout`, and OpenCode apply/clean accept `dryRun` | Operations are planned or evaluated without the corresponding host-file write (`server.ts:223-250`, `server.ts:324-351`, `contract.ts:231-235`, `host.ts:1354-1358`). |
| Host RPC | Server dispatches methods from `hostContract` to a selected `hostId` | Host-local scan, skill, MCP, plugin, or OpenCode result (`contract.ts:348-436`, `server.ts:520-521`). |
| CLI JSON output | Caller passes `--json` to supported read/report commands | Handler serializes the result as JSON (`server.ts:2266-2282`). |

### Failure behavior

- Zod rejects inputs that do not match the declared RPC schemas (`server.ts:201-434`, `contract.ts:348-436`).
- A host-call rejection during MCP scan is stored in the snapshot `error`; fan-out and sync results carry failed counts and error text (`server.ts:543-553`, `server.ts:1427-1451`, `server.ts:1341-1369`).
- Host writes return per-operation errors when the agent is unknown, the file is not writable, or parsing/writing fails (`host.ts:1315-1369`).
- Skill adopt/restore handlers throw when the host returns `ok: false`; bulk operations preserve failures in their result (`server.ts:1922-1960`, `server.ts:1972-1978`).
- CLI argument or operation errors can return `exitCode: 1` and `stderr` (`server.ts:2365-2371`, `server.ts:2440-2454`, `server.ts:2465-2472`).

## Authentication and transport

- **UI-to-server:** the BB plugin UI calls RPC method names such as `overview` and `rescan`; the plugin registers them with `bb.rpc.register` (`app.tsx:114-138`, `server.ts:1854-1865`). No per-method authentication check is implemented in this plugin (`server.ts:1854-2065`).
- **Server-to-host:** host calls use `bb.hosts.experimental_client({ contract: hostContract })` and target a BB host ID; these calls run in the trusted host entry (`server.ts:520-521`, `host.ts:998-1000`).
- **CLI:** BB invokes the registered `tools` command group inside the plugin runtime (`server.ts:2153-2166`).
- **HTTP:** no Hono app or route registration is present in the plugin entry; `hono` is a development dependency only (`package.json:61-72`).

## UI/server RPC

All methods use BB RPC names rather than HTTP method/path pairs. Each method accepts the Zod input shown in `rpcContract`; the caller is the plugin UI unless noted.

| Area | Method | Caller | Purpose | Auth |
|---|---|---|---|---|
| Overview | `overview` | UI | Return inventory, drift, pending entries, skills, plugins, and OpenCode view | BB plugin RPC; no plugin-level check (`server.ts:201-203`, `server.ts:1854-1856`) |
| Overview | `rescan` | UI | Scan all connected machines, or the given `hostId`; refresh MetaMCP | BB plugin RPC (`server.ts:203-204`, `server.ts:1857-1860`) |
| Catalogue | `adopt` | UI | Add pending server names with global/local-only scope | BB plugin RPC (`server.ts:204-210`, `server.ts:1861-1864`) |
| Catalogue | `ignore`, `unignore` | UI | Hide pending names or show them again | BB plugin RPC (`server.ts:211-212`, `server.ts:1865-1876`) |
| Catalogue | `catalog_update`, `catalog_remove` | UI | Change scope, target agents, server spec, or remove a catalogue row | BB plugin RPC (`server.ts:213-222`, `server.ts:1877-1892`) |
| Catalogue | `purge` | UI | Remove a server from selected host(s), optionally gateway configs; supports dry run | BB plugin RPC (`server.ts:223-237`, `server.ts:1893-1901`) |
| Catalogue | `plan`, `sync` | UI | Return proposed operations; apply additions/updates with dry-run and include-different flags | BB plugin RPC (`server.ts:238-251`, `server.ts:1903-1909`) |
| Catalogue | `probe` | UI | Handshake selected server(s) and return result counts | BB plugin RPC (`server.ts:254-260`, `server.ts:1910-1913`) |
| Catalogue | `set_server_enabled` | UI | Enable/disable a server where its dialect supports the flag | BB plugin RPC (`server.ts:262-273`, `server.ts:1914-1917`) |
| Gateway | `gateway_add` | UI | Parse JSON and add entries to a host's existing MetaMCP config | BB plugin RPC (`server.ts:275-288`, `server.ts:1918-1921`) |
| Schedule/language | `set_auto_sync`, `set_skills_fanout_auto`, `set_language` | UI | Change auto-sync switches and UI/CLI language | BB plugin RPC (`server.ts:252-253`, `server.ts:319-323`, `server.ts:2057-2065`) |
| Skills | `skill_adopt`, `skill_adopt_bulk` | UI | Apply explicit per-home actions | BB plugin RPC (`server.ts:289-317`, `server.ts:1922-1960`) |
| Skills | `skills_fanout` | UI | Promote, Git-sync, and fan out canon, optionally dry-run | BB plugin RPC (`server.ts:324-351`, `server.ts:1968-1971`) |
| Skills | `skills_backups`, `skills_backup_restore` | UI | List snapshots or restore a selected snapshot | BB plugin RPC (`server.ts:353-370`, `server.ts:1972-1978`) |
| Skills | `skills_sync` | UI | Synchronize canonical skill repository with configured Git remote | BB plugin RPC (`server.ts:372-380`, `server.ts:1979-1985`) |
| OpenCode | `opencode_sync` | UI | Copy selected providers, models, and enabled state from source to connected target(s) | BB plugin RPC (`server.ts:381-394`, `server.ts:1986-1989`) |
| OpenCode | `opencode_clean` | UI | Remove named or known-stale providers; supports dry run | BB plugin RPC (`server.ts:396-407`, `server.ts:1990-1993`) |
| OpenCode | `opencode_apply` | UI | Apply provider/model/enabled operations to one host | BB plugin RPC (`server.ts:408-419`, `server.ts:1994-2017`) |
| OpenCode | `opencode_set_default_model` | UI | Update BB's default and/or OpenCode's model defaults | BB plugin RPC (`server.ts:420-433`, `server.ts:2018-2055`) |

## Host RPC

The `hostContract` is executed by the trusted host entry (`contract.ts:348-436`, `host.ts:998-1000`). UI/server callers reach it through server orchestration.

| Method | Caller | Purpose | Auth |
|---|---|---|---|
| `scan` | Server | Read CLI binaries and MCP configuration on one host | BB host RPC channel (`contract.ts:348-350`, `host.ts:1001-1034`) |
| `apply` | Server | Upsert/remove MCP entries; dry-run supported | BB host RPC channel (`contract.ts:350-353`, `host.ts:1299-1369`) |
| `probe` | Server | Connect to selected MCP server definitions with bounded timeout | BB host RPC channel (`contract.ts:354-360`, `host.ts:1036-1085`) |
| `skills_scan` | Server | Inventory canon and skill homes | BB host RPC channel (`contract.ts:361`, `host.ts:1087`) |
| `skills_adopt`, `skills_adopt_bulk` | Server | Adopt, take, link, delete, or unlink skills by location | BB host RPC channel (`contract.ts:362-396`, `host.ts:1089-1098`) |
| `skills_fanout` | Server | Apply planned links, mirrors, pulls, drops, and retirements | BB host RPC channel (`contract.ts:398-411`, `host.ts:1106-1189`) |
| `skills_backups_list`, `skills_backup_restore` | Server | List and restore skill snapshots | BB host RPC channel (`contract.ts:413-423`, `host.ts:1195-1274`) |
| `skills_sync` | Server | Synchronize canon with supplied Git URL | BB host RPC channel (`contract.ts:425-431`, `host.ts:1280-1297`) |
| `opencode_scan`, `opencode_apply` | Server | Read or write OpenCode JSON config | BB host RPC channel (`contract.ts:433-434`, `host.ts:1372-1375`) |
| `plugins_scan` | Server | Inventory installed CLI plugins | BB host RPC channel (`contract.ts:435`, `host.ts:1376`) |

## CLI commands

All commands are registered under `bb tools`; `--json` returns JSON for the read/report commands listed with that option (`server.ts:2153-2265`, `server.ts:2266-2282`).

| Area | Command | Caller | Purpose | Auth |
|---|---|---|---|---|
| Overview | `bb tools status [--json]` | BB CLI user | Print current inventory and drift | BB CLI runtime (`server.ts:2157`, `server.ts:2287-2290`) |
| Overview | `bb tools scan [--host <id>]` | BB CLI user | Rescan one or all connected hosts | BB CLI runtime (`server.ts:2158`, `server.ts:2291-2295`) |
| Catalogue | `bb tools catalog [--json]` | BB CLI user | List catalogue rows | BB CLI runtime (`server.ts:2159`, `server.ts:2296-2309`) |
| Catalogue | `bb tools pending [--json]` | BB CLI user | List unknown configured servers | BB CLI runtime (`server.ts:2160`, `server.ts:2310-2322`) |
| Catalogue | `bb tools adopt <name...>` | BB CLI user | Adopt pending servers using inferred scope | BB CLI runtime (`server.ts:2161`, `server.ts:2324-2329`) |
| Catalogue | `bb tools ignore <name...>` / `bb tools unignore <name...>` | BB CLI user | Hide or restore pending suggestions | BB CLI runtime (`server.ts:2162-2166`, `server.ts:2330-2345`) |
| Catalogue | `bb tools plan [--host <id>]` | BB CLI user | Show planned operations | BB CLI runtime (`server.ts:2168`, `server.ts:2346-2355`) |
| Catalogue | `bb tools sync [--host <id>] [--dry-run] [--with-different]` | BB CLI user | Apply or preview catalogue sync | BB CLI runtime (`server.ts:2169-2173`, `server.ts:2357-2363`) |
| Catalogue | `bb tools forget <name>` | BB CLI user | Remove only the catalogue row | BB CLI runtime (`server.ts:2175-2177`, `server.ts:2365-2375`) |
| Catalogue | `bb tools remove <name> [--host <id>] [--with-gateways] [--dry-run]` | BB CLI user | Remove from machine configs; dry run available | BB CLI runtime (`server.ts:2179-2183`, `server.ts:2376-2397`) |
| Catalogue | `bb tools probe [<name>] [--host <id>]` | BB CLI user | Run live MCP checks | BB CLI runtime (`server.ts:2185-2187`, `server.ts:2399-2419`) |
| Catalogue | `bb tools enable <name> [--host <id>]` / `bb tools disable <name> [--host <id>]` | BB CLI user | Toggle supported server configs | BB CLI runtime (`server.ts:2189-2197`, `server.ts:2421-2431`) |
| Settings | `bb tools auto on|off` | BB CLI user | Enable or disable scheduled MCP sync | BB CLI runtime (`server.ts:2199`, `server.ts:2433-2439`) |
| Gateway | `bb tools gateway-add <file.json> --host <id>` | BB CLI user | Import JSON server entries into the existing gateway config | BB CLI runtime (`server.ts:2201-2204`, `server.ts:2440-2464`) |
| Language | `bb tools lang [ru|en]` | BB CLI user | Read or set interface and CLI language | BB CLI runtime (`server.ts:2205-2209`, `server.ts:2465-2480`) |
| Skills | `bb tools skills [--host <id>] [--canon]` | BB CLI user | List out-of-canon rows or machine canon state | BB CLI runtime (`server.ts:2211-2214`, `server.ts:2482-2534`) |
| Skills | `bb tools skills-adopt <folder> <name> --host <id> [--link|--delete|--take|--unlink]` | BB CLI user | Perform one home action | BB CLI runtime (`server.ts:2215-2219`, `server.ts:2536-2560`) |
| Skills | `bb tools skills-fanout [--host <id>] [--dry-run] [--all]` | BB CLI user | Promote, sync, and lay out canon | BB CLI runtime (`server.ts:2221-2224`, `server.ts:2560-2590`) |
| Skills | `bb tools skills-backups [--host <id>] [--json]` | BB CLI user | List archived skill versions | BB CLI runtime (`server.ts:2225-2229`, `server.ts:2590-2601`) |
| Skills | `bb tools skills-restore <snapshot-id> --host <id>` | BB CLI user | Restore a snapshot into canon | BB CLI runtime (`server.ts:2231-2234`, `server.ts:2602-2611`) |
| Skills | `bb tools skills-sync [--host <id>]` | BB CLI user | Sync canon through configured Git remote | BB CLI runtime (`server.ts:2235-2239`, `server.ts:2612-2622`) |
| Plugins | `bb tools plugins [--json]` | BB CLI user | Show installed CLI plugins across hosts | BB CLI runtime (`server.ts:2241-2244`, `server.ts:2624-2649`) |
| OpenCode | `bb tools opencode [--json]` | BB CLI user | Report model/provider state and drift | BB CLI runtime (`server.ts:2245-2249`, `server.ts:2651-2677`) |
| OpenCode | `bb tools opencode-sync [--from <host>] [--to <host>] [--dry-run] [--json]` | BB CLI user | Copy full provider/model/enabled state from source to other host(s) | BB CLI runtime (`server.ts:2251-2254`, `server.ts:2678-2695`) |
| OpenCode | `bb tools opencode-clean [--host <id>] [--dry-run] [--json]` | BB CLI user | Remove known stale providers | BB CLI runtime (`server.ts:2256-2259`, `server.ts:2697-2704`) |
| OpenCode | `bb tools opencode-set-default <modelId>` | BB CLI user | Set BB and host OpenCode default model | BB CLI runtime (`server.ts:2261-2264`, `server.ts:2705-2727`) |

See the [feature pages](features/mcp-catalog.md), [skills](features/skills.md), [OpenCode](features/opencode.md), and [CLI plugins](features/cli-plugins.md) for behavior details.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools architecture](architecture.md)
- [Agent Tools deployment](deployment.md)
- [CLI plugin inventory](features/cli-plugins.md)
- [MCP server catalogue](features/mcp-catalog.md)
- [OpenCode provider and model management](features/opencode.md)
- [Agent skill canon and rollout](features/skills.md)
- [Agent Tools overview](overview.md)
