---
title: Agent skill canon and rollout
type: component
created: 2026-09-27
updated: 2026-09-27
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
6. `planFanOut` creates `link`, `mirror`, `pull`, `drop`, or `retire` operations; writes snapshot replaced directories, checks for files that would be lost, and records fan-out provenance (`skills.ts:409-525`, `host.ts:1122-1188`).
7. The archive view lists backup metadata; restore snapshots the current canon version and copies the chosen snapshot into the canon (`host.ts:1195-1274`, `server.ts:1972-1977`).

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
- Fan-out defaults off in settings; the hourly schedule syncs Git when a remote is configured, and applies fan-out only when the fan-out setting is enabled (`server.ts:493-515`, `server.ts:2068-2087`).
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
