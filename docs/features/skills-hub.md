---
title: Hub skills and categories
type: component
created: 2026-10-27
updated: 2026-10-27
status: active
confidence: high
tags: [skills, hub, categories, classifier]
sources:
  - skills-hub-service.ts
  - hub-skills.ts
  - classifier.ts
  - categories.ts
  - skills-page.tsx
  - skill-meta.ts
---
# Hub skills and categories

The hub skills feature manages BB's session-wide skill library, organizes skills into a two-level category tree, and exposes the work through the Skills page and `bb tools` (`hub-skills.ts:8-12`, `skills-page.tsx:140-199`, `skills-hub-service.ts:732-742`).

## Purpose

The hub library is `<experimental_dataDir>/skills` in the BB server process. BB stages these skills into sessions; the plugin stores category assignments and classifier state separately in BB key-value storage (`hub-skills.ts:8-12`, `skills-hub-service.ts:201-208`, `skills-hub-service.ts:229-260`). The related per-machine canon scanner and fan-out are described in [Agent skill canon and rollout](skills.md).

## How it works

1. `SkillsPage` loads `skills_hub`, holds the hub view and error state, polls every five seconds while classification is running, and fetches detail when a skill is selected (`skills-page.tsx:140-210`).
2. `createSkillsHubService` sets the hub root from `bb.server.experimental_dataDir`, caches a skill listing for 15 seconds, reads the category tree, assignments, review queue and classifier state from KV, and exposes handlers (`skills-hub-service.ts:201-260`, `skills-hub-service.ts:413-451`, `skills-hub-service.ts:524-579`).
3. `listHubSkills` enumerates top-level directories and describes each folder; `readHubSkill` rejects unsafe names or missing directories, then returns metadata, a capped `SKILL.md`, file list, and Git history (`hub-skills.ts:80-105`, `hub-skills.ts:147-163`).
4. Classification first prunes assignments and review items for skills no longer on the hub, then places eligible family siblings, then queues remaining unplaced skills for the hidden model thread (`classifier.ts:223-253`).
5. `placeByFamily` repeatedly places a skill when its same-prefix siblings already agree on a still-existing subsection; it writes `source: "family"` and does not change the category tree (`classifier.ts:175-200`, `categories.ts:169-190`).
6. The model calls `agent_tools_skill_tree` and `agent_tools_skill_assign`. `applyModelAssign` rejects unknown or already assigned skill names, clamps confidence to 0..1, sends confidence below 0.6 to review, and otherwise validates/creates the two-level path and records a model assignment (`classifier.ts:76-88`, `classifier.ts:127-173`, `categories.ts:44-47`, `categories.ts:126-167`).
7. Publishing from a connected machine packs an archive via host RPC; `publishArchive` unpacks to a temporary directory, requires exactly one safe skill folder, rejects blocking BB validation problems, optionally returns a dry-run result, backs up a replaced skill, installs it, and commits/pushes unless Git ignores that name (`skills-hub-service.ts:495-509`, `hub-skills.ts:276-332`).
8. Removing a hub skill validates the name and existence, snapshots its folder, deletes it, and commits/pushes unless ignored (`hub-skills.ts:347-357`).
9. On service startup, a persisted `classifier.running` flag is reset and classification is kicked off again; errors in this recovery task are logged as warnings (`skills-hub-service.ts:335-343`).

| Branch | Input / condition | Result |
|---|---|---|
| Family placement | At least two assigned siblings share the first hyphen-delimited name segment and unanimously use one subsection; that subsection still exists (`classifier.ts:169-201`, `categories.ts:169-190`). | Assignment source is `family`; the loop repeats while it makes progress. |
| Model placement | Skill is present, has no prior assignment, confidence is at least 0.6, and category names pass validation (`classifier.ts:127-173`, `categories.ts:126-167`). | Assignment source is `model`; missing sections or subsections are created. |
| Manual review | Model confidence is below 0.6, or two model attempts end without an assignment (`classifier.ts:141-149`, `classifier.ts:285-300`). | Review record remains available for explicit acceptance. |
| Publish dry run | Archive passes validation and `dryRun` is true (`hub-skills.ts:276-307`). | Returns `ok: true` and replacement status without changing the hub or Git state. |
| Publish rejection | Archive extraction fails, contains other than one top-level folder, has an unsafe name, or has blocking BB problems (`hub-skills.ts:282-302`, `hub-skills.ts:320-331`). | Returns `ok: false`; temporary extraction directory is removed in `finally`. |
| Hub removal | Name is invalid or the directory is absent (`hub-skills.ts:348-352`). | Returns `ok: false` with an error and does not remove a directory. |
| Reload recovery | KV says classification was running when the service starts (`skills-hub-service.ts:335-343`). | Clears the flag, logs resumption, and starts a fresh classifier run from current hub/store state. |

### `placeByFamily`

1. `unplacedSkills` excludes names that already have assignments or review items; the family pass only considers the remaining input skill names (`classifier.ts:183-184`, `categories.ts:206-215`).
2. `inferByFamily` uses the first hyphen-delimited segment as the family key. A name without a hyphen has no family; otherwise it gathers already assigned siblings with the same key, excluding the name itself (`categories.ts:169-185`).
3. Fewer than two assigned siblings produces no inferred category. With enough siblings, every assignment must point to the same section and subsection; disagreement returns no match (`categories.ts:174-190`).
4. The caller also verifies that the inferred IDs still locate a path in the current tree. Missing paths are skipped; valid paths are upserted with source `family`, null confidence/reason and the caller's timestamp (`classifier.ts:184-194`).
5. A successful placement makes progress, so the pass repeats. Newly placed siblings can meet the quorum for another unplaced skill; the loop stops when a pass places nothing, then returns the updated assignment store and count (`classifier.ts:179-200`). The family pass does not create or mutate categories.

| Family case | Result |
|---|---|
| No hyphen in the name, fewer than two assigned siblings, or siblings disagree | Leave the skill unplaced for later model classification (`categories.ts:182-190`). |
| Siblings agree but their category path was removed | Leave the skill unplaced (`classifier.ts:184-185`). |
| At least two siblings agree on an existing path | Add a `family` assignment; repeat the scan until no more skills qualify (`classifier.ts:179-200`). |

### `createSkillsHubService`

1. It resolves the library root from `experimental_dataDir` and keeps an in-memory listing cache. A normal read reuses entries younger than 15 seconds; a fresh read bypasses the cache, and mutations invalidate it (`skills-hub-service.ts:201-227`).
2. It reads tree, assignments and review in parallel. Missing values become the seeded tree or empty arrays. Store mutations are chained through `storeLock` so overlapping UI and tool writes each read the prior result, then persist all three values (`skills-hub-service.ts:229-256`). Classifier state merges stored state with its empty defaults (`skills-hub-service.ts:258-260`).
3. It builds the classifier adapters: skills without `SKILL.md` are skipped; configuration selects provider/model and either a configured project or the first personal/available project; the thread is hidden and gets only the classifier role metadata and category tools (`skills-hub-service.ts:262-333`, `skills-hub-service.ts:279-310`, `skills-hub-service.ts:345-386`).
4. On startup, a persisted running flag is cleared and a new classifier run starts; recovery exceptions are logged (`skills-hub-service.ts:335-343`). It then registers the classifier tools and creates the hub handlers (`skills-hub-service.ts:345-378`, `skills-hub-service.ts:524-579`).
5. `refreshMachines` visits connected hosts in order, stores each count or a truncated per-host error, then persists the full result (`skills-hub-service.ts:390-410`). `view` checks whether the root exists, reads skills/store/Git/classifier/machine/config state concurrently, and joins valid assignments and review entries onto listed skills (`skills-hub-service.ts:413-451`).
6. Handlers return refreshed views after category edits, classification start, and machine refresh. Publish packs from a host, validates and installs the archive, invalidates cache and starts classification on successful real publish; pull catches pack/RPC errors into a failure object. Remove invalidates cache and returns the operation result with a fresh view; cleanup refreshes machine counts only when `dryRun` is false (`skills-hub-service.ts:495-522`, `skills-hub-service.ts:534-578`).

| Service branch | Condition | Result or failure |
|---|---|---|
| Hub directory absent | `stat(root)` fails. | View reports `available:false` and an empty skill listing while still assembling KV, Git, classifier and machine state (`skills-hub-service.ts:413-423`, `skills-hub-service.ts:426-451`). |
| Fresh cached listing | Cache age is below 15 seconds and caller did not request fresh data. | Reuse cached skill descriptions; filesystem edits outside service invalidation appear after expiry (`skills-hub-service.ts:201-227`). |
| Missing category values | Tree, assignments or review key is absent. | Seed default tree and use empty assignment/review arrays (`skills-hub-service.ts:229-235`). |
| No classifier project configured | Project ID setting is blank. | Choose a personal project, then the first listed project; throw when the list is empty (`skills-hub-service.ts:262-269`). |
| Host refresh failure | One `skill_homes_count` call rejects. | Store that host with empty homes and an error string clipped to 200 characters; continue through the remaining hosts (`skills-hub-service.ts:390-410`). |
| Category write fails | Store callback, KV read, or one of the three KV writes rejects. | Handler rejects; lock chain recovers for the next call (`skills-hub-service.ts:240-256`). |
| Host publish pack fails | Host returns `ok:false` or no archive. | Return a structured publish failure without calling `publishArchive` (`skills-hub-service.ts:495-505`). |
| Host pull fails | Hub packing or `skill_unpack` throws. | Return `{ok:false, path:null, error}` (`skills-hub-service.ts:511-522`). |

## Business rules

- The category tree has two levels; each section contains subsections, and labels are limited to 60 characters (`categories.ts:7-20`, `categories.ts:126-167`).
- Existing manual assignments cannot be replaced by an automatic family or model assignment (`categories.ts:22-33`, `categories.ts:193-204`).
- A model cannot assign a skill missing from the current hub set or change a skill that already has a category (`classifier.ts:134-140`).
- RPC field bounds and required `dryRun` inputs are owned by the [API reference](../api.md) (`skills-hub-service.ts:139-183`).
- Publishing replaces the destination only after the staged folder has no blocking BB validation problem; replacement snapshots live below `~/.agents/skills-backups` (`hub-skills.ts:298-319`, `hub-skills.ts:245-259`).
- Hub reads cap `SKILL.md` content at 200,000 characters and the file list at 400 entries; inaccessible or unsafe skill names produce `null` (`hub-skills.ts:45-46`, `hub-skills.ts:107-127`, `hub-skills.ts:147-163`).

## Failures

- The page shows a loading state until `skills_hub` resolves; the initial request error is displayed, while polling errors are ignored (`skills-page.tsx:163-183`, `skills-page.tsx:293-299`).
- A failed publish pack or archive validation returns a structured failure; after a successful non-dry-run publish, the listing cache is invalidated and classification is kicked (`skills-hub-service.ts:495-509`).
- Classifier errors are recorded in `lastError`, set `running` false, and update `lastRunAt`; startup-recovery errors are logged (`classifier.ts:256-261`, `skills-hub-service.ts:335-343`).
- A Git commit can succeed while push fails; the result retains `committed: true`, the commit SHA, and the push error (`hub-skills.ts:206-234`).
- Backup, removal, and Git checks in `removeHubSkill` are not wrapped in a catch; filesystem or Git process exceptions reject the call (`hub-skills.ts:348-357`).

## Gotchas

- A publish can return `ok: true` while its nested commit result reports a failed push; inspect `commit.pushed` and `commit.error` (`hub-skills.ts:316-319`, `hub-skills.ts:227-233`).
- The hub listing cache lasts 15 seconds. The service invalidates it after its publish and remove handlers, while changes made outside those handlers remain subject to the cache TTL (`skills-hub-service.ts:201-227`, `skills-hub-service.ts:524-565`).

## Public API

| Surface | Entry point | Purpose |
|---|---|---|
| UI | `SkillsPage` (`skills-page.tsx:140-210`) | Loads hub state, polls classification, and loads selected skill detail. |
| UI/server RPC | `skillsRpcContract` (`skills-hub-service.ts:139-184`) | Declares hub/detail/file reads; move, review, category, classify, remove, publish, pull, and machine refresh/cleanup operations. See [API and commands](../api.md#hub-skills-uiserver-rpc). |
| Service | `createSkillsHubService` (`skills-hub-service.ts:210-269`) | Builds hub/cache/KV access and the skills RPC/CLI handlers. |
| Hub read | `listHubSkills`, `readHubSkill`, `readHubSkillFile` (`hub-skills.ts:95-105`, `hub-skills.ts:147-174`) | List skill folders, read validated detail, or read one contained file. |
| Hub Git and transfer | `hubGitState`, `commitAndPush`, `packHubSkill` (`hub-skills.ts:179-234`, `hub-skills.ts:334-345`) | Read repository state, commit/push selected paths, or pack one skill. |
| Hub mutation | `publishArchive`, `removeHubSkill` (`hub-skills.ts:276-357`) | Validate and publish an archive, or back up and remove a skill. |
| Categorization | `placeByFamily`, `applyModelAssign` (`classifier.ts:127-200`) | Place agreed sibling skills or validate and store one model result. |
| CLI | `SKILLS_CLI_USAGE` (`skills-hub-service.ts:732-742`) | Lists hub, tree, publish, pull, move, classify, remove, machine status, and cleanup commands. |

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools API and commands](../api.md)
- [Agent Tools data model](../data-model.md)
- [Agent skill canon and rollout](skills.md)
- [Agent Tools overview](../overview.md)
