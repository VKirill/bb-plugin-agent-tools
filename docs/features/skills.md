---
title: Agent skill canon and rollout
type: component
created: 2026-09-27
updated: 2026-09-28
status: active
confidence: high
tags: [skills, canon, fanout]
sources:
  - skills.ts
  - host.ts
  - server.ts
  - contract.ts
  - i18n.ts
  - app.tsx
---
# Agent skill canon and rollout
The skills feature compares skill folders on each machine against `~/.agents/skills`, then plans promotions, Git synchronization, CLI-home links or mirrors, and snapshots (`host.ts:596-653`, `server.ts:1289-1364`).

## Purpose

Each scanned skill entry includes its name, directory or symlink kind, resolved target, content hash, newest modification time, and whether `SKILL.md` exists (`contract.ts:74-106`). The shared planner assigns visible states and deterministic actions (`skills.ts:138-190`, `skills.ts:191-252`).

## How it works

1. A machine host scans the canon and known homes, ignores hidden names, fingerprints skill folders, and also detects names already supplied by marketplace plugins (`host.ts:566-653`).
2. The server stores the scan by host and derives out-of-canon rows and a cross-machine canon matrix (`server.ts:565-574`, `server.ts:820-889`).
3. `resolveRowAction` returns an automatic action when a state and location policy determine one; equal-date divergences and manual BB registry cases remain unresolved (`skills.ts:138-178`).
4. An explicit adopt/link/take/delete/unlink action runs on the selected host; the host checks location policy, `SKILL.md`, existing canon content, and symlink conditions (`server.ts:1922-1929`, `host.ts:692-787`).
5. Fan-out first promotes the unique newest candidate into the local canon, then syncs the configured Git remote, then computes and applies home operations (`skills.ts:267-330`, `server.ts:1289-1364`).
6. `planFanOut` returns `link`, `mirror`, `pull`, `drop`, or `retire` operations plus next history state; the host executor snapshots replacements and blocks operations that would lose files (`skills.ts:409-525`, `host.ts:1122-1188`).
7. The archive view lists backup metadata; restore snapshots the current canon version and copies the chosen snapshot into the canon (`host.ts:1195-1274`, `server.ts:1972-1977`).

### Server initialization and settings

1. The `plugin` entry reads the `lang` key from BB KV; a supported saved language is applied and an absent or invalid value selects Russian (`server.ts:465-471`).
2. It defines MetaMCP address/key/namespaces, scheduled skills fan-out, marketplace-name handling, and the canon Git remote. Defaults are empty URL/key, `secondary`, fan-out off, plugin names included, and no remote (`server.ts:473-515`).
3. It creates a host RPC client and exposes helpers for catalog, ignored names, auto-sync, and probe storage. Missing stored collections read as empty lists; missing `autoSync` reads as false (`server.ts:517-531`).

The initialization code here has no local catch around the initial KV read or host client creation (`server.ts:465-520`).

### Skill row classification

`computeSkillRows` indexes canon entries that contain `SKILL.md`, recording hashes and modification times, and records targets of canon symlinks. It then skips the canon location and homes that do not exist, and classifies each remaining entry (`skills.ts:191-215`).

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

Each emitted row contains its name, home id, state, hash, local mtime, and canon mtime; output sorts by name then home id. For an ordinary real home folder with no matching canon name, the state is `only-here`. This classifier returns rows and has no error-result branch (`skills.ts:195-252`).

### Row action resolution

`resolveRowAction` checks location policy before state. An `own` home returns no suggestion except for `stray-link`; a `link` policy changes whether replacing a copy means linking it or deleting it (`skills.ts:139-164`).

| Row state / condition | Returned action |
|---|---|
| `stray-link` | `unlink` |
| `bb-registry` outside the own-registry early return | Manual `unlink` |
| `only-here` | `adopt` into canon |
| `linked-external` | No canon mtime: `adopt`; newer local mtime: `take`; otherwise no action |
| `copy` | `link` for link-policy homes, `delete` for other policies |
| `diverged`, local mtime newer | `take` |
| `diverged`, canon mtime newer | `link` for link-policy homes, otherwise `delete` |
| Equal or missing mtimes for a divergence; unlisted state | No action (`null`) |

The resolver proposes a mode and label; it does not inspect files or execute the action. `null` means there is no deterministic suggestion; host-side validation can still reject the proposed mode (`skills.ts:139-178`, `host.ts:692-787`).

### Fan-out planning

`planFanOut` computes operations and next history state from one host's canon, scanned homes, plugin skill names, and prior mirror history. It does not write files (`skills.ts:409-424`, `skills.ts:507-525`).

1. For each canon skill it checks whether a canon symlink already points into the BB home and whether a marketplace plugin supplies the name (`skills.ts:424-433`).
2. If BB exists and is not the source of canon, a non-plugin skill missing from BB becomes `mirror`; if prior state says Agent Tools mirrored it, absence instead becomes `retire`. A differing BB mirror becomes `mirror` when canon mtime (null treated as zero) is at least the BB mtime; otherwise it becomes `pull` (`skills.ts:433-453`).
3. It checks homes other than `agents` and `bb`. A home is eligible under `link` policy when the directory or its parent exists. Marketplace names are skipped. Missing entries become `link`; real copies and live external symlinks remain unchanged; symlinks already targeting canon need no operation (`skills.ts:455-473`).
4. For real BB directories absent from canon, prior mirror history produces `drop`; otherwise they become `pull` and are added to candidate canon names. BB symlinks are skipped (`skills.ts:476-487`).
5. It drops dangling links and links into canon when that skill is absent or retired. Links to external targets remain (`skills.ts:489-505`).
6. It returns the operations, sorted next-state entries containing hashes and whether a real BB mirror is expected, and the names skipped because plugins provide them (`skills.ts:507-525`).

The planner has no per-operation failure result: ineligible homes are skipped or represented in the plan, and write failures belong to the host executor (`skills.ts:455-473`, `host.ts:1122-1188`).

### Canon screen

`SkillCanon` builds counts from all canon rows, then applies the selected filter and a trimmed, case-insensitive name query to decide which rows to display. Filters are all, missing on at least one host, divergent on at least one host, and supplied by a plugin. An empty canon gets a “canon empty or hosts not scanned” message. When the visible set is empty, the message depends on the filter (`gaps`, `differs`, or other), even if the text query caused the empty result (`app.tsx:584-656`).

For each displayed row, the homes cell filters `row.hosts` to all entries when no host is selected or to entries whose `hostId` matches the selection. It maps those entries to home-id lists and intersects them; no selected-host rows produce an empty list. An empty result displays `только канон`; otherwise sorted ids are rendered as paths (`app.tsx:695-707`).

The matrix renders each host state as present/same, newer, stale, differs, or missing, and marks plugin-provided canon names with a badge (`app.tsx:669-692`).

### Host adoption and replacement

`adoptSkill` validates the selected home and policy before changing files. It rejects unknown homes, the canon itself, BB's own-registry home, and absent skill paths (`host.ts:692-714`).

For symlinks, only `unlink`, `adopt`, and `take` have action paths. Unlink is allowed for `drop` homes or a link into BB's own registry; adopt/take resolves the target, requires `SKILL.md`, and copies the dereferenced target into canon. `take` archives an existing canon entry first. Other symlink modes fail as “already a symlink”; broken targets and duplicate adopt names return errors (`host.ts:715-747`).

For real folders, `unlink` is rejected, `SKILL.md` is required, and `delete` is rejected for a `link` home. `delete` removes the home folder; `take` archives an existing canon folder, moves the local folder into canon and recreates a symlink for `link` homes; `adopt` requires an unused canon name and moves the folder into canon. The link/replacement branch requires an existing canon entry, archives the local folder, then creates a canon symlink where the home policy requires it (`host.ts:749-787`).

The host returns `{ ok: false, error }` for validation failures. Filesystem errors from directory creation, copy, rename, removal, or symlink creation are not caught in this function (`host.ts:700-787`).

### Canon Git synchronization

`syncSkillsCanon` uses supplied Git, path-expansion, timestamp, host-name, and optional fingerprint dependencies; otherwise it uses the host Git runner and local defaults (`host.ts:158-169`).

1. Without `.git` in the canon, it creates a timestamped snapshot, clones the remote to a temporary path, adds only top-level entries absent locally, and moves clone metadata into canon. When `fingerprintDir` is supplied, it records same-name hash divergences while retaining local folders; then it removes the temporary clone (`host.ts:171-201`).
2. With `.git`, it reads `origin`; when its URL differs from the requested remote, it adds or changes `origin`, then runs `pull --rebase --autostash` (`host.ts:202-212`).
3. If pull fails, it aborts the rebase. A failure other than untracked-file overwrite returns an error. For that overwrite case it fetches `origin`, reads top-level non-hidden names from the fetched tree, checks out only names absent locally, and records local name collisions without replacing them (`host.ts:213-248`).
4. It adds root-level symlink names to `.gitignore`, stages all changes, commits only when the worktree is dirty, and verifies the fetched ref is an ancestor of local HEAD. If needed, it records the remote ref with an `ours` merge commit (`host.ts:250-283`).
5. It pushes and returns `ok: true` with a message indicating whether it committed and pushed. A push failure returns `ok: false` and a clipped error (`host.ts:284-294`).

Clone, pull, fetch, checkout, commit, merge, or ref failures reach the catch path, which aborts a rebase where possible and returns `ok: false`, an error, and no success message (`host.ts:213-218`, `host.ts:244-247`, `host.ts:295-298`).

## Modes, policies, and states

| Home policy | Location | Behavior |
|---|---|---|
| Canon | `~/.agents/skills` | Source of truth, and the directory synchronized with Git (`skills.ts:103-117`, `host.ts:596-653`). |
| Link | `~/.claude/skills`, `~/.qwen/skills` | Missing entries are symlinked to canon; real copies can be replaced with links (`skills.ts:103-117`, `skills.ts:123-133`, `skills.ts:455-473`). |
| Native | `~/.codex/skills`, `~/.cursor/skills`, `~/.config/opencode/skills` | Their homes are not rewritten during fan-out (`skills.ts:103-117`, `skills.ts:123-133`, `skills.ts:455-473`). |
| Own | `~/.bb/skills` | Plugin does not rewrite BB's skill registry; fan-out mirrors real directories beside it (`skills.ts:103-117`, `skills.ts:123-133`, `skills.ts:418-451`). |
| Drop | `~/.gemini/config/skills` | Copies and links are removed during rule-based handling (`skills.ts:103-117`, `skills.ts:123-133`, `skills.ts:138-145`). |
| Manual action | `bb-registry`, equal-date divergence, protected external links | No automatic action is returned (`skills.ts:138-178`). |
| Fan-out operations | link, mirror, pull, drop, retire | Link to canon, copy canon to BB, pull a newer BB tree into canon, remove a home copy, or retire a skill deleted in BB (`skills.ts:346-356`, `skills.ts:409-525`). |

## Failures

- Unknown folders, missing skills, missing `SKILL.md`, attempts to manipulate the canon directly, or disallowed home policies return `ok: false` (`host.ts:692-751`).
- A replacement is blocked if the losing tree contains files absent from the winning tree (`host.ts:674-682`, `host.ts:1144-1164`).
- Fan-out errors are reported per operation; an absent home path fails only when the planned operation cannot find the corresponding scanned location (`host.ts:1122-1180`).
- Git sync reports missing Git, remote, or merge/push failures with `ok: false`; the orchestration excludes hosts whose sync failed from later fan-out (`host.ts:158-217`, `server.ts:1289-1364`).
- A remote is required for `skills-sync`; without one, the server returns an error before starting sync (`server.ts:1979-1985`).

## Business rules

- Folder policy is centralized in `LOCATION_POLICY`; unknown locations default to `link` (`skills.ts:103-122`).
- A unique most-recent version can be promoted; if the top timestamp is shared by different hashes, no automatic promotion is planned (`skills.ts:267-330`).
- The fan-out planner does not retire a skill missing from BB unless prior state records that the plugin mirrored it (`skills.ts:418-451`, `skills.ts:507-524`).
- Marketplace-provided skill names are skipped by fan-out unless the explicit wildcard requests the full canon (`skills.ts:409-433`, `host.ts:1106-1121`).
- The hourly schedule runs skills fan-out when enabled; if fan-out is disabled but a Git remote is configured, it still synchronizes the canon with Git (`server.ts:493-515`, `server.ts:2074-2086`). The setting default is documented in [deployment](../deployment.md).
- Replaced/deleted trees are archived before removal; link-to-canon trees are not copied into backup (`host.ts:517-537`).

## Public API or commands

See [API and commands](../api.md). The main calls are `skill_adopt`, `skill_adopt_bulk`, `skills_fanout`, `skills_backups`, `skills_backup_restore`, and `skills_sync` (`server.ts:289-380`).

## Gotchas

- Git sync requires a configured remote; fan-out without a remote only affects each host's local homes (`server.ts:1979-1985`, `i18n.ts:231-260`).
- A project skill symlink is not replaced as part of promotion; its target contents may be copied to canon while the live link remains in place (`skills.ts:151-159`, `host.ts:731-747`).
- The fan-out history file tracks whether a BB mirror was created; losing that record changes how later missing skills are interpreted (`host.ts:497-520`, `skills.ts:435-451`).

See [decisions](../decisions.md), [data model](../data-model.md), and [gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools API and commands](../api.md)
- [Agent Tools data model](../data-model.md)
- [Agent Tools decisions](../decisions.md)
- [Agent Tools gotchas](../gotchas.md)
- [Agent Tools overview](../overview.md)
