---
title: Agent skill canon and rollout
type: component
created: 2026-09-27
updated: 2026-09-30
status: active
confidence: medium
tags: [skills, canon, fanout]
sources:
  - skills.ts
  - host.ts
  - server.ts
  - contract.ts
  - i18n.ts
  - app.tsx
  - skills-sync.ts
  - skills-server.ts
  - skill-tree.ts
---
# Agent skill canon and rollout
The skills feature compares skill folders on each machine against `~/.agents/skills`, then plans promotions, Git synchronization, CLI-home links or mirrors, and snapshots (`host.ts:374-435`, `server.ts:1538-1569`).

## Purpose

Each scanned skill entry includes its name, directory or symlink kind, resolved target, content hash, newest modification time, and whether `SKILL.md` exists (`contract.ts:74-106`). The shared planner assigns visible states and deterministic actions (`skills.ts:138-190`, `skills.ts:191-252`).

## How it works

1. A machine host scans the canon and known homes, ignores hidden names, fingerprints skill folders, and also detects names already supplied by marketplace plugins (`host.ts:374-435`).
2. The server stores the scan by host and derives out-of-canon rows and a cross-machine canon matrix (`server.ts:569-589`, `server.ts:834-900`).
3. `resolveRowAction` returns an automatic action when a state and location policy determine one; equal-date divergences and manual BB registry cases remain unresolved (`skills.ts:138-178`).
4. An explicit adopt/link/take/delete/unlink action runs on the selected host; the host checks location policy, `SKILL.md`, existing canon content, and symlink conditions (`server.ts:2122-2129`, `host.ts:476-570`).
5. Fan-out first promotes the unique newest candidate into the local canon, then syncs the configured Git remote, then computes and applies home operations (`skills.ts:302-365`, `server.ts:1311-1356`, `server.ts:1538-1556`).
6. The same rollout includes a separate mirror plan for the BB server process's `experimental_dataDir/skills`; its rules and archive fallback are described under [BB server mirror planning](#bb-server-mirror-planning) (`server.ts:1361-1532`, `skills.ts:582-612`).
7. `planFanOut` returns `link`, `mirror`, `pull`, `drop`, or `retire` operations plus next history state; the host executor snapshots replacements, copies without dependency/cache artifacts, and blocks operations that would lose files (`skills.ts:409-525`, `host.ts:890-975`, `skill-tree.ts:12-29`). Planned BB mirrors that exceed the 10 MiB byte limit are returned as failed operations (`skills.ts:145-162`, `host.ts:972-975`).
8. The archive view lists backup metadata; restore snapshots the current canon version and copies the chosen snapshot into the canon (`host.ts:982-1061`, `server.ts:2173-2177`).

### Server initialization and settings

1. The `plugin` entry reads the `lang` key from BB KV; a supported saved language is applied and an absent or invalid value selects Russian (`server.ts:479-485`).
2. It defines MetaMCP address/key/namespaces, scheduled skills fan-out, marketplace-name handling, and the canon Git remote. Defaults are empty URL/key, `secondary`, fan-out off, plugin names included, and no remote (`server.ts:487-529`).
3. It creates a host RPC client and exposes helpers for catalog, ignored names, auto-sync, and probe storage. Missing stored collections read as empty lists; missing `autoSync` reads as false (`server.ts:531-545`).

The initialization code here has no local catch around the initial KV read or host client creation (`server.ts:483-535`).

### Skill row classification

`computeSkillRows` builds a row set from canon and scanned homes; it does not read the filesystem or write skill data (`skills.ts:226-288`).

1. It indexes only canon entries with `SKILL.md`, retaining their hashes, mtimes and symlink targets. It also normalizes the canon path and finds the scanned BB home (`skills.ts:230-246`).
2. It skips the canon location and homes not present in the scan, then classifies every entry by symlink/directory kind, home policy, target path, `SKILL.md` presence, and canon hash (`skills.ts:247-276`).
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
| Home absent or it is the canon itself | Entries are not visited (`skills.ts:247-250`). |
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

`runServerBbSkills` uses the local canon and fills missing names from the most populated connected host canon. It runs Git sync first when a remote is configured and this is not a dry run, then scans canon and server destination and calls `planServerBbMirror` (`server.ts:1361-1453`). Local entries are copied directly; a host-only entry is packed with `skills_archive`, then extracted into `dataDir/skills`. A blocked plan or failed archive, extraction, or copy is returned in the rollout's per-operation failures (`server.ts:1455-1532`, `contract.ts:440-447`, `host.ts:1086-1115`, `skills-server.ts:120-145`).

### Canon screen

`SkillCanon` renders a view of `data.skillCanon`; it does not call RPC methods or own scan errors (`app.tsx:588-623`).

1. It derives counts for all rows, gaps, divergent states, plugin-provided entries and oversized rows (`app.tsx:591-601`).
2. It filters by the selected category and trimmed, case-insensitive skill-name query (`app.tsx:603-613`).
3. With zero total rows it shows that the canon is empty or machines have not been scanned. With rows but no visible matches it chooses an empty message by filter (`app.tsx:615-623`, `app.tsx:652-661`).
4. Otherwise it renders one host-state cell per row, plugin/size badges where relevant, and a homes cell. That cell shows the selected machine's homes or the intersection across all machines; an empty home intersection shows `только канон`, and non-empty home IDs are sorted and converted to paths (`app.tsx:663-721`).

| Filter | Includes rows when |
|---|---|
| `all` | No category condition applies. |
| `gaps` | At least one host reports `missing`. |
| `differs` | At least one host is `differs`, `newer`, or `stale`. |
| `plugin` | `fromPlugin` is true. |
| `heavy` | `tooHeavy` is true (`app.tsx:588-613`). |

This component has no local error branch: it renders the supplied overview and empty-state messages; request errors belong to its parent (`app.tsx:588-623`).

For each displayed row, the homes cell filters `row.hosts` to all entries when no host is selected or to entries whose `hostId` matches the selection. It maps those entries to home-id lists and intersects them; no selected-host rows produce an empty list. An empty home list displays `только канон`; otherwise sorted ids are rendered as paths (`app.tsx:713-721`).

The matrix renders each host state as present/same, newer, stale, differs, or missing, and marks plugin-provided canon names with a badge (`app.tsx:669-692`).

### Host adoption and replacement

`adoptSkill` validates the selected home and policy before changing files. It rejects unknown homes, the canon itself, BB's own-registry home, and absent skill paths (`host.ts:476-498`).

For symlinks, only `unlink`, `adopt`, and `take` have action paths. Unlink is allowed for `drop` homes or a link into BB's own registry; adopt/take resolves the target, requires `SKILL.md`, and copies the dereferenced target into canon. `take` archives an existing canon entry first. Other symlink modes fail as “already a symlink”; broken targets and duplicate adopt names return errors (`host.ts:499-531`).

For real folders, `unlink` is rejected, `SKILL.md` is required, and `delete` is rejected for a `link` home. `delete` removes the home folder; `take` archives an existing canon folder, moves the local folder into canon and recreates a symlink for `link` homes; `adopt` requires an unused canon name and moves the folder into canon. The link/replacement branch requires an existing canon entry, archives the local folder, then creates a canon symlink where the home policy requires it (`host.ts:533-570`).

The host returns `{ ok: false, error }` for validation failures. Filesystem errors from directory creation, copy, rename, removal, or symlink creation are not caught in this function (`host.ts:476-570`).

### Canon Git synchronization

`syncSkillsCanon` uses an injected Git runner and optional path, timestamp, host-name, and fingerprint functions; otherwise it uses the host Git runner and local defaults (`skills-sync.ts:21-49`, `skills-sync.ts:87-98`).

1. Without `.git` in the canon, it creates a timestamped snapshot, clones the remote to a temporary path, adds only top-level entries absent locally, and moves clone metadata into canon. When `fingerprintDir` is supplied, it records same-name hash divergences while retaining local folders; then it removes the temporary clone (`skills-sync.ts:99-130`).
2. With `.git`, it reads `origin`; when its URL differs from the requested remote, it adds or changes `origin`, then runs `pull --rebase --autostash` (`skills-sync.ts:131-142`).
3. If pull fails, it aborts the rebase. A failure other than untracked-file overwrite returns an error. For that overwrite case it fetches `origin`, reads top-level non-hidden names from the fetched tree, checks out only names absent locally, and records local name collisions without replacing them (`skills-sync.ts:142-177`).
4. It adds root-level symlink names and dependency/cache directories to `.gitignore`, stages all changes, commits only when the worktree is dirty, and verifies the fetched ref is an ancestor of local HEAD. If needed, it records the remote ref with an `ours` merge commit (`skills-sync.ts:179-221`).
5. It pushes and returns `ok: true` with a message indicating whether it committed and pushed. A push failure returns `ok: false` and a clipped error; other Git failures abort an in-progress rebase where possible and return `ok: false` (`skills-sync.ts:222-236`).

Clone, pull, fetch, checkout, commit, merge, or ref failures reach the catch path, which aborts a rebase where possible and returns `ok: false`, an error, and no success message (`skills-sync.ts:233-236`).

| Branch | Condition and work | Result or failure |
|---|---|---|
| First Git sync | Canon lacks `.git`; snapshot local tree, clone remote, add only absent top-level items, preserve same-name local content and install clone metadata (`skills-sync.ts:99-130`). | Continues into ignore/stage/commit/ref-check/push. Clone or migration errors are caught and returned as `ok:false` (`skills-sync.ts:233-236`). |
| Existing repository | Read `origin`, add or replace its URL when needed, then `pull --rebase --autostash` (`skills-sync.ts:131-142`). | A successful pull sets the remote ref used by the later ancestry check (`skills-sync.ts:139-142`). |
| Pull blocked by untracked overwrite | Abort rebase; only this parsed failure with named paths enters recovery. Fetch remote tree and check out names absent locally; existing local names are kept (`skills-sync.ts:142-177`). | Fetch/checkout failure returns `ok:false`; other pull errors return `ok:false` without recovery (`skills-sync.ts:145-175`). |
| Local commit/reconcile | Add root symlink and junk-directory ignores, stage the canon, commit only if dirty, and verify remote ref is an ancestor; if not, record it with an `ours` merge (`skills-sync.ts:179-221`). | Missing remote ref or failed merge/recheck returns `ok:false` via the outer catch (`skills-sync.ts:210-221`, `skills-sync.ts:233-236`). |
| Push | Push after local reconciliation (`skills-sync.ts:222-223`). | Push failure returns `ok:false` with clipped first-line error; success returns `ok:true` and a message. A clean tree still pushes but does not create a commit (`skills-sync.ts:222-232`). |

## Modes, policies, and states

| Home policy | Location | Behavior |
|---|---|---|
| Canon | `~/.agents/skills` | Source of truth, and the directory synchronized with Git (`host.ts:376-378`, `skills-sync.ts:87-98`). |
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
- Git sync reports missing Git, remote, or merge/push failures with `ok: false`; the orchestration excludes hosts whose sync failed from later fan-out (`skills-sync.ts:87-236`, `server.ts:1248-1305`, `server.ts:1538-1569`).
- A remote is required for `skills-sync`; without one, the server returns an error before starting sync (`server.ts:2179-2185`).

## Business rules

- Folder policy is centralized in `LOCATION_POLICY`; unknown locations default to `link` (`skills.ts:103-122`).
- A unique most-recent version can be promoted; if the top timestamp is shared by different hashes, no automatic promotion is planned (`skills.ts:267-330`).
- The fan-out planner does not retire a skill missing from BB unless prior state records that the plugin mirrored it (`skills.ts:418-451`, `skills.ts:507-524`).
- CLI homes skip marketplace-provided skill names when `skillsFanOutPluginNames` is off; the default is on, and `bb tools skills-fanout --all` also explicitly includes those names. BB server mirroring follows the same setting (`server.ts:515-520`, `server.ts:1197-1207`, `server.ts:1383-1388`, `server.ts:2768-2770`).
- Skill copies and archives omit `node_modules`, `.git`, Python caches and virtual environments, JS build caches, `.DS_Store`, `.backup.json`, and `.pyc`, `.bak`, or `.tmp` files (`skill-tree.ts:12-29`, `host.ts:1096-1108`, `skills-server.ts:130-145`).
- The scan records BB-counted bytes, file count, and whether recognized junk is present. Current fan-out guards use the byte value; they do not pass the file count to `bbTreeProblem` (`contract.ts:99-105`, `skills.ts:151-162`, `skills.ts:475-477`, `skills.ts:594-597`).
- The hourly schedule runs skills fan-out when enabled; if fan-out is disabled but a Git remote is configured, it still synchronizes the canon with Git (`server.ts:507-514`, `server.ts:2267-2287`). The setting default is documented in [deployment](../deployment.md).
- Replaced/deleted trees are archived before removal; link-to-canon trees are not copied into backup (`host.ts:299-315`, `host.ts:935-957`).

## Public API or commands

See [API and commands](../api.md). The main calls are `skill_adopt`, `skill_adopt_bulk`, `skills_fanout`, `skills_backups`, `skills_backup_restore`, and `skills_sync` (`server.ts:289-380`).

## Gotchas

- Git sync requires a configured remote; fan-out without a remote still lays out eligible homes, but does not synchronize canon with Git (`server.ts:2179-2185`, `i18n.ts:231-260`).
- A project skill symlink is not replaced as part of promotion; its target contents may be copied to canon while the live link remains in place (`skills.ts:302-365`).
- The fan-out history file tracks whether a BB mirror was created; losing that record changes how later missing skills are interpreted (`host.ts:275-293`, `host.ts:966-975`, `skills.ts:458-487`, `skills.ts:524-530`).

See [decisions](../decisions.md), [data model](../data-model.md), and [gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools API and commands](../api.md)
- [Agent Tools data model](../data-model.md)
- [Agent Tools decisions](../decisions.md)
- [Agent Tools gotchas](../gotchas.md)
- [Agent Tools overview](../overview.md)
