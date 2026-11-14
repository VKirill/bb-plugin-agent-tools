---
title: Machine skill discovery
type: component
created: 2026-10-28
updated: 2026-11-14
status: active
confidence: medium
tags: [skills, machines, discovery]
sources:
  - host-skills.ts
  - host.ts
  - contract.ts
  - skills-hub-service.ts
  - hub-only.ts
---
# Machine skill discovery
The hub's machine scan counts CLI skill-home entries and returns one importable copy for each discovered skill name.

## Purpose

`skill_homes_count` combines per-home counts with `listMachineSkills` results, excluding any directory protected by the hub's canon marker token (`host-skills.ts:113-207`, `host.ts:1193-1196`). The hub stores those results by host, then uses `machineNotOnHub` to offer import for skill names absent from `loadableHubNames(hub)` (`skills-hub-service.ts:962-1000`, `skills-hub-service.ts:1083`, `skills-hub-service.ts:1163-1179`, `hub-only.ts:46-57`).

## How it works

1. Before calling a host, `protectPaths` stamps `<root>/.agent-tools-canon` with the persistent KV token `skillCanonToken` (excluding `.agent-tools-canon` in `.git/info/exclude`) and passes `{ path, token }` entries in `protect` (`skills-hub-service.ts:927-959`, `host-skills.ts:113-145`).
2. `countSkillHomes` walks the ordered `MACHINE_SKILL_HOMES` list, skips protected directories whose `.agent-tools-canon` matches `token`, skips hidden names and each location's `keep` entries, counts real directories separately from symlinks, and omits homes with zero entries (`host-skills.ts:14-25`, `host-skills.ts:131-165`).
3. `listMachineSkills` resolves each configured home entry to its real path. It skips protected canon paths, `bb-cli`, unresolved links, and paths inside CLI or BB-owned roots (`host-skills.ts:175-207`).
4. It requires a regular `SKILL.md` file, records its rounded modification time, and keeps the newest candidate per name. Equal timestamps keep the earlier candidate encountered in `MACHINE_SKILL_HOMES` (`host-skills.ts:186-207`).
5. It sorts the selected records by name and returns `{name, path, home, mtime}`. The host RPC returns these alongside home counts (`host-skills.ts:186-207`, `host.ts:1193-1196`).
6. The hub refresh calls every enrolled host, stores success or a clipped error per host, filters discovered skills with `machineNotOnHub` (skills on the hub with a `blocking: true` validation problem do not suppress import), and copies selected names during import (`skills-hub-service.ts:962-1000`, `skills-hub-service.ts:1083`, `skills-hub-service.ts:1163-1179`, `hub-only.ts:46-57`).

| Candidate condition | Discovery outcome |
|---|---|
| Directory contains matching `.agent-tools-canon` token from `protect` | Protected from counting, discovery, and cleanup (`host-skills.ts:120-165`, `host-skills.ts:186-259`). |
| Hidden entry or location-specific `keep` name | Not visited (`host-skills.ts:148-165`, `host-skills.ts:186-207`). |
| Name is `bb-cli` | Skipped as BB-owned (`host-skills.ts:184-207`). |
| Real path cannot be resolved or is within an owned root | Skipped (`host-skills.ts:175-207`). |
| `SKILL.md` is absent, unreadable, or not a regular file | Skipped (`host-skills.ts:186-207`). |
| Same name occurs in more than one home | Keep the candidate with greater `SKILL.md` mtime; equal mtime leaves the prior candidate (`host-skills.ts:186-207`). |
| A home directory cannot be read while counting | Treat it as empty; other homes are still scanned (`host-skills.ts:148-165`). |
| Host skill scan rejects | Hub retains that host with empty counts and an error string capped at 200 characters, then continues (`skills-hub-service.ts:962-1000`). |

## Business rules

- The scan reads homes and does not change the machine's skill files (`host-skills.ts:148-207`).
- Canon protection matches by both directory path and random token stored in `.agent-tools-canon`, so another machine whose `~/.bb/skills` sits at the same path without the hub token is still scanned and cleaned (`host-skills.ts:113-145`, `skills-hub-service.ts:927-959`).
- Import copies selected skills absent from `loadableHubNames(hub)` through the publish validation path and leaves the source in place (`skills-hub-service.ts:1163-1179`, `hub-only.ts:46-57`).
- Cleanup moves eligible home entries (including `.git` when present) into a dated backup, skips protected roots, and writes `~/.agents/skills-on-hub`; its preview uses `dryRun` (`host-skills.ts:29`, `host-skills.ts:216-259`).

## Public API

| Surface | Contract |
|---|---|
| Host RPC | `skill_homes_count` accepts optional `protect` (up to 8 `{path, token}` entries) and returns at most 32 non-empty homes plus an optional `found` list capped at 3,000 (`contract.ts:465-479`). |
| Host RPC | `skill_homes_cleanup` accepts required `dryRun` and optional `protect` (up to 8 entries) (`contract.ts:481-494`). |
| Host handler | `skill_homes_count` returns `{ homes, found }` via `countSkillHomes` and `listMachineSkills` (`host.ts:1193-1196`); `skill_homes_cleanup` calls `cleanupSkillHomes` (`host.ts:1198`). |
| Hub service | `skills_machines_refresh` refreshes all hosts; `skills_machines_import` copies chosen missing skills; `skills_machines_cleanup` cleans one host (`skills-hub-service.ts:1309-1325`). |

See [hub skills and categories](skills-hub.md) for the import, hub-only enforcement, cleanup, and settings flows.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools API and commands](../api.md)
