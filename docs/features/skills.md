---
title: Agent skill canon and rollout
type: component
created: 2026-09-27
updated: 2026-10-28
status: deprecated
confidence: medium
tags: [skills, canon, fanout]
sources:
  - skills.ts
  - host.ts
  - server.ts
  - contract.ts
  - i18n.ts
  - i18n.en.ts
  - app.tsx
  - skills-sync.ts
  - skills-server.ts
  - skill-tree.ts
  - skills-hub-service.ts
  - hub-skills.ts
  - classifier.ts
  - categories.ts
  - skills-page.tsx
  - skill-meta.ts
  - host-skills.ts
---
# Agent skill canon and rollout
This page describes the deprecated per-machine canon scanner and fan-out retained for old RPC clients. Current skill management uses the BB server hub; machine skills are imported by copy, and cleanup is an explicit operation. The old machine-canon settings are no longer read: retained code fixes scheduled fan-out off, plugin-name inclusion on, and the Git remote empty (`server.ts:546-548`). See [Hub skills and categories](skills-hub.md) (`server.ts:2730-2739`, `skills-hub-service.ts:593-609`, `skills-hub-service.ts:728-735`).

The legacy machine rollout compares skill folders on each machine against `~/.agents/skills`, then plans promotions, Git synchronization, CLI-home links or mirrors, and snapshots (`host.ts:374-435`, `server.ts:1528-1559`).

## Purpose

The active skills library stores skill files under the BB server data directory. The older machine scanner compares CLI homes with `~/.agents/skills`; its former CLI commands now return a migration message, while retained RPC handlers still expose the old operations (`hub-skills.ts:8-12`, `host.ts:374-435`, `server.ts:2730-2739`, `server.ts:2203-2219`). Hub publishing, category placement, machine import, cleanup settings and restart recovery are documented in [Hub skills and categories](skills-hub.md).

## Legacy machine canon and rollout

### How it works

1. A machine host scans the canon and known homes, ignores hidden names, fingerprints skill folders, and also detects names already supplied by marketplace plugins (`host.ts:374-435`).
2. The server stores the scan by host and derives out-of-canon rows and a cross-machine canon matrix (`server.ts:613-623`, `server.ts:868-900`).
3. `resolveRowAction` returns an automatic action when a state and location policy determine one; equal-date divergences and manual BB registry cases remain unresolved (`skills.ts:138-178`).
4. An explicit adopt/link/take/delete/unlink action runs on the selected host; the host checks location policy, `SKILL.md`, existing canon content, and symlink conditions (`server.ts:2112-2119`, `host.ts:476-570`).
5. Fan-out first promotes the unique newest candidate into the local canon, then syncs the configured Git remote, then computes and applies home operations (`skills.ts:302-365`, `server.ts:1301-1346`, `server.ts:1528-1546`).
6. The same rollout includes a separate mirror plan for the BB server process's `experimental_dataDir/skills`; its rules and archive fallback are described under [BB server mirror planning](#bb-server-mirror-planning) (`server.ts:1351-1522`, `skills.ts:582-612`).
7. `planFanOut` returns `link`, `mirror`, `pull`, `drop`, or `retire` operations plus next history state; the host executor snapshots replacements, copies without dependency/cache artifacts, and blocks operations that would lose files (`skills.ts:409-525`, `host.ts:890-975`, `skill-tree.ts:12-29`). Planned BB mirrors that exceed the 10 MiB byte limit are returned as failed operations (`skills.ts:145-162`, `host.ts:972-975`).
8. The archive view lists backup metadata; restore snapshots the current canon version and copies the chosen snapshot into the canon (`host.ts:982-1061`, `server.ts:2163-2167`).

### Server initialization and settings

1. The `plugin` entry reads `lang` from BB KV; a saved `ru` or `en` value is applied, while an absent or invalid value selects English (`server.ts:484-490`).
2. It defines MetaMCP, classifier provider/model/project, automatic classification, and cleanup-offer settings. Machine-canon schedule, marketplace-name, and Git-remote settings have been removed (`server.ts:492-542`).
3. It creates the host RPC client and skills hub service, then defines KV readers for catalogue, ignored names, auto-sync and probes. Missing collections read as empty lists; missing `autoSync` reads as false (`server.ts:556-583`).

The initial language KV read, settings definition, and host-client construction have no local catch branch (`server.ts:484-490`, `server.ts:492-551`).

### Skill row classification

`computeSkillRows` builds a legacy row set from canon and scanned homes; it does not read the filesystem or write skill data (`skills.ts:226-288`). The current import path instead calls `listMachineSkills`, which resolves links, excludes owned roots and BB's own `bb-cli` skill, requires a file named `SKILL.md`, and retains the newest copy per name (`host-skills.ts:132-163`).

1. It indexes only canon entries with `SKILL.md`, retaining their hashes, mtimes and symlink targets. It also normalizes the canon path and finds the scanned BB home (`skills.ts:230-246`).
2. It skips the canon location and locations marked absent by the scan, then classifies each remaining entry by symlink/directory kind, home policy, target path, `SKILL.md` presence, and canon hash (`skills.ts:247-276`).
3. Entries selected for display become rows containing name, home id, state, hash, local mtime and canon mtime; rows sort by name then home id (`skills.ts:277-288`).

| Entry condition | Row outcome |
|---|---|
| Symlink in a `drop` home | `stray-link` |
| Symlink target under canon; target under BB skill registry | `linked`; `bb-registry`, respectively |
| External symlink with no canon entry and with `SKILL.md` | `only-here`; without `SKILL.md` it is omitted |
| External symlink with a canon entry | Omitted when hashes match; otherwise `linked-external` |
| Real folder without `SKILL.md` | Omitted |
| Real folder targeted by a canon symlink | `canonical-source` |
| Other real folder with no canon entry | `only-here` |
| Other real folder with a canon entry | `copy` when hashes match; otherwise `diverged` |

| Input case | Row outcome |
|---|---|
| Canon entry lacks `SKILL.md` | It is excluded from the canon lookup, so no row can match it by canonical hash (`skills.ts:235-240`). |
| Canon location | Skipped explicitly. A location with `exists: false` is skipped before its entries are visited (`skills.ts:247-250`). |
| Symlink in `drop` policy | `stray-link`; symlink to canon | `linked`; symlink into BB home | `bb-registry` (`skills.ts:252-258`). |
| External symlink without canon entry | `only-here` when `SKILL.md` exists; otherwise excluded (`skills.ts:259-262`). |
| External symlink matching canon hash | Excluded; differing hash | `linked-external` (`skills.ts:263-267`). |
| Real directory without `SKILL.md` | Excluded; directory targeted by canon symlink | `canonical-source` (`skills.ts:268-271`). |
| Other real directory | `only-here` with no canon entry; otherwise `copy` for equal hashes or `diverged` for different hashes (`skills.ts:272-276`). |

The function returns a sorted row array and has no error-result branch (`skills.ts:277-288`).

### Row action resolution

`resolveRowAction` is a pure decision function: it reads one row and its home policy, returns an action and label, or returns `null` when no deterministic suggestion applies (`skills.ts:174-214`). It follows this order:

1. An `own` location returns `null` before other states, except `stray-link`, which remains eligible for `unlink` (`skills.ts:175-179`).
2. `bb-registry` returns a manual `unlink`; `only-here` returns `adopt` (`skills.ts:180-185`).
3. `linked-external` returns `adopt` if canon has no mtime, `take` if the local mtime is newer, and otherwise no suggestion (`skills.ts:186-195`).
4. For `copy`, `link` policy returns `link`, and other policies return `delete` (`skills.ts:196-200`).
5. For `diverged`, newer local content returns `take`; newer canon returns `link` for `link` homes or `delete` otherwise; equal or missing mtimes return `null` (`skills.ts:201-213`).

| Row state / condition | Returned action |
|---|---|
| `stray-link` | `unlink`, including in a `drop` home (`skills.ts:175-179`) |
| `bb-registry` | Manual `unlink`, unless the home policy was `own` and returned earlier (`skills.ts:177-182`) |
| `only-here` | `adopt` into canon (`skills.ts:183-185`) |
| `linked-external` | No canon mtime: `adopt`; newer local mtime: `take`; otherwise `null` (`skills.ts:186-195`) |
| `copy` | `link` for link-policy homes, `delete` for other policies (`skills.ts:196-200`) |
| `diverged`, local mtime newer | `take` (`skills.ts:201-204`) |
| `diverged`, canon mtime newer | `link` for link-policy homes, otherwise `delete` (`skills.ts:205-209`) |
| Equal or missing mtimes for a divergence; unlisted state | No action (`null`) (`skills.ts:210-213`) |

The resolver proposes a mode and label; it does not inspect files or execute the action. Its failure outcome is `null`, not an exception or an error object. Host-side validation can still reject a returned mode (`skills.ts:174-214`, `host.ts:476-570`).

### Fan-out planning

`planFanOut` consumes one machine's canon, scanned homes, plugin names and prior mirror history, then returns planned operations, next history state, skipped plugin names and blocked BB copies; it performs no file writes (`skills.ts:411-417`, `skills.ts:448-456`, `skills.ts:555-572`).

1. For each canon skill it detects when canon already points to a real BB-home source and checks whether a marketplace plugin provides the name (`skills.ts:464-472`).
2. For an eligible BB home, a missing untracked mirror becomes `mirror`; a missing skill previously mirrored by Agent Tools becomes `retire`. For differing hashes, canon mtime greater than or equal to BB mtime yields `mirror`; otherwise it yields `pull`. Equal hashes with junk in a real BB directory yield a cleanup `mirror` (`skills.ts:475-499`).
3. For non-canon, non-BB homes, it considers only `link` policy and existing directory/parent paths. Marketplace-provided names are skipped; a missing entry becomes `link`; real copies and symlinks not pointing to canon are left unchanged (`skills.ts:503-520`).
4. For BB entries absent from canon, BB symlinks are skipped. A real directory previously mirrored by the plugin becomes `drop`; an untracked real directory becomes `pull` and is added as a candidate canon name (`skills.ts:524-534`).
5. For `link` homes, it plans `drop` for dangling links or links into canon when that skill is absent or retired. Links to external targets do not point to canon and receive no operation (`skills.ts:537-552`).
6. It forms the next set from current canon names plus pulled BB names, removes retired names, sorts entries, and records content hash and whether Agent Tools owns a real BB mirror. It returns these entries with operations, blocked items and plugin-skipped names (`skills.ts:555-572`).

The planner does not write files; oversized BB copies are returned in `blocked`. Filesystem failures happen in the host executor and become per-operation `ok:false` rows (`skills.ts:475-477`, `host.ts:908-975`).

### BB server mirror planning

`planServerBbMirror` plans only additions or replacements under the BB server process's `dataDir/skills`; it does not handle pulls or retirements (`skills.ts:575-612`). It ignores plugin-provided names when those names are passed in, canon symlinks, and destination symlinks. For regular canon folders, it blocks copies above 10 MiB, plans missing copies, plans a mirror when canon is at least as new, and plans a cleanup mirror when hashes match but the destination contains junk (`skills.ts:582-609`). The routine checks byte size only: although scans carry `bbFiles`, its callers pass `bytes` to `bbTreeProblem` without a file count (`contract.ts:99-105`, `skills.ts:151-162`, `skills.ts:582-595`).

`runServerBbSkills` uses the local canon and fills missing names from the most populated connected host canon. It runs Git sync first when a remote is configured and this is not a dry run, then scans canon and server destination and calls `planServerBbMirror` (`server.ts:1351-1443`). Local entries are copied directly; a host-only entry is packed with `skills_archive`, then extracted into `dataDir/skills`. A blocked plan or failed archive, extraction, or copy is returned in the rollout's per-operation failures (`server.ts:1445-1522`, `contract.ts:440-447`, `host.ts:1086-1115`, `skills-server.ts:130-146`).

Archive extraction modes and failure behavior are detailed in [BB server skill mirror archive](skills-server-mirror.md) (`skills-server.ts:130-146`, `server.ts:1478-1493`).

### Canon screen

`SkillCanon` renders a view of `data.skillCanon`; it does not call RPC methods or own scan errors (`app.tsx:590-625`). Skill state labels, hints, legend entries, and out-of-canon filters call `t()` during render, after BB’s document locale sets the selected language (`app.tsx:114-119`, `app.tsx:431-451`, `app.tsx:463-490`, `app.tsx:497-507`, `i18n.ts:31-39`, `i18n.en.ts:4-63`).

1. It derives counts for all rows, gaps, divergent states, plugin-provided entries and oversized rows (`app.tsx:591-603`).
2. It filters by the selected category and trimmed, case-insensitive skill-name query (`app.tsx:605-615`).
3. With zero total rows it shows that the canon is empty or machines have not been scanned. With rows but no visible matches it chooses an empty message by filter (`app.tsx:617-625`, `app.tsx:654-663`).
4. Otherwise it renders one host-state cell per row, plugin/size badges where relevant, and a homes cell. That cell shows the selected machine's homes or the intersection across all machines; an empty home intersection displays the localized “canon only” label, and non-empty home IDs are sorted and converted to paths (`app.tsx:665-724`).

| Filter | Includes rows when |
|---|---|
| `all` | No category condition applies. |
| `gaps` | At least one host reports `missing`. |
| `differs` | At least one host is `differs`, `newer`, or `stale`. |
| `plugin` | `fromPlugin` is true. |
| `heavy` | `tooHeavy` is true (`app.tsx:590-615`). |

This component has no local error branch: it renders the supplied overview and empty-state messages; request errors belong to its parent (`app.tsx:590-625`).

For each displayed row, the homes cell filters `row.hosts` to all entries when no host is selected or to entries whose `hostId` matches the selection. It maps those entries to home-id lists and intersects them; no selected-host rows produce an empty list. An empty home list displays the localized “canon only” label; otherwise sorted IDs are rendered as paths (`app.tsx:715-723`).

The matrix renders each host state as present/same, newer, stale, differs, or missing, and marks plugin-provided canon names with a badge (`app.tsx:671-694`). Archive dates use the selected language's `en-GB` or `ru-RU` locale, and known Russian snapshot reasons pass through `t()` before display (`app.tsx:737-741`, `app.tsx:822-826`, `i18n.en.ts:4-63`).

### Host adoption and replacement

`adoptSkill` validates the selected home and policy before changing files. It rejects unknown homes, the canon itself, BB's own-registry home, and absent skill paths (`host.ts:476-498`).

For symlinks, only `unlink`, `adopt`, and `take` have action paths. Unlink is allowed for `drop` homes or a link into BB's own registry; adopt/take resolves the target, requires `SKILL.md`, and copies the dereferenced target into canon. `take` archives an existing canon entry first. Other symlink modes fail as “already a symlink”; broken targets and duplicate adopt names return errors (`host.ts:499-531`).

For real folders, `unlink` is rejected, `SKILL.md` is required, and `delete` is rejected for a `link` home. `delete` removes the home folder; `take` archives an existing canon folder, moves the local folder into canon and recreates a symlink for `link` homes; `adopt` requires an unused canon name and moves the folder into canon. The link/replacement branch requires an existing canon entry, archives the local folder, then creates a canon symlink where the home policy requires it (`host.ts:533-570`).

The host returns `{ ok: false, error }` for validation failures. Filesystem errors from directory creation, copy, rename, removal, or symlink creation are not caught in this function (`host.ts:476-570`).

### Canon Git synchronization

The retained `syncSkillsCanon` routine has first-sync and existing-repository paths, collision recovery, local commit/reconciliation, and push outcomes. Its current legacy caller has an empty configured remote, so it returns before invoking Git; the full function flow and failure cases are documented in [Machine canon Git synchronization](skills-sync.md) (`server.ts:548`, `server.ts:1278-1293`, `skills-sync.ts:115-271`).

## Modes, policies, and states

| Home policy | Location | Behavior |
|---|---|---|
| Legacy canon | `~/.agents/skills` | Source used by retained machine-canon scan and RPC code; the current hub feature does not use it as its source of truth (`host.ts:376-378`, `skills-hub-service.ts:593-609`). |
| Link | `~/.claude/skills`, `~/.qwen/skills` | Missing entries are symlinked to canon; real copies can be replaced with links (`skills.ts:103-117`, `skills.ts:123-133`, `skills.ts:455-473`). |
| Native | `~/.codex/skills`, `~/.cursor/skills`, `~/.config/opencode/skills` | Their homes are not rewritten during fan-out (`skills.ts:103-117`, `skills.ts:123-133`, `skills.ts:455-473`). |
| Own | `~/.bb/skills` | Plugin does not rewrite BB's skill registry; fan-out mirrors real directories beside it (`skills.ts:103-117`, `skills.ts:123-133`, `skills.ts:418-451`). |
| Drop | `~/.gemini/config/skills` | Copies and links are removed during rule-based handling (`skills.ts:103-117`, `skills.ts:123-133`, `skills.ts:138-145`). |
| Manual action | `bb-registry`, equal-date divergence, protected external links | No automatic action is returned (`skills.ts:138-178`). |
| Fan-out operations | link, mirror, pull, drop, retire | Link to canon, copy canon to BB, pull a newer BB tree into canon, remove a home copy, or retire a skill deleted in BB (`skills.ts:346-356`, `skills.ts:409-525`). |
| BB mirror plan | Regular canon directories only | Separate process-directory mirror; see [BB server mirror planning](#bb-server-mirror-planning) (`skills.ts:582-612`). |

## Failures

- Unknown folders, missing skills, missing `SKILL.md`, attempts to manipulate the canon directly, or disallowed home policies return `ok: false` (`host.ts:476-570`).
- A replacement is blocked if the losing tree contains files absent from the winning tree (`host.ts:440-466`, `host.ts:929-945`).
- Fan-out errors are reported per operation; an absent home path fails only when the planned operation cannot find the corresponding scanned location (`host.ts:908-975`).
- Git sync reports missing Git, remote, or merge/push failures with `ok: false`; the orchestration excludes hosts whose sync failed from later fan-out (`skills-sync.ts:87-236`, `server.ts:1238-1295`, `server.ts:1528-1559`).
- A remote is required for `skills-sync`; without one, the server returns an error before starting sync (`server.ts:2169-2175`).

## Business rules

- Folder policy is centralized in `LOCATION_POLICY`; unknown locations default to `link` (`skills.ts:103-122`).
- A unique most-recent version can be promoted; if the top timestamp is shared by different hashes, no automatic promotion is planned (`skills.ts:267-330`).
- The fan-out planner does not retire a skill missing from BB unless prior state records that the plugin mirrored it (`skills.ts:418-451`, `skills.ts:507-524`).
- The retained `skills_fanout` RPC hard-codes plugin-name inclusion on, so its rollout passes `*` and does not skip marketplace-provided names. The former CLI workflow now returns a migration message, so its old `--all` option is not an available command (`server.ts:548`, `server.ts:1195-1204`, `server.ts:1233-1240`, `server.ts:2730-2739`).
- Skill copies and archives omit `node_modules`, `.git`, Python caches and virtual environments, JS build caches, `.DS_Store`, `.backup.json`, and `.pyc`, `.bak`, or `.tmp` files (`skill-tree.ts:12-29`, `host.ts:1096-1108`, `skills-server.ts:130-145`).
- The scan records BB-counted bytes, file count, and whether recognized junk is present. Legacy fan-out guards use the byte value; they do not pass the file count to `bbTreeProblem` (`contract.ts:99-105`, `skills.ts:151-162`, `skills.ts:475-477`, `skills.ts:594-597`).
- The current hourly schedule refreshes machine skill counts and starts the hub classifier when `skillsClassifierAuto` is enabled; it does not run machine fan-out (`server.ts:2302-2312`).
- Replaced/deleted trees are archived before removal; link-to-canon trees are not copied into backup (`host.ts:299-315`, `host.ts:935-957`).

## Public API or commands

The former machine-canon CLI commands return a migration message. The legacy `skills_fanout` RPC remains registered for older callers; the old skills schedule setter is a no-op. Current hub API and commands are listed in [Hub skills and categories](skills-hub.md) and [API and commands](../api.md) (`server.ts:2296-2299`, `server.ts:2730-2739`, `server.ts:2203-2219`).

## Gotchas

- The server's retained legacy `skills_sync` RPC cannot synchronize because its legacy remote is an empty constant (`server.ts:546-548`, `server.ts:2214-2219`).
- A project skill symlink is not replaced as part of promotion; its target contents may be copied to canon while the live link remains in place (`skills.ts:302-365`).
- The fan-out history file tracks whether a BB mirror was created; losing that record changes how later missing skills are interpreted (`host.ts:275-293`, `host.ts:966-975`, `skills.ts:458-487`, `skills.ts:524-530`).

See [decisions](../decisions.md), [data model](../data-model.md), and [gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools API and commands](../api.md)
- [Agent Tools data model](../data-model.md)
- [Agent Tools decisions](../decisions.md)
- [Hub skills and categories](skills-hub.md)
- [Machine canon Git synchronization](skills-sync.md)
- [Agent Tools gotchas](../gotchas.md)
- [Agent Tools overview](../overview.md)
