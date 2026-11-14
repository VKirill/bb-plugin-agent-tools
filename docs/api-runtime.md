---
title: Plugin RPC and Skills page runtime
type: component
created: 2026-10-27
updated: 2026-11-14
status: active
confidence: medium
tags: [api, rpc, skills, runtime]
sources:
  - server.ts
  - skills-hub-service.ts
  - hub-only.ts
  - required-session-policy.ts
  - skills-page.tsx
  - settings-page.tsx
  - contract.ts
  - hub-skills.ts
  - categories.ts
  - classifier.ts
---
# Plugin RPC and Skills page runtime
The plugin startup installs a validated RPC contract, and the Skills page uses the skills-hub methods to load, classify, organize, transfer, and inspect hub skills (`server.ts:479-627`, `server.ts:219-450`, `skills-page.tsx:155-225`).

## Purpose

This page describes the runtime branches behind plugin initialization, the two plugin RPC contracts, `SkillsPage`, and `SettingsPage`. The general method and command inventory is in [API and commands](api.md); hub data meaning is in [Agent Tools data model](data-model.md#hub-skills-categories-and-classifier-state).

## Plugin initialization

### How it works

1. `plugin` reads the KV language and keeps it only when it is `ru` or `en`; otherwise it selects English, then sets the shared language before declaring labels (`server.ts:477-484`).
2. It defines MetaMCP, classifier, experimental `skillsHubOnly`, and skill-suggest settings. `readConfig` calls `settings.get()` when its consumer requests configuration, and `readUiLangChoice` reads `"uiLang"` from KV defaulting to `"auto"` (`server.ts:485-586`).
3. It creates the host RPC client and `createSkillsHubService`, passing live settings readers and a saver that writes changed fields with `settings.experimental_set` (`server.ts:590-609`). A blank classifier provider falls back to `claude-code`; a blank model is passed through for BB's provider default (`server.ts:593-606`, `skills-hub-service.ts:392-409`).
4. It registers agent configuration: hidden classifier/card-writer threads receive their registered tools and instructions with no skills, while every other thread gets public suggest tools (when enabled) and the `agent-tools` skill (`server.ts:612-616`, `skills-hub-service.ts:894-925`).
5. It defines readers for catalogue, ignored names, auto-sync and probes. Missing stored arrays resolve to empty arrays and missing auto-sync resolves to false (`server.ts:619-627`). The RPC handler registration combines hub handlers with the main handlers (`server.ts:2043-2045`).

| Condition | Branch and outcome | Failure behavior |
|---|---|---|
| Stored CLI language is supported | Apply `ru` or `en` before settings labels are declared (`server.ts:481-484`). | The KV read is awaited without a local catch; rejection fails initialization (`server.ts:481-484`). |
| Stored CLI language absent or unsupported | Select English (`server.ts:481-484`). | No fallback error is returned. |
| Classifier provider setting is blank | The settings callback substitutes `claude-code`; blank model is kept blank so thread creation omits `model` and lets the provider choose its default (`server.ts:593-595`, `skills-hub-service.ts:398`). | A config-read failure rejects the settings-dependent service operation. |
| Hidden classifier or card-writer thread | `configureThread` supplies role tools/instructions and clears skills (`server.ts:612-616`, `skills-hub-service.ts:894-909`); `spawnHidden` adds `experimental_vkRequiredSessionPolicy` when advertised (`skills-hub-service.ts:404-408`, `required-session-policy.ts:73-103`). | Other threads do not enter the hidden role branch. |

### Outcomes and failures

The plugin entry has no local recovery wrapper around the initial language read, settings definition, or host-client construction (`server.ts:479-591`). The skills service starts background recovery, stamps `<root>/.agent-tools-canon` via `protectPaths()`, and ignores startup stamp errors (`skills-hub-service.ts:464-470`, `skills-hub-service.ts:1586-1588`). Optional machine feature scans log their failures and continue without replacing stored records (`server.ts:651-696`).

## `rpcContract`

### How it works

1. `rpcContract` is built with `defineRpcContract`, spreads `skillsRpcContract`, then adds overview, catalogue, schedule, probe, legacy skills rollout, OpenCode, gateway, `set_language`, and `ui_language_set` methods (`server.ts:219-450`).
2. Each entry binds a method name to a Zod input and output. Nullable inputs represent optional selection; defaults on `purge`, `sync`, `skills_fanout`, and other methods are encoded in the schema (`server.ts:242-270`, `server.ts:348-392`).
3. `bb.rpc.register` receives the contract and a handler object. Hub methods come from `skillsHub.handlers`; main handlers read/write state, call hosts, and return refreshed overview data (`server.ts:2043-2253`).
4. `overview` reads the composed view including `uiLang`. Mutating methods generally publish the new overview after state changes; specific methods instead return counted outcomes or `{ choice }` (`server.ts:1185-1201`, `server.ts:2043-2253`).

| Branch | Input condition | Outcome or failure |
|---|---|---|
| Invalid method input | Value does not satisfy the declared input schema. | Contract validation rejects the call before its handler (`server.ts:219-450`). |
| Catalogue ignore/unignore | One or more names; each list has 1–100 strings. | Add/remove names from the `ignored` KV set, then return the published overview (`server.ts:230-231`, `server.ts:2054-2065`). |
| Language updates | `set_language` (`ru|en`) or `ui_language_set` (`auto|ru|en`). | Store KV `"lang"` or `"uiLang"`, publish overview, and return overview or `{ choice }`; invalid values fail schema validation (`server.ts:339-347`, `server.ts:2151-2162`). |
| Skill adoption | One operation, or up to 200 bulk operations with an explicit host, location and mode. | Single host failure throws; bulk returns changed/failed counts and error strings with overview (`server.ts:308-338`, `server.ts:2111-2150`). |
| Sync and purge | Optional host plus `dryRun`; sync also carries `includeDifferent`. | Return operation counts, bounded errors, and overview; host errors are included in results by the handlers (`server.ts:242-270`, `server.ts:2082-2098`). |

### Outcomes and failures

An invalid input is a contract rejection. Handler errors can reject the RPC when uncaught; batch operations with explicit error arrays return partial results instead (`server.ts:219-450`, `server.ts:2119-2150`).

## `skillsRpcContract`

### How it works

1. `skillsRpcContract` declares the skills hub methods, their input limits, nullability and output shapes (`skills-hub-service.ts:197-268`).
2. `createSkillsHubService` (`skills-hub-service.ts:322`) returns `handlers` (`skills-hub-service.ts:1244-1326`), which `bb.rpc.register` spreads via `skillsHub.handlers` into the main plugin RPC contract (`server.ts:2043-2045`).
3. Read methods assemble a hub view, read one skill detail or return one contained text file. Mutations use serialized category-store writes, file/Git operations, `enforceHubOnlyMode`, or host RPC as appropriate (`skills-hub-service.ts:342-369`, `skills-hub-service.ts:1006-1326`).
4. The UI action wrapper replaces hub state when a handler returns it; thrown calls display an error and clear the busy flag (`skills-page.tsx:163-190`).

| Method group | Branch and state change | Result and failure |
|---|---|---|
| `skills_hub`, `skills_hub_detail`, `skills_hub_file` | Read current view (filtering `notOnHub` via `machineNotOnHub` and setting `offerCleanup: config.hubOnly`), validated skill detail, or one contained file (`skills-hub-service.ts:1044-1086`, `skills-hub-service.ts:1268-1276`). | Detail returns null for unsafe/missing directories; file reader returns nullable text. Filesystem/storage exceptions reject (`hub-skills.ts:147-174`). |
| `skills_move`, `skills_review_accept`, category create/rename/remove | Serialize a store read-modify-write. Move requires an existing path; review acceptance requires a complete proposal; removal requires an unassigned category (`skills-hub-service.ts:1096-1131`, `categories.ts:242-251`). | Returns refreshed view; invalid paths/proposals or occupied category removal reject (`skills-hub-service.ts:1277-1296`). |
| `skills_classify` | Kick background classifier and immediately read view (`skills-hub-service.ts:1088-1091`, `skills-hub-service.ts:1297-1300`). | View reports running/error state. Classification failures are persisted in classifier state (`classifier.ts:256-261`). |
| `skills_publish` | Call host `skill_pack`; then validate and publish its archive. Dry run stops before hub writes; successful publish invalidates listing cache and starts classification (`skills-hub-service.ts:1133-1147`, `hub-skills.ts:276-334`). | Pack/validation failures return structured `ok:false`; filesystem, backup, and Git errors can reject or appear in nested commit results (`skills-hub-service.ts:1133-1147`, `hub-skills.ts:298-332`). |
| `skills_remove` | Back up and remove the hub directory, invalidate cache, and assemble a fresh view (`skills-hub-service.ts:1301-1305`, `hub-skills.ts:348-357`). | Invalid/missing name returns structured failure; filesystem or Git exceptions reject (`hub-skills.ts:348-357`). |
| `skills_pull` | Pack hub skill then send `skill_unpack` to selected host (`skills-hub-service.ts:1149-1161`). | Caught failures return `{ok:false,path:null,error}` (`skills-hub-service.ts:1149-1161`). |
| Machine refresh/import/cleanup | Refresh passes `protectPaths()` and saves success or error rows; import checks `loadableHubNames(hub)`; cleanup passes `protectPaths()` and `dryRun` to one host (`skills-hub-service.ts:955-1000`, `skills-hub-service.ts:1163-1179`, `skills-hub-service.ts:1309-1325`). | Per-host refresh failures are retained in stored summary; cleanup host-call failure rejects (`skills-hub-service.ts:962-1000`, `skills-hub-service.ts:1317-1325`). |
| `skills_settings`, `skills_settings_set` | Reads `uiLang`, classifier settings, `hubOnly`, `hubOnlyLast`, and choices; setting `hubOnly: true` immediately kicks `enforceHubOnlyMode()` (`skills-hub-service.ts:1186-1266`). | Persisted summary saved to `skillHubOnlyLast`; provider/model change resets classifier `threadId` (`skills-hub-service.ts:1013-1041`, `skills-hub-service.ts:1260-1264`). |

## `SkillsPage`

### How it works

1. The page initializes local view, error, selection, filters, detail, dialog, and busy state. Its `act` wrapper clears prior errors, runs an RPC, stores returned hub state, catches rejected calls into the visible error state, and always clears busy (`skills-page.tsx:155-195`).
2. On mount it calls `skills_hub`. A null view displays loading text or the initial load error; an unavailable hub displays its configured root (`skills-page.tsx:194-200`, `skills-page.tsx:310-325`).
3. While classifier state says `running`, it polls `skills_hub` every five seconds; polling failures are ignored. Selecting a skill clears stale detail, loads `skills_hub_detail`, and ignores late responses after selection changes (`skills-page.tsx:201-235`).
4. It derives counts for review items, blocking problems, unplaced skills, category counts and machine homes containing leftovers (gated by `offerCleanup = hub.offerCleanup`). Search matches name or description and takes priority over the selected category node (`skills-page.tsx:236-285`).
5. It filters the list by all, review, problems, unplaced, section or subsection; it renders category navigation, skill rows, counts and empty-state text (`skills-page.tsx:240-310`, `skills-page.tsx:415-610`).
6. Selecting a row opens its detail card, which shows skill content, validation findings, files and history. The card can move a skill, accept a review proposal, request a host pull, or remove the hub skill (`skills-page.tsx:610-810`).
7. Category dialogs create, rename and remove category paths. Machine cleanup first requests a `dryRun` preview, then presents the moved paths before explicit confirmation (`skills-page.tsx:419-475`, `skills-page.tsx:760-935`).
8. Classification can be started manually while no action is busy and no classifier run is active; machine refresh uses its own busy action (`skills-page.tsx:360-385`).

| UI mode | Branch | Outcome or failure |
|---|---|---|
| Loading | Hub request has not produced a view. | Show loading text; after initial failure, show the captured error (`skills-page.tsx:310-325`). |
| Hub unavailable | `hub.available` is false. | Show the missing hub directory and its expected root (`skills-page.tsx:315-328`). |
| List filtering | Query non-empty, otherwise selected node chooses all/review/problems/unplaced/section/subsection. | Search ignores node selection and matches name/description; empty results show a matching empty state (`skills-page.tsx:250-305`, `skills-page.tsx:565-580`). |
| Classifier running | Hub classifier has `running:true`. | Poll every five seconds and disable manual classify until stopped (`skills-page.tsx:201-208`, `skills-page.tsx:360-380`). |
| Operation fails | Action wrapper catches rejection. | Show an alert; user can hide it; busy resets in `finally` (`skills-page.tsx:163-190`, `skills-page.tsx:385-395`). Polling errors have no visible alert (`skills-page.tsx:201-207`). |
| Machine cleanup | User previews a host with skill-home entries (visible when `hubOnly` / `offerCleanup` is enabled). | Preview result opens confirmation with moved paths; apply sends `dryRun:false` and refreshes host counts (`skills-page.tsx:240-244`, `skills-page.tsx:419-475`). |

### Public API

The page uses `skills_hub`, `skills_hub_detail`, `skills_hub_file`, category and assignment methods, classifier, publish/pull/remove, and machine refresh/import/cleanup. Input limits and payload definitions are owned by [API and commands](api.md#hub-skills-uiserver-rpc) (`skills-page.tsx:163-225`, `skills-hub-service.ts:197-268`).

## `SettingsPage`

`SettingsPage` loads page language (`uiLang`), classifier settings, `hubOnly`, and `hubOnlyLast` with `skills_settings`, requests model choices when the provider changes, saves `uiLang` via `ui_language_set` (immediately updating `setUiLangChoice` + `applyUiLang`), and saves classifier/hub-only edits through `skills_settings_set` (`settings-page.tsx:47-162`, `settings-page.tsx:243-289`). Provider/project failures become empty lists, while model-fetch errors appear beside the model selector (`skills-hub-service.ts:1186-1243`). Save failures remain on the page, and the busy indicator is cleared after either result (`settings-page.tsx:78-115`).

The page's RPC methods and input bounds are listed in [Hub skills UI/server RPC](api.md#hub-skills-uiserver-rpc) (`skills-hub-service.ts:197-268`). Detailed function paths for initialization, the hub service, the Skills page, RPC registration, settings, and hub file operations are in [Runtime function details](api-runtime-details.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Plugin and hub runtime function details](api-runtime-details.md)
- [Agent Tools API and commands](api.md)
