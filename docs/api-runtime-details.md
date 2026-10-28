---
title: Plugin and hub runtime function details
type: component
created: 2026-10-28
updated: 2026-10-28
status: active
confidence: high
tags: [runtime, rpc, skills, initialization]
sources:
  - server.ts
  - skills-hub-service.ts
  - skills-page.tsx
  - settings-page.tsx
  - hub-skills.ts
  - contract.ts
  - classifier.ts
---
# Plugin and hub runtime function details
This page traces plugin initialization, hub RPC setup, UI requests, and hub file operations to their success and failure branches.

Detailed RPC and page overview: [Plugin RPC and Skills page runtime](api-runtime.md).

## `plugin`

### How it works

1. Read `lang` from BB KV; keep `ru` or `en`, otherwise choose English, then set the shared language (`server.ts:484-490`).
2. Define MetaMCP and skill-classifier settings. `readConfig` calls `settings.get()` on demand; the legacy machine-canon options are constants rather than settings (`server.ts:492-548`).
3. Create the host RPC client and skills-hub service with a live settings reader and a saver using `settings.experimental_set` (`server.ts:545-561`). Blank provider uses `claude-code`; blank model is omitted when spawning a thread so BB selects its default (`server.ts:550-561`, `skills-hub-service.ts:350-365`).
4. Register agent configuration. A thread carrying classifier role metadata gets the category tools and instructions; other threads receive the `agent-tools` skill (`server.ts:564-568`, `skills-hub-service.ts:435-442`).
5. Define catalogue readers and state defaults, then register the RPC contract with hub handlers and main handlers (`server.ts:571-589`, `server.ts:2088-2115`).

| Condition | Outcome | Failure |
|---|---|---|
| KV language is `ru` or `en` | Use that language before declaring labels (`server.ts:488-490`). | The awaited KV read has no local catch and rejects initialization. |
| KV language is absent or unsupported | Use English (`server.ts:488-490`). | No language fallback error is returned. |
| Classifier metadata matches | Supply classifier tools/instructions and no plugin skill; otherwise supply the plugin skill (`server.ts:564-568`). | A classifier setup failure is not caught by this callback. |
| Initial service recovery or machine refresh fails | Log a warning; service initialization continues (`skills-hub-service.ts:390-398`, `skills-hub-service.ts:612-615`). | Settings reads made later by the service can reject the requesting RPC. |

The plugin entry has no catch around language read, settings definition, host-client creation, or classifier-agent configuration (`server.ts:484-568`).

## `rpcContract`

### How it works

1. Build a `defineRpcContract` object by spreading the skills-hub schema and adding catalogue, scan, sync, purge, probe, OpenCode, gateway and language methods (`server.ts:219-455`).
2. Each method specifies a Zod input and output. Nullable host IDs represent all-host selection; `purge` supplies defaults for gateway inclusion and dry run; bounded lists constrain bulk requests (`server.ts:242-270`, `server.ts:273-455`).
3. Register the contract with a handler object that spreads `skillsHub.handlers` before defining the main plugin handlers (`server.ts:2088-2091`).
4. Handlers either return refreshed overview state, return operation counts/results, or throw when an operation cannot proceed (`server.ts:2092-2150`, `server.ts:2613-2645`).

| Request branch | Result or failure |
|---|---|
| Input fails its schema | Contract validation rejects before dispatch (`server.ts:219-455`). |
| Handler returns partial failures | The RPC returns its bounded error list and counts (`server.ts:1640-1685`, `server.ts:1688-1729`). |
| Handler throws | The RPC call rejects; the UI action wrapper converts that rejection to a visible error (`skills-page.tsx:178-190`). |

## `createSkillsHubService`

### How it works

1. Resolve the hub root as `<experimental_dataDir>/skills` and initialize an in-memory list cache (`skills-hub-service.ts:263-281`).
2. Read category tree, assignments and review queue from KV, substituting a seed tree and empty arrays when keys are absent. Serialize read-modify-write updates with `storeLock` (`skills-hub-service.ts:283-310`).
3. Resolve classifier project from the configured project ID, else the personal project, else the first project. No listed project throws an error (`skills-hub-service.ts:316-324`). Build classifier adapters for hub skills, hidden thread creation and thread status (`skills-hub-service.ts:333-388`).
4. On startup, if stored classifier state says `running`, clear that flag and start a fresh run. Register model tools and begin an initial machine refresh if no machine snapshot exists (`skills-hub-service.ts:390-442`, `skills-hub-service.ts:612-615`).
5. Build hub views by reading hub files, KV stores, Git state, machine summaries and live config, then join category/review state to each listed skill (`skills-hub-service.ts:479-521`).
6. Return handlers for settings, hub reads, category edits, classification, publish/pull/remove, machine refresh/import/cleanup, and matching CLI commands (`skills-hub-service.ts:659-737`, `skills-hub-service.ts:836-915`).

| Condition | Result or failure |
|---|---|
| Cached list is younger than 15 seconds and no fresh read requested | Return cached skill summaries (`skills-hub-service.ts:272-281`). |
| Hub root is absent | View sets `available:false` and uses an empty skill list while still reading stores (`skills-hub-service.ts:479-488`). |
| No configured classifier project and no BB projects exist | Project selection throws; the classifier run records its failure state (`skills-hub-service.ts:316-324`, `classifier.ts:256-261`). |
| A host machine-count call rejects | Save a per-host error row and continue refreshing other hosts (`skills-hub-service.ts:444-475`). |
| KV update rejects | The current request rejects; `storeLock` recovers for the next update (`skills-hub-service.ts:292-309`). |

## `SkillsPage`

### How it works

1. Initialize view, filter, selection, dialog and busy state. `act` clears the prior error, runs one action, stores a returned view, displays thrown errors and always resets busy (`skills-page.tsx:155-190`).
2. Load `skills_hub` on mount. While classification is running, poll the same method every five seconds; polling errors are ignored (`skills-page.tsx:194-207`).
3. When a skill is selected, clear the old detail, request `skills_hub_detail`, and ignore the result if selection changed before it returned (`skills-page.tsx:209-229`).
4. Derive review/problem/unplaced counts, search by name or description, and choose all/review/problems/unplaced/section/subsection rows (`skills-page.tsx:231-282`).
5. Run classification, category edits, publish/pull/remove, machine refresh/import, or optional cleanup through RPC actions (`skills-page.tsx:340-428`, `skills-page.tsx:745-919`). Cleanup first requests a dry-run preview, then requires a confirmation action.

| UI state | Branch and outcome |
|---|---|
| No view yet | Show loading text; show the initial request error if loading failed (`skills-page.tsx:297-303`). |
| Hub unavailable | Show the expected hub root (`skills-page.tsx:305-311`). |
| Search active | Match name/description regardless of selected category; show the relevant empty state when no rows match (`skills-page.tsx:240-282`, `skills-page.tsx:554-561`). |
| Classifier running | Poll and disable manual classification (`skills-page.tsx:200-207`, `skills-page.tsx:347-361`). |
| Action rejects | Display the error and clear busy; polling rejection stays hidden (`skills-page.tsx:178-190`, `skills-page.tsx:200-207`). |
| Cleanup offered | Preview moved paths, request confirmation, then apply and refresh machine state (`skills-page.tsx:392-428`, `skills-page.tsx:858-919`). |

## `SettingsPage`

### How it works

1. Load `skills_settings`; on success store values, on rejection display its message (`settings-page.tsx:37-51`).
2. When provider is non-empty, request its models and show returned model options or a model-fetch error (`settings-page.tsx:53-65`).
3. Provider changes clear the selected model; model, project, auto-classification and cleanup-offer controls each send a partial settings patch (`settings-page.tsx:108-175`, `settings-page.tsx:180-199`).
4. Save through `skills_settings_set`; show saved/error state and always reset busy (`settings-page.tsx:67-79`, `settings-page.tsx:203-205`).

| Failure or branch | UI outcome |
|---|---|
| Initial settings call rejects | Keep settings null and show the error instead of controls (`settings-page.tsx:46-51`, `settings-page.tsx:84-86`). |
| Provider/model list is empty or model lookup rejects | Show loading state or model error beside the model selector (`settings-page.tsx:128-149`). |
| Save rejects | Keep current settings, display an alert, and clear busy (`settings-page.tsx:67-79`, `settings-page.tsx:91-97`). |
| Provider or project is no longer in the returned choice list | Preserve its current value as a selectable option (`settings-page.tsx:116-124`, `settings-page.tsx:159-165`). |

## `readHubSkill`

### How it works

1. Reject a name that fails the hub's safe-name pattern (`hub-skills.ts:53-55`, `hub-skills.ts:147-149`).
2. Stat `<root>/<name>`; return `null` if absent or not a directory (`hub-skills.ts:149-152`).
3. Describe metadata and validation problems, read `SKILL.md`, enumerate files while skipping junk and symlinks, and read Git history (`hub-skills.ts:80-93`, `hub-skills.ts:107-145`, `hub-skills.ts:152-162`).
4. Return nullable content capped at 200,000 characters with a truncation flag, at most 400 file records with a truncation flag, and history (`hub-skills.ts:45-46`, `hub-skills.ts:153-162`).

| Condition | Result or failure |
|---|---|
| Unsafe name or missing/non-directory root entry | Return `null` (`hub-skills.ts:147-152`). |
| `SKILL.md` is unreadable or missing | Return detail with `content:null`; summary metadata still comes from `describe` (`hub-skills.ts:57-59`, `hub-skills.ts:152-158`). |
| File traversal/read errors | Directory reads and text reads degrade to empty/nullable values; Git history errors return an empty history (`hub-skills.ts:57-59`, `hub-skills.ts:107-145`). |

## `publishArchive`

### How it works

1. Create a temporary directory, decode the base64 archive to a tar file, and extract while excluding recognized skill junk (`hub-skills.ts:276-290`).
2. Require exactly one visible top-level folder and a safe skill name. Describe its contents and reject blocking BB validation problems (`hub-skills.ts:290-302`).
3. For dry run, return validity and whether the destination exists without replacing it or committing (`hub-skills.ts:303-307`).
4. For a real publish, back up and remove an existing skill, install the staged folder by rename with copy fallback, then commit/push unless Git ignores that name (`hub-skills.ts:308-319`).
5. Return caught failures as `ok:false`; always remove the temporary directory (`hub-skills.ts:320-331`).

| Condition | Result or failure |
|---|---|
| Archive has zero or multiple top-level folders; name unsafe; BB validation blocks | Return structured rejection without replacing the destination (`hub-skills.ts:290-302`). |
| Dry run passes validation | Return `ok:true`, replacement status and problems; no hub/Git write (`hub-skills.ts:303-307`). |
| Backup, extraction, install, or commit throws | Return `ok:false` with a clipped error; temporary data is removed, but a destination already removed before a later error is not restored by this function (`hub-skills.ts:308-331`). |
| Git ignores the skill path | Install it but skip commit/push (`hub-skills.ts:316-319`). |

## `removeHubSkill`

### How it works

1. Return a structured error for an unsafe name or missing hub directory (`hub-skills.ts:348-352`).
2. Check whether Git ignores the name, make a dated backup, and remove the directory (`hub-skills.ts:352-354`).
3. Commit and push the removal unless ignored, then return the backup path and commit result (`hub-skills.ts:355-356`).

| Condition | Result or failure |
|---|---|
| Unsafe name or missing directory | `ok:false`; no directory removal (`hub-skills.ts:349-351`). |
| Backup/removal/Git check throws | The function does not catch it; the caller's RPC rejects (`hub-skills.ts:352-356`, `skills-hub-service.ts:712-716`). |
| Commit/push returns an error value | Return `ok:true` with the backup and commit result; the service exposes the nested commit error in its response (`hub-skills.ts:355-356`, `skills-hub-service.ts:712-716`). |

<!-- lane-pilot:backlinks -->
## Referenced by

- [Plugin RPC and Skills page runtime](api-runtime.md)
