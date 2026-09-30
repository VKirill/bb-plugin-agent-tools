---
title: Agent Tools API and commands
type: component
created: 2026-09-27
updated: 2026-09-30
status: active
confidence: medium
tags: [api, rpc, cli]
sources:
  - server.ts
  - contract.ts
  - host.ts
  - app.tsx
  - package.json
  - skills-sync.ts
  - skills-server.ts
  - opencode.ts
  - i18n.ts
---
# Agent Tools API and commands
The plugin exposes BB plugin RPC methods, machine-local host RPC methods, and the `bb tools` CLI; this repository registers no plugin-owned HTTP routes (`server.ts:2055-2265`, `server.ts:2353-2373`).

## How it works

1. The plugin UI calls a named server RPC, or BB invokes the `tools` CLI handler (`app.tsx:114-138`, `server.ts:2153-2166`).
2. `rpcContract` validates the UI/server method inputs, while `hostContract` defines the methods and payloads the server can call on a selected host (`server.ts:201-434`, `contract.ts:355-452`).
3. The server handler reads stored state or orchestrates host calls; host RPC targets a BB host ID (`server.ts:534`, `server.ts:2055-2121`).
4. The host performs the requested scan or file operation and returns a typed result; write calls return per-operation outcomes and backups (`host.ts:783-785`, `host.ts:1118-1189`).
5. The server returns the result to the UI/CLI and publishes refreshed overview state after mutations (`server.ts:1081-1085`, `server.ts:2055-2265`, `server.ts:2480-2932`).

### Modes and branches

| Mode | Branch | Result |
|---|---|---|
| Read/report | `overview`, scans, plans, and inventory CLI commands read snapshots or collect host scans | Overview or report data; scan failures are retained as host errors (`server.ts:543-553`, `server.ts:779-820`). |
| Mutating RPC/CLI | Catalogue, skill, OpenCode, and config commands call server handlers that update KV state or host files | Updated overview, counts, and operation results (`server.ts:2055-2265`, `server.ts:2480-2932`). |
| Dry run | `sync`, `purge`, `skills_fanout`, and OpenCode apply/clean accept `dryRun` | Operations are planned or evaluated without the corresponding host-file write (`server.ts:223-250`, `server.ts:324-351`, `contract.ts:231-250`, `host.ts:1173-1177`). |
| Host RPC | Server dispatches methods from `hostContract` to a selected `hostId` | Host-local scan, skill, MCP, plugin, or OpenCode result (`contract.ts:355-452`, `server.ts:520-521`). |
| CLI JSON output | Caller passes `--json` to supported read/report commands | Handler serializes the result as JSON (`server.ts:2480-2534`, `server.ts:2825-2932`). |

### Failure behavior

- Zod rejects inputs that do not match the declared RPC schemas (`server.ts:215-448`, `contract.ts:355-452`).
- A host-call rejection during MCP scan is stored in the snapshot `error`; fan-out and sync results carry failed counts and error text (`server.ts:558-567`, `server.ts:1178-1242`, `server.ts:1606-1651`).
- Host writes return per-operation errors when the agent is unknown, the file is not writable, or parsing/writing fails (`host.ts:1118-1189`).
- Skill adopt/restore handlers throw when the host returns `ok: false`; bulk operations preserve failures in their result (`server.ts:2122-2160`, `server.ts:2173-2177`).
- CLI input checks return `exitCode: 1` with `stderr` for a missing catalogue name, a missing `--host` on gateway import, an unreadable import file, or an invalid language (`server.ts:2565-2571`, `server.ts:2640-2653`, `server.ts:2665-2672`).

## Authentication and transport

- **UI-to-server:** the BB plugin UI calls RPC method names such as `overview` and `rescan`; the plugin registers them with `bb.rpc.register` (`app.tsx:114-138`, `server.ts:2055-2060`). No per-method authentication check is implemented in this plugin (`server.ts:2055-2265`).
- **Server-to-host:** the plugin creates `bb.hosts.experimental_client({ contract: hostContract })`; each call supplies the target BB `hostId`, and handlers run in the trusted host entry (`server.ts:534`, `server.ts:561`, `host.ts:782-785`).
- **CLI:** BB registers the `tools` command group and invokes its `run(argv)` handler inside the plugin runtime (`server.ts:2353-2356`, `server.ts:2466-2475`).
- **HTTP:** no Hono app or route registration is present in the plugin entry; `hono` is a development dependency only (`package.json:61-72`).

## UI/server RPC

All methods use BB RPC names rather than HTTP method/path pairs. Each method accepts the Zod input shown in `rpcContract`; the caller is the plugin UI unless noted.

| Area | Method | Caller | Purpose | Auth |
|---|---|---|---|---|
| Overview | `overview` | UI | Return inventory, drift, pending entries, skills, plugins, and OpenCode view | BB plugin RPC; no plugin-level check (`server.ts:216`, `server.ts:2055-2056`) |
| Overview | `rescan` | UI | Scan all connected machines, or the given `hostId`; refresh MetaMCP | BB plugin RPC (`server.ts:217`, `server.ts:2057-2060`) |
| Catalogue | `adopt` | UI | Add pending server names with global/local-only scope | BB plugin RPC (`server.ts:218-224`, `server.ts:2061-2064`) |
| Catalogue | `ignore`, `unignore` | UI | Hide pending names or show them again | BB plugin RPC (`server.ts:225-226`, `server.ts:2065-2076`) |
| Catalogue | `catalog_update`, `catalog_remove` | UI | Change scope, target agents, server spec, or remove a catalogue row | BB plugin RPC (`server.ts:227-236`, `server.ts:2077-2092`) |
| Catalogue | `purge` | UI | Remove a server from selected host(s), optionally gateway configs; supports dry run | BB plugin RPC (`server.ts:237-250`, `server.ts:2093-2101`) |
| Catalogue | `plan`, `sync` | UI | Return proposed operations; apply additions/updates with dry-run and include-different flags | BB plugin RPC (`server.ts:252-264`, `server.ts:2103-2109`) |
| Catalogue | `probe` | UI | Handshake selected server(s) and return result counts | BB plugin RPC (`server.ts:268-274`, `server.ts:2110-2113`) |
| Catalogue | `set_server_enabled` | UI | Enable/disable a server where its dialect supports the flag | BB plugin RPC (`server.ts:276-288`, `server.ts:2114-2117`) |
| Gateway | `gateway_add` | UI | Parse JSON and add entries to a host's existing MetaMCP config | BB plugin RPC (`server.ts:289-301`, `server.ts:2118-2120`) |
| Schedule/language | `set_auto_sync`, `set_skills_fanout_auto`, `set_language` | UI | Change auto-sync switches and UI/CLI language | BB plugin RPC (`server.ts:252-253`, `server.ts:319-323`, `server.ts:2162-2166`, `server.ts:2255-2264`) |
| Skills | `skill_adopt`, `skill_adopt_bulk` | UI | Apply explicit per-home actions | BB plugin RPC (`server.ts:289-317`, `server.ts:2122-2160`) |
| Skills | `skills_fanout` | UI | Promote, Git-sync, fan out to connected machine homes, and mirror skills into BB server dataDir; optionally dry-run | BB plugin RPC (`server.ts:324-351`, `server.ts:1538-1569`, `server.ts:2168-2171`) |
| Skills | `skills_backups`, `skills_backup_restore` | UI | List snapshots or restore a selected snapshot | BB plugin RPC (`server.ts:353-370`, `server.ts:2172-2177`) |
| Skills | `skills_sync` | UI | Synchronize the canon with configured Git remote and return per-host results | BB plugin RPC (`server.ts:372-380`, `server.ts:2179-2185`) |
| OpenCode | `opencode_sync` | UI | Copy selected providers, models, and enabled state from source to connected target(s) | BB plugin RPC (`server.ts:395-407`, `server.ts:2186-2191`) |
| OpenCode | `opencode_clean` | UI | Remove named or known-stale providers; supports dry run | BB plugin RPC (`server.ts:408-419`, `server.ts:2188-2195`) |
| OpenCode | `opencode_apply` | UI | Apply provider/model/enabled operations to one host | BB plugin RPC (`server.ts:420-433`, `server.ts:2196-2217`) |
| OpenCode | `opencode_set_default_model` | UI | Update BB's default and/or OpenCode's model defaults | BB plugin RPC (`server.ts:434-448`, `server.ts:2218-2252`) |

## Host RPC

The `hostContract` is executed by the trusted host entry (`contract.ts:355-452`, `host.ts:782-785`). UI/server callers reach it through the client created during plugin initialization (`server.ts:534`).

| Method | Caller | Purpose | Auth |
|---|---|---|---|
| `scan` | Server | Read CLI binaries and MCP configuration on one host | BB host RPC channel (`contract.ts:355-357`, `host.ts:785-818`) |
| `apply` | Server | Upsert/remove MCP entries; dry-run supported | BB host RPC channel (`contract.ts:356-360`, `host.ts:1118-1189`) |
| `probe` | Server | Connect to selected MCP server definitions with bounded timeout | BB host RPC channel (`contract.ts:361-367`, `host.ts:839-869`) |
| `skills_scan` | Server | Inventory canon and skill homes | BB host RPC channel (`contract.ts:368`, `host.ts:374-435`, `host.ts:871`) |
| `skills_adopt`, `skills_adopt_bulk` | Server | Adopt, take, link, delete, or unlink skills by location | BB host RPC channel (`contract.ts:369-403`, `host.ts:873-882`) |
| `skills_fanout` | Server | Apply planned links, mirrors, pulls, drops, and retirements | BB host RPC channel (`contract.ts:409-418`, `host.ts:885-975`) |
| `skills_backups_list`, `skills_backup_restore` | Server | List and restore skill snapshots | BB host RPC channel (`contract.ts:420-430`, `host.ts:982-1061`) |
| `skills_sync` | Server | Synchronize canon with configured Git remote and return per-host success/failure | BB host RPC channel (`contract.ts:432-439`, `host.ts:1060-1084`, `server.ts:1248-1305`, `server.ts:2179-2185`) |
| `skills_archive` | Server | Pack one canon skill for transfer to the BB server process; archive omits recognized junk and fails when tar is unavailable or the archive exceeds 8 MiB | BB host RPC channel (`contract.ts:440-448`, `host.ts:1086-1115`, `server.ts:1494-1502`) |
| `opencode_scan`, `opencode_apply` | Server | Read or write OpenCode JSON config | BB host RPC channel (`contract.ts:449-450`, `host.ts:574-698`, `host.ts:1191-1193`) |
| `plugins_scan` | Server | Inventory installed CLI plugins | BB host RPC channel (`contract.ts:451`, `host.ts:700-780`, `host.ts:1195-1196`) |

### Host contract request flow and branches

1. `defineRpcContract` declares each method's Zod input and output. Invalid payloads fail contract validation before the host handler runs (`contract.ts:355-414`).
2. The server's host client dispatches a method to the selected machine; handlers receive an abort signal where long-running work can be cancelled (`server.ts:534`, `server.ts:561`, `host.ts:782-785`).
3. The handler returns the declared output shape. Some methods report operation failures inside that shape; an uncaught exception or aborted signal rejects the host call.

| Method | Branches and limits | Output and failure behavior |
|---|---|---|
| `scan` / `skills_scan` | No arguments; scan methods check the RPC abort signal while traversing host data (`contract.ts:355-368`, `host.ts:785-818`, `host.ts:374-435`, `host.ts:871`). | Return the machine scan; interruption rejects the call, which server orchestration handles at the caller (`server.ts:558-567`, `server.ts:580-588`). |
| `apply` | Up to 200 upsert/remove operations and required `dryRun` (`contract.ts:357-360`). | Returns per-operation `{ok,error}` and created backup paths. Unknown agents, unwritable files, parse errors, and write failures become failed operation rows (`host.ts:1118-1189`). |
| `probe` | Up to 60 targets, timeout from 1 to 60 seconds; checks targets sequentially (`contract.ts:361-367`, `host.ts:820-868`). | Unknown agent or missing config entry becomes a result with `ok:false`; protocol outcome and elapsed milliseconds are recorded per target (`host.ts:832-868`). |
| `skills_adopt`, `skills_adopt_bulk` | One selected location/name/action or up to 200 such actions; modes are `adopt`, `link`, `take`, `delete`, `unlink` (`contract.ts:369-403`). Bulk execution is sequential and checks cancellation between actions (`host.ts:873-882`). | Each action returns `ok` and optional error; validation failures are values, while uncaught filesystem failures reject the call (`host.ts:476-570`). |
| `skills_fanout` | Up to 500 plugin names plus required `dryRun`; `*` bypasses plugin-name exclusion, empty names use scanned plugin names (`contract.ts:409-418`, `host.ts:890-905`). | Returns per-operation `ok/error` and skipped plugin names. Dry run records planned operations without writes; blocked plans and caught operation errors are returned as failed rows (`host.ts:906-975`). |

### Plugin initialization

1. The plugin reads `lang` from BB KV. Only supported language values are selected; a missing or invalid value selects Russian, then updates the shared dictionary (`server.ts:479-485`).
2. It defines plugin settings, then creates `readConfig` as a live `settings.get()` call and creates a host client bound to `hostContract` (`server.ts:487-534`).
3. It defines KV readers for catalogue, ignored names, auto-sync and probes. Missing arrays read as `[]`; absent `autoSync` reads as `false` (`server.ts:536-545`).

| Initialization condition | Selected behavior |
|---|---|
| Saved language is `ru` or `en` | Apply that dictionary before settings labels are defined (`server.ts:483-485`, `i18n.ts:6-17`). |
| Saved language is missing or unsupported | Start in Russian (`server.ts:483-485`). |
| A setting changes while the plugin is running | `readConfig` retrieves the settings object at use time (`server.ts:531-534`). |

The initial KV read, settings definition, and host-client construction have no local catch branch; a failure there rejects plugin initialization (`server.ts:483-534`). Exact setting values and rollout effects are owned by [skills](features/skills.md).

### OpenCode host apply

1. The host checks `opencode.json` then `opencode.jsonc`, selects the first regular file, and returns a failed result if neither exists (`host.ts:638-667`).
2. A file containing comments is rejected as read-only; other JSON parse errors return `ok:false` with the parse message (`host.ts:669-684`).
3. The operation list updates provider maps and optional enable state, removes provider plus enabled-list references, changes model fields, or replaces the enabled-provider list (`opencode.ts:132-175`).
4. If not a dry run and the serialized document differs, the host backs up the file and writes atomically; it then rescans and returns the scan and backup list (`host.ts:686-697`).

| Condition | Result |
|---|---|
| Missing config or commented JSONC | `ok:false`, no backup, and `scan:null` (`host.ts:651-671`). |
| Invalid JSON | `ok:false` with parse error and no backup (`host.ts:673-684`). |
| Dry run or unchanged result | No file write or backup; the result is still rescanned and returns `ok:true` (`host.ts:686-697`). |
| Backup, atomic write, or rescan throws | The helper has no catch around those operations, so the host RPC rejects (`host.ts:690-697`). |

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
