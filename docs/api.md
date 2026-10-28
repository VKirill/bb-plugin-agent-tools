---
title: Agent Tools API and commands
type: component
created: 2026-09-27
updated: 2026-10-28
status: active
confidence: low
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
  - skills-hub-service.ts
  - skills-page.tsx
  - categories.ts
  - settings-page.tsx
  - host-skills.ts
---
# Agent Tools API and commands
The plugin exposes BB plugin RPC methods, machine-local host RPC methods, and the `bb tools` CLI; this repository registers no plugin-owned HTTP routes (`server.ts:2045-2255`, `server.ts:2343-2363`).

## How it works

1. The plugin UI calls a named server RPC, or BB invokes the `tools` CLI handler (`app.tsx:115-139`, `server.ts:2143-2156`).
2. `rpcContract` validates the UI/server method inputs, while `hostContract` defines the methods and payloads the server can call on a selected host (`server.ts:201-434`, `contract.ts:355-452`).
3. The server handler reads stored state or orchestrates host calls through a client bound to `hostContract`; each host call supplies a target BB `hostId` (`server.ts:545-550`, `server.ts:592-600`).
4. The host performs the requested scan or file operation and returns a typed result; write calls return per-operation outcomes and backups (`host.ts:783-785`, `host.ts:1118-1189`).
5. The server returns the result to the UI/CLI and publishes refreshed overview state after mutations (`server.ts:1071-1075`, `server.ts:2045-2255`, `server.ts:2470-2902`).

Detailed startup, RPC-contract and Skills page branches are documented in [RPC runtime internals](api-runtime.md) (`server.ts:484-551`, `server.ts:201-448`, `skills-hub-service.ts:150-213`, `skills-page.tsx:140-210`).

### Modes and branches

| Mode | Branch | Result |
|---|---|---|
| Read/report | `overview` assembles stored snapshots and derived views; scan commands collect host scans; plan commands derive operations from snapshots | Overview/report data; `scanHost` stores a failed scan call with its host ID, time, and error (`server.ts:821-833`, `server.ts:586-594`, `server.ts:1148-1174`). |
| Mutating RPC/CLI | Catalogue, skill, OpenCode, and config commands call server handlers that update KV state or host files | Updated overview, counts, and operation results (`server.ts:2045-2255`, `server.ts:2470-2902`). |
| Dry run | `sync`, `purge`, `skills_fanout`, and OpenCode apply/clean accept `dryRun` | Operations are planned or evaluated without the corresponding host-file write (`server.ts:223-250`, `server.ts:324-351`, `contract.ts:231-250`, `host.ts:1173-1177`). |
| Host RPC | Server dispatches methods from `hostContract` to a selected `hostId` | Host-local scan, skill, MCP, plugin, or OpenCode result (`contract.ts:355-491`, `server.ts:545-550`, `host.ts:789-795`). |
| CLI JSON output | Caller passes `--json` to supported read/report commands | Handler serializes the result as JSON (`server.ts:2470-2494`, `server.ts:2825-2932`). |

### Failure behavior

- Zod rejects inputs that do not match the declared RPC schemas (`server.ts:215-448`, `contract.ts:355-452`).
- A host-call rejection during MCP scan is stored in the snapshot `error`; fan-out and sync handlers collect operation failures and return counts/error strings (`server.ts:586-594`, `server.ts:1168-1232`, `server.ts:1596-1641`).
- Host writes return per-operation errors when the agent is unknown, the file is not writable, or parsing/writing fails (`host.ts:1118-1189`).
- Skill adopt/restore handlers throw when the host returns `ok: false`; bulk operations preserve failures in their result (`server.ts:2112-2150`, `server.ts:2163-2167`).
- CLI input checks return `exitCode: 1` with `stderr` when `forget` names no catalogue entry, gateway import lacks `--host` or cannot read its file, or the language is invalid (`server.ts:2613-2619`, `server.ts:2688-2701`, `server.ts:2713-2720`).

## Authentication and transport

- **UI-to-server:** the BB plugin UI calls RPC method names such as `overview` and `rescan`; the plugin registers them with `bb.rpc.register` (`app.tsx:115-139`, `server.ts:2045-2050`). No per-method authentication check is implemented in this plugin (`server.ts:2045-2255`).
- **Server-to-host:** the plugin creates `bb.hosts.experimental_client({ contract: hostContract })`; calls supply the target BB `hostId`, and methods are handled by the registered host entry (`server.ts:545-550`, `server.ts:586-594`, `host.ts:789-795`).
- **CLI:** BB registers the `tools` command group and invokes its `run(argv)` handler inside the plugin runtime (`server.ts:2343-2346`, `server.ts:2456-2465`).
- **HTTP:** no Hono app or route registration is present in the plugin entry; `hono` is a development dependency only (`package.json:61-72`).

## UI/server RPC

All methods use BB RPC names rather than HTTP method/path pairs. Each method accepts the Zod input shown in `rpcContract`; the caller is the plugin UI unless noted.

| Area | Method | Caller | Purpose | Auth |
|---|---|---|---|---|
| Overview | `overview` | UI | Return inventory, drift, pending entries, skills, plugins, and OpenCode view | BB plugin RPC (`server.ts:134-151`, `server.ts:1104-1127`, `server.ts:2082-2086`) |
| Overview | `rescan` | UI | Scan all connected machines, or the given `hostId`; refresh MetaMCP | BB plugin RPC (`server.ts:217`, `server.ts:2047-2050`) |
| Catalogue | `adopt` | UI | Add pending server names with global/local-only scope | BB plugin RPC (`server.ts:218-224`, `server.ts:2051-2054`) |
| Catalogue | `ignore`, `unignore` | UI | Hide pending names or show them again | BB plugin RPC (`server.ts:734-750`, `server.ts:2094-2104`) |
| Catalogue | `catalog_update`, `catalog_remove` | UI | Change scope, target agents, server spec, or remove a catalogue row | BB plugin RPC (`server.ts:227-236`, `server.ts:2067-2082`) |
| Catalogue | `purge` | UI | Remove a server from selected host(s), optionally gateway configs; supports dry run | BB plugin RPC (`server.ts:237-250`, `server.ts:2083-2091`) |
| Catalogue | `plan`, `sync` | UI | Return proposed operations; apply additions/updates with dry-run and include-different flags | BB plugin RPC (`server.ts:252-264`, `server.ts:2093-2099`) |
| Catalogue | `probe` | UI | Handshake selected server(s) and return result counts | BB plugin RPC (`server.ts:268-274`, `server.ts:2100-2103`) |
| Catalogue | `set_server_enabled` | UI | Enable/disable a server where its dialect supports the flag | BB plugin RPC (`server.ts:276-288`, `server.ts:2104-2107`) |
| Gateway | `gateway_add` | UI | Parse JSON and add entries to a host's existing MetaMCP config | BB plugin RPC (`server.ts:289-301`, `server.ts:2108-2110`) |
| Schedule/language | `set_auto_sync`, `set_skills_fanout_auto`, `set_language` | UI | Change scheduled MCP sync and UI/CLI language; legacy skill setter is a no-op | BB plugin RPC (`server.ts:272`, `server.ts:2197-2201`, `server.ts:2292-2299`) |
| Skills | `skill_adopt`, `skill_adopt_bulk` | UI | Apply explicit per-home actions | BB plugin RPC (`server.ts:289-317`, `server.ts:2112-2150`) |
| Skills (legacy RPC) | `skills_fanout` | Older UI clients | Retained machine-canon rollout handler; current CLI rejects the former workflow | BB plugin RPC (`server.ts:343-351`, `server.ts:2203-2206`, `server.ts:2730-2739`) |
| Skills | `skills_backups`, `skills_backup_restore` | UI | List snapshots or restore a selected snapshot | BB plugin RPC (`server.ts:353-370`, `server.ts:2162-2167`) |
| Skills (legacy RPC) | `skills_sync` | Older UI clients | Legacy handler rejects because no machine-canon Git remote is configured | BB plugin RPC (`server.ts:391-399`, `server.ts:2214-2219`, `server.ts:546-548`) |
| OpenCode | `opencode_sync` | UI | Copy selected providers, models, and enabled state from source to connected target(s) | BB plugin RPC (`server.ts:395-407`, `server.ts:2176-2181`) |
| OpenCode | `opencode_clean` | UI | Remove named or known-stale providers; supports dry run | BB plugin RPC (`server.ts:408-419`, `server.ts:2178-2185`) |
| OpenCode | `opencode_apply` | UI | Apply provider/model/enabled operations to one host | BB plugin RPC (`server.ts:420-433`, `server.ts:2186-2207`) |
| OpenCode | `opencode_set_default_model` | UI | Update BB's default and/or OpenCode's model defaults | BB plugin RPC (`server.ts:434-448`, `server.ts:2208-2242`) |

### Hub skills UI/server RPC

`SkillsPage` uses these RPC methods to manage the BB server's hub library. The contract validates payloads and result shapes; the handlers live in `createSkillsHubService` (`skills-page.tsx:140-210`, `skills-hub-service.ts:150-213`, `skills-hub-service.ts:567-683`).

| Method | Input | Result / effect |
|---|---|---|
| `skills_hub` | `null` | Hub listing, category tree, classifier status, machine scan summary and Git status. |
| `skills_hub_detail` | `name` (max 120 chars) | Detail or `null`; includes capped skill content, file list and history. |
| `skills_hub_file` | `name` (max 120), relative `path` (max 500) | Text or `null` for the selected file. |
| `skills_move` | `skill`, `sectionId`, `subsectionId` | Saves a manual assignment and returns refreshed hub state. |
| `skills_review_accept` | `skill` (max 120) | Creates/uses the proposed category and records a manual assignment. |
| `skills_category_create` | Non-empty `section` and `subsection`, each max 60 | Adds the missing category path and returns hub state. |
| `skills_category_rename` | `id`, non-empty `title` max 60 | Renames a section or subsection and returns hub state. |
| `skills_category_remove` | `id` | Removes an empty subsection or a section with no assigned skills; throws when assignments use that ID (`skills-hub-service.ts:593-595`, `categories.ts:241-250`). |
| `skills_classify` | `null` | Starts background classification and returns hub state. |
| `skills_remove` | `name` (max 120) | Archives and removes a hub skill; returns `{ok,error,hub}`. |
| `skills_pull` | `name`, `hostId`, nullable `target` max 500 | Copies a hub skill to a connected host; returns `{ok,path,error}`. |
| `skills_publish` | `hostId`, `path` max 500, required `dryRun` | Packs a host skill and publishes it to the hub; returns validation and Git result. |
| `skills_machines_refresh` | `null` | Refreshes skill-home counts and discovered skills for every host in BB host listing; returns hub state (`skills-hub-service.ts:444-475`). |
| `skills_machines_import` | `hostId`, nullable `names` list (up to 3,000 names; each max 200) | Copies selected discovered skills that are missing from the hub; returns per-skill validation results and hub state. |
| `skills_machines_cleanup` | `hostId`, required `dryRun` | Explicitly previews or archives machine skill-home entries; the UI offer setting does not gate this RPC or CLI command. Returns moved counts, errors and hub state (`skills-hub-service.ts:728-735`, `settings-page.tsx:188-199`). |
| `skills_settings` | `null` | Returns classifier provider/model/project, automatic classification and cleanup-offer settings, plus provider/project choices. |
| `skills_settings_set` | Optional `provider` (max 120), `model` (max 200), `auto`, `projectId` (max 120), `offerCleanup` | Saves a partial settings update and returns refreshed choices and values. |
| `skills_provider_models` | `providerId` (max 120) | Returns provider model choices or a nullable error string. |

The schemas and limits are declared per method in `skillsRpcContract` (`skills-hub-service.ts:154-223`). The UI loads the hub on mount, polls at five-second intervals while classification is active, and fetches detail for the selected skill (`skills-page.tsx:179-210`). The UI action wrapper displays thrown RPC errors and clears its busy state in `finally` (`skills-page.tsx:163-177`).

## Host RPC

The `hostContract` is executed by the registered host entry (`contract.ts:355-491`, `host.ts:789-795`). UI/server callers reach it through the client created during plugin initialization (`server.ts:545-550`).

| Method | Caller | Purpose | Auth |
|---|---|---|---|
| `scan` | Server | Read CLI binaries and MCP configuration on one host | BB host RPC channel (`contract.ts:355-357`, `host.ts:785-818`) |
| `apply` | Server | Upsert/remove MCP entries; dry-run supported | BB host RPC channel (`contract.ts:356-360`, `host.ts:1118-1189`) |
| `probe` | Server | Connect to selected MCP server definitions with bounded timeout | BB host RPC channel (`contract.ts:361-367`, `host.ts:839-869`) |
| `skills_scan` | Server | Legacy inventory of machine canon and skill homes | BB host RPC channel (`contract.ts:368`, `host.ts:374-435`, `host.ts:871`) |
| `skills_adopt`, `skills_adopt_bulk` | Server | Adopt, take, link, delete, or unlink skills by location | BB host RPC channel (`contract.ts:369-403`, `host.ts:873-882`) |
| `skills_fanout` | Server | Apply planned links, mirrors, pulls, drops, and retirements | BB host RPC channel (`contract.ts:409-418`, `host.ts:885-975`) |
| `skills_backups_list`, `skills_backup_restore` | Server | List and restore skill snapshots | BB host RPC channel (`contract.ts:420-430`, `host.ts:982-1061`) |
| `skills_sync` | Legacy server handler | Machine-canon Git synchronization (no configured remote in the current server) | BB host RPC channel (`contract.ts:432-439`, `host.ts:1060-1084`, `server.ts:546-548`, `server.ts:1282-1293`) |
| `skills_archive` | Server | Pack one canon skill for transfer to the BB server process; archive omits recognized junk and fails when tar is unavailable or the archive exceeds 8 MiB | BB host RPC channel (`contract.ts:440-448`, `host.ts:1086-1115`, `server.ts:1484-1492`) |
| `opencode_scan`, `opencode_apply` | Server | Read or write OpenCode JSON config | BB host RPC channel (`contract.ts:449-450`, `host.ts:574-698`, `host.ts:1191-1193`) |
| `skill_pack` / `skill_unpack` | Skills hub service | Pack a machine folder for hub publishing, or copy a hub skill to a machine target | BB host RPC channel (`contract.ts:456-470`, `host-skills.ts:48-98`, `skills-hub-service.ts:564-590`) |
| `skill_homes_count` | Skills hub service | Count homes and return discovered skills; see [machine skill discovery](features/machine-skill-discovery.md) for filtering, duplicate selection, and failures (`host-skills.ts:144-163`) | BB host RPC channel (`contract.ts:473-481`, `host.ts:1216`) |
| `skill_homes_cleanup` | Skills hub service | Preview or move machine skill-home entries into a dated backup (`host-skills.ts:172-223`) | BB host RPC channel (`contract.ts:483-490`, `host.ts:1218`) |
| `plugins_scan` | Server | Inventory installed CLI plugins | BB host RPC channel (`contract.ts:492-494`, `host.ts:700-780`, `host.ts:1220-1224`) |

### Host contract request flow and branches

1. `defineRpcContract` declares each method's Zod input and output. Invalid payloads fail contract validation before the host handler runs (`contract.ts:355-414`).
2. The server creates the host client with `hostContract` and calls it with the selected machine's `hostId`; registered host handlers receive the BB RPC context, including its abort signal (`server.ts:545-550`, `server.ts:592-604`, `host.ts:789-795`).
3. The handler returns the declared output shape. Some methods report operation failures inside that shape; an uncaught exception or aborted signal rejects the host call.

| Method | Branches and limits | Output and failure behavior |
|---|---|---|
| `scan` / `skills_scan` | No arguments; scan methods check the RPC abort signal while traversing host data (`contract.ts:355-368`, `host.ts:789-825`, `host.ts:374-435`, `host.ts:871`). | Return the machine scan; a `scan` rejection is stored in the snapshot's `error` field (`server.ts:586-594`). |
| `apply` | Up to 200 upsert/remove operations and required `dryRun` (`contract.ts:357-360`). | Returns per-operation `{ok,error}` and created backup paths. Unknown agents, unwritable files, parse errors, and write failures become failed operation rows (`host.ts:1118-1189`). |
| `probe` | Up to 60 targets, timeout from 1 to 60 seconds; checks targets sequentially (`contract.ts:361-367`, `host.ts:820-868`). | Unknown agent or missing config entry becomes a result with `ok:false`; protocol outcome and elapsed milliseconds are recorded per target (`host.ts:832-868`). |
| `skills_adopt`, `skills_adopt_bulk` | One selected location/name/action or up to 200 such actions; modes are `adopt`, `link`, `take`, `delete`, `unlink` (`contract.ts:369-403`). Bulk execution is sequential and checks cancellation between actions (`host.ts:873-882`). | Each action returns `ok` and optional error; validation failures are values, while uncaught filesystem failures reject the call (`host.ts:476-570`). |
| `skills_fanout` | Up to 500 plugin names plus required `dryRun`; `*` bypasses plugin-name exclusion, empty names use scanned plugin names (`contract.ts:409-418`, `host.ts:890-905`). | Returns per-operation `ok/error` and skipped plugin names. Dry run records planned operations without writes; blocked plans and caught operation errors are returned as failed rows (`host.ts:906-975`). |

### Plugin initialization

1. The plugin reads `lang` from BB KV. `isLang` retains supported `ru` or `en`; absent or invalid values select English, then update the shared dictionary (`server.ts:484-490`).
2. It defines MetaMCP and classifier settings, creates `readConfig` as a live `settings.get()` call, then creates the host client and skills-hub service with config read/write callbacks (`server.ts:492-561`).
3. It defines catalogue, ignored-name, auto-sync, and probe readers. Missing stored arrays read as `[]`; absent `autoSync` reads as `false` (`server.ts:564-573`).
4. It registers classifier-thread configuration and later registers RPC handlers, including the skills-hub handler map (`server.ts:552-562`, `server.ts:2082-2086`).

| Initialization condition | Selected behavior |
|---|---|
| Saved language is `ru` or `en` | Apply that dictionary before settings labels are defined (`server.ts:488-490`, `i18n.ts:6-17`). |
| Saved language is missing or unsupported | Start in English (`server.ts:488-490`). |
| A setting changes while the plugin is running | `readConfig` retrieves settings at use time; a blank provider falls back to `claude-code`, and a blank model means use the provider default (`server.ts:543-561`, `skills-hub-service.ts:350-362`). |

The initial language read, settings definition, and host-client construction have no local catch branch (`server.ts:488-550`). Skills settings reads happen when the service uses them; machine feature scan failures are handled separately by scan orchestration (`server.ts:603-648`). Current classifier and cleanup setting behavior is owned by [hub skills](features/skills-hub.md).

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

All commands are registered under `bb tools`; `--json` returns JSON for the read/report commands listed with that option (`server.ts:2143-2255`, `server.ts:2256-2272`).

| Area | Command | Caller | Purpose | Auth |
|---|---|---|---|---|
| Overview | `bb tools status [--json]` | BB CLI user | Print current inventory and drift | BB CLI runtime (`server.ts:2147`, `server.ts:2277-2280`) |
| Overview | `bb tools scan [--host <id>]` | BB CLI user | Rescan one or all connected hosts | BB CLI runtime (`server.ts:2148`, `server.ts:2281-2285`) |
| Catalogue | `bb tools catalog [--json]` | BB CLI user | List catalogue rows | BB CLI runtime (`server.ts:2149`, `server.ts:2286-2299`) |
| Catalogue | `bb tools pending [--json]` | BB CLI user | List unknown configured servers | BB CLI runtime (`server.ts:2150`, `server.ts:2300-2312`) |
| Catalogue | `bb tools adopt <name...>` | BB CLI user | Adopt pending servers using inferred scope | BB CLI runtime (`server.ts:2151`, `server.ts:2314-2319`) |
| Catalogue | `bb tools ignore <name...>` / `bb tools unignore <name...>` | BB CLI user | Hide or restore pending suggestions | BB CLI runtime (`server.ts:2152-2156`, `server.ts:2320-2335`) |
| Catalogue | `bb tools plan [--host <id>]` | BB CLI user | Show planned operations | BB CLI runtime (`server.ts:2158`, `server.ts:2336-2345`) |
| Catalogue | `bb tools sync [--host <id>] [--dry-run] [--with-different]` | BB CLI user | Apply or preview catalogue sync | BB CLI runtime (`server.ts:2159-2163`, `server.ts:2347-2353`) |
| Catalogue | `bb tools forget <name>` | BB CLI user | Remove only the catalogue row | BB CLI runtime (`server.ts:2165-2167`, `server.ts:2355-2365`) |
| Catalogue | `bb tools remove <name> [--host <id>] [--with-gateways] [--dry-run]` | BB CLI user | Remove from machine configs; dry run available | BB CLI runtime (`server.ts:2169-2173`, `server.ts:2366-2387`) |
| Catalogue | `bb tools probe [<name>] [--host <id>]` | BB CLI user | Run live MCP checks | BB CLI runtime (`server.ts:2175-2177`, `server.ts:2389-2409`) |
| Catalogue | `bb tools enable <name> [--host <id>]` / `bb tools disable <name> [--host <id>]` | BB CLI user | Toggle supported server configs | BB CLI runtime (`server.ts:2179-2187`, `server.ts:2411-2421`) |
| Settings | `bb tools auto on|off` | BB CLI user | Enable or disable scheduled MCP sync | BB CLI runtime (`server.ts:2189`, `server.ts:2423-2429`) |
| Gateway | `bb tools gateway-add <file.json> --host <id>` | BB CLI user | Import JSON server entries into the existing gateway config | BB CLI runtime (`server.ts:2191-2194`, `server.ts:2430-2454`) |
| Language | `bb tools lang [ru|en]` | BB CLI user | Read or set interface and CLI language | BB CLI runtime (`server.ts:2195-2199`, `server.ts:2455-2470`) |
| Legacy skills | `skills`, `skills-adopt`, `skills-fanout`, `skills-backups`, `skills-restore`, `skills-sync` | BB CLI user | These former machine-canon commands return a migration error directing users to `bb tools skills-hub` | BB CLI runtime (`server.ts:2730-2739`) |
| Hub skills | `bb tools skills-hub [--json]` / `bb tools skills-tree [--skills] [--json]` | BB CLI user | Show hub skills, category assignments, validation problems, Git state, or the category tree | Plugin CLI runtime (`skills-hub-service.ts:705-742`, `skills-hub-service.ts:836-846`) |
| Hub skills | `bb tools skills-publish <folder> [--host <id>] [--dry-run]` | BB CLI user | Validate and publish one host skill folder to the hub | Plugin CLI runtime (`skills-hub-service.ts:744-764`, `skills-hub-service.ts:836-846`) |
| Hub skills | `bb tools skills-pull <name> [--to <folder>] [--host <id>]` | BB CLI user | Copy one hub skill to a connected host | Plugin CLI runtime (`skills-hub-service.ts:766-771`, `skills-hub-service.ts:836-846`) |
| Hub skills | `bb tools skills-move <name> "<section>/<subsection>"` / `bb tools skills-classify [--wait]` | BB CLI user | Set a manual category or classify unplaced skills | Plugin CLI runtime (`skills-hub-service.ts:773-793`, `skills-hub-service.ts:836-846`) |
| Hub skills | `bb tools skills-remove <name>` | BB CLI user | Archive and remove a skill from the hub | Plugin CLI runtime (`skills-hub-service.ts:794-799`, `skills-hub-service.ts:836-846`) |
| Hub skills | `bb tools skills-machines` / `bb tools skills-import --host <id> [<name...>] [--dry-run]` | BB CLI user | Inspect machine skill folders or copy selected skills missing from the hub; import leaves originals in place | Plugin CLI runtime (`skills-hub-service.ts:593-609`, `skills-hub-service.ts:855-880`, `skills-hub-service.ts:904-914`) |
| Hub skills | `bb tools skills-cleanup --host <id> [--dry-run]` | BB CLI user | Explicitly preview or archive machine skill-home entries; available regardless of the UI offer setting | Plugin CLI runtime (`host-skills.ts:172-223`, `skills-hub-service.ts:882-895`, `skills-hub-service.ts:913-914`) |
| Plugins | `bb tools plugins [--json]` | BB CLI user | Show installed CLI plugins across hosts | BB CLI runtime (`server.ts:2231-2234`, `server.ts:2584-2609`) |
| OpenCode | `bb tools opencode [--json]` | BB CLI user | Report model/provider state and drift | BB CLI runtime (`server.ts:2235-2239`, `server.ts:2611-2637`) |
| OpenCode | `bb tools opencode-sync [--from <host>] [--to <host>] [--dry-run] [--json]` | BB CLI user | Copy full provider/model/enabled state from source to other host(s) | BB CLI runtime (`server.ts:2241-2244`, `server.ts:2638-2655`) |
| OpenCode | `bb tools opencode-clean [--host <id>] [--dry-run] [--json]` | BB CLI user | Remove known stale providers | BB CLI runtime (`server.ts:2246-2249`, `server.ts:2657-2664`) |
| OpenCode | `bb tools opencode-set-default <modelId>` | BB CLI user | Set BB and host OpenCode default model | BB CLI runtime (`server.ts:2251-2254`, `server.ts:2665-2687`) |

See the [feature pages](features/mcp-catalog.md), [hub skills and categories](features/skills-hub.md), [legacy machine skills](features/skills.md), [OpenCode](features/opencode.md), and [CLI plugins](features/cli-plugins.md) for behavior details.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Plugin RPC and Skills page runtime](api-runtime.md)
- [Agent Tools architecture](architecture.md)
- [Agent Tools deployment](deployment.md)
- [CLI plugin inventory](features/cli-plugins.md)
- [MCP server catalogue](features/mcp-catalog.md)
- [OpenCode provider and model management](features/opencode.md)
- [Hub skills and categories](features/skills-hub.md)
- [Agent skill canon and rollout](features/skills.md)
- [Agent Tools overview](overview.md)
