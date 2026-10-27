---
title: BB server skill mirror archive
type: component
created: 2026-10-27
updated: 2026-10-27
status: active
confidence: medium
tags: [skills, archive, server-mirror]
sources:
  - skills-server.ts
  - server.ts
  - host.ts
  - contract.ts
---
# BB server skill mirror archive
The rollout keeps `<experimental_dataDir>/skills` populated from the local canon and, when needed, a connected host canon; archive transfer is the fallback for a host-only skill (`server.ts:1361-1453`).

## Purpose

The BB server process has its own skill directory, separate from enrolled machines. The rollout plans mirrors from local canon entries, then can pack a missing entry on a connected host and extract that archive into the server process directory (`server.ts:1361-1453`, `skills-server.ts:58-64`). The full canon policy and rollout are in [Agent skill canon and rollout](skills.md).

## How it works

1. `runServerBbSkills` reads local canon and the server-process destination, finds missing skill names and selects a connected host canon for names absent locally (`server.ts:1361-1453`).
2. For a selected host-only skill it calls `skills_archive`; the host excludes recognized junk and rejects a packed archive larger than 8 MiB (`server.ts:1412-1453`, `host.ts:1086-1115`, `contract.ts:440-448`).
3. The rollout calls `extractSkillArchive` with the destination root, skill name, base64 payload, and `dryRun` flag (`server.ts:1488-1503`, `skills-server.ts:130-146`).
4. A real extraction backs up the existing destination, removes that directory, creates the destination root, decodes the archive to a temporary `.tgz`, and runs `tar xzf` into the root with junk-directory exclusions (`skills-server.ts:133-141`).
5. The temp archive is removed in a `finally` block after `tar` runs. The rollout records archive, extraction, copy, or blocked-plan errors in per-operation results (`skills-server.ts:137-145`, `server.ts:1455-1532`).

| Mode or condition | Outcome or failure |
|---|---|
| `dryRun: true` | Extraction returns before backup, deletion, directory creation, or temporary archive creation (`skills-server.ts:130-136`). |
| Archive from host is valid and run is real | Existing destination is backed up, then removed; archive contents are unpacked in the destination root (`skills-server.ts:133-141`). |
| Host pack fails, archive is absent, or exceeds host limit | The rollout records the host archive operation as failed and does not call extraction (`server.ts:1412-1453`, `server.ts:1488-1503`, `host.ts:1086-1115`). |
| Backup/removal/root creation/archive write fails | The exception propagates to the rollout operation. These steps precede the `try/finally` around `tar` (`skills-server.ts:133-143`, `server.ts:1488-1503`). |
| `tar` fails | Extraction rejects and the temporary archive is removed by `finally`; the previous destination is not restored after its earlier removal (`skills-server.ts:133-145`). |

## Business rules

- Dry run performs no archive extraction writes (`skills-server.ts:130-136`).
- The archive is extracted under the destination root and excludes recognized skill junk directories (`skills-server.ts:139-141`).
- The host-side archive has an 8 MiB maximum; it is base64 RPC content and excludes recognized junk (`host.ts:1086-1115`, `contract.ts:440-448`).

## Public API

`extractSkillArchive(destRoot, name, archiveBase64, dryRun)` is called by server rollout orchestration; it is not a user-facing RPC method (`skills-server.ts:130-146`, `server.ts:1488-1503`).

## Gotchas

The destination is backed up and removed before archive decoding and extraction. A later write or `tar` error leaves the prior content only in its backup; this function does not restore it (`skills-server.ts:133-145`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agent skill canon and rollout](skills.md)
