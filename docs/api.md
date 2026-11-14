---
title: Agent Tools API and commands
type: component
created: 2026-09-27
updated: 2026-11-14
status: active
confidence: high
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
  - hub-only.ts
  - required-session-policy.ts
---
# Agent Tools API and commands
The plugin exposes BB plugin RPC methods, machine-local host RPC methods, and the `bb tools` CLI; this repository registers no plugin-owned HTTP routes (`server.ts:2043-2253`, `server.ts:2350-2954`).

## How it works

1. The plugin UI calls a named server RPC, or BB invokes the `tools` CLI handler (`app.tsx:100-170`, `server.ts:2350-2954`).
2. `rpcContract` validates the UI/server method inputs, while `hostContract` defines the methods and payloads the server can call on a selected host (`server.ts:219-450`, `contract.ts:359-498`).
3. The server handler reads stored state or orchestrates host calls through a client bound to `hostContract`; each host call supplies a target BB `hostId` (`server.ts:590-609`, `server.ts:640-650`).
4. The host performs the requested scan or file operation and returns a typed result; write calls return per-operation outcomes and backups (`host.ts:789-826`, `host.ts:1102-1178`).
5. The server returns the result to the UI/CLI and publishes refreshed overview state after mutations (`server.ts:1185-1201`, `server.ts:2043-2253`, `server.ts:2510-2954`).

Detailed startup, RPC-contract and Skills page branches are documented in [RPC runtime internals](api-runtime.md) (`server.ts:477-627`, `server.ts:219-450`, `skills-hub-service.ts:197-268`, `skills-page.tsx:155-225`).

### Modes and branches

| Mode | Branch | Result |
|---|---|---|
| Read/report | `overview` assembles stored snapshots and derived views; scan commands collect host scans; plan commands derive operations from snapshots | Overview/report data; `scanHost` stores a failed scan call with its host ID, time, and error (`server.ts:875-1183`, `server.ts:640-650`, `server.ts:1202-1241`). |
| Mutating RPC/CLI | Catalogue, skill, OpenCode, and config commands call server handlers that update KV state or host files | Updated overview, counts, and operation results (`server.ts:2043-2253`, `server.ts:2510-2954`). |
| Dry run | `sync`, `purge`, `skills_fanout`, and OpenCode apply/clean accept `dryRun` | Operations are planned or evaluated without the corresponding host-file write (`server.ts:242-270`, `server.ts:348-373`, `server.ts:393-431`, `host.ts:1160-1178`). |
| Host RPC | Server dispatches methods from `hostContract` to a selected `hostId` | Host-local scan, skill, MCP, plugin, or OpenCode result (`contract.ts:359-498`, `server.ts:590-609`, `host.ts:789-826`). |
| CLI JSON output | Caller passes `--json` to supported read/report commands | Handler serializes the result as JSON (`server.ts:2516-2548`, `server.ts:2845-2954`). |

### Failure behavior

- Zod rejects inputs that do not match the declared RPC schemas (`server.ts:219-450`, `contract.ts:359-498`).
- A host-call rejection during MCP scan is stored in the snapshot `error`; fan-out and sync handlers collect operation failures and return counts/error strings (`server.ts:640-650`, `server.ts:1243-1324`, `server.ts:1594-1642`).
- Host writes return per-operation errors when the agent is unknown, the file is not writable, or parsing/writing fails (`host.ts:1102-1178`).
- Skill adopt/restore handlers throw when the host returns `ok: false`; bulk operations preserve failures in their result (`server.ts:2111-2150`, `server.ts:2168-2173`).
- CLI input checks return `exitCode: 1` with `stderr` when `forget` names no catalogue entry, gateway import lacks `--host` or cannot read its file, or the language is invalid (`server.ts:2601-2623`, `server.ts:2665-2706`).

## Authentication and transport

- **UI-to-server:** the BB plugin UI calls RPC method names such as `overview` and `rescan`; the plugin registers them with `bb.rpc.register` (`app.tsx:100-170`, `server.ts:2043-2049`). No per-method authentication check is implemented in this plugin (`server.ts:2043-2253`).
- **Server-to-host:** the plugin creates `bb.hosts.experimental_client({ contract: hostContract })`; calls supply the target BB `hostId`, and methods are handled by the registered host entry (`server.ts:590-609`, `server.ts:640-650`, `host.ts:789-826`).
- **CLI:** BB registers the `tools` command group and invokes its `run(argv)` handler inside the plugin runtime (`server.ts:2350-2510`).
- **HTTP:** no Hono app or route registration is present in the plugin entry; `hono` is a development dependency only (`package.json:61-72`).

## UI/server RPC

All methods use BB RPC names rather than HTTP method/path pairs. Each method accepts the Zod input shown in `rpcContract`; the caller is the plugin UI unless noted.

| Area | Method | Caller | Purpose | Auth |
|---|---|---|---|---|
| Overview | `overview` | UI | Return inventory, drift, pending entries, `uiLang`, skills, plugins, and OpenCode view | BB plugin RPC (`server.ts:134-203`, `server.ts:875-1183`, `server.ts:2045`) |
| Overview | `rescan` | UI | Scan all connected machines, or the given `hostId`; refresh MetaMCP | BB plugin RPC (`server.ts:222`, `server.ts:2046-2049`) |
| Catalogue | `adopt` | UI | Add pending server names with global/local-only scope | BB plugin RPC (`server.ts:223-229`, `server.ts:2050-2053`) |
| Catalogue | `ignore`, `unignore` | UI | Hide pending names or show them again | BB plugin RPC (`server.ts:230-231`, `server.ts:2054-2065`) |
| Catalogue | `catalog_update`, `catalog_remove` | UI | Change scope, target agents, server spec, or remove a catalogue row | BB plugin RPC (`server.ts:232-241`, `server.ts:2066-2081`) |
| Catalogue | `purge` | UI | Remove a server from selected host(s), optionally gateway configs; supports dry run | BB plugin RPC (`server.ts:242-256`, `server.ts:2082-2091`) |
| Catalogue | `plan`, `sync` | UI | Return proposed operations; apply additions/updates with dry-run and include-different flags | BB plugin RPC (`server.ts:257-270`, `server.ts:2092-2098`) |
| Catalogue | `probe` | UI | Handshake selected server(s) and return result counts | BB plugin RPC (`server.ts:273-280`, `server.ts:2099-2102`) |
| Catalogue | `set_server_enabled` | UI | Enable/disable a server where its dialect supports the flag | BB plugin RPC (`server.ts:281-293`, `server.ts:2103-2106`) |
| Gateway | `gateway_add` | UI | Parse JSON and add entries to a host's existing MetaMCP config | BB plugin RPC (`server.ts:294-307`, `server.ts:2107-2110`) |
| Schedule/language | `set_auto_sync`, `set_skills_fanout_auto`, `set_language`, `ui_language_set` | UI | Change scheduled MCP sync, CLI/server language (`ru|en`), or page UI language (`auto|ru|en`); legacy skill setter is a no-op | BB plugin RPC (`server.ts:271-272`, `server.ts:339-347`, `server.ts:2151-2162`, `server.ts:2245-2252`) |
| Skills | `skill_adopt`, `skill_adopt_bulk` | UI | Apply explicit per-home actions | BB plugin RPC (`server.ts:308-338`, `server.ts:2111-2150`) |
| Skills (legacy RPC) | `skills_fanout` | Older UI clients | Retained machine-canon promotion, fan-out, and BB server mirror handler (no Git sync stage); current CLI rejects the former workflow | BB plugin RPC (`server.ts:348-373`, `server.ts:2163-2166`, `server.ts:2707-2716`) |
| Skills | `skills_backups`, `skills_backup_restore` | UI | List snapshots or restore a selected snapshot | BB plugin RPC (`server.ts:375-392`, `server.ts:2167-2173`) |
| OpenCode | `opencode_sync` | UI | Copy selected providers, models, and enabled state from source to connected target(s) | BB plugin RPC (`server.ts:393-407`, `server.ts:2174-2177`) |
| OpenCode | `opencode_clean` | UI | Remove named or known-stale providers; supports dry run | BB plugin RPC (`server.ts:408-419`, `server.ts:2178-2181`) |
| OpenCode | `opencode_apply` | UI | Apply provider/model/enabled operations to one host | BB plugin RPC (`server.ts:420-431`, `server.ts:2182-2205`) |
| OpenCode | `opencode_set_default_model` | UI | Update BB's default and/or OpenCode's model defaults | BB plugin RPC (`server.ts:432-450`, `server.ts:2206-2244`) |

### Hub skills UI/server RPC

`SkillsPage` (`skills-page.tsx:155-225`) and `SettingsPage` (`settings-page.tsx:47-115`) call `skillsRpcContract` (`skills-hub-service.ts:197-268`) to manage the BB server's hub library and hub settings; `createSkillsHubService` (`skills-hub-service.ts:322`) builds the RPC `handlers` (`skills-hub-service.ts:1244-1326`).

| Method | Input | Result / effect |
|---|---|---|
| `skills_hub` | `null` | Hub listing, category tree, classifier status, machine scan summary (with `offerCleanup` reflecting `hubOnly`) and Git status (`skills-hub-service.ts:152`, `skills-hub-service.ts:1044-1086`). |
| `skills_hub_detail` | `name` (max 120 chars) | Detail or `null`; includes capped skill content, file list and history (`skills-hub-service.ts:1269-1275`). |
| `skills_hub_file` | `name` (max 120), relative `path` (max 500) | Text or `null` for the selected file (`skills-hub-service.ts:1276`). |
| `skills_move` | `skill`, `sectionId`, `subsectionId` | Saves a manual assignment and returns refreshed hub state (`skills-hub-service.ts:1277-1280`). |
| `skills_review_accept` | `skill` (max 120) | Creates/uses the proposed category and records a manual assignment (`skills-hub-service.ts:1281-1284`). |
| `skills_category_create` | Non-empty `section` and `subsection`, each max 60 | Adds the missing category path and returns hub state (`skills-hub-service.ts:1285-1288`). |
| `skills_category_rename` | `id`, non-empty `title` max 60 | Renames a section or subsection and returns hub state (`skills-hub-service.ts:1289-1292`). |
| `skills_category_remove` | `id` | Removes an empty subsection or a section with no assigned skills; throws when assignments use that ID (`skills-hub-service.ts:1293-1296`, `categories.ts:242-251`). |
| `skills_classify` | `null` | Starts background classification and returns hub state (`skills-hub-service.ts:1297-1300`). |
| `skills_remove` | `name` (max 120) | Archives and removes a hub skill; returns `{ok,error,hub}` (`skills-hub-service.ts:1301-1305`). |
| `skills_pull` | `name`, `hostId`, nullable `target` max 500 | Copies a hub skill to a connected host; returns `{ok,path,error}` (`skills-hub-service.ts:1306`). |
| `skills_publish` | `hostId`, `path` max 500, required `dryRun` | Packs a host skill and publishes it to the hub; returns validation and Git result (`skills-hub-service.ts:1307-1308`). |
| `skills_machines_refresh` | `null` | Refreshes skill-home counts and discovered skills for every host in BB host listing; returns hub state (`skills-hub-service.ts:962-1000`, `skills-hub-service.ts:1309-1312`). |
| `skills_machines_import` | `hostId`, nullable `names` list (up to 3,000 names; each max 200) | Copies selected discovered skills absent from `loadableHubNames(hub)`; returns per-skill validation results and hub state (`skills-hub-service.ts:1163-1179`, `skills-hub-service.ts:1313-1316`). |
| `skills_machines_cleanup` | `hostId`, required `dryRun` | Explicitly previews or archives machine skill-home entries (with `protectPaths()` token); returns moved counts, errors and hub state (`skills-hub-service.ts:955-959`, `skills-hub-service.ts:1317-1325`). |
| `skills_settings` | `null` | Returns `uiLang` (`auto|ru|en`), classifier provider/model/project, automatic classification, `hubOnly`, `hubOnlyLast`, and provider/project choices (`skills-hub-service.ts:155-174`, `skills-hub-service.ts:1186-1223`). |
| `skills_settings_set` | Optional `provider` (max 120), `model` (max 200), `auto`, `projectId` (max 120), `hubOnly` | Saves a partial settings update; immediately kicks `enforceHubOnlyMode()` when `hubOnly` is set true (`skills-hub-service.ts:232-241`, `skills-hub-service.ts:1246-1266`). |
| `skills_provider_models` | `providerId` (max 120) | Returns provider model choices or a nullable error string (`skills-hub-service.ts:1225-1243`). |

The schemas and limits are declared per method in `skillsRpcContract` (`skills-hub-service.ts:197-268`). The UI loads the hub on mount, polls at five-second intervals while classification is active, and fetches detail for the selected skill (`skills-page.tsx:194-225`). The UI action wrapper displays thrown RPC errors and clears its busy state in `finally` (`skills-page.tsx:163-190`).

## Host RPC

The `hostContract` is executed by the registered host entry (`contract.ts:359-498`, `host.ts:789-826`). UI/server callers reach it through the client created during plugin initialization (`server.ts:590-609`).

| Method | Caller | Purpose | Auth |
|---|---|---|---|
| `scan` | Server | Read CLI binaries and MCP configuration on one host | BB host RPC channel (`contract.ts:360`, `host.ts:789-826`) |
| `apply` | Server | Upsert/remove MCP entries; dry-run supported | BB host RPC channel (`contract.ts:361-364`, `host.ts:1102-1178`) |
| `probe` | Server | Connect to selected MCP server definitions with bounded timeout | BB host RPC channel (`contract.ts:365-371`, `host.ts:827-877`) |
| `skills_scan` | Server | Legacy inventory of machine canon and skill homes | BB host RPC channel (`contract.ts:372`, `host.ts:381-442`, `host.ts:878`) |
| `skills_adopt`, `skills_adopt_bulk` | Server | Adopt, take, link, delete, or unlink skills by location | BB host RPC channel (`contract.ts:373-412`, `host.ts:880-896`) |
| `skills_fanout` | Server | Apply planned links, mirrors, pulls, drops, and retirements | BB host RPC channel (`contract.ts:413-423`, `host.ts:897-987`) |
| `skills_backups_list`, `skills_backup_restore` | Server | List and restore skill snapshots | BB host RPC channel (`contract.ts:424-436`, `host.ts:989-1068`) |
| `skills_archive` | Server | Pack one canon skill for transfer to the BB server process; archive omits recognized junk and fails when tar is unavailable or the archive exceeds 8 MiB | BB host RPC channel (`contract.ts:437-445`, `host.ts:1070-1100`, `server.ts:1430-1515`) |
| `opencode_scan`, `opencode_apply` | Server | Read or write OpenCode JSON config | BB host RPC channel (`contract.ts:495-496`, `host.ts:581-705`, `host.ts:1200-1202`) |
| `skill_pack` / `skill_unpack` | Skills hub service | Pack a machine folder for hub publishing, or copy a hub skill to a machine target | BB host RPC channel (`contract.ts:446-464`, `host-skills.ts:48-112`, `host.ts:1180-1191`) |
| `skill_homes_count` | Skills hub service | Count homes and return discovered skills, respecting optional `protect` canon-marker paths; see [machine skill discovery](features/machine-skill-discovery.md) (`host-skills.ts:113-207`) | BB host RPC channel (`contract.ts:465-479`, `host.ts:1193-1196`) |
| `skill_homes_cleanup` | Skills hub service | Preview or move machine skill-home entries into a dated backup, skipping `protect` paths (`host-skills.ts:216-259`) | BB host RPC channel (`contract.ts:481-494`, `host.ts:1198`) |
| `plugins_scan` | Server | Inventory installed CLI plugins | BB host RPC channel (`contract.ts:497`, `host.ts:707-786`, `host.ts:1204`) |

### Host contract request flow and branches

1. `defineRpcContract` declares each method's Zod input and output. Invalid payloads fail contract validation before the host handler runs (`contract.ts:359-498`).
2. The server creates the host client with `hostContract` and calls it with the selected machine's `hostId`; registered host handlers receive the BB RPC context, including its abort signal (`server.ts:590-609`, `server.ts:640-650`, `host.ts:789-826`).
3. The handler returns the declared output shape. Some methods report operation failures inside that shape; an uncaught exception or aborted signal rejects the host call.

| Method | Branches and limits | Output and failure behavior |
|---|---|---|
| `scan` / `skills_scan` | No arguments; scan methods check the RPC abort signal while traversing host data (`contract.ts:360-372`, `host.ts:789-826`, `host.ts:381-442`, `host.ts:878`). | Return the machine scan; a `scan` rejection is stored in the snapshot's `error` field (`server.ts:640-650`). |
| `apply` | Up to 200 upsert/remove operations and required `dryRun` (`contract.ts:361-364`). | Returns per-operation `{ok,error}` and created backup paths. Unknown agents, unwritable files, parse errors, and write failures become failed operation rows (`host.ts:1102-1178`). |
| `probe` | Up to 60 targets, timeout from 1 to 60 seconds; checks targets sequentially (`contract.ts:365-371`, `host.ts:827-877`). | Unknown agent or missing config entry becomes a result with `ok:false`; protocol outcome and elapsed milliseconds are recorded per target (`host.ts:827-877`). |
| `skills_adopt`, `skills_adopt_bulk` | One selected location/name/action or up to 200 such actions; modes are `adopt`, `link`, `take`, `delete`, `unlink` (`contract.ts:373-412`). Bulk execution is sequential and checks cancellation between actions (`host.ts:880-896`). | Each action returns `ok` and optional error; validation failures are values, while uncaught filesystem failures reject the call (`host.ts:483-577`). |
| `skills_fanout` | Up to 500 plugin names plus required `dryRun`; `*` bypasses plugin-name exclusion, empty names use scanned plugin names (`contract.ts:413-423`, `host.ts:897-987`). | Returns per-operation `ok/error` and skipped plugin names. Dry run records planned operations without writes; blocked plans and caught operation errors are returned as failed rows (`host.ts:897-987`). |
| `skill_homes_count`, `skill_homes_cleanup` | Optional `protect` list (up to 8 `{path, token}` canon markers); cleanup also requires `dryRun` (`contract.ts:465-494`). | Return non-empty home counts and discovered skills (`count`), or backup path, moved counts, and errors (`cleanup`) (`host.ts:1193-1199`). |

### Plugin initialization

1. The plugin reads `lang` from BB KV. `isLang` retains supported `ru` or `en`; absent or invalid values select English, then update the shared dictionary (`server.ts:479-484`).
2. It defines MetaMCP, skill-classifier, experimental `skillsHubOnly`, and skill-suggest settings, creates `readConfig` as a live `settings.get()` call, defines `readUiLangChoice` from KV `uiLang`, then creates the host client and skills-hub service with config read/write callbacks (`server.ts:485-609`).
3. It defines catalogue, ignored-name, auto-sync, and probe readers. Missing stored arrays read as `[]`; absent `autoSync` reads as `false` (`server.ts:619-627`).
4. It registers classifier-thread configuration and later registers RPC handlers, including the skills-hub handler map (`server.ts:612-616`, `server.ts:2043-2045`).

| Initialization condition | Selected behavior |
|---|---|
| Saved language is `ru` or `en` | Apply that dictionary before settings labels are defined (`server.ts:481-484`, `i18n.ts:10-25`). |
| Saved language is missing or unsupported | Start in English (`server.ts:481-484`). |
| A setting changes while the plugin is running | `readConfig` retrieves settings at use time; a blank provider falls back to `claude-code`, and a blank model means use the provider default (`server.ts:581-609`, `skills-hub-service.ts:392-409`). |

The initial language read, settings definition, and host-client construction have no local catch branch (`server.ts:479-591`). Skills settings reads happen when the service uses them; machine feature scan failures are handled separately by scan orchestration (`server.ts:651-696`). Current classifier, canon protection, and hub-only setting behavior is owned by [hub skills](features/skills-hub.md).

### OpenCode host apply

1. The host checks `opencode.json` then `opencode.jsonc`, selects the first regular file, and returns a failed result if neither exists (`host.ts:645-675`).
2. A file containing comments is rejected as read-only; other JSON parse errors return `ok:false` with the parse message (`host.ts:672-690`).
3. The operation list updates provider maps and optional enable state, removes provider plus enabled-list references, changes model fields, or replaces the enabled-provider list (`opencode.ts:132-175`).
4. If not a dry run and the serialized document differs, the host backs up the file and writes atomically; it then rescans and returns the scan and backup list (`host.ts:690-705`).

| Condition | Result |
|---|---|
| Missing config or commented JSONC | `ok:false`, no backup, and `scan:null` (`host.ts:672-678`). |
| Invalid JSON | `ok:false` with parse error and no backup (`host.ts:680-690`). |
| Dry run or unchanged result | No file write or backup; the result is still rescanned and returns `ok:true` (`host.ts:693-704`). |
| Backup, atomic write, or rescan throws | The helper has no catch around those operations, so the host RPC rejects (`host.ts:690-705`). |

## CLI commands

All commands are registered under `bb tools`; `--json` returns JSON for the read/report commands listed with that option (`server.ts:2350-2954`).

| Area | Command | Caller | Purpose | Auth |
|---|---|---|---|---|
| Overview | `bb tools status [--json]` | BB CLI user | Print current inventory and drift | BB CLI runtime (`server.ts:2365-2380`, `server.ts:2512-2515`) |
| Overview | `bb tools scan [--host <id>]` | BB CLI user | Rescan one or all connected hosts | BB CLI runtime (`server.ts:2365-2380`, `server.ts:2516-2520`) |
| Catalogue | `bb tools catalog [--json]` | BB CLI user | List catalogue rows | BB CLI runtime (`server.ts:2521-2534`) |
| Catalogue | `bb tools pending [--json]` | BB CLI user | List unknown configured servers | BB CLI runtime (`server.ts:2535-2548`) |
| Catalogue | `bb tools adopt <name...>` | BB CLI user | Adopt pending servers using inferred scope | BB CLI runtime (`server.ts:2549-2554`) |
| Catalogue | `bb tools ignore <name...>` / `bb tools unignore <name...>` | BB CLI user | Hide or restore pending suggestions | BB CLI runtime (`server.ts:2555-2570`) |
| Catalogue | `bb tools plan [--host <id>]` | BB CLI user | Show planned operations | BB CLI runtime (`server.ts:2571-2581`) |
| Catalogue | `bb tools sync [--host <id>] [--dry-run] [--with-different]` | BB CLI user | Apply or preview catalogue sync | BB CLI runtime (`server.ts:2582-2589`) |
| Catalogue | `bb tools forget <name>` | BB CLI user | Remove only the catalogue row | BB CLI runtime (`server.ts:2590-2600`) |
| Catalogue | `bb tools remove <name> [--host <id>] [--with-gateways] [--dry-run]` | BB CLI user | Remove from machine configs; dry run available | BB CLI runtime (`server.ts:2601-2623`) |
| Catalogue | `bb tools probe [<name>] [--host <id>]` | BB CLI user | Run live MCP checks | BB CLI runtime (`server.ts:2624-2645`) |
| Catalogue | `bb tools enable <name> [--host <id>]` / `bb tools disable <name> [--host <id>]` | BB CLI user | Toggle supported server configs | BB CLI runtime (`server.ts:2646-2657`) |
| Settings | `bb tools auto on|off` | BB CLI user | Enable or disable scheduled MCP sync | BB CLI runtime (`server.ts:2658-2664`) |
| Gateway | `bb tools gateway-add <file.json> --host <id>` | BB CLI user | Import JSON server entries into the existing gateway config | BB CLI runtime (`server.ts:2665-2689`) |
| Language | `bb tools lang [ru|en]` | BB CLI user | Read or set CLI and server language | BB CLI runtime (`server.ts:2690-2706`) |
| Legacy skills | `skills`, `skills-adopt`, `skills-fanout`, `skills-backups`, `skills-restore`, `skills-sync` | BB CLI user | These former machine-canon commands return a migration error directing users to `bb tools skills-hub` | BB CLI runtime (`server.ts:2707-2716`) |
| Hub skills | `bb tools skills-hub [--json]` / `bb tools skills-tree [--skills] [--json]` | BB CLI user | Show hub skills, category assignments, validation problems, Git state, or the category tree | Plugin CLI runtime (`skills-hub-service.ts:1348-1386`) |
| Hub skills | `bb tools skills-publish <folder> [--host <id>] [--dry-run]` | BB CLI user | Validate and publish one host skill folder to the hub | Plugin CLI runtime (`skills-hub-service.ts:1387-1408`) |
| Hub skills | `bb tools skills-pull <name> [--to <folder>] [--host <id>]` | BB CLI user | Copy one hub skill to a connected host | Plugin CLI runtime (`skills-hub-service.ts:1409-1415`) |
| Hub skills | `bb tools skills-move <name> "<section>/<subsection>"` / `bb tools skills-classify [--wait]` | BB CLI user | Set a manual category or classify unplaced skills | Plugin CLI runtime (`skills-hub-service.ts:1416-1436`) |
| Hub skills | `bb tools skills-remove <name>` | BB CLI user | Archive and remove a skill from the hub | Plugin CLI runtime (`skills-hub-service.ts:1437-1443`) |
| Hub skills | `bb tools skills-machines` / `bb tools skills-import --host <id> [<name...>] [--dry-run]` | BB CLI user | Inspect machine skill folders or copy selected skills missing from `loadableHubNames(hub)`; import leaves originals in place | Plugin CLI runtime (`skills-hub-service.ts:1163-1179`, `skills-hub-service.ts:1444-1470`) |
| Hub skills | `bb tools skills-cleanup --host <id> [--dry-run]` / `bb tools skills-hub-only [--dry-run] [--json]` | BB CLI user | Explicitly preview/archive machine skill-home entries (`skills-cleanup`), or run hub-only import-then-cleanup enforcement across connected machines (`skills-hub-only`) | Plugin CLI runtime (`host-skills.ts:216-259`, `skills-hub-service.ts:1471-1511`, `hub-only.ts:63-126`, `server.ts:2449-2452`) |
| Skill suggest | `bb tools skills-suggest` / `skills-cards` / `skills-suggest-log` | BB CLI user | Run Jev routing, inspect/refresh routing cards, or read suggestion log | Plugin CLI runtime (`skills-hub-service.ts:1512-1580`) |
| Plugins | `bb tools plugins [--json]` | BB CLI user | Show installed CLI plugins across hosts | BB CLI runtime (`server.ts:2845-2871`) |
| OpenCode | `bb tools opencode [--json]` | BB CLI user | Report model/provider state and drift | BB CLI runtime (`server.ts:2872-2898`) |
| OpenCode | `bb tools opencode-sync [--from <host>] [--to <host>] [--dry-run] [--json]` | BB CLI user | Copy full provider/model/enabled state from source to other host(s) | BB CLI runtime (`server.ts:2899-2917`) |
| OpenCode | `bb tools opencode-clean [--host <id>] [--dry-run] [--json]` | BB CLI user | Remove known stale providers | BB CLI runtime (`server.ts:2918-2925`) |
| OpenCode | `bb tools opencode-set-default <modelId>` | BB CLI user | Set BB and host OpenCode default model | BB CLI runtime (`server.ts:2926-2954`) |

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
