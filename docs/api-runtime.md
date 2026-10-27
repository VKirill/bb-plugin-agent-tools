---
title: Plugin RPC and Skills page runtime
type: component
created: 2026-10-27
updated: 2026-10-27
status: active
confidence: medium
tags: [api, rpc, skills, runtime]
sources:
  - server.ts
  - skills-hub-service.ts
  - skills-page.tsx
  - contract.ts
  - hub-skills.ts
  - categories.ts
  - classifier.ts
---
# Plugin RPC and Skills page runtime
The plugin startup installs a validated RPC contract, and the Skills page uses the skills-hub methods to load, classify, organize, transfer, and inspect hub skills (`server.ts:484-565`, `server.ts:219-222`, `skills-page.tsx:140-210`).

## Purpose

This page describes the runtime branches behind plugin initialization, the two plugin RPC contracts, and `SkillsPage`. The general method and command inventory is in [API and commands](api.md); hub data meaning is in [Agent Tools data model](data-model.md#hub-skills-categories-and-classifier-state).

## Plugin initialization

### How it works

1. `plugin` reads the KV language and keeps it only when it is `ru` or `en`; otherwise it selects English, then sets the shared language before declaring labels (`server.ts:484-490`).
2. It defines plugin settings, including the skills classifier provider/model/project and Git remote. `readConfig` calls `settings.get()` when a consumer asks for configuration (`server.ts:492-556`).
3. It creates the host RPC client and `createSkillsHubService`. The service config callback trims provider/model values and substitutes their defaults when they are blank (`server.ts:557-565`).
4. It registers classifier-thread agent configuration: threads marked for the classifier receive its two tools and instructions; every other thread gets the `agent-tools` skill (`server.ts:566-572`).
5. It defines readers for catalogue, ignored names, auto-sync and probes. Missing arrays resolve to empty arrays and missing auto-sync resolves to false (`server.ts:574-583`). The RPC handler registration combines hub handlers with the main handlers (`server.ts:2092-2096`).

| Condition | Branch and outcome | Failure behavior |
|---|---|---|
| Stored language is supported | Apply `ru` or `en` before settings labels are declared (`server.ts:488-490`). | The KV read is awaited without a local catch; rejection fails initialization (`server.ts:488-490`). |
| Stored language absent or unsupported | Select English (`server.ts:488-490`). | No fallback error is returned. |
| Classifier provider/model setting is blank | Service config substitutes `claude-code` and `claude-haiku-5-5`; project ID stays as configured for project selection (`server.ts:558-565`). | Settings read or service setup rejection propagates from initialization (`server.ts:557-565`). |
| A thread carries classifier role metadata | Configure classifier tools/instructions and suppress the plugin skill for that thread (`server.ts:566-572`). | Other threads do not enter the classifier branch. |

### Outcomes and failures

The plugin entry has no local recovery wrapper around language read, settings definition, client construction, or hub-service construction, so errors in those awaited setup operations reject initialization (`server.ts:488-565`). Optional machine feature scans are separate: scan orchestration logs their failures and continues without replacing stored records (`server.ts:628-648`).

## `rpcContract`

### How it works

1. `rpcContract` is built with `defineRpcContract`, spreads `skillsRpcContract`, then adds overview, catalogue, schedule, probe, legacy skills rollout, OpenCode, gateway, and language methods (`server.ts:219-448`).
2. Each entry binds a method name to a Zod input and output. Nullable inputs represent optional selection; defaults on `purge`, `sync`, `skills_fanout`, and other methods are encoded in the schema (`server.ts:242-270`, `server.ts:343-380`).
3. `bb.rpc.register` receives the contract and a handler object. Hub methods come from `skillsHub.handlers`; main handlers read/write state, call hosts, and return refreshed overview data (`server.ts:2092-2125`).
4. `overview` reads the composed view. Mutating methods generally publish the new overview after state changes; specific methods instead return counted outcomes or errors (`server.ts:2095-2125`, `server.ts:2130-2160`).

| Branch | Input condition | Outcome or failure |
|---|---|---|
| Invalid method input | Value does not satisfy the declared input schema. | Contract validation rejects the call before its handler (`server.ts:219-448`). |
| Catalogue ignore/unignore | One or more names; each list has 1–100 strings. | Add/remove names from the `ignored` KV set, then return the published overview (`server.ts:230-231`, `server.ts:2104-2114`). |
| Language update | `lang` is `ru` or `en`. | Store the value, update the in-process language, publish overview; other values fail schema validation (`server.ts:339-342`, `server.ts:2201-2205`). |
| Skill adoption | One operation, or up to 200 bulk operations with an explicit host, location and mode. | Single host failure throws; bulk returns changed/failed counts and error strings with overview (`server.ts:308-335`, `server.ts:2122-2160`). |
| Sync and purge | Optional host plus `dryRun`; sync also carries `includeDifferent`. | Return operation counts, bounded errors, and overview; host errors are included in results by the handlers (`server.ts:242-270`, `server.ts:2224-2265`). |

### Outcomes and failures

An invalid input is a contract rejection. Handler errors can reject the RPC when uncaught; batch operations with explicit error arrays return partial results instead (`server.ts:219-448`, `server.ts:2122-2160`).

## `skillsRpcContract`

### How it works

1. `skillsRpcContract` declares the skills hub methods, their input limits, nullability and output shapes (`skills-hub-service.ts:139-183`).
2. `createSkillsHubService` returns handlers that are registered into the main plugin RPC contract (`skills-hub-service.ts:524-579`, `server.ts:2092-2096`).
3. Read methods assemble a hub view, read one skill detail or return one contained text file. Mutations use serialized category-store writes, file/Git operations, or host RPC as appropriate (`skills-hub-service.ts:229-256`, `skills-hub-service.ts:524-579`).
4. The UI action wrapper replaces hub state when a handler returns it; thrown calls display an error and clear the busy flag (`skills-page.tsx:163-177`).

| Method group | Branch and state change | Result and failure |
|---|---|---|
| `skills_hub`, `skills_hub_detail`, `skills_hub_file` | Read current view, validated skill detail, or one contained file (`skills-hub-service.ts:413-451`, `skills-hub-service.ts:524-533`). | Detail returns null for unsafe/missing directories; file reader returns nullable text. Filesystem/storage exceptions reject (`hub-skills.ts:147-163`, `hub-skills.ts:166-174`). |
| `skills_move`, `skills_review_accept`, category create/rename/remove | Serialize a store read-modify-write. Move requires an existing path; review acceptance requires a complete proposal; removal requires an unassigned category (`skills-hub-service.ts:458-492`, `skills-hub-service.ts:542-552`, `categories.ts:241-250`). | Returns refreshed view; invalid paths/proposals or occupied category removal reject (`skills-hub-service.ts:458-492`, `skills-hub-service.ts:550-552`). |
| `skills_classify` | Kick background classifier and immediately read view (`skills-hub-service.ts:454-456`, `skills-hub-service.ts:554-557`). | View reports running/error state. Classification failures are persisted in classifier state (`classifier.ts:256-261`). |
| `skills_publish` | Call host `skill_pack`; then validate and publish its archive. Dry run stops before hub writes; successful publish invalidates listing cache and starts classification (`skills-hub-service.ts:495-509`, `hub-skills.ts:276-334`). | Pack/validation failures return structured `ok:false`; filesystem, backup, and Git errors can reject or appear in nested commit results (`skills-hub-service.ts:502-509`, `hub-skills.ts:298-332`). |
| `skills_remove` | Back up and remove the hub directory, invalidate cache, and assemble a fresh view (`skills-hub-service.ts:558-562`, `hub-skills.ts:348-357`). | Invalid/missing name returns structured failure; filesystem or Git exceptions reject (`hub-skills.ts:348-357`). |
| `skills_pull` | Pack hub skill then send `skill_unpack` to selected host (`skills-hub-service.ts:511-522`). | Caught failures return `{ok:false,path:null,error}` (`skills-hub-service.ts:511-522`). |
| Machine refresh/cleanup | Refresh calls each host and saves success or error rows; cleanup passes `dryRun` to one host and refreshes machine counts only after a real cleanup (`skills-hub-service.ts:390-410`, `skills-hub-service.ts:566-578`). | Per-host refresh failures are retained in the stored summary; cleanup host-call failure rejects (`skills-hub-service.ts:390-410`, `skills-hub-service.ts:570-578`). |

## `SkillsPage`

### How it works

1. The page initializes local view, error, selection, filters, detail, dialog, and busy state. Its `act` wrapper clears prior errors, runs an RPC, stores returned hub state, catches rejected calls into the visible error state, and always clears busy (`skills-page.tsx:140-177`).
2. On mount it calls `skills_hub`. A null view displays loading text or the initial load error; an unavailable hub displays its configured root (`skills-page.tsx:179-183`, `skills-page.tsx:293-307`).
3. While classifier state says `running`, it polls `skills_hub` every five seconds; polling failures are ignored. Selecting a skill clears stale detail, loads `skills_hub_detail`, and ignores late responses after selection changes (`skills-page.tsx:185-210`).
4. It derives counts for review items, blocking problems, unplaced skills, category counts and machine homes containing leftovers. Search matches name or description and takes priority over the selected category node (`skills-page.tsx:212-229`, `skills-page.tsx:240-261`).
5. It filters the list by all, review, problems, unplaced, section or subsection; it renders category navigation, skill rows, counts and empty-state text (`skills-page.tsx:240-282`, `skills-page.tsx:417-578`).
6. Selecting a row opens its detail card, which shows skill content, validation findings, files and history. The card can move a skill, accept a review proposal, request a host pull, or remove the hub skill (`skills-page.tsx:580-714`).
7. Category dialogs create, rename and remove category paths. Machine cleanup first requests a `dryRun` preview, then presents the moved paths before explicit confirmation (`skills-page.tsx:381-415`, `skills-page.tsx:732-906`).
8. Classification can be started manually while no action is busy and no classifier run is active; machine refresh uses its own busy action (`skills-page.tsx:343-359`).

| UI mode | Branch | Outcome or failure |
|---|---|---|
| Loading | Hub request has not produced a view. | Show loading text; after initial failure, show the captured error (`skills-page.tsx:293-299`). |
| Hub unavailable | `hub.available` is false. | Show the missing hub directory and its expected root (`skills-page.tsx:301-307`). |
| List filtering | Query non-empty, otherwise selected node chooses all/review/problems/unplaced/section/subsection. | Search ignores node selection and matches name/description; empty results show a matching empty state (`skills-page.tsx:240-282`, `skills-page.tsx:541-548`). |
| Classifier running | Hub classifier has `running:true`. | Poll every five seconds and disable manual classify until stopped (`skills-page.tsx:185-192`, `skills-page.tsx:343-350`). |
| Operation fails | Action wrapper catches rejection. | Show an alert; user can hide it; busy resets in `finally` (`skills-page.tsx:163-177`, `skills-page.tsx:362-369`). Polling errors have no visible alert (`skills-page.tsx:185-190`). |
| Machine cleanup | User previews a host with skill-home entries. | Preview result opens confirmation with moved paths; apply sends `dryRun:false` and refreshes host counts (`skills-page.tsx:381-415`, `skills-page.tsx:845-906`). |

### Public API

The page uses `skills_hub`, `skills_hub_detail`, `skills_hub_file`, category and assignment methods, classifier, publish/pull/remove, and machine refresh/cleanup. Input limits and payload definitions are owned by [API and commands](api.md#hub-skills-uiserver-rpc) (`skills-page.tsx:163-210`, `skills-hub-service.ts:139-183`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools API and commands](api.md)
