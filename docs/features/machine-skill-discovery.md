---
title: Machine skill discovery
type: component
created: 2026-10-28
updated: 2026-10-28
status: active
confidence: high
tags: [skills, machines, discovery]
sources:
  - host-skills.ts
  - host.ts
  - contract.ts
  - skills-hub-service.ts
---
# Machine skill discovery
The hub's machine scan counts CLI skill-home entries and returns one importable copy for each discovered skill name.

## Purpose

`skill_homes_count` combines per-home counts with `listMachineSkills` results. The hub stores those results by host, then uses `notOnHub` to offer import for skill names absent from the server hub (`host.ts:1216`, `skills-hub-service.ts:444-475`, `skills-hub-service.ts:593-609`).

## How it works

1. `countSkillHomes` walks the ordered `MACHINE_SKILL_HOMES` list. It skips hidden names and each location's `keep` entries, counts real directories separately from symlinks, and omits homes with zero entries (`host-skills.ts:14-25`, `host-skills.ts:101-123`).
2. `listMachineSkills` resolves each configured home entry to its real path. It skips `bb-cli`, unresolved links, and paths inside CLI or BB-owned roots (`host-skills.ts:132-154`).
3. It requires a regular `SKILL.md` file, records its rounded modification time, and keeps the newest candidate per name. Equal timestamps keep the earlier candidate encountered in `MACHINE_SKILL_HOMES` (`host-skills.ts:149-160`).
4. It sorts the selected records by name and returns `{name, path, home, mtime}`. The host RPC returns these alongside home counts (`host-skills.ts:125-163`, `host.ts:1216`).
5. The hub refresh calls every enrolled host, stores success or a clipped error per host, and import selects discovered names still absent from the hub (`skills-hub-service.ts:444-475`, `skills-hub-service.ts:593-609`).

| Candidate condition | Discovery outcome |
|---|---|
| Hidden entry or location-specific `keep` name | Not visited (`host-skills.ts:101-104`, `host-skills.ts:149-151`). |
| Name is `bb-cli` | Skipped as BB-owned (`host-skills.ts:141-143`, `host-skills.ts:151-152`). |
| Real path cannot be resolved or is within an owned root | Skipped (`host-skills.ts:146-154`). |
| `SKILL.md` is absent, unreadable, or not a regular file | Skipped (`host-skills.ts:155-156`). |
| Same name occurs in more than one home | Keep the candidate with greater `SKILL.md` mtime; equal mtime leaves the prior candidate (`host-skills.ts:157-160`). |
| A home directory cannot be read while counting | Treat it as empty; other homes are still scanned (`host-skills.ts:101-104`, `host-skills.ts:108-122`). |
| Host skill scan rejects | Hub retains that host with empty counts and an error string capped at 200 characters, then continues (`skills-hub-service.ts:444-475`). |

## Business rules

- The scan reads homes and does not change the machine's skill files (`host-skills.ts:144-163`).
- Import copies selected skills through the same archive validation used by hub publishing and leaves the source in place (`skills-hub-service.ts:593-609`).
- Cleanup is a separate operation that moves eligible home entries into a dated backup; its preview uses `dryRun` (`host-skills.ts:167-223`).

## Public API

| Surface | Contract |
|---|---|
| Host RPC | `skill_homes_count` has empty input and returns at most 32 non-empty homes plus an optional `found` list capped at 3,000 (`contract.ts:472-481`). |
| Host handler | Returns `{ homes, found }` by calling `countSkillHomes` and `listMachineSkills` (`host.ts:1216`). |
| Hub service | `skills_machines_refresh` refreshes all hosts; `skills_machines_import` copies chosen missing skills (`skills-hub-service.ts:720-727`). |

See [hub skills and categories](skills-hub.md) for the import, cleanup, and settings flows.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent Tools API and commands](../api.md)
