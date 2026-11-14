---
title: Plugin and hub runtime function details
type: component
created: 2026-10-28
updated: 2026-11-14
status: active
confidence: medium
tags: [runtime, rpc, skills, initialization]
sources:
  - server.ts
  - skills-hub-service.ts
  - hub-only.ts
  - required-session-policy.ts
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

1. Read `lang` from BB KV; keep `ru` or `en`, otherwise choose English, then set the shared language (`server.ts:479-484`).
2. Define MetaMCP, skill-classifier, experimental `skillsHubOnly`, and skill-suggest settings. `readConfig` calls `settings.get()` on demand, and `readUiLangChoice` reads `"uiLang"` from KV (`server.ts:485-589`).
3. Create the host RPC client and skills-hub service with a live settings reader and a saver using `settings.experimental_set` (`server.ts:590-609`). Blank provider uses `claude-code`; blank model is omitted when spawning a thread so BB selects its default (`server.ts:593-606`, `skills-hub-service.ts:392-409`).
4. Register agent configuration. A hidden thread carrying classifier or card-writer role metadata gets its role tools/instructions with no skills; other threads receive public tools (when enabled) and the `agent-tools` skill (`server.ts:612-616`, `skills-hub-service.ts:894-925`).
5. Define catalogue readers and state defaults, then register the RPC contract with hub handlers and main handlers (`server.ts:619-627`, `server.ts:2043-2253`).

| Condition | Outcome | Failure |
|---|---|---|
| KV language is `ru` or `en` | Use that language before declaring labels (`server.ts:481-484`). | The awaited KV read has no local catch and rejects initialization. |
| KV language is absent or unsupported | Use English (`server.ts:481-484`). | No language fallback error is returned. |
| Hidden thread role metadata matches | Supply role tools/instructions and no plugin skill, plus `requiredSessionPolicySpawnField` on spawn (`server.ts:612-616`, `skills-hub-service.ts:404-408`, `required-session-policy.ts:73-103`). | A setup failure propagates to the requesting operation. |
| Initial service recovery or startup canon stamp fails | Log recovery warning or swallow startup stamp rejection; initialization continues (`skills-hub-service.ts:464-470`, `skills-hub-service.ts:1586-1588`). | Settings reads made later by the service can reject the requesting RPC. |

The plugin entry has no catch around language read, settings definition, host-client creation, or agent configuration (`server.ts:479-616`).

## `rpcContract`

### How it works

1. Build a `defineRpcContract` object by spreading the skills-hub schema and adding catalogue, scan, sync, purge, probe, OpenCode, gateway, `set_language`, and `ui_language_set` methods (`server.ts:219-450`).
2. Each method specifies a Zod input and output. Nullable host IDs represent all-host selection; `purge` supplies defaults for gateway inclusion and dry run; bounded lists constrain bulk requests (`server.ts:242-270`, `server.ts:273-450`).
3. Register the contract with a handler object that spreads `skillsHub.handlers` before defining the main plugin handlers (`server.ts:2043-2253`).
4. Handlers either return refreshed overview state, return operation counts/results, return `{ choice }`, or throw when an operation cannot proceed (`server.ts:2043-2253`).

| Request branch | Result or failure |
|---|---|
| Input fails its schema | Contract validation rejects before dispatch (`server.ts:219-450`). |
| Handler returns partial failures | The RPC returns its bounded error list and counts (`server.ts:1594-1689`, `server.ts:2119-2150`). |
| Handler throws | The RPC call rejects; the UI action wrapper converts that rejection to a visible error (`skills-page.tsx:163-190`). |

## `createSkillsHubService`

### How it works

1. Resolve the hub root as `<experimental_dataDir>/skills` and initialize an in-memory list cache (`skills-hub-service.ts:328-340`).
2. Read category tree, assignments and review queue from KV, substituting a seed tree and empty arrays when keys are absent. Serialize read-modify-write updates with `storeLock` (`skills-hub-service.ts:342-369`).
3. Resolve classifier project from the configured project ID, else the personal project, else the first project. No listed project throws an error (`skills-hub-service.ts:375-383`). Build classifier and card-writer adapters using `spawnHidden` with `requiredSessionPolicySpawnField` (`skills-hub-service.ts:392-413`, `required-session-policy.ts:73-103`).
4. On startup, if stored classifier state says `running`, clear that flag and start a fresh run (`skills-hub-service.ts:464-470`). KV `"skillCanonToken"` (`KV.canonToken`, `skills-hub-service.ts:313`) supplies the token stamped into `<root>/.agent-tools-canon` (`CANON_MARKER`) and excluded in `.git/info/exclude` by `canonToken`, `stampCanon`, and `protectPaths` (`skills-hub-service.ts:927-959`, `skills-hub-service.ts:1586-1588`).
5. Build hub views by reading hub files, KV stores, Git state, machine summaries and live config, filtering `notOnHub` via `machineNotOnHub`, mapping `offerCleanup: config.hubOnly`, and joining category/review state (`skills-hub-service.ts:1044-1086`, `hub-only.ts:46-57`).
6. Return handlers for settings (including immediate `enforceHubOnlyMode()` when `hubOnly` is enabled), hub reads, category edits, classification, publish/pull/remove, machine refresh/import/cleanup, and matching CLI commands (`skills-hub-service.ts:1244-1589`).

| Condition | Result or failure |
|---|---|
| Cached list is younger than 15 seconds and no fresh read requested | Return cached skill summaries (`skills-hub-service.ts:331-340`). |
| Hub root is absent | View sets `available:false` and uses an empty skill list while still reading stores (`skills-hub-service.ts:1044-1086`). |
| No configured classifier project and no BB projects exist | Project selection throws; the classifier run records its failure state (`skills-hub-service.ts:375-383`, `classifier.ts:256-261`). |
| A host machine-count call rejects | Save a per-host error row and continue refreshing other hosts (`skills-hub-service.ts:962-1000`). |
| Hub-only encounters a blocking or transient error on a host | Mark that host skipped (`"BB не загружает: ..."` plus transient reasons) and keep machine folders untouched (`hub-only.ts:63-118`, `skills-hub-service.ts:1006-1041`). |
| KV update rejects | The current request rejects; `storeLock` recovers for the next update (`skills-hub-service.ts:353-369`). |

## `SkillsPage`

### How it works

1. Initialize view, filter, selection, dialog and busy state. `act` clears the prior error, runs one action, stores a returned view, displays thrown errors and always resets busy (`skills-page.tsx:155-195`).
2. Load `skills_hub` on mount. While classification is running, poll the same method every five seconds; polling errors are ignored (`skills-page.tsx:194-208`).
3. When a skill is selected, clear the old detail, request `skills_hub_detail`, and ignore the result if selection changed before it returned (`skills-page.tsx:209-235`).
4. Derive review/problem/unplaced counts, search by name or description, and choose all/review/problems/unplaced/section/subsection rows (`skills-page.tsx:236-305`).
5. Run classification, category edits, publish/pull/remove, machine refresh/import, or `offerCleanup`-gated cleanup through RPC actions (`skills-page.tsx:360-475`, `skills-page.tsx:760-935`). Cleanup first requests a dry-run preview, then requires confirmation.

| UI state | Branch and outcome |
|---|---|
| No view yet | Show loading text; show the initial request error if loading failed (`skills-page.tsx:310-325`). |
| Hub unavailable | Show the expected hub root (`skills-page.tsx:315-328`). |
| Search active | Match name/description regardless of selected category; show the relevant empty state when no rows match (`skills-page.tsx:250-305`, `skills-page.tsx:565-580`). |
| Classifier running | Poll and disable manual classification (`skills-page.tsx:201-208`, `skills-page.tsx:360-380`). |
| Action rejects | Display the error and clear busy; polling rejection stays hidden (`skills-page.tsx:163-190`, `skills-page.tsx:201-207`). |
| Cleanup offered (`offerCleanup` / `hubOnly`) | Preview moved paths, request confirmation, then apply and refresh machine state (`skills-page.tsx:240-244`, `skills-page.tsx:419-475`). |

## `SettingsPage`

### How it works

1. Load `skills_settings`; on success store `uiLang`, classifier fields, `hubOnly`, `hubOnlyLast`, and choices; on rejection display its message (`settings-page.tsx:47-65`).
2. When provider is non-empty, request its models and show returned model options or a model-fetch error (`settings-page.tsx:66-77`).
3. Language controls update `uiLang` via `ui_language_set`, calling `setUiLangChoice` and `applyUiLang`; provider changes clear the selected model; model, project, auto-classification, and `hubOnly` controls send partial patches to `skills_settings_set` (`settings-page.tsx:78-289`).
4. Show saved/error state, last `hubOnlyLast` summary (`imported`, `moved`, `rejected`, `skipped`), and always reset busy (`settings-page.tsx:78-115`, `settings-page.tsx:268-289`).

| Failure or branch | UI outcome |
|---|---|
| Initial settings call rejects | Keep settings null and show the error instead of controls (`settings-page.tsx:47-65`, `settings-page.tsx:116-125`). |
| Provider/model list is empty or model lookup rejects | Show loading state or model error beside the model selector (`settings-page.tsx:180-210`). |
| Save rejects | Keep current settings, display an alert, and clear busy (`settings-page.tsx:78-115`, `settings-page.tsx:120-128`). |
| Provider or project is no longer in the returned choice list | Preserve its current value as a selectable option (`settings-page.tsx:165-175`, `settings-page.tsx:212-222`). |

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
